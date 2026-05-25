/**
 * Tests for market-views.ts Parquet-view registration.
 *
 * Covers the three primary Parquet views:
 *   - market.spot               (Hive: ticker=X/date=Y/data.parquet)
 *   - market.enriched           (per-ticker file: ticker=X/data.parquet)
 *   - market.enriched_context   (global single file: context/data.parquet)
 *
 * Ensures:
 *   - Empty market/ dir → all three land in tablesKept, not viewsCreated
 *   - Populated dirs → view is registered and selectable
 *   - Hive-partitioned views (option_chain, option_quote_minutes) still
 *     resolve to tablesKept when their files are absent
 *   - Idempotency: calling createMarketParquetViews twice does not error
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMarketParquetViews } from "../../../../src/db/market-views.js";

let tmpDir: string;
let db: DuckDBInstance;
let conn: DuckDBConnection;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `views-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(tmpDir, "market"), { recursive: true });
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
  await conn.run("ATTACH ':memory:' AS market");
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
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeSpotPartitionFixture(
  ticker: string,
  date: string,
): Promise<void> {
  const dir = join(
    tmpDir,
    "market",
    "spot",
    `ticker=${ticker}`,
    `date=${date}`,
  );
  mkdirSync(dir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT '${ticker}'::VARCHAR AS ticker,
             '${date}'::VARCHAR    AS date,
             '09:30'::VARCHAR      AS time,
             100.0 AS open, 101.0 AS high, 99.0 AS low, 100.5 AS close,
             100.0 AS bid, 101.0 AS ask
    ) TO '${join(dir, "data.parquet")}' (FORMAT PARQUET);
  `);
}

async function writeEnrichedFixture(ticker: string): Promise<void> {
  const dir = join(tmpDir, "market", "enriched", `ticker=${ticker}`);
  mkdirSync(dir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT '${ticker}'::VARCHAR AS ticker,
             '2025-01-06'::VARCHAR AS date,
             100.0 AS Prior_Close,
             0.5 AS Gap_Pct
    ) TO '${join(dir, "data.parquet")}' (FORMAT PARQUET);
  `);
}

async function writeEnrichedContextFixture(): Promise<void> {
  const dir = join(tmpDir, "market", "enriched", "context");
  mkdirSync(dir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT '2025-01-06'::VARCHAR AS date,
             1 AS Vol_Regime,
             0 AS Term_Structure_State,
             'UP'::VARCHAR AS Trend_Direction,
             0.1 AS VIX_Spike_Pct,
             0.2 AS VIX_Gap_Pct
    ) TO '${join(dir, "data.parquet")}' (FORMAT PARQUET);
  `);
}

async function writeLegacyOptionQuoteFixture(): Promise<void> {
  const dir = join(
    tmpDir,
    "market",
    "option_quote_minutes",
    "underlying=SPX",
    "date=2025-01-06",
  );
  mkdirSync(dir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT 'SPX'::VARCHAR AS underlying,
             '2025-01-06'::VARCHAR AS date,
             'SPXW250106C05000000'::VARCHAR AS ticker,
             '09:30'::VARCHAR AS time,
             1.0 AS bid,
             1.1 AS ask,
             1.05 AS mid,
             NULL::BIGINT AS last_updated_ns,
             NULL::VARCHAR AS source
    ) TO '${join(dir, "data.parquet")}' (FORMAT PARQUET);
  `);
}

/**
 * Multi-bar fixture for RTH aggregation tests. Writes N minute bars for a
 * given (ticker, date) so the market.spot_daily view's GROUP BY
 * ticker+date + RTH window 09:30–16:00 can be exercised.
 */
async function writeSpotMinuteBarsFixture(
  ticker: string,
  date: string,
  bars: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    bid: number;
    ask: number;
  }>,
): Promise<void> {
  const dir = join(
    tmpDir,
    "market",
    "spot",
    `ticker=${ticker}`,
    `date=${date}`,
  );
  mkdirSync(dir, { recursive: true });
  const values = bars
    .map(
      (b) =>
        `('${ticker}', '${date}', '${b.time}', ${b.open}, ${b.high}, ${b.low}, ${b.close}, ${b.bid}, ${b.ask})`,
    )
    .join(",\n");
  await conn.run(`
    COPY (
      SELECT * FROM (VALUES ${values})
        AS t(ticker, date, time, open, high, low, close, bid, ask)
    ) TO '${join(dir, "data.parquet")}' (FORMAT PARQUET);
  `);
}

