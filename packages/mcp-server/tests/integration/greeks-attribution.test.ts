import { jest } from "@jest/globals";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  collapseFactors,
  handleDecomposeGreeks,
  handleGetGreeksAttribution,
} from "../../src/test-exports.ts";
import type {
  AttributionInstanceResult,
  AttributionSummaryResult,
} from "../../src/test-exports.ts";
import { buildTestStores } from "../fixtures/market-stores/build-stores.ts";
import type { MarketStores } from "../../src/market/stores/index.ts";
import type { QuoteRow } from "../../src/market/stores/types.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPY_470C_BARS = [
  { t: 1737124320000, o: 5.0, h: 5.2, l: 4.9, c: 5.1 },
  { t: 1737124380000, o: 5.1, h: 5.5, l: 5.0, c: 5.3 },
  { t: 1737124440000, o: 5.3, h: 5.4, l: 4.7, c: 4.8 },
];

// The second trade must use a real session: Jan 18 is Saturday and Jan 20 is MLK Day.
const SPY_475C_BARS = [
  { t: 1737469920000, o: 3.0, h: 3.1, l: 2.9, c: 3.05 },
  { t: 1737469980000, o: 3.05, h: 3.3, l: 3.0, c: 3.2 },
  { t: 1737470040000, o: 3.2, h: 3.3, l: 2.6, c: 2.7 },
];

const SPY_UNDERLYING_DAY1_BARS = [
  { t: 1737124320000, o: 470.0, h: 470.5, l: 469.8, c: 470.2 },
  { t: 1737124380000, o: 470.2, h: 471.0, l: 470.1, c: 470.8 },
  { t: 1737124440000, o: 470.8, h: 471.4, l: 470.6, c: 471.1 },
];

const SPY_UNDERLYING_DAY2_BARS = [
  { t: 1737469920000, o: 468.0, h: 468.3, l: 467.6, c: 467.9 },
  { t: 1737469980000, o: 467.9, h: 468.1, l: 467.1, c: 467.4 },
  { t: 1737470040000, o: 467.4, h: 467.8, l: 466.8, c: 467.0 },
];

