/**
 * Integration tests for DuckDB-to-JSON metadata migration
 *
 * Tests the one-time migration of profiles, sync metadata, market import metadata,
 * and flat import log from DuckDB tables to JSON files.
 *
 * Covers: migration of each store, idempotency, empty-table skip,
 * env-var gating, and timestamp preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import {
  migrateMetadataToJson,
  readJsonFile,
  getProfileJson,
  getSyncMetadataJson,
  getMarketImportMetadataJson,
  getFlatImportLogJson,
  listProfilesJson,
  getAllSyncedBlockIdsJson,
} from "../../src/test-exports.ts";

describe("json-migration", () => {
  let tmpDir: string;
  let blocksDir: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `json-migration-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    blocksDir = join(tmpDir, "blocks");
    mkdirSync(blocksDir, { recursive: true });

    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();

    // Create required schemas and tables (mimics connection.ts startup)
    await conn.run("CREATE SCHEMA IF NOT EXISTS trades");
    await conn.run("CREATE SCHEMA IF NOT EXISTS profiles");
    await conn.run("ATTACH ':memory:' AS market");

    // trades._sync_metadata
    await conn.run(`
      CREATE TABLE IF NOT EXISTS trades._sync_metadata (
        block_id VARCHAR NOT NULL PRIMARY KEY,
        tradelog_hash VARCHAR NOT NULL,
        dailylog_hash VARCHAR,
        reportinglog_hash VARCHAR,
        synced_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        sync_version INTEGER NOT NULL DEFAULT 1
      )
    `);

    // profiles.strategy_profiles
    await conn.run(`
      CREATE TABLE IF NOT EXISTS profiles.strategy_profiles (
        block_id VARCHAR NOT NULL,
        strategy_name VARCHAR NOT NULL,
        structure_type VARCHAR NOT NULL,
        greeks_bias VARCHAR NOT NULL,
        thesis TEXT NOT NULL DEFAULT '',
        legs JSON,
        entry_filters JSON,
        exit_rules JSON,
        expected_regimes JSON,
        key_metrics JSON,
        position_sizing JSON,
        underlying VARCHAR,
        re_entry BOOLEAN,
        cap_profits BOOLEAN,
        cap_losses BOOLEAN,
        require_two_prices_pt BOOLEAN,
        close_on_completion BOOLEAN,
        ignore_margin_req BOOLEAN,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (block_id, strategy_name)
      )
    `);

    // market._sync_metadata
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market._sync_metadata (
        source VARCHAR NOT NULL,
        ticker VARCHAR NOT NULL,
        target_table VARCHAR NOT NULL,
        max_date VARCHAR,
        synced_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        PRIMARY KEY (source, ticker, target_table)
      )
    `);

    // market.flat_import_log
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.flat_import_log (
        date VARCHAR NOT NULL,
        asset_class VARCHAR NOT NULL,
        underlying VARCHAR NOT NULL,
        imported_at VARCHAR NOT NULL,
        bar_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, asset_class, underlying)
      )
    `);

    process.env.TRADEBLOCKS_PARQUET = "true";
  });

  afterEach(() => {
    delete process.env.TRADEBLOCKS_PARQUET;
    try {
      conn.closeSync();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates profiles from DuckDB to JSON", async () => {
    // Insert 2 profiles
    await conn.run(`
      INSERT INTO profiles.strategy_profiles
        (block_id, strategy_name, structure_type, greeks_bias, thesis, legs, entry_filters, exit_rules, expected_regimes, key_metrics)
      VALUES
        ('block-a', 'Iron Condor', 'iron_condor', 'neutral', 'Sell premium', '[]', '[]', '[]', '["low"]', '{}'),
        ('block-b', 'Put Spread', 'vertical', 'bearish', 'Directional bet', '[]', '[]', '[]', '["high"]', '{}')
    `);

    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(true);
    expect(result.profiles).toBe(2);

    // Verify JSON files exist and are readable
    const profileA = await getProfileJson("block-a", "Iron Condor", blocksDir);
    expect(profileA).not.toBeNull();
    expect(profileA!.blockId).toBe("block-a");
    expect(profileA!.strategyName).toBe("Iron Condor");
    expect(profileA!.structureType).toBe("iron_condor");

    const profileB = await getProfileJson("block-b", "Put Spread", blocksDir);
    expect(profileB).not.toBeNull();
    expect(profileB!.blockId).toBe("block-b");
    expect(profileB!.greeksBias).toBe("bearish");
  });

  it("migrates sync metadata from DuckDB to JSON", async () => {
    // Insert sync metadata for 2 blocks
    await conn.run(`
      INSERT INTO trades._sync_metadata
        (block_id, tradelog_hash, dailylog_hash, reportinglog_hash, synced_at, sync_version)
      VALUES
        ('block-1', 'hash-a', 'hash-b', NULL, '2025-06-01 12:00:00', 1),
        ('block-2', 'hash-c', NULL, NULL, '2025-06-02 14:00:00', 2)
    `);

    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(true);
    expect(result.syncMeta).toBe(2);

    // Verify .sync-meta.json files
    const meta1 = await getSyncMetadataJson("block-1", blocksDir);
    expect(meta1).not.toBeNull();
    expect(meta1!.block_id).toBe("block-1");
    expect(meta1!.tradelog_hash).toBe("hash-a");
    expect(meta1!.dailylog_hash).toBe("hash-b");
    expect(meta1!.sync_version).toBe(1);

    const meta2 = await getSyncMetadataJson("block-2", blocksDir);
    expect(meta2).not.toBeNull();
    expect(meta2!.tradelog_hash).toBe("hash-c");
    expect(meta2!.dailylog_hash).toBeNull();
  });

  it("migrates market import metadata from DuckDB to JSON", async () => {
    // Insert 3 market metadata entries
    await conn.run(`
      INSERT INTO market._sync_metadata
        (source, ticker, target_table, max_date, synced_at)
      VALUES
        ('csv:/data/spy.csv', 'SPY', 'daily', '2025-06-01', '2025-06-01 10:00:00'),
        ('csv:/data/spx.csv', 'SPX', 'daily', '2025-06-01', '2025-06-01 11:00:00'),
        ('csv:/data/vix.csv', 'VIX', 'date_context', '2025-06-01', '2025-06-01 12:00:00')
    `);

    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(true);
    expect(result.marketMeta).toBe(3);

    // Verify aggregate JSON file
    const meta1 = await getMarketImportMetadataJson("csv:/data/spy.csv", "SPY", "daily", tmpDir);
    expect(meta1).not.toBeNull();
    expect(meta1!.max_date).toBe("2025-06-01");

    const meta2 = await getMarketImportMetadataJson("csv:/data/spx.csv", "SPX", "daily", tmpDir);
    expect(meta2).not.toBeNull();
    expect(meta2!.ticker).toBe("SPX");

    const meta3 = await getMarketImportMetadataJson(
      "csv:/data/vix.csv",
      "VIX",
      "date_context",
      tmpDir,
    );
    expect(meta3).not.toBeNull();
    expect(meta3!.target_table).toBe("date_context");
  });

  it("migrates flat import log from DuckDB to JSON", async () => {
    // Insert 5 flat import log entries
    const entries = [
      ["2025-01-06", "options", "SPY", "2025-06-01T10:00:00Z", 5000],
      ["2025-01-07", "options", "SPY", "2025-06-01T10:05:00Z", 4800],
      ["2025-01-08", "options", "SPY", "2025-06-01T10:10:00Z", 5200],
      ["2025-01-06", "options", "QQQ", "2025-06-01T11:00:00Z", 3000],
      ["2025-01-07", "options", "QQQ", "2025-06-01T11:05:00Z", 3100],
    ];
    for (const [date, assetClass, underlying, importedAt, barCount] of entries) {
      await conn.run(`
        INSERT INTO market.flat_import_log (date, asset_class, underlying, imported_at, bar_count)
        VALUES ('${date}', '${assetClass}', '${underlying}', '${importedAt}', ${barCount})
      `);
    }

    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(true);
    expect(result.flatLog).toBe(5);

    // Verify flat import log JSON
    const importedDates = await getFlatImportLogJson(
      "options",
      "SPY",
      "2025-01-06",
      "2025-01-08",
      tmpDir,
    );
    expect(importedDates.size).toBe(3);
    expect(importedDates.has("2025-01-06")).toBe(true);
    expect(importedDates.has("2025-01-07")).toBe(true);
    expect(importedDates.has("2025-01-08")).toBe(true);

    const qqqDates = await getFlatImportLogJson(
      "options",
      "QQQ",
      "2025-01-06",
      "2025-01-07",
      tmpDir,
    );
    expect(qqqDates.size).toBe(2);
  });

  it("idempotent: skips when JSON already exists", async () => {
    // Insert profile data
    await conn.run(`
      INSERT INTO profiles.strategy_profiles
        (block_id, strategy_name, structure_type, greeks_bias, legs, entry_filters, exit_rules, expected_regimes, key_metrics)
      VALUES ('block-x', 'Test Strategy', 'vertical', 'neutral', '[]', '[]', '[]', '[]', '{}')
    `);

    // Insert sync metadata
    await conn.run(`
      INSERT INTO trades._sync_metadata (block_id, tradelog_hash) VALUES ('block-x', 'hash-1')
    `);

    // Insert market metadata
    await conn.run(`
      INSERT INTO market._sync_metadata (source, ticker, target_table) VALUES ('src', 'SPY', 'daily')
    `);

    // Insert flat import log
    await conn.run(`
      INSERT INTO market.flat_import_log (date, asset_class, underlying, imported_at, bar_count)
      VALUES ('2025-01-01', 'options', 'SPY', '2025-06-01T00:00:00Z', 100)
    `);

    // First run -- should migrate
    const first = await migrateMetadataToJson(conn, tmpDir, blocksDir);
    expect(first.migrated).toBe(true);
    expect(first.profiles).toBe(1);
    expect(first.syncMeta).toBe(1);
    expect(first.marketMeta).toBe(1);
    expect(first.flatLog).toBe(1);

    // Second run -- should skip all (JSON files already exist)
    const second = await migrateMetadataToJson(conn, tmpDir, blocksDir);
    expect(second.migrated).toBe(false);
    expect(second.profiles).toBe(0);
    expect(second.syncMeta).toBe(0);
    expect(second.marketMeta).toBe(0);
    expect(second.flatLog).toBe(0);
  });

  it("skips when DuckDB tables are empty", async () => {
    // Tables exist but are empty (created in beforeEach)
    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(false);
    expect(result.profiles).toBe(0);
    expect(result.syncMeta).toBe(0);
    expect(result.marketMeta).toBe(0);
    expect(result.flatLog).toBe(0);

    // Verify no JSON files were created
    const profiles = await listProfilesJson(blocksDir);
    expect(profiles).toEqual([]);

    const syncIds = await getAllSyncedBlockIdsJson(blocksDir);
    expect(syncIds).toEqual([]);

    const marketMeta = await readJsonFile(join(tmpDir, "market-meta", "sync-metadata.json"));
    expect(marketMeta).toBeNull();

    const flatLog = await readJsonFile(join(tmpDir, "market-meta", "flat-import-log.json"));
    expect(flatLog).toBeNull();
  });

  it("skips when TRADEBLOCKS_PARQUET is not set", async () => {
    delete process.env.TRADEBLOCKS_PARQUET;

    // Insert data that would normally be migrated
    await conn.run(`
      INSERT INTO profiles.strategy_profiles
        (block_id, strategy_name, structure_type, greeks_bias, legs, entry_filters, exit_rules, expected_regimes, key_metrics)
      VALUES ('block-z', 'Skip Test', 'vertical', 'neutral', '[]', '[]', '[]', '[]', '{}')
    `);

    const result = await migrateMetadataToJson(conn, tmpDir, blocksDir);

    expect(result.migrated).toBe(false);
    expect(result.profiles).toBe(0);

    // Verify no JSON files were created
    const profiles = await listProfilesJson(blocksDir);
    expect(profiles).toEqual([]);
  });

  it("preserves original timestamps during profile migration", async () => {
    const createdAt = "2024-03-15 09:30:00";
    const updatedAt = "2025-01-20 14:45:00";

    await conn.run(`
      INSERT INTO profiles.strategy_profiles
        (block_id, strategy_name, structure_type, greeks_bias, thesis,
         legs, entry_filters, exit_rules, expected_regimes, key_metrics,
         created_at, updated_at)
      VALUES
        ('block-ts', 'Timestamp Test', 'iron_condor', 'neutral', 'Test timestamps',
         '[]', '[]', '[]', '[]', '{}',
         TIMESTAMP '${createdAt}', TIMESTAMP '${updatedAt}')
    `);

    await migrateMetadataToJson(conn, tmpDir, blocksDir);

    // Read the JSON file directly to check stored timestamps
    const profile = await getProfileJson("block-ts", "Timestamp Test", blocksDir);
    expect(profile).not.toBeNull();

    // The createdAt and updatedAt should be close to the originals
    // DuckDB may add timezone info, so we compare the date portions
    const createdDate = profile!.createdAt;
    const updatedDate = profile!.updatedAt;

    expect(createdDate.getFullYear()).toBe(2024);
    expect(createdDate.getMonth()).toBe(2); // March = 2
    expect(createdDate.getDate()).toBe(15);

    expect(updatedDate.getFullYear()).toBe(2025);
    expect(updatedDate.getMonth()).toBe(0); // January = 0
    expect(updatedDate.getDate()).toBe(20);
  });
});
