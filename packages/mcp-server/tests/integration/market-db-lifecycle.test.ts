/**
 * Integration tests for Market DB Lifecycle
 *
 * Verifies the dual-DB connection lifecycle introduced in Phase 60:
 *   - market.duckdb created on first getConnection()
 *   - Canonical v3.0 market tables (spot, enriched, enriched_context,
 *     _sync_metadata) created post Phase 6 Wave D
 *   - Primary key constraints enforced
 *   - DETACH on close + re-ATTACH on reconnect preserves data
 *   - Legacy market schema in analytics.duckdb dropped before ATTACH
 *   - MARKET_DB_PATH env var overrides default path
 */
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { DuckDBInstance } from "@duckdb/node-api";

// @ts-expect-error - importing from bundled output
import { getConnection, closeConnection, upgradeToReadWrite, downgradeToReadOnly, getConnectionMode } from "../../src/test-exports.ts";

describe("Market DB Lifecycle", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "market-lifecycle-"));
  });

  afterEach(async () => {
    // Always close connection and clean up env var
    delete process.env.MARKET_DB_PATH;
    await closeConnection();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("creates market.duckdb file on first connection", async () => {
    await getConnection(testDir);

    const marketDbPath = path.join(testDir, "market.duckdb");
    // fs.access throws if file does not exist
    await expect(fs.access(marketDbPath)).resolves.toBeUndefined();
  });

  it("creates all canonical market tables on first connection", async () => {
    const conn = await getConnection(testDir);

    // Verify v3.0 canonical tables exist and are queryable (RO connection can read)
    // Post Phase 6 Wave D: spot / enriched / enriched_context + _sync_metadata are
    // the physical fallback surface. option_chain / option_quote_minutes are
    // Parquet-view-only (no physical fallback).
    const tables = [
      "market.spot",
      "market.enriched",
      "market.enriched_context",
      "market._sync_metadata",
    ];
    for (const table of tables) {
      // runAndReadAll throws if table doesn't exist
      await expect(
        conn.runAndReadAll(`SELECT COUNT(*) FROM ${table} WHERE 1=0`)
      ).resolves.toBeDefined();
    }

    // Upgrade to RW to verify market.spot is writable (basic INSERT)
    const rwConn = await upgradeToReadWrite(testDir);
    await rwConn.run(
      `INSERT INTO market.spot (ticker, date, time, open) VALUES ('SPX', '2025-01-01', '09:30', 100.0)`
    );
    const result = await rwConn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot WHERE ticker = 'SPX'`
    );
    expect(Number(result.getRows()[0][0])).toBe(1);
  });

  it("market tables have correct primary key constraints", async () => {
    await getConnection(testDir);
    const conn = await upgradeToReadWrite(testDir);

    // market.spot: PK (ticker, date, time)
    await conn.run(
      `INSERT INTO market.spot (ticker, date, time) VALUES ('SPX', '2025-01-02', '09:30')`
    );
    await expect(
      conn.run(
        `INSERT INTO market.spot (ticker, date, time) VALUES ('SPX', '2025-01-02', '09:30')`
      )
    ).rejects.toThrow();

    // market.enriched: PK (ticker, date)
    await conn.run(`INSERT INTO market.enriched (ticker, date) VALUES ('SPX', '2025-01-02')`);
    await expect(
      conn.run(`INSERT INTO market.enriched (ticker, date) VALUES ('SPX', '2025-01-02')`)
    ).rejects.toThrow();

    // market.enriched_context: PK (date)
    await conn.run(`INSERT INTO market.enriched_context (date) VALUES ('2025-01-02')`);
    await expect(
      conn.run(`INSERT INTO market.enriched_context (date) VALUES ('2025-01-02')`)
    ).rejects.toThrow();

    // market._sync_metadata: PK (source, ticker, target_table)
    await conn.run(
      `INSERT INTO market._sync_metadata (source, ticker, target_table, synced_at) VALUES ('test-source', 'SPX', 'enriched', NOW())`
    );
    await expect(
      conn.run(
        `INSERT INTO market._sync_metadata (source, ticker, target_table, synced_at) VALUES ('test-source', 'SPX', 'enriched', NOW())`
      )
    ).rejects.toThrow();
  });

  it("DETACHes on close and re-ATTACHes on reconnect preserving data", async () => {
    // First connection: upgrade to RW and insert data
    await getConnection(testDir);
    const conn1 = await upgradeToReadWrite(testDir);
    await conn1.run(
      `INSERT INTO market.spot (ticker, date, time, open) VALUES ('SPX', '2025-01-02', '09:30', 200.0)`
    );

    // Close triggers DETACH
    await closeConnection();

    // Second connection: re-ATTACH happens in getConnection (returns RO)
    const conn2 = await getConnection(testDir);

    // Verify data persisted across close/reopen cycle (readable in RO mode)
    const result = await conn2.runAndReadAll(
      `SELECT open FROM market.spot WHERE ticker = 'SPX' AND date = '2025-01-02' AND time = '09:30'`
    );
    const rows = result.getRows();
    expect(rows.length).toBe(1);
    expect(Number(rows[0][0])).toBe(200.0);
  });

  it("drops legacy market schema from analytics.duckdb on connection", async () => {
    // Simulate pre-Phase-60 state: analytics.duckdb has inline market schema
    const analyticsDbPath = path.join(testDir, "analytics.duckdb");
    const rawInst = await DuckDBInstance.create(analyticsDbPath);
    const rawConn = await rawInst.connect();
    await rawConn.run("CREATE SCHEMA IF NOT EXISTS market");
    await rawConn.run(
      "CREATE TABLE market.spx_daily (date VARCHAR PRIMARY KEY, close DOUBLE)"
    );
    rawConn.closeSync();

    // Now call getConnection — it should drop the old schema and ATTACH market.duckdb
    const conn = await getConnection(testDir);

    // New table from market.duckdb should exist and be queryable
    await expect(
      conn.runAndReadAll(`SELECT * FROM market.spot WHERE 1=0`)
    ).resolves.toBeDefined();

    // Old inline table should be gone: query duckdb_tables() for market schema
    // tables that are NOT in the market.duckdb catalog — should be zero
    const legacyResult = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM duckdb_tables() WHERE database_name != 'market' AND schema_name = 'market'`
    );
    expect(Number(legacyResult.getRows()[0][0])).toBe(0);
  });

  it("respects MARKET_DB_PATH environment variable", async () => {
    const customDir = path.join(testDir, "custom", "market");
    const customDbPath = path.join(customDir, "my-market.duckdb");

    // Set env var before calling getConnection so resolveMarketDbPath picks it up
    process.env.MARKET_DB_PATH = customDbPath;

    await getConnection(testDir);

    // Verify market.duckdb created at custom path
    await expect(fs.access(customDbPath)).resolves.toBeUndefined();

    // Default path should NOT have been created
    const defaultPath = path.join(testDir, "market.duckdb");
    await expect(fs.access(defaultPath)).rejects.toThrow();
  });
});

