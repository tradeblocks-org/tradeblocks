/**
 * ParquetSpotStore writeBars zero/weekend guard.
 *
 * Tests the defense-in-depth write-side filter that drops any bar with a
 * zero/null/non-finite OHLC value, and skips weekend (Sat/Sun) writes
 * entirely. Provider outages, holiday responses, and partial-session
 * artifacts come in as zero-priced rows; persisting them poisons every
 * downstream aggregate (spot_daily.low → 0 → Intraday_Range_Pct ~ 100%,
 * RSI/ATR/EMA gradient blowups, Prior_Range_vs_ATR sentinel zeros).
 *
 * Behavior contract (current):
 *   - All-zero batch → skipped silently (no throw, no write).
 *   - Mixed batch (some zero rows, some valid rows) → only valid rows are
 *     written. The earlier guard let mixed batches through; that turned
 *     out to be wrong because the enricher does NOT strip zero-rows on
 *     read (see src/utils/market-enricher.ts).
 *   - Weekend date → skipped silently (no real market activity should
 *     ever land in market.spot for Sat/Sun).
 *   - Empty batch → no-op (early return).
 *   - All-valid batch → writes all rows (no regression).
 *
 * Uses the shared build-fixture helper so the test exercises the real
 * Parquet write path (writeSpotPartition) end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { join } from "node:path";
import {
  FilePartitionCommitStore,
  ParquetSpotStore,
  runPartitionCommitAttempt,
} from "../../src/test-exports.ts";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import type { BarRow } from "../../src/market/stores/types.ts";

function zeroBar(time: string): BarRow {
  return {
    ticker: "SPX",
    date: "2025-01-06",
    time,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
  };
}

function validBar(time: string, basePrice: number): BarRow {
  return {
    ticker: "SPX",
    date: "2025-01-06",
    time,
    open: basePrice,
    high: basePrice + 1,
    low: basePrice - 1,
    close: basePrice + 0.5,
    bid: basePrice - 0.1,
    ask: basePrice + 0.1,
    volume: 0,
  };
}

describe("ParquetSpotStore writeBars zero/weekend guard", () => {
  let fixture: FixtureHandle;
  let store: ParquetSpotStore;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    store = new ParquetSpotStore(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("skips silently when every bar is all-zero (no throw, no rows written)", async () => {
    const bars = ["09:30", "10:30", "15:45"].map(zeroBar);
    await expect(store.writeBars("SPX", "2025-01-06", bars)).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read).toEqual([]);
  });

  it("filters zero rows out of a mixed batch and writes only the valid ones", async () => {
    // Mixed batch: 1 zero bar + 2 valid bars. Earlier behavior allowed all
    // 3 rows through; new behavior drops the zero row to prevent it from
    // contaminating spot_daily aggregates (min(low) → 0).
    const bars = [zeroBar("09:30"), validBar("10:30", 105), validBar("15:45", 99)];
    await expect(store.writeBars("SPX", "2025-01-06", bars)).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read.length).toBe(2);
    // Confirm the zero row is gone — every persisted bar has positive prices
    for (const r of read) {
      expect(r.open).toBeGreaterThan(0);
      expect(r.high).toBeGreaterThan(0);
      expect(r.low).toBeGreaterThan(0);
      expect(r.close).toBeGreaterThan(0);
    }
  });

  it("records mixed-batch input, written, and dropped quality counts exactly", async () => {
    const bars = [zeroBar("09:30"), validBar("10:30", 105), validBar("15:45", 99)];
    const receiptStore = new FilePartitionCommitStore(join(fixture.ctx.dataDir, "market"));
    const attempt = await runPartitionCommitAttempt(
      { attemptId: "spot-quality-test", recorder: receiptStore },
      () => store.writeBars("SPX", "2025-01-06", bars),
    );

    expect(attempt.value).toBeUndefined();
    expect(attempt.receipts).toHaveLength(1);
    expect(attempt.receipts[0].receipt.quality).toEqual({
      inputRows: 3,
      writtenRows: 2,
      droppedRows: 1,
    });
  });

  it("keeps store writeFromSelect results row-count-only while the attempt captures evidence", async () => {
    const receiptStore = new FilePartitionCommitStore(join(fixture.ctx.dataDir, "market"));
    const attempt = await runPartitionCommitAttempt(
      { attemptId: "spot-select-result", recorder: receiptStore },
      () =>
        store.writeFromSelect(
          { ticker: "SPX", date: "2025-01-07" },
          `SELECT 'SPX' AS ticker, '2025-01-07' AS date, '09:30' AS time,
                  100.0 AS open, 101.0 AS high, 99.0 AS low, 100.5 AS close,
                  NULL::DOUBLE AS bid, NULL::DOUBLE AS ask`,
        ),
    );

    expect(attempt.value).toEqual({ rowCount: 1 });
    expect(Object.keys(attempt.value)).toEqual(["rowCount"]);
    expect(attempt.receipts).toHaveLength(1);
  });

  it("skips weekend dates (Saturday) silently — no rows written", async () => {
    // 2025-01-04 is a Saturday. Even with valid-looking prices the entire
    // batch is dropped because no real market activity should land for Sat/Sun.
    const bars = [validBar("09:30", 100), validBar("10:30", 105)].map((b) => ({
      ...b,
      date: "2025-01-04",
    }));
    await expect(store.writeBars("SPX", "2025-01-04", bars)).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-04", "2025-01-04");
    expect(read).toEqual([]);
  });

  it("skips weekend dates (Sunday) silently — no rows written", async () => {
    const bars = [validBar("09:30", 100)].map((b) => ({
      ...b,
      date: "2025-01-05",
    }));
    await expect(store.writeBars("SPX", "2025-01-05", bars)).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-05", "2025-01-05");
    expect(read).toEqual([]);
  });

  it("preserves the empty-array early-return contract (no error, no write)", async () => {
    await expect(store.writeBars("SPX", "2025-01-06", [])).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read).toEqual([]);
  });

  it("happy path: all non-zero OHLC rows succeed (no regression)", async () => {
    const bars = [validBar("09:30", 100), validBar("10:30", 105), validBar("15:45", 99)];
    await expect(store.writeBars("SPX", "2025-01-06", bars)).resolves.toBeUndefined();
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read.length).toBe(3);
    expect(read[0].open).toBe(100);
  });
});
