/**
 * Unit tests for json-adapters.ts
 *
 * Tests four metadata store JSON adapters:
 * 1. Profile adapter (upsert, get, list, delete)
 * 2. Sync metadata adapter (get, upsert, delete, getAllSyncedBlockIds)
 * 3. Market import metadata adapter (get, upsert)
 * 4. Flat import log adapter (get, upsert)
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

import {
  // Profile adapter
  upsertProfileJson,
  getProfileJson,
  listProfilesJson,
  deleteProfileJson,
  // Sync metadata adapter
  getSyncMetadataJson,
  upsertSyncMetadataJson,
  deleteSyncMetadataJson,
  getAllSyncedBlockIdsJson,
  // Market import metadata adapter
  getMarketImportMetadataJson,
  upsertMarketImportMetadataJson,
  // Flat import log adapter
  getFlatImportLogJson,
  upsertFlatImportLogJson,
} from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(label: string): string {
  return path.join(
    os.tmpdir(),
    `json-adapters-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

// ---------------------------------------------------------------------------
// Profile Adapter Tests
// ---------------------------------------------------------------------------

describe("Profile adapter", () => {
  let blocksDir: string;

  beforeEach(async () => {
    blocksDir = makeTmpDir("profiles");
    await fs.mkdir(blocksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(blocksDir, { recursive: true, force: true });
  });

  const baseProfile = {
    blockId: "block-123",
    strategyName: "Iron Condor #1",
    structureType: "iron_condor",
    greeksBias: "theta_positive",
    thesis: "Sell premium in low-vol environments",
    legs: [{ type: "short_put", strike: "5-delta", expiry: "45-DTE", quantity: -1 }],
    entryFilters: [{ field: "VIX_Close", operator: "<", value: 20 }],
    exitRules: [{ type: "stop_loss", trigger: "200% of credit" }],
    expectedRegimes: ["low_vol"],
    keyMetrics: { expectedWinRate: 0.85 },
    underlying: "SPX",
  };

  it("writes profile JSON to {blocksDir}/{blockId}/profiles/{slug}.json", async () => {
    const result = await upsertProfileJson(baseProfile, blocksDir);

    const filePath = path.join(blocksDir, "block-123", "profiles", "iron-condor-1.json");
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    expect(result.strategyName).toBe("Iron Condor #1");
    expect(result.blockId).toBe("block-123");
  });

  it("preserves existing createdAt if file exists; sets new updatedAt", async () => {
    const first = await upsertProfileJson(baseProfile, blocksDir);
    const firstCreatedAt = first.createdAt;

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const second = await upsertProfileJson(baseProfile, blocksDir);
    expect(second.createdAt.getTime()).toBe(firstCreatedAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("stores dates as ISO strings in JSON; returns StrategyProfile with Date objects", async () => {
    const result = await upsertProfileJson(baseProfile, blocksDir);

    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);

    // Read raw JSON to verify ISO strings
    const filePath = path.join(blocksDir, "block-123", "profiles", "iron-condor-1.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(typeof raw.createdAt).toBe("string");
    expect(typeof raw.updatedAt).toBe("string");
    // Should be valid ISO date strings
    expect(new Date(raw.createdAt).toISOString()).toBe(raw.createdAt);
  });

  it("getProfileJson reads and returns StrategyProfile with Date objects, or null if not found", async () => {
    // Not found
    const notFound = await getProfileJson("block-123", "Iron Condor #1", blocksDir);
    expect(notFound).toBeNull();

    // Found
    await upsertProfileJson(baseProfile, blocksDir);
    const found = await getProfileJson("block-123", "Iron Condor #1", blocksDir);
    expect(found).not.toBeNull();
    expect(found!.strategyName).toBe("Iron Condor #1");
    expect(found!.createdAt).toBeInstanceOf(Date);
    expect(found!.updatedAt).toBeInstanceOf(Date);
  });

  it("listProfilesJson(blocksDir, blockId) returns all profiles for a block", async () => {
    await upsertProfileJson(baseProfile, blocksDir);
    await upsertProfileJson({ ...baseProfile, strategyName: "Pickle RIC v2" }, blocksDir);

    const profiles = await listProfilesJson(blocksDir, "block-123");
    expect(profiles).toHaveLength(2);
    const names = profiles.map((p) => p.strategyName).sort();
    expect(names).toEqual(["Iron Condor #1", "Pickle RIC v2"]);
  });

  it("listProfilesJson(blocksDir) without blockId scans all block directories", async () => {
    await upsertProfileJson(baseProfile, blocksDir);
    await upsertProfileJson(
      { ...baseProfile, blockId: "block-456", strategyName: "Calendar Spread" },
      blocksDir,
    );

    const profiles = await listProfilesJson(blocksDir);
    expect(profiles).toHaveLength(2);
    const blockIds = profiles.map((p) => p.blockId).sort();
    expect(blockIds).toEqual(["block-123", "block-456"]);
  });

  it("deleteProfileJson deletes the file and returns true, or false if not found", async () => {
    await upsertProfileJson(baseProfile, blocksDir);

    const deleted = await deleteProfileJson("block-123", "Iron Condor #1", blocksDir);
    expect(deleted).toBe(true);

    const deletedAgain = await deleteProfileJson("block-123", "Iron Condor #1", blocksDir);
    expect(deletedAgain).toBe(false);

    const notFound = await getProfileJson("block-123", "Iron Condor #1", blocksDir);
    expect(notFound).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync Metadata Adapter Tests
// ---------------------------------------------------------------------------

describe("Sync metadata adapter", () => {
  let blocksDir: string;

  beforeEach(async () => {
    blocksDir = makeTmpDir("sync");
    await fs.mkdir(blocksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(blocksDir, { recursive: true, force: true });
  });

  const baseMeta = {
    block_id: "block-abc",
    tradelog_hash: "hash123",
    dailylog_hash: "hash456",
    reportinglog_hash: null,
    synced_at: new Date("2025-06-15T10:30:00Z"),
    sync_version: 1,
  };

  it("getSyncMetadataJson reads {blocksDir}/{blockId}/.sync-meta.json, returns with synced_at as Date", async () => {
    // Not found
    const notFound = await getSyncMetadataJson("block-abc", blocksDir);
    expect(notFound).toBeNull();

    // Write then read
    await upsertSyncMetadataJson(baseMeta, blocksDir);
    const found = await getSyncMetadataJson("block-abc", blocksDir);
    expect(found).not.toBeNull();
    expect(found!.block_id).toBe("block-abc");
    expect(found!.tradelog_hash).toBe("hash123");
    expect(found!.synced_at).toBeInstanceOf(Date);
    expect(found!.synced_at.toISOString()).toBe("2025-06-15T10:30:00.000Z");
  });

  it("upsertSyncMetadataJson writes to .sync-meta.json with synced_at as ISO string", async () => {
    await upsertSyncMetadataJson(baseMeta, blocksDir);

    const filePath = path.join(blocksDir, "block-abc", ".sync-meta.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(typeof raw.synced_at).toBe("string");
    expect(raw.synced_at).toBe("2025-06-15T10:30:00.000Z");
  });

  it("deleteSyncMetadataJson deletes .sync-meta.json for a block", async () => {
    await upsertSyncMetadataJson(baseMeta, blocksDir);

    const deleted = await deleteSyncMetadataJson("block-abc", blocksDir);
    expect(deleted).toBe(true);

    const deletedAgain = await deleteSyncMetadataJson("block-abc", blocksDir);
    expect(deletedAgain).toBe(false);
  });

  it("getAllSyncedBlockIdsJson scans blocksDir for directories containing .sync-meta.json", async () => {
    await upsertSyncMetadataJson(baseMeta, blocksDir);
    await upsertSyncMetadataJson({ ...baseMeta, block_id: "block-def" }, blocksDir);
    // Create a directory without .sync-meta.json
    await fs.mkdir(path.join(blocksDir, "block-no-sync"), { recursive: true });

    const ids = await getAllSyncedBlockIdsJson(blocksDir);
    expect(ids.sort()).toEqual(["block-abc", "block-def"]);
  });
});

// ---------------------------------------------------------------------------
// Market Import Metadata Adapter Tests
// ---------------------------------------------------------------------------

describe("Market import metadata adapter", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir("market-meta");
    await fs.mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const baseMeta = {
    source: "import_market_csv:/path/to/spx.csv",
    ticker: "SPX",
    target_table: "daily",
    max_date: "2025-06-15",
    synced_at: new Date("2025-06-15T12:00:00Z"),
  };

  it("getMarketImportMetadataJson reads entry from market-meta/sync-metadata.json by composite key", async () => {
    // Not found
    const notFound = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "SPX",
      "daily",
      dataDir,
    );
    expect(notFound).toBeNull();

    // Write then read
    await upsertMarketImportMetadataJson(baseMeta, dataDir);
    const found = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "SPX",
      "daily",
      dataDir,
    );
    expect(found).not.toBeNull();
    expect(found!.ticker).toBe("SPX");
    expect(found!.max_date).toBe("2025-06-15");
    expect(found!.synced_at).toBeInstanceOf(Date);
  });

  it("upsertMarketImportMetadataJson creates/updates entry in aggregate file, preserving other entries", async () => {
    await upsertMarketImportMetadataJson(baseMeta, dataDir);
    await upsertMarketImportMetadataJson(
      {
        ...baseMeta,
        ticker: "QQQ",
        max_date: "2025-06-14",
      },
      dataDir,
    );

    // Both should be readable
    const spx = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "SPX",
      "daily",
      dataDir,
    );
    const qqq = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "QQQ",
      "daily",
      dataDir,
    );
    expect(spx).not.toBeNull();
    expect(qqq).not.toBeNull();
    expect(qqq!.max_date).toBe("2025-06-14");

    // Update SPX
    await upsertMarketImportMetadataJson({ ...baseMeta, max_date: "2025-06-20" }, dataDir);
    const updated = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "SPX",
      "daily",
      dataDir,
    );
    expect(updated!.max_date).toBe("2025-06-20");

    // QQQ should be preserved
    const qqqStill = await getMarketImportMetadataJson(
      "import_market_csv:/path/to/spx.csv",
      "QQQ",
      "daily",
      dataDir,
    );
    expect(qqqStill).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flat Import Log Adapter Tests
// ---------------------------------------------------------------------------

describe("Flat import log adapter", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir("flat-log");
    await fs.mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("getFlatImportLogJson reads entries filtered by asset_class, underlying, and date range", async () => {
    // Empty initially
    const empty = await getFlatImportLogJson("option", "SPX", "2025-06-01", "2025-06-30", dataDir);
    expect(empty.size).toBe(0);

    // Add entries
    await upsertFlatImportLogJson(
      {
        date: "2025-06-10",
        asset_class: "option",
        underlying: "SPX",
        imported_at: new Date().toISOString(),
        bar_count: 1000,
      },
      dataDir,
    );
    await upsertFlatImportLogJson(
      {
        date: "2025-06-15",
        asset_class: "option",
        underlying: "SPX",
        imported_at: new Date().toISOString(),
        bar_count: 1200,
      },
      dataDir,
    );
    await upsertFlatImportLogJson(
      {
        date: "2025-06-20",
        asset_class: "option",
        underlying: "QQQ",
        imported_at: new Date().toISOString(),
        bar_count: 800,
      },
      dataDir,
    );

    // Filter by SPX in date range
    const spxDates = await getFlatImportLogJson(
      "option",
      "SPX",
      "2025-06-01",
      "2025-06-30",
      dataDir,
    );
    expect(spxDates.size).toBe(2);
    expect(spxDates.has("2025-06-10")).toBe(true);
    expect(spxDates.has("2025-06-15")).toBe(true);

    // Filter by QQQ
    const qqqDates = await getFlatImportLogJson(
      "option",
      "QQQ",
      "2025-06-01",
      "2025-06-30",
      dataDir,
    );
    expect(qqqDates.size).toBe(1);
    expect(qqqDates.has("2025-06-20")).toBe(true);

    // Filter out of range
    const outOfRange = await getFlatImportLogJson(
      "option",
      "SPX",
      "2025-07-01",
      "2025-07-31",
      dataDir,
    );
    expect(outOfRange.size).toBe(0);
  });

  it("upsertFlatImportLogJson creates/updates entry by composite key (date, asset_class, underlying)", async () => {
    await upsertFlatImportLogJson(
      {
        date: "2025-06-10",
        asset_class: "option",
        underlying: "SPX",
        imported_at: "2025-06-10T12:00:00Z",
        bar_count: 1000,
      },
      dataDir,
    );

    // Update same entry
    await upsertFlatImportLogJson(
      {
        date: "2025-06-10",
        asset_class: "option",
        underlying: "SPX",
        imported_at: "2025-06-10T14:00:00Z",
        bar_count: 1500,
      },
      dataDir,
    );

    // Verify the update (get should still return 1 date)
    const dates = await getFlatImportLogJson("option", "SPX", "2025-06-01", "2025-06-30", dataDir);
    expect(dates.size).toBe(1);
  });
});
