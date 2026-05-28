/**
 * Unit tests for sync-middleware.withFullSync retry + loud-fallback behavior.
 *
 * Covers quick task 260421-j1b:
 *   - Happy path: RW acquired on first attempt, sync runs, no warn, no syncSkipped.
 *   - Retry success: RW fails on attempt 1 (RO fallback), succeeds on attempt 2.
 *   - Retry exhaustion: all 3 attempts fall back to RO — fabricated SyncResult
 *     has syncSkipped=true, skipReason="could_not_acquire_write_lock", and a
 *     single console.warn fires.
 *
 * Mocks `../../../src/db/connection.js` and `../../../src/sync/index.js` via
 * jest.unstable_mockModule so the test never touches real DuckDB.
 */

import { jest } from "@jest/globals";

// --- Mocked module surfaces (typed) ---

type ConnectionMode = "read_write" | "read_only" | null;

const upgradeToReadWrite = jest.fn<() => Promise<unknown>>();
const downgradeToReadOnly = jest.fn<() => Promise<void>>();
const getConnectionMode = jest.fn<() => ConnectionMode>();
const syncAllBlocks = jest.fn<(baseDir: string) => Promise<unknown>>();
// Unused in withFullSync but imported at module top level — mock to avoid resolve failure.
const syncBlock = jest.fn();

jest.unstable_mockModule("../../../src/db/connection.ts", () => ({
  upgradeToReadWrite,
  downgradeToReadOnly,
  getConnectionMode,
}));

jest.unstable_mockModule("../../../src/sync/index.ts", () => ({
  syncAllBlocks,
  syncBlock,
}));

// Dynamic import AFTER mocks are registered. Use top-level await (Node 18+/ESM) —
// the Jest runner tolerates this because testMatch files are loaded as ESM.
const { withFullSync } = await import(
  "../../../src/tools/middleware/sync-middleware.ts"
);

// Shared fixture — a non-empty SyncResult from syncAllBlocks.
const NORMAL_SYNC_RESULT = {
  blocksProcessed: 3,
  blocksSynced: 2,
  blocksUnchanged: 1,
  blocksDeleted: 0,
  errors: [],
  results: [],
};

describe("withFullSync — retry + loud fallback (260421-j1b)", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    upgradeToReadWrite.mockReset();
    downgradeToReadOnly.mockReset();
    getConnectionMode.mockReset();
    syncAllBlocks.mockReset();

    upgradeToReadWrite.mockResolvedValue(undefined);
    downgradeToReadOnly.mockResolvedValue(undefined);

    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it("happy path: RW on first attempt, sync runs, no warn, syncSkipped=false, downgrade runs", async () => {
    getConnectionMode.mockReturnValue("read_write");
    syncAllBlocks.mockResolvedValue({ ...NORMAL_SYNC_RESULT });

    const handler = jest.fn(async (_input: unknown, ctx: { blockSyncResult: unknown }) => ctx);
    const wrapped = withFullSync("/data", handler);

    const ctx = (await wrapped({})) as {
      blockSyncResult: {
        blocksProcessed: number;
        blocksSynced: number;
        blocksUnchanged: number;
        blocksDeleted: number;
        errors: unknown[];
        results: unknown[];
        syncSkipped?: boolean;
        skipReason?: string;
      };
      baseDir: string;
    };

    expect(upgradeToReadWrite).toHaveBeenCalledTimes(1);
    expect(syncAllBlocks).toHaveBeenCalledTimes(1);
    expect(downgradeToReadOnly).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    // Either syncSkipped === false (explicit) or falsy is acceptable; plan sets it false.
    expect(ctx.blockSyncResult.syncSkipped).toBe(false);
    expect(ctx.blockSyncResult.skipReason).toBeUndefined();
    expect(ctx.blockSyncResult.blocksProcessed).toBe(3);
    expect(ctx.blockSyncResult.blocksSynced).toBe(2);
    expect(ctx.blockSyncResult.blocksUnchanged).toBe(1);
    expect(ctx.baseDir).toBe("/data");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retry success: RW fails once (RO), succeeds on attempt 2 after ~100ms backoff", async () => {
    jest.useFakeTimers();

    // First call → read_only, second call → read_write
    getConnectionMode
      .mockReturnValueOnce("read_only")
      .mockReturnValueOnce("read_write");
    syncAllBlocks.mockResolvedValue({ ...NORMAL_SYNC_RESULT });

    const handler = jest.fn(async (_input: unknown, ctx: { blockSyncResult: unknown }) => ctx);
    const wrapped = withFullSync("/data", handler);

    const promise = wrapped({});

    // Drain any pending microtasks so the first mode check + setTimeout(100) has registered.
    // Then advance past the first backoff so the second attempt can run.
    await jest.advanceTimersByTimeAsync(100);
    await jest.runAllTimersAsync();

    const ctx = (await promise) as {
      blockSyncResult: { syncSkipped?: boolean; skipReason?: string; blocksProcessed: number };
    };

    expect(upgradeToReadWrite).toHaveBeenCalledTimes(2);
    expect(syncAllBlocks).toHaveBeenCalledTimes(1);
    expect(downgradeToReadOnly).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    expect(ctx.blockSyncResult.syncSkipped).toBe(false);
    expect(ctx.blockSyncResult.skipReason).toBeUndefined();
    expect(ctx.blockSyncResult.blocksProcessed).toBe(3);
  });

  it("retry exhaustion: all 3 attempts return RO, sync skipped, loud warn, flag set", async () => {
    jest.useFakeTimers();

    getConnectionMode.mockReturnValue("read_only");

    const handler = jest.fn(async (_input: unknown, ctx: { blockSyncResult: unknown }) => ctx);
    const wrapped = withFullSync("/data", handler);

    const promise = wrapped({});

    // Advance past both backoffs between attempts 1-2 and 2-3 (100 + 250 = 350ms).
    // No sleep happens after the final attempt — the loop falls through to skip.
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(250);
    await jest.runAllTimersAsync();

    const ctx = (await promise) as {
      blockSyncResult: {
        blocksProcessed: number;
        blocksSynced: number;
        blocksUnchanged: number;
        blocksDeleted: number;
        errors: unknown[];
        results: unknown[];
        syncSkipped?: boolean;
        skipReason?: string;
      };
    };

    expect(upgradeToReadWrite).toHaveBeenCalledTimes(3);
    expect(syncAllBlocks).not.toHaveBeenCalled();
    expect(downgradeToReadOnly).not.toHaveBeenCalled();

    // Loud warn fires exactly once, mentioning "sync skipped" and "could not acquire write lock".
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = String((warnSpy.mock.calls[0] ?? [""])[0]);
    expect(warnMsg).toMatch(/sync skipped/i);
    expect(warnMsg).toMatch(/could not acquire write lock/i);

    // Fabricated SyncResult: zero counts, empty arrays, syncSkipped + skipReason set.
    expect(ctx.blockSyncResult.syncSkipped).toBe(true);
    expect(ctx.blockSyncResult.skipReason).toBe("could_not_acquire_write_lock");
    expect(ctx.blockSyncResult.blocksProcessed).toBe(0);
    expect(ctx.blockSyncResult.blocksSynced).toBe(0);
    expect(ctx.blockSyncResult.blocksUnchanged).toBe(0);
    expect(ctx.blockSyncResult.blocksDeleted).toBe(0);
    expect(ctx.blockSyncResult.errors).toEqual([]);
    expect(ctx.blockSyncResult.results).toEqual([]);
  });
});
