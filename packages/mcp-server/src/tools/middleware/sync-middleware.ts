/**
 * Sync Middleware
 *
 * Higher-order functions that wrap MCP tool handlers with automatic
 * sync-before-query behavior. Eliminates sync boilerplate from tools.
 *
 * Connection lifecycle per tool call:
 *   1. upgradeToReadWrite (retries + RO fallback if another session holds the lock)
 *   2. If RW: sync data → downgradeToReadOnly
 *      If RO fallback: skip sync, use existing data
 *   3. Handler runs on read-only connection
 */

import {
  syncBlock,
  syncAllBlocks,
  type BlockSyncResult,
  type SyncResult,
} from "../../sync/index.ts";
import { upgradeToReadWrite, downgradeToReadOnly, getConnectionMode } from "../../db/connection.ts";

// MCP tool response types - index signature required for SDK compatibility
interface ToolError {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export interface SingleBlockContext {
  syncResult: BlockSyncResult;
  baseDir: string;
}

export interface MultiBlockContext {
  syncResults: Map<string, BlockSyncResult>;
  baseDir: string;
}

export interface FullSyncContext {
  blockSyncResult: SyncResult;
  baseDir: string;
}

/**
 * Middleware for tools that operate on a single block.
 * Syncs the block before calling the handler.
 * Returns error response if block was deleted.
 */
export function withSyncedBlock<TInput extends { blockId: string }, TOutput>(
  baseDir: string,
  handler: (input: TInput, ctx: SingleBlockContext) => Promise<TOutput>
): (input: TInput) => Promise<TOutput | ToolError> {
  return async (input: TInput) => {
    // NOTE: single-shot RW upgrade + silent RO fallback. withFullSync uses a bounded
    // retry + loud warn (see 260421-j1b plan). Apply here if/when lock contention
    // becomes a visible problem for single-block tools.
    await upgradeToReadWrite(baseDir, { fallbackToReadOnly: true });
    let syncResult: BlockSyncResult;

    if (getConnectionMode() === "read_write") {
      try {
        syncResult = await syncBlock(input.blockId, baseDir);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    } else {
      // RO fallback — another session holds the write lock, skip sync
      syncResult = { blockId: input.blockId, status: "unchanged" };
    }

    if (syncResult.status === "deleted") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Block '${input.blockId}' no longer exists (folder was deleted). Call list_blocks to see available blocks.`,
          },
        ],
        isError: true as const,
      };
    }

    if (syncResult.status === "error" && syncResult.error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Sync error for block '${input.blockId}': ${syncResult.error}. Call list_blocks to see available blocks.`,
          },
        ],
        isError: true as const,
      };
    }

    return handler(input, { syncResult, baseDir });
  };
}

/**
 * Middleware for tools that compare multiple blocks.
 * Syncs all specified blocks before calling the handler.
 * Returns error response if any block was deleted.
 */
export function withSyncedBlocks<
  TInput extends { blockIds?: string[]; blockIdA?: string; blockIdB?: string },
  TOutput,
>(
  baseDir: string,
  handler: (input: TInput, ctx: MultiBlockContext) => Promise<TOutput>
): (input: TInput) => Promise<TOutput | ToolError> {
  return async (input: TInput) => {
    // Collect block IDs from various input patterns
    const blockIds: string[] =
      input.blockIds ??
      [input.blockIdA, input.blockIdB].filter((id): id is string => !!id);

    const syncResults = new Map<string, BlockSyncResult>();

    // NOTE: single-shot RW upgrade + silent RO fallback. withFullSync uses a bounded
    // retry + loud warn (see 260421-j1b plan). Apply here if/when lock contention
    // becomes a visible problem for multi-block tools.
    await upgradeToReadWrite(baseDir, { fallbackToReadOnly: true });

    if (getConnectionMode() === "read_write") {
      try {
        for (const blockId of blockIds) {
          const result = await syncBlock(blockId, baseDir);
          syncResults.set(blockId, result);

          if (result.status === "deleted") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Block '${blockId}' no longer exists (folder was deleted). Call list_blocks to see available blocks.`,
                },
              ],
              isError: true as const,
            };
          }

          if (result.status === "error" && result.error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sync error for block '${blockId}': ${result.error}. Call list_blocks to see available blocks.`,
                },
              ],
              isError: true as const,
            };
          }
        }
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    }
    // RO fallback: syncResults stays empty — handler queries existing data

    return handler(input, { syncResults, baseDir });
  };
}

/**
 * Middleware for tools that need a full sync of all blocks.
 * Used by list_blocks which needs to see all available blocks.
 *
 * Note: market data sync (removed in Phase 64) is intentionally NOT called here (DB-09).
 * Market data writes must not be wrapped in analytics.duckdb transactions.
 * Market data is imported via dedicated import_market_csv tool (Phase 61+).
 */
export function withFullSync<TInput, TOutput>(
  baseDir: string,
  handler: (input: TInput, ctx: FullSyncContext) => Promise<TOutput>
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput) => {
    // Outer retry loop: papers over short RW-lock races where another session is
    // mid-sync. upgradeToReadWrite itself already retries internally (4× 1000ms
    // with RO fallback), so each iteration is really "give the other session
    // another window to release." 3 attempts × [100, 250, 500]ms backoff =
    // ~850ms outer budget before we give up and warn loudly.
    // See quick task 260421-j1b for rationale.
    const backoffsMs = [100, 250, 500]; // 3 attempts, ~850ms worst case
    let attempts = 0;
    let mode: "read_write" | "read_only" | null = null;
    for (let i = 0; i < backoffsMs.length; i++) {
      attempts = i + 1;
      await upgradeToReadWrite(baseDir, { fallbackToReadOnly: true });
      mode = getConnectionMode();
      if (mode === "read_write") break;
      // Last attempt: don't sleep — we're about to fall through to the skip path.
      if (i < backoffsMs.length - 1) {
        await new Promise((r) => setTimeout(r, backoffsMs[i]));
      }
    }

    let blockSyncResult: SyncResult;
    if (mode === "read_write") {
      try {
        blockSyncResult = await syncAllBlocks(baseDir);
        // Explicitly mark as not-skipped so callers checking the flag get a stable answer.
        blockSyncResult.syncSkipped = false;
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    } else {
      // All retries exhausted — another session still holds the write lock.
      // Surface this LOUDLY (warn + flag) so downstream callers and humans can
      // tell that sync was skipped and data may be stale.
      console.warn(
        `[sync-middleware] sync skipped: could not acquire write lock after ${attempts} retries; ` +
          `downstream data may be stale until next call succeeds.`
      );
      blockSyncResult = {
        blocksProcessed: 0,
        blocksSynced: 0,
        blocksUnchanged: 0,
        blocksDeleted: 0,
        errors: [],
        results: [],
        syncSkipped: true,
        skipReason: "could_not_acquire_write_lock",
      };
    }

    return handler(input, { blockSyncResult, baseDir });
  };
}