describe("market-views registration", () => {
  it("empty market/ dir: spot/enriched/enriched_context land in tablesKept, not viewsCreated", async () => {
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).not.toContain("spot");
    expect(result.viewsCreated).not.toContain("enriched");
    expect(result.viewsCreated).not.toContain("enriched_context");
    expect(result.tablesKept).toContain("spot");
    expect(result.tablesKept).toContain("enriched");
    expect(result.tablesKept).toContain("enriched_context");
  });

  it("creates market.spot view when ticker=X/date=Y/data.parquet exists", async () => {
    await writeSpotPartitionFixture("SPX", "2025-01-06");
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("spot");
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot`,
    );
    expect(Number(read.getRows()[0][0])).toBe(1);
  });

  it("creates market.enriched view when enriched/ticker=X/data.parquet exists", async () => {
    await writeEnrichedFixture("SPX");
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("enriched");
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.enriched`,
    );
    expect(Number(read.getRows()[0][0])).toBe(1);
  });

  it("creates market.enriched_context view when enriched/context/data.parquet exists", async () => {
    await writeEnrichedContextFixture();
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("enriched_context");
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.enriched_context`,
    );
    expect(Number(read.getRows()[0][0])).toBe(1);
  });

  it("creates nullable greeks columns for legacy option quote partitions", async () => {
    await writeLegacyOptionQuoteFixture();
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("option_quote_minutes");

    const read = await conn.runAndReadAll(
      `SELECT delta, gamma, theta, vega, iv, greeks_source, greeks_revision
         FROM market.option_quote_minutes
        WHERE ticker = 'SPXW250106C05000000'`,
    );
    expect(read.getRows()).toEqual([[null, null, null, null, null, null, null]]);
  });

  it("view-vs-table transparency: same SELECT works against view as against physical table", async () => {
    await writeSpotPartitionFixture("SPX", "2025-01-06");
    await createMarketParquetViews(conn, tmpDir);
    const viaView = await conn.runAndReadAll(
      `SELECT ticker FROM market.spot WHERE ticker = 'SPX'`,
    );
    expect(viaView.getRows().length).toBeGreaterThan(0);
  });

  it("canonical views (option_chain, option_quote_minutes, spot, enriched, enriched_context, spot_daily) resolve in tablesKept on empty dir", async () => {
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.tablesKept).toContain("option_chain");
    expect(result.tablesKept).toContain("option_quote_minutes");
    expect(result.tablesKept).toContain("spot");
    expect(result.tablesKept).toContain("enriched");
    expect(result.tablesKept).toContain("enriched_context");
    expect(result.tablesKept).toContain("spot_daily");
  });

  it("second call is idempotent — re-registering views does not error", async () => {
    await writeSpotPartitionFixture("SPX", "2025-01-06");
    await createMarketParquetViews(conn, tmpDir);
    await createMarketParquetViews(conn, tmpDir);
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot`,
    );
    expect(Number(read.getRows()[0][0])).toBeGreaterThan(0);
  });
});

// =============================================================================
// market.spot_daily view
//
// The view RTH-aggregates market.spot into ticker+date daily bars. Semantics
// MUST match SpotStore.readDailyBars: first(open ORDER BY time), max(high),
// min(low), last(close ORDER BY time), first(bid ORDER BY time),
// last(ask ORDER BY time), RTH window 09:30–16:00 inclusive, GROUP BY
// ticker+date. Registration is unconditional — a view over table-or-view
// works whether market.spot resolves to a Parquet view or a fallback table.
// =============================================================================

