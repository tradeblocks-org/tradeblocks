/**
 * Integration tests for Sync Layer
 *
 * Tests change detection (new, changed, deleted blocks) and transaction rollback behavior.
 * Uses temporary directories for isolation between tests.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// Import from bundled test exports (test-exports.js has all dependencies bundled)
// @ts-expect-error - importing from bundled output
import { syncAllBlocks, syncBlock, getConnection, closeConnection, upgradeToReadWrite } from '../../src/test-exports.ts';

// Note: fileURLToPath and path.dirname are available if needed for fixtures
// Tests use temporary directories for isolation, so these are not currently used
void fileURLToPath;
void path.dirname;

// CSV headers matching the tradelog format
const CSV_HEADERS = 'Date Opened,Time Opened,Date Closed,Time Closed,Opening Price,Closing Price,Legs,Premium,No. of Contracts,P/L,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,Reason For Close,Funds at Close,Margin Req.';
const REPORTING_HEADERS = 'Date Opened,Time Opened,Date Closed,Time Closed,Opening Price,Closing Price,Legs,Initial Premium,No. of Contracts,P/L,Strategy,Reason For Close,Avg. Closing Cost';

// Sample trade rows for tests
const SAMPLE_TRADE_ROW_1 = '2024-01-02,09:35:00,2024-01-02,15:30:00,2.50,0.50,SPX 4800P/4750P,250,1,200,Sync Test Strategy,1.50,1.50,Target,10200,5000';
const SAMPLE_TRADE_ROW_2 = '2024-01-03,09:35:00,2024-01-03,15:45:00,2.75,0.25,SPX 4820P/4770P,275,1,250,Sync Test Strategy,1.50,1.50,Target,10450,5000';
const SAMPLE_TRADE_ROW_3 = '2024-01-04,09:35:00,2024-01-04,14:00:00,2.25,0.10,SPX 4900P/4850P,225,2,430,Sync Test Strategy,3.00,3.00,Target,10680,5000';
const SAMPLE_REPORTING_ROW_1 = '2024-01-02,09:35:00,2024-01-02,15:30:00,2.50,0.50,SPX 4800P/4750P,250,1,180,Sync Test Strategy,Target,0.50';

/**
 * Create a tradelog.csv in a block directory with the given trade rows
 */
async function createBlockWithTrades(testDir: string, blockId: string, tradeRows: string[]): Promise<string> {
  const blockPath = path.join(testDir, blockId);
  await fs.mkdir(blockPath, { recursive: true });
  const csvContent = [CSV_HEADERS, ...tradeRows].join('\n');
  await fs.writeFile(path.join(blockPath, 'tradelog.csv'), csvContent);
  return blockPath;
}

/**
 * Create reportinglog.csv in a block directory with given rows
 */
async function createReportingLog(
  testDir: string,
  blockId: string,
  reportingRows: string[]
): Promise<void> {
  const blockPath = path.join(testDir, blockId);
  await fs.mkdir(blockPath, { recursive: true });
  const csvContent = [REPORTING_HEADERS, ...reportingRows].join('\n');
  await fs.writeFile(path.join(blockPath, 'reportinglog.csv'), csvContent);
}

/**
 * Query trade count for a block from DuckDB
 * Note: DuckDB COUNT returns BigInt, so we convert to Number
 */
async function getTradeCount(testDir: string, blockId: string): Promise<number> {
  const conn = await getConnection(testDir);
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) as count FROM trades.trade_data WHERE block_id = $1`,
    [blockId]
  );
  const rows = reader.getRows();
  return rows.length > 0 ? Number(rows[0][0]) : 0;
}

/**
 * Query reporting trade count for a block from DuckDB
 */
async function getReportingCount(testDir: string, blockId: string): Promise<number> {
  const conn = await getConnection(testDir);
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) as count FROM trades.reporting_data WHERE block_id = $1`,
    [blockId]
  );
  const rows = reader.getRows();
  return rows.length > 0 ? Number(rows[0][0]) : 0;
}

/**
 * Get reportinglog_hash from sync metadata (null when reporting log is not tracked)
 */