describe("Ephemeral Write Lock", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "ephemeral-lock-"));
  });

  afterEach(async () => {
    await closeConnection();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("getConnection returns read-only connection after init", async () => {
    await getConnection(testDir);

    // After getConnection, the connection should be in read-only mode
    expect(getConnectionMode()).toBe("read_only");

    // Verify reads work on the RO connection
    const conn = await getConnection(testDir);
    const result = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot WHERE 1=0`
    );
    expect(result).toBeDefined();
  });

  it("upgradeToReadWrite switches to read-write mode and downgradeToReadOnly switches back", async () => {
    // Start with RO after init
    await getConnection(testDir);
    expect(getConnectionMode()).toBe("read_only");

    // Upgrade to RW
    const rwConn = await upgradeToReadWrite(testDir);
    expect(getConnectionMode()).toBe("read_write");

    // Verify writes work in RW mode
    await rwConn.run(
      `INSERT INTO market.spot (ticker, date, time, open) VALUES ('SPX', '2025-06-01', '09:30', 500.0)`
    );

    // Downgrade back to RO
    await downgradeToReadOnly(testDir);
    expect(getConnectionMode()).toBe("read_only");

    // Verify reads still work after downgrade
    const roConn = await getConnection(testDir);
    const result = await roConn.runAndReadAll(
      `SELECT open FROM market.spot WHERE ticker = 'SPX' AND date = '2025-06-01' AND time = '09:30'`
    );
    expect(Number(result.getRows()[0][0])).toBe(500.0);
  });

  it("write lock is released after getConnection (second instance can open RO)", async () => {
    // Initialize the DB via getConnection (ends in RO mode)
    await getConnection(testDir);
    expect(getConnectionMode()).toBe("read_only");

    // A second DuckDBInstance should be able to open the same analytics.duckdb in READ_ONLY
    // because the main connection released the write lock after init
    const analyticsDbPath = path.join(testDir, "analytics.duckdb");
    let secondInstance: InstanceType<typeof DuckDBInstance> | null = null;
    try {
      secondInstance = await DuckDBInstance.create(analyticsDbPath, {
        access_mode: "READ_ONLY",
      });
      const secondConn = await secondInstance.connect();
      // Verify the second instance can read (proves lock is released)
      const result = await secondConn.runAndReadAll(
        `SELECT COUNT(*) FROM trades.trade_data WHERE 1=0`
      );
      expect(result).toBeDefined();
      secondConn.closeSync();
    } finally {
      if (secondInstance) secondInstance.closeSync();
    }
  });
});
