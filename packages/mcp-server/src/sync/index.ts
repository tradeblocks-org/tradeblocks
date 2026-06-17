/**
 * Sync Layer Public API
 *
 * Provides synchronization between CSV files and DuckDB analytics database.
 * Exports hashing utilities, metadata operations, and sync functions.
 */

import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { getConnection } from "../db/connection.ts";
import {
  syncBlockInternal,
  detectBlockChanges,
  cleanupDeletedBlocks,
  type BlockSyncResult,
} from "./block-sync.ts";
import { getSyncMetadata } from "./metadata.ts";

// Re-export hasher utilities
export { hashFileContent } from "./hasher.ts";

// Re-export metadata operations and types
export {
  getSyncMetadata,
  upsertSyncMetadata,
  deleteSyncMetadata,
  getAllSyncedBlockIds,
  type BlockSyncMetadata,
} from "./metadata.ts";

// Re-export block sync types and internal functions (for testing)
export { type BlockSyncResult } from "./block-sync.ts";

// --- Result Types ---

/**
 * Result of syncing all blocks
 */
export interface SyncResult {
  blocksProcessed: number;
  blocksSynced: number;
  blocksUnchanged: number;
  blocksDeleted: number;
  errors: Array<{ blockId: string; error: string }>;
  results: BlockSyncResult[];
  /** True when the middleware could not acquire the RW lock and fell back to RO without running sync. */
  syncSkipped?: boolean;
  /** Machine-readable reason for skipping sync. Only populated when syncSkipped === true. */
  skipReason?: "could_not_acquire_write_lock";
}

// --- Blocks Directory Override ---

/**
 * Optional override for where CSV block folders live.
 * When set, sync functions scan this directory for blocks instead of baseDir.
 * DuckDB connections still use baseDir.
 *
 * Set via --blocks-dir CLI flag or BLOCKS_DIRECTORY env var.
 */
let _blocksDir: string | null = null;

export function setBlocksDir(dir: string): void {
  _blocksDir = dir;
}

export function getBlocksDir(baseDir: string): string {
  if (_blocksDir) return _blocksDir;
  const nestedBlocksDir = path.join(baseDir, "blocks");
  return existsSync(nestedBlocksDir) ? nestedBlocksDir : baseDir;
}

// --- Sync Functions ---

/**
 * Sync all blocks from the data directory to DuckDB.
 *
 * Scans all block folders, computes content hashes, and syncs
 * blocks that have changed since last sync. Also removes data
 * for blocks that no longer exist.
 *
 * @param baseDir - Base data directory containing block folders
 * @returns Sync result with counts and any errors
 */
export async function syncAllBlocks(baseDir: string): Promise<SyncResult> {
  const conn = await getConnection(baseDir);
  const blocksDir = getBlocksDir(baseDir);
  const results: BlockSyncResult[] = [];
  const errors: Array<{ blockId: string; error: string }> = [];

  // 1. Detect changes (scan blocksDir for CSV folders)
  const { toSync, toDelete } = await detectBlockChanges(conn, blocksDir);

  // 2. Delete orphaned blocks
  for (const blockId of toDelete) {
    try {
      await cleanupDeletedBlocks(conn, [blockId], blocksDir);
      results.push({ blockId, status: "deleted" });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({ blockId, error: `Failed to delete: ${errorMsg}` });
    }
  }

  // 3. Sync changed/new blocks
  for (const blockId of toSync) {
    const blockPath = path.join(blocksDir, blockId);
    const result = await syncBlockInternal(conn, blockId, blockPath);
    results.push(result);
    if (result.status === "error" && result.error) {
      errors.push({ blockId, error: result.error });
    }
  }

  return {
    blocksProcessed: results.length,
    blocksSynced: results.filter((r) => r.status === "synced").length,
    blocksUnchanged: results.filter((r) => r.status === "unchanged").length,
    blocksDeleted: results.filter((r) => r.status === "deleted").length,
    errors,
    results,
  };
}

/**
 * Sync a single block to DuckDB.
 *
 * Computes content hash for the block's CSV files and syncs
 * if changes are detected. Used for lazy per-block syncing.
 *
 * @param blockId - Block identifier (folder name)
 * @param baseDir - Base data directory containing block folders
 * @returns Sync result for the block
 */
export async function syncBlock(
  blockId: string,
  baseDir: string
): Promise<BlockSyncResult> {
  const conn = await getConnection(baseDir);
  const blocksDir = getBlocksDir(baseDir);
  const blockPath = path.join(blocksDir, blockId);

  // Check if folder exists
  try {
    await fs.access(blockPath);
  } catch {
    // Block folder doesn't exist - if it was synced before, clean it up
    const existing = await getSyncMetadata(conn, blockId, blocksDir);
    if (existing) {
      await cleanupDeletedBlocks(conn, [blockId], blocksDir);
      return { blockId, status: "deleted" };
    }
    return { blockId, status: "error", error: `Block folder not found: ${blockId}` };
  }

  return syncBlockInternal(conn, blockId, blockPath);
}