describe("market.spot_daily view", () => {
  it("RTH aggregation correctness: open=first, close=last, high=max, low=min within 09:30–16:00", async () => {
    // 5 bars: 09:29 (pre-RTH, excluded), 09:30 (first RTH), 10:00,
    // 16:00 (last RTH), 16:30 (post-RTH, excluded).
    await writeSpotMinuteBarsFixture("SPX", "2025-01-06", [
      { time: "09:29", open: 500.0, high: 999.0, low: 400.0, close: 501.0, bid: 500.0, ask: 502.0 }, // excluded
      { time: "09:30", open: 600.0, high: 610.0, low: 595.0, close: 602.0, bid: 601.0, ask: 603.0 },
      { time: "10:00", open: 602.0, high: 650.0, low: 590.0, close: 640.0, bid: 639.0, ask: 641.0 },
      { time: "16:00", open: 640.0, high: 645.0, low: 620.0, close: 625.0, bid: 624.0, ask: 626.0 },
      { time: "16:30", open: 625.0, high: 700.0, low: 300.0, close: 626.0, bid: 625.0, ask: 627.0 }, // excluded
    ]);

    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("spot_daily");

    const read = await conn.runAndReadAll(
      `SELECT "open", high, low, "close", bid, ask
         FROM market.spot_daily
        WHERE ticker = 'SPX' AND date = '2025-01-06'`,
    );
    const rows = read.getRows();
    expect(rows.length).toBe(1);
    const [openVal, highVal, lowVal, closeVal, bidVal, askVal] = rows[0];
    // open = first RTH tick (09:30) open = 600.0
    expect(Number(openVal)).toBe(600.0);
    // close = last RTH tick (16:00) close = 625.0
    expect(Number(closeVal)).toBe(625.0);
    // high = max across RTH highs: max(610, 650, 645) = 650.0 (pre/post-RTH 999/700 excluded)
    expect(Number(highVal)).toBe(650.0);
    // low = min across RTH lows: min(595, 590, 620) = 590.0 (pre/post-RTH 400/300 excluded)
    expect(Number(lowVal)).toBe(590.0);
    // bid/ask follow the same first/last semantics from the RTH window
    expect(Number(bidVal)).toBe(601.0); // first RTH tick bid
    expect(Number(askVal)).toBe(626.0); // last RTH tick ask
  });

  it("unconditional registration: view is registered even when market.spot is a fallback table", async () => {
    // Do NOT write any Parquet partitions — market.spot resolves to tablesKept.
    // Pre-create a physical fallback table so the view has something to bind to.
    await conn.run(`
      CREATE TABLE market.spot (
        ticker VARCHAR NOT NULL,
        date   VARCHAR NOT NULL,
        time   VARCHAR NOT NULL,
        open   DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
        bid    DOUBLE, ask  DOUBLE
      )
    `);

    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("spot_daily");
    // The view resolves over the fallback table; selecting works and yields 0 rows.
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot_daily`,
    );
    expect(Number(read.getRows()[0][0])).toBe(0);
  });

  it("single row per ticker+date: multiple minute bars collapse into one daily row", async () => {
    await writeSpotMinuteBarsFixture("SPX", "2025-01-06", [
      { time: "09:30", open: 100.0, high: 101.0, low: 99.0, close: 100.2, bid: 100.0, ask: 100.4 },
      { time: "10:00", open: 100.2, high: 102.0, low: 100.0, close: 101.5, bid: 101.4, ask: 101.6 },
      { time: "11:00", open: 101.5, high: 103.0, low: 101.0, close: 102.8, bid: 102.7, ask: 102.9 },
      { time: "15:30", open: 102.8, high: 103.5, low: 101.5, close: 103.0, bid: 102.9, ask: 103.1 },
      { time: "16:00", open: 103.0, high: 103.5, low: 102.5, close: 103.2, bid: 103.1, ask: 103.3 },
    ]);

    await createMarketParquetViews(conn, tmpDir);
    const read = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot_daily
        WHERE ticker = 'SPX' AND date = '2025-01-06'`,
    );
    expect(Number(read.getRows()[0][0])).toBe(1);
  });

  it("DROP dance handles pre-existing table of same name — view replaces table without throwing", async () => {
    // Pre-create a physical TABLE named market.spot_daily BEFORE
    // createMarketParquetViews registers the view. The DROP VIEW IF EXISTS +
    // DROP TABLE IF EXISTS dance in market-views.ts must tolerate the type
    // mismatch gracefully.
    await conn.run(`
      CREATE TABLE market.spot_daily (
        ticker VARCHAR, date VARCHAR, open DOUBLE
      )
    `);
    await writeSpotMinuteBarsFixture("SPX", "2025-01-06", [
      { time: "09:30", open: 50.0, high: 51.0, low: 49.0, close: 50.5, bid: 50.0, ask: 51.0 },
      { time: "16:00", open: 50.5, high: 52.0, low: 50.0, close: 51.8, bid: 51.7, ask: 51.9 },
    ]);

    // Must not throw — the DROP TABLE step neutralizes the pre-existing TABLE,
    // then CREATE OR REPLACE VIEW binds the new view.
    const result = await createMarketParquetViews(conn, tmpDir);
    expect(result.viewsCreated).toContain("spot_daily");
    const read = await conn.runAndReadAll(
      `SELECT "open", "close" FROM market.spot_daily
        WHERE ticker = 'SPX' AND date = '2025-01-06'`,
    );
    const rows = read.getRows();
    expect(rows.length).toBe(1);
    expect(Number(rows[0][0])).toBe(50.0); // first RTH open
    expect(Number(rows[0][1])).toBe(51.8); // last RTH close
  });
});
