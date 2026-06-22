/**
 * Phase 2 Plan 02 — market-schemas.ts changes.
 *
 * Covers:
 *   - D-11: market.data_coverage CREATE removed from ensureMutableMarketTables
 *   - D-24, D-25: new DuckDB physical tables market.spot / market.enriched / market.enriched_context
 *   - D-12 / Pitfall 1: market.option_quote_minutes DROP+recreate with `underlying` as first key
 *   - Phase 6 Wave D: legacy fallback-table CREATE blocks (daily, date_context,
 *     intraday, option_chain, option_quote_minutes) retired — the D-10 "legacy
 *     tables still created" assertion has been deleted here accordingly.
 *   - Idempotency: second call succeeds with new schema intact
 *
 * Imports directly from src/db/market-schemas.ts (source path) — Plan 01 owns all
 * Wave 1 test-exports edits, so this plan intentionally does NOT touch test-exports.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  ensureMutableMarketTables,
  ensureMarketDataTables,
} from "../../../../src/db/market-schemas.ts";

let db: DuckDBInstance;
let conn: DuckDBConnection;

async function attachMarketInMemory(): Promise<void> {
  await conn.run("ATTACH ':memory:' AS market");
}

/** Returns the ordered list of column names for a table (PRAGMA table_info column 1 = name). */
async function columnNames(tableName: string): Promise<string[]> {
  const r = await conn.runAndReadAll(`PRAGMA table_info('${tableName}')`);
  return r.getRows().map((row) => String(row[1]));
}

beforeEach(async () => {
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
  await attachMarketInMemory();
});

afterEach(() => {
  try {
    conn.closeSync();
  } catch {
    /* ignore */
  }
  try {
    db.closeSync();
  } catch {
    /* ignore */
  }
});

describe("market-schemas: Phase 2 changes", () => {
  it("ensureMutableMarketTables no longer creates market.data_coverage (D-11)", async () => {
    await ensureMutableMarketTables(conn);
    await expect(conn.runAndReadAll(`SELECT * FROM market.data_coverage`)).rejects.toThrow();
  });

  it("ensureMutableMarketTables still creates market._sync_metadata", async () => {
    await ensureMutableMarketTables(conn);
    const cols = await columnNames("market._sync_metadata");
    expect(cols).toContain("source");
    expect(cols).toContain("ticker");
    expect(cols).toContain("target_table");
    expect(cols).not.toContain("enriched_through");
  });

  it("ensureMarketDataTables creates market.spot with exact spec columns", async () => {
    await ensureMarketDataTables(conn);
    const cols = await columnNames("market.spot");
    expect(cols).toEqual(["ticker", "date", "time", "open", "high", "low", "close", "bid", "ask"]);
  });

  it("ensureMarketDataTables creates market.enriched with computed fields only (no OHLCV, D-25)", async () => {
    await ensureMarketDataTables(conn);
    const cols = await columnNames("market.enriched");
    // Required computed fields present
    expect(cols).toContain("ticker");
    expect(cols).toContain("date");
    expect(cols).toContain("RSI_14");
    expect(cols).toContain("Gap_Pct");
    expect(cols).toContain("Prior_Close");
    expect(cols).toContain("Opening_Drive_Strength");
    expect(cols).toContain("Day_of_Week");
    expect(cols).toContain("ivr");
    expect(cols).toContain("ivp");
    // OHLCV absent per D-25
    expect(cols).not.toContain("open");
    expect(cols).not.toContain("high");
    expect(cols).not.toContain("low");
    expect(cols).not.toContain("close");
  });

  it("ensureMarketDataTables creates market.enriched_context with date-partition fields", async () => {
    await ensureMarketDataTables(conn);
    const cols = await columnNames("market.enriched_context");
    expect(cols).toEqual([
      "date",
      "Vol_Regime",
      "Term_Structure_State",
      "Trend_Direction",
      "VIX_Spike_Pct",
      "VIX_Gap_Pct",
    ]);
  });

  it("second call to ensureMarketDataTables is idempotent (no error, new schema intact)", async () => {
    await ensureMarketDataTables(conn);
    await ensureMarketDataTables(conn); // second run must not throw or corrupt schema
    const spotCols = await columnNames("market.spot");
    expect(spotCols[0]).toBe("ticker");
    const enrichedCols = await columnNames("market.enriched");
    expect(enrichedCols).toContain("RSI_14");
  });

  // Phase 6 Wave D: the legacy "D-10" assertion that verified the retired
  // legacy OHLCV/date-context/minute-bar/option-chain fallback tables are
  // still created has been DELETED, along with the D-12 fallback
  // table migration for market.option_quote_minutes. Those CREATE TABLE blocks
  // no longer exist in market-schemas.ts. The v3.0 Parquet-view path is the
  // canonical read surface for option_quote_minutes; only the Phase 2 v3.0
  // tables (spot, enriched, enriched_context) remain as physical fallbacks.
});