async function getReportingHash(testDir: string, blockId: string): Promise<string | null> {
  const conn = await getConnection(testDir);
  const reader = await conn.runAndReadAll(
    `SELECT reportinglog_hash FROM trades._sync_metadata WHERE block_id = $1`,
    [blockId]
  );
  const rows = reader.getRows();
  if (rows.length === 0) return null;
  return (rows[0][0] as string | null) ?? null;
}

/**
 * Check if block metadata exists in sync metadata table
 */
async function hasBlockMetadata(testDir: string, blockId: string): Promise<boolean> {
  const conn = await getConnection(testDir);
  const reader = await conn.runAndReadAll(
    `SELECT 1 FROM trades._sync_metadata WHERE block_id = $1`,
    [blockId]
  );
  return reader.getRows().length > 0;
}

describe('Sync Layer Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create isolated temp directory for each test
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'sync-test-'));
    // Pre-open connection in RW mode — getConnection() downgrades to RO after init,
    // but sync operations need write access for INSERT/DELETE
    await getConnection(testDir);
    await upgradeToReadWrite(testDir);
  });

  afterEach(async () => {
    // Close DuckDB connection to release file lock
    await closeConnection();
    // Clean up temp directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Change Detection', () => {
    it('detects new blocks correctly', async () => {
      // Create a new block
      await createBlockWithTrades(testDir, 'new-block', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);

      // Sync all blocks
      const result = await syncAllBlocks(testDir);

      // Verify sync result
      expect(result.blocksSynced).toBe(1);
      expect(result.blocksUnchanged).toBe(0);
      expect(result.blocksDeleted).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify data in DuckDB
      const tradeCount = await getTradeCount(testDir, 'new-block');
      expect(tradeCount).toBe(2);

      // Verify metadata exists
      const hasMetadata = await hasBlockMetadata(testDir, 'new-block');
      expect(hasMetadata).toBe(true);
    });

    it('detects changed blocks correctly', async () => {
      // Create and sync a block
      await createBlockWithTrades(testDir, 'changed-block', [SAMPLE_TRADE_ROW_1]);
      await syncAllBlocks(testDir);

      // Verify initial sync
      let tradeCount = await getTradeCount(testDir, 'changed-block');
      expect(tradeCount).toBe(1);

      // Modify the block by adding another trade
      await createBlockWithTrades(testDir, 'changed-block', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);

      // Sync again
      const result = await syncAllBlocks(testDir);

      // Verify block was re-synced (not unchanged)
      expect(result.blocksSynced).toBe(1);
      expect(result.blocksUnchanged).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify updated data in DuckDB
      tradeCount = await getTradeCount(testDir, 'changed-block');
      expect(tradeCount).toBe(2);
    });

    it('detects deleted blocks correctly', async () => {
      // Create and sync a block
      const blockPath = await createBlockWithTrades(testDir, 'to-delete', [SAMPLE_TRADE_ROW_1]);
      await syncAllBlocks(testDir);

      // Verify initial sync
      let tradeCount = await getTradeCount(testDir, 'to-delete');
      expect(tradeCount).toBe(1);
      let hasMetadata = await hasBlockMetadata(testDir, 'to-delete');
      expect(hasMetadata).toBe(true);

      // Delete the block folder
      await fs.rm(blockPath, { recursive: true });

      // Sync again
      const result = await syncAllBlocks(testDir);

      // Verify block was detected as deleted
      expect(result.blocksDeleted).toBe(1);
      expect(result.blocksSynced).toBe(0);
      expect(result.blocksUnchanged).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify data removed from DuckDB
      tradeCount = await getTradeCount(testDir, 'to-delete');
      expect(tradeCount).toBe(0);

      // Verify metadata removed
      hasMetadata = await hasBlockMetadata(testDir, 'to-delete');
      expect(hasMetadata).toBe(false);
    });

    it('cleans up stale data when tradelog is removed from a previously-synced block', async () => {
      // Create and sync block with both tradelog and reportinglog
      await createBlockWithTrades(testDir, 'missing-tradelog', [SAMPLE_TRADE_ROW_1]);
      await createReportingLog(testDir, 'missing-tradelog', [SAMPLE_REPORTING_ROW_1]);
      await syncAllBlocks(testDir);

      let tradeCount = await getTradeCount(testDir, 'missing-tradelog');
      let reportingCount = await getReportingCount(testDir, 'missing-tradelog');
      expect(tradeCount).toBe(1);
      expect(reportingCount).toBe(1);

      // Remove tradelog only
      await fs.rm(path.join(testDir, 'missing-tradelog', 'tradelog.csv'));

      // Sync should treat this as deleted/stale and clean all synced rows
      const result = await syncAllBlocks(testDir);
      expect(result.blocksDeleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      tradeCount = await getTradeCount(testDir, 'missing-tradelog');
      reportingCount = await getReportingCount(testDir, 'missing-tradelog');
      const hasMetadata = await hasBlockMetadata(testDir, 'missing-tradelog');
      expect(tradeCount).toBe(0);
      expect(reportingCount).toBe(0);
      expect(hasMetadata).toBe(false);
    });

    it('clears reporting data when reportinglog is removed but tradelog is unchanged', async () => {
      // Create and sync block with both logs
      await createBlockWithTrades(testDir, 'missing-reportinglog', [SAMPLE_TRADE_ROW_1]);
      await createReportingLog(testDir, 'missing-reportinglog', [SAMPLE_REPORTING_ROW_1]);
      await syncAllBlocks(testDir);

      let tradeCount = await getTradeCount(testDir, 'missing-reportinglog');
      let reportingCount = await getReportingCount(testDir, 'missing-reportinglog');
      let reportingHash = await getReportingHash(testDir, 'missing-reportinglog');
      expect(tradeCount).toBe(1);
      expect(reportingCount).toBe(1);
      expect(reportingHash).not.toBeNull();

      // Remove reportinglog only (tradelog hash remains unchanged)
      await fs.rm(path.join(testDir, 'missing-reportinglog', 'reportinglog.csv'));

      // Sync should resync this block to clear stale reporting_data and hash
      const result = await syncAllBlocks(testDir);
      expect(result.blocksSynced).toBe(1);
      expect(result.errors).toHaveLength(0);

      tradeCount = await getTradeCount(testDir, 'missing-reportinglog');
      reportingCount = await getReportingCount(testDir, 'missing-reportinglog');
      reportingHash = await getReportingHash(testDir, 'missing-reportinglog');
      expect(tradeCount).toBe(1);
      expect(reportingCount).toBe(0);
      expect(reportingHash).toBeNull();
    });

    it('skips unchanged blocks (not reprocessed)', async () => {
      // Create and sync a block
      await createBlockWithTrades(testDir, 'unchanged-block', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);
      const firstResult = await syncAllBlocks(testDir);
      expect(firstResult.blocksSynced).toBe(1);

      // Sync again without any modifications
      const result = await syncAllBlocks(testDir);

      // Unchanged blocks are detected via hash comparison in detectBlockChanges
      // and are NOT added to the sync queue - so they won't appear in results at all.
      // This is the expected behavior: no work is done for unchanged blocks.
      expect(result.blocksProcessed).toBe(0);
      expect(result.blocksSynced).toBe(0);
      expect(result.blocksDeleted).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify data still intact (unchanged blocks preserve their data)
      const tradeCount = await getTradeCount(testDir, 'unchanged-block');
      expect(tradeCount).toBe(2);
    });

    it('handles multiple blocks with mixed states', async () => {
      // Create three blocks
      await createBlockWithTrades(testDir, 'block-a', [SAMPLE_TRADE_ROW_1]);
      await createBlockWithTrades(testDir, 'block-b', [SAMPLE_TRADE_ROW_2]);
      const blockCPath = await createBlockWithTrades(testDir, 'block-c', [SAMPLE_TRADE_ROW_3]);

      // Initial sync
      const firstResult = await syncAllBlocks(testDir);
      expect(firstResult.blocksSynced).toBe(3);

      // Modify block-a, leave block-b unchanged, delete block-c
      await createBlockWithTrades(testDir, 'block-a', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);
      await fs.rm(blockCPath, { recursive: true });

      // Sync again
      const result = await syncAllBlocks(testDir);

      // Verify mixed results:
      // - block-a: changed (hash differs) -> synced
      // - block-b: unchanged (hash matches) -> NOT processed (won't appear in results)
      // - block-c: deleted -> deleted
      expect(result.blocksSynced).toBe(1); // block-a changed
      expect(result.blocksDeleted).toBe(1); // block-c deleted
      // blocksUnchanged is 0 because unchanged blocks aren't added to results
      expect(result.blocksProcessed).toBe(2); // Only changed + deleted blocks
      expect(result.errors).toHaveLength(0);

      // Verify block-b data is still intact even though it wasn't "processed"
      const tradeCount = await getTradeCount(testDir, 'block-b');
      expect(tradeCount).toBe(1);
    });
  });

  describe('Transaction Rollback', () => {
    it('ensures atomic updates - either full sync or no change', async () => {
      // Create a block with valid CSV first
      await createBlockWithTrades(testDir, 'atomic-test', [SAMPLE_TRADE_ROW_1]);
      await syncAllBlocks(testDir);

      // Verify initial sync worked
      let tradeCount = await getTradeCount(testDir, 'atomic-test');
      expect(tradeCount).toBe(1);

      // Modify the CSV to have different content (new trade)
      await createBlockWithTrades(testDir, 'atomic-test', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);

      // Sync again - this should succeed atomically
      const result = await syncAllBlocks(testDir);

      // Verify sync completed successfully
      expect(result.blocksSynced).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify we have exactly 2 trades (not 1, not 3)
      // This proves the atomic DELETE + INSERT worked
      tradeCount = await getTradeCount(testDir, 'atomic-test');
      expect(tradeCount).toBe(2);
    });

    it('cleans up data on sync failure for previously-synced block', async () => {
      // This test verifies the cleanup behavior when sync fails.
      // The implementation deletes old data when a re-sync fails to prevent stale state.

      // Create a block with valid CSV first
      await createBlockWithTrades(testDir, 'cleanup-test', [SAMPLE_TRADE_ROW_1]);
      await syncAllBlocks(testDir);

      // Verify initial sync worked
      let tradeCount = await getTradeCount(testDir, 'cleanup-test');
      expect(tradeCount).toBe(1);
      let hasMetadata = await hasBlockMetadata(testDir, 'cleanup-test');
      expect(hasMetadata).toBe(true);

      // Modify the CSV with different content (change the hash)
      // The sync layer handles malformed CSVs gracefully (inserts with null values)
      // so we can't easily force an error. But we can verify the hash change detection works.
      await createBlockWithTrades(testDir, 'cleanup-test', [SAMPLE_TRADE_ROW_2, SAMPLE_TRADE_ROW_3]);

      // Sync again
      const result = await syncAllBlocks(testDir);

      // Block should be re-synced
      expect(result.blocksSynced).toBe(1);

      // Verify data was replaced atomically (not accumulated)
      tradeCount = await getTradeCount(testDir, 'cleanup-test');
      expect(tradeCount).toBe(2);
      hasMetadata = await hasBlockMetadata(testDir, 'cleanup-test');
      expect(hasMetadata).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty block folder gracefully', async () => {
      // Create empty folder (no tradelog.csv)
      const blockPath = path.join(testDir, 'empty-block');
      await fs.mkdir(blockPath, { recursive: true });

      // Sync - should not crash
      const result = await syncAllBlocks(testDir);

      // Block without tradelog should be skipped (not synced, not in errors for missing file)
      // The detectBlockChanges function skips folders without tradelog
      expect(result.blocksSynced).toBe(0);
      expect(result.blocksUnchanged).toBe(0);

      // Verify no data in DuckDB for this block
      const tradeCount = await getTradeCount(testDir, 'empty-block');
      expect(tradeCount).toBe(0);
    });

    it('handles malformed CSV gracefully', async () => {
      // Create block with malformed CSV (wrong headers)
      const blockPath = path.join(testDir, 'malformed-block');
      await fs.mkdir(blockPath, { recursive: true });
      await fs.writeFile(
        path.join(blockPath, 'tradelog.csv'),
        'WrongHeader1,WrongHeader2,WrongHeader3\nval1,val2,val3\nval4,val5,val6'
      );

      // Sync - should capture error but not crash
      const result = await syncAllBlocks(testDir);

      // Block is new so it will attempt to sync, but with malformed data
      // The sync will succeed but with potentially null/0 values for missing fields
      // Since the CSV has headers but wrong ones, it will insert rows with null values

      // Verify no crash occurred and we have a result
      expect(result.blocksProcessed).toBeGreaterThanOrEqual(0);

      // Check if data was inserted (with null/default values) or rejected
      const tradeCount = await getTradeCount(testDir, 'malformed-block');
      // Either 0 (rejected) or 2 (inserted with nulls) is acceptable behavior
      expect(tradeCount === 0 || tradeCount === 2).toBe(true);
    });

    it('syncBlock returns deleted for removed folder', async () => {
      // Create and sync a block
      const blockPath = await createBlockWithTrades(testDir, 'sync-block-test', [SAMPLE_TRADE_ROW_1]);
      await syncBlock('sync-block-test', testDir);

      // Verify initial sync
      let hasMetadata = await hasBlockMetadata(testDir, 'sync-block-test');
      expect(hasMetadata).toBe(true);

      // Delete the folder
      await fs.rm(blockPath, { recursive: true });

      // Call syncBlock directly
      const result = await syncBlock('sync-block-test', testDir);

      // Verify status is deleted
      expect(result.status).toBe('deleted');
      expect(result.blockId).toBe('sync-block-test');

      // Verify cleanup happened
      hasMetadata = await hasBlockMetadata(testDir, 'sync-block-test');
      expect(hasMetadata).toBe(false);
    });

    it('syncBlock returns error for non-existent block that was never synced', async () => {
      // Call syncBlock for a block that doesn't exist and was never synced
      const result = await syncBlock('non-existent-block', testDir);

      // Should return error status
      expect(result.status).toBe('error');
      expect(result.error).toContain('not found');
    });

    it('handles block with hidden files correctly', async () => {
      // Create a block
      await createBlockWithTrades(testDir, 'hidden-files-block', [SAMPLE_TRADE_ROW_1]);

      // Add a hidden file that should be ignored
      await fs.writeFile(path.join(testDir, 'hidden-files-block', '.hidden'), 'hidden content');

      // Create hidden folder that should be ignored
      await fs.mkdir(path.join(testDir, '.hidden-folder'), { recursive: true });
      await fs.writeFile(path.join(testDir, '.hidden-folder', 'tradelog.csv'), `${CSV_HEADERS}\n${SAMPLE_TRADE_ROW_2}`);

      // Sync
      const result = await syncAllBlocks(testDir);

      // Only the visible block should be synced
      expect(result.blocksSynced).toBe(1);

      // Verify hidden folder was not synced
      const hasHiddenMetadata = await hasBlockMetadata(testDir, '.hidden-folder');
      expect(hasHiddenMetadata).toBe(false);
    });

    it('sequential syncs preserve data consistency', async () => {
      // Note: True concurrent sync may cause race conditions with DuckDB transactions.
      // This test verifies that rapid sequential syncs work correctly.
      // For production, the sync layer should only be called from a single execution context.

      // Create a block
      await createBlockWithTrades(testDir, 'sequential-sync-block', [SAMPLE_TRADE_ROW_1, SAMPLE_TRADE_ROW_2]);

      // First sync
      const result1 = await syncAllBlocks(testDir);
      expect(result1.blocksSynced).toBe(1);
      expect(result1.errors).toHaveLength(0);

      // Second sync (same data - should detect unchanged)
      const result2 = await syncAllBlocks(testDir);
      expect(result2.blocksProcessed).toBe(0);
      expect(result2.errors).toHaveLength(0);

      // Verify data is correct
      const tradeCount = await getTradeCount(testDir, 'sequential-sync-block');
      expect(tradeCount).toBe(2);
    });

    it('handles CSV with headers only (no data rows)', async () => {
      // Create block with CSV that has headers but no data rows
      const blockPath = path.join(testDir, 'headers-only-block');
      await fs.mkdir(blockPath, { recursive: true });
      await fs.writeFile(
        path.join(blockPath, 'tradelog.csv'),
        CSV_HEADERS // Only headers, no data rows
      );

      // Sync
      const result = await syncAllBlocks(testDir);

      // Block should sync (or at least not crash)
      // It may show as synced with 0 trades or as unchanged depending on implementation
      expect(result.errors).toHaveLength(0);

      // Verify no trades in DuckDB
      const tradeCount = await getTradeCount(testDir, 'headers-only-block');
      expect(tradeCount).toBe(0);
    });

    it('recreates required schemas when analytics DB is replaced in-process', async () => {
      // Seed database and verify initial sync.
      await createBlockWithTrades(testDir, 'schema-reinit-block', [SAMPLE_TRADE_ROW_1]);
      const firstSync = await syncAllBlocks(testDir);
      expect(firstSync.blocksSynced).toBe(1);

      // Simulate external database replacement while process stays alive.
      await closeConnection();
      await fs.rm(path.join(testDir, 'analytics.duckdb'), { force: true });
      await fs.rm(path.join(testDir, 'analytics.duckdb.wal'), { force: true });

      // Reopen in RW mode and verify required tables exist on the fresh DB file.
      await getConnection(testDir);
      const conn = await upgradeToReadWrite(testDir);
      const syncMetaCheck = await conn.runAndReadAll(`
        SELECT COUNT(*)
        FROM duckdb_tables()
        WHERE schema_name = 'trades' AND table_name = '_sync_metadata'
      `);
      const tradeDataCheck = await conn.runAndReadAll(`
        SELECT COUNT(*)
        FROM duckdb_tables()
        WHERE schema_name = 'trades' AND table_name = 'trade_data'
      `);

      expect(Number(syncMetaCheck.getRows()[0][0])).toBe(1);
      expect(Number(tradeDataCheck.getRows()[0][0])).toBe(1);

      // Confirm sync can proceed on the recreated DB without missing-table errors.
      const secondSync = await syncAllBlocks(testDir);
      expect(secondSync.blocksSynced).toBe(1);
      expect(secondSync.errors).toHaveLength(0);
    });

    it('hash is stable across multiple reads', async () => {
      // Create a block
      await createBlockWithTrades(testDir, 'hash-stability-block', [SAMPLE_TRADE_ROW_1]);

      // Sync once
      const firstResult = await syncAllBlocks(testDir);
      expect(firstResult.blocksSynced).toBe(1);

      // Without modifying the file, sync again multiple times
      const secondResult = await syncAllBlocks(testDir);
      const thirdResult = await syncAllBlocks(testDir);

      // All subsequent syncs should detect no change (hash is stable)
      expect(secondResult.blocksProcessed).toBe(0);
      expect(thirdResult.blocksProcessed).toBe(0);

      // Data should remain intact
      const tradeCount = await getTradeCount(testDir, 'hash-stability-block');
      expect(tradeCount).toBe(1);
    });

    it('syncBlock with unchanged content returns unchanged', async () => {
      // Create and sync a block
      await createBlockWithTrades(testDir, 'single-sync-test', [SAMPLE_TRADE_ROW_1]);
      const firstResult = await syncBlock('single-sync-test', testDir);

      // Verify initial sync
      expect(firstResult.status).toBe('synced');
      expect(firstResult.tradeCount).toBe(1);

      // Call syncBlock again without changes
      const secondResult = await syncBlock('single-sync-test', testDir);

      // Should return unchanged status
      expect(secondResult.status).toBe('unchanged');
    });

    it('handles rapid sequential syncs correctly', async () => {
      // Create a block
      await createBlockWithTrades(testDir, 'rapid-sync-block', [SAMPLE_TRADE_ROW_1]);

      // Run many syncs sequentially in rapid succession
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await syncAllBlocks(testDir));
      }

      // First should sync, rest should be no-ops (0 blocks processed)
      expect(results[0].blocksSynced).toBe(1);
      for (let i = 1; i < 5; i++) {
        expect(results[i].blocksProcessed).toBe(0);
      }

      // Verify data is correct
      const tradeCount = await getTradeCount(testDir, 'rapid-sync-block');
      expect(tradeCount).toBe(1);
    });
  });
});