describe("get_greeks_attribution integration", () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let stores: MarketStores;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "test-greeks-attribution-"));
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`CREATE SCHEMA IF NOT EXISTS trades`);
    await conn.run(`
      CREATE TABLE trades.trade_data (
        block_id VARCHAR NOT NULL,
        date_opened DATE NOT NULL,
        time_opened VARCHAR,
        strategy VARCHAR,
        legs VARCHAR,
        premium DOUBLE,
        num_contracts INTEGER,
        pl DOUBLE NOT NULL,
        date_closed DATE,
        time_closed VARCHAR,
        reason_for_close VARCHAR,
        margin_req DOUBLE,
        opening_commissions DOUBLE,
        closing_commissions DOUBLE,
        ticker VARCHAR
      )
    `);

    // Store reads use the same attached market catalog as production.
    await conn.run(`ATTACH ':memory:' AS market`);
    await conn.run(`
      CREATE TABLE market.spot (
        ticker VARCHAR NOT NULL,
        date   VARCHAR NOT NULL,
        time   VARCHAR NOT NULL,
        open   DOUBLE,
        high   DOUBLE,
        low    DOUBLE,
        close  DOUBLE,
        bid    DOUBLE,
        ask    DOUBLE,
        PRIMARY KEY (ticker, date, time)
      )
    `);
    await conn.run(`
      CREATE TABLE market.enriched (
        ticker VARCHAR NOT NULL,
        date   VARCHAR NOT NULL,
        ivp    DOUBLE,
        PRIMARY KEY (ticker, date)
      )
    `);

    stores = buildTestStores({ conn, dataDir: dataDir });

    process.env.MASSIVE_API_KEY = "test-key-attribution";
  });

  afterEach(() => {
    delete process.env.MASSIVE_API_KEY;
    jest.restoreAllMocks();
    conn.closeSync();
    db.closeSync();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Seed SPY underlying bars directly into market.spot since handleReplayTrade
  // reads underlying via stores.spot (not fetch). ET wallclock: 2025-01-17 is
  // in EST (UTC-5). SPY_UNDERLYING_DAY1_BARS use UTC ms aligned to
  // 14:32 UTC = 09:32 ET (the first minute the replay accepts).
  const seedSpyUnderlying = async (
    bars: Array<{ t: number; o: number; h: number; l: number; c: number }>,
  ) => {
    for (const b of bars) {
      const date = new Date(b.t).toISOString().slice(0, 10);
      const utcMinutes = Math.floor((b.t / 60_000) % (60 * 24));
      const etHours = Math.floor(utcMinutes / 60) - 5;
      const mm = String(utcMinutes % 60).padStart(2, "0");
      const etTime = `${String(etHours).padStart(2, "0")}:${mm}`;
      await conn.run(
        `INSERT INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
         VALUES ('SPY', $1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [date, etTime, b.o, b.h, b.l, b.c],
      );
    }
  };

  // Seed option_quote_minutes for the option-leg tests. Mirrors
  // trade-replay.test.ts seedOptionQuotes (HL2-anchored bid/ask split with
  // 0.05 spread → mid = bar.close).
  const seedOptionQuotes = async (
    occTicker: string,
    underlying: string,
    bars: Array<{ t: number; o: number; h: number; l: number; c: number }>,
  ) => {
    const byDate = new Map<string, QuoteRow[]>();
    for (const b of bars) {
      const date = new Date(b.t).toISOString().slice(0, 10);
      const utcMinutes = Math.floor((b.t / 60_000) % (60 * 24));
      const etHours = Math.floor(utcMinutes / 60) - 5;
      const mm = String(utcMinutes % 60).padStart(2, "0");
      const etTime = `${String(etHours).padStart(2, "0")}:${mm}`;
      const bid = b.c - 0.05;
      const ask = b.c + 0.05;
      const rows = byDate.get(date) ?? [];
      rows.push({ occ_ticker: occTicker, timestamp: `${date} ${etTime}`, bid, ask });
      byDate.set(date, rows);
    }
    for (const [date, rows] of byDate) {
      await stores.quote.writeQuotes(underlying, date, rows);
    }
  };

  // Seed option partitions through the production store, without provider calls.
  test("summary mode keeps raw factor P&Ls and reports execution edge separately", async () => {
    await conn.run(`
      INSERT INTO trades.trade_data
        (block_id, date_opened, date_closed, strategy, legs, premium, num_contracts, pl, ticker)
      VALUES
        ('test-block', '2025-01-17', '2025-01-17', 'calendar', 'SPY 470C', 500.0, 1, 250.0, 'SPY')
    `);

    await seedSpyUnderlying(SPY_UNDERLYING_DAY1_BARS);
    await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

    const decomp = await handleDecomposeGreeks(
      {
        block_id: "test-block",
        trade_index: 0,
        format: "summary",
        multiplier: 100,
        skip_quotes: true,
      },
      dataDir,
      stores,
      conn,
    );

    const summary = (await handleGetGreeksAttribution(
      {
        block_id: "test-block",
        mode: "summary",
        skip_quotes: true,
      },
      dataDir,
      stores,
      conn,
    )) as AttributionSummaryResult;

    const expected = collapseFactors(decomp.factors, false);
    const actualByFactor = new Map(summary.attribution.map((entry) => [entry.factor, entry.pnl]));

    for (const [factor, pnl] of expected.entries()) {
      expect(actualByFactor.get(factor)).toBeCloseTo(Math.round(pnl * 100) / 100, 2);
    }
    expect(summary.total_pnl).toBe(250);
    expect(summary.mark_total_pnl).toBeCloseTo(Math.round(decomp.totalPnlChange * 100) / 100, 2);
    expect(summary.execution_edge).toBeCloseTo(
      Math.round((250 - decomp.totalPnlChange) * 100) / 100,
      2,
    );
    expect(summary.gross_attribution_flow).toBeGreaterThan(0);
    expect(summary.attribution.some((entry) => entry.pct_of_gross !== undefined)).toBe(true);
  });

  test("instance mode labels each step with its replay bar timestamp", async () => {
    await conn.run(`
      INSERT INTO trades.trade_data
        (block_id, date_opened, date_closed, strategy, legs, premium, num_contracts, pl, ticker)
      VALUES
        ('test-block', '2025-01-17', '2025-01-17', 'calendar', 'SPY 470C', 500.0, 1, 250.0, 'SPY')
    `);

    await seedSpyUnderlying(SPY_UNDERLYING_DAY1_BARS);
    await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

    const instance = (await handleGetGreeksAttribution(
      {
        block_id: "test-block",
        mode: "instance",
        trade_index: 0,
        skip_quotes: true,
        detailed: true,
      },
      dataDir,
      stores,
      conn,
    )) as AttributionInstanceResult;

    // Three bars (09:32, 09:33, 09:34) → two steps, each labelled with the
    // timestamp of the bar it ends at. Nothing is labelled by trading day.
    const labels = instance.steps.map((s) => s.date);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(2);
    for (const label of labels) {
      expect(["2025-01-17 09:33", "2025-01-17 09:34"]).toContain(label);
      expect(label.startsWith("day-")).toBe(false);
    }
  });

  test("strategy filter maps to the correct trade indices", async () => {
    await conn.run(`
      INSERT INTO trades.trade_data
        (block_id, date_opened, date_closed, strategy, legs, premium, num_contracts, pl, ticker)
      VALUES
        ('test-block', '2025-01-17', '2025-01-17', 'first', 'SPY 470C', 500.0, 1, 100.0, 'SPY'),
        ('test-block', '2025-01-21', '2025-01-21', 'second', 'SPY 475C', 300.0, 1, -80.0, 'SPY')
    `);

    await seedSpyUnderlying([...SPY_UNDERLYING_DAY1_BARS, ...SPY_UNDERLYING_DAY2_BARS]);
    // Option-leg quotes are seeded through the Parquet store, with no provider.
    await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
    await seedOptionQuotes("SPY250121C00475000", "SPY", SPY_475C_BARS);

    const direct = await handleDecomposeGreeks(
      {
        block_id: "test-block",
        trade_index: 1,
        format: "summary",
        multiplier: 100,
        skip_quotes: true,
      },
      dataDir,
      stores,
      conn,
    );

    const summary = (await handleGetGreeksAttribution(
      {
        block_id: "test-block",
        mode: "summary",
        strategy: "second",
        skip_quotes: true,
      },
      dataDir,
      stores,
      conn,
    )) as AttributionSummaryResult;

    expect(summary.trades_total).toBe(1);
    expect(summary.total_pnl).toBe(-80);
    expect(summary.mark_total_pnl).toBeCloseTo(Math.round(direct.totalPnlChange * 100) / 100, 2);
  });
});
