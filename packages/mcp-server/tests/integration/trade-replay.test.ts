import { jest } from "@jest/globals";

/**
 * Integration tests for replay_trade MCP tool (handleReplayTrade)
 *
 * Tests both hypothetical and tradelog replay modes with a real in-memory
 * DuckDB and isolated Parquet option partitions, seeded and read through
 * the production market stores.
 */

import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { handleReplayTrade } from "../../src/tools/replay.ts";
import { handleAnalyzeExitTriggers, handleDecomposeGreeks } from "../../src/tools/exit-analysis.ts";
import {
  batchExitAnalysisSchema,
  handleBatchExitAnalysis,
} from "../../src/tools/batch-exit-analysis.ts";
import { buildTestStores } from "../fixtures/market-stores/build-stores.ts";
import type { MarketStores } from "../../src/market/stores/index.ts";
import type { QuoteRow } from "../../src/market/stores/types.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Minute bars for SPY 470C — 3 minutes starting at 09:32 ET on 2025-01-17 (the first
// minute the replay accepts; 09:30/09:31 are the opening rotation and are dropped)
// 2025-01-17 is in EST (UTC-5): 09:32 ET = 14:32 UTC = 1737124320000 ms
const SPY_470C_BARS = [
  { t: 1737124320000, o: 5.0, h: 5.2, l: 4.9, c: 5.1 }, // 09:32
  { t: 1737124380000, o: 5.1, h: 5.5, l: 5.0, c: 5.3 }, // 09:33
  { t: 1737124440000, o: 5.3, h: 5.4, l: 4.7, c: 4.8 }, // 09:34
];

// Minute bars for SPY 475C (short leg of spread)
const SPY_475C_BARS = [
  { t: 1737124320000, o: 3.0, h: 3.1, l: 2.9, c: 3.05 }, // 09:32
  { t: 1737124380000, o: 3.05, h: 3.3, l: 3.0, c: 3.2 }, // 09:33
  { t: 1737124440000, o: 3.2, h: 3.3, l: 2.6, c: 2.7 }, // 09:34
];

const SPY_UNDERLYING_BARS = [
  { t: 1737124320000, o: 470.0, h: 470.5, l: 469.8, c: 470.2 },
  { t: 1737124380000, o: 470.2, h: 471.0, l: 470.1, c: 470.8 },
  { t: 1737124440000, o: 470.8, h: 471.4, l: 470.6, c: 471.1 },
];

// =============================================================================
// Test suite
// =============================================================================

describe("replay_trade integration", () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let stores: MarketStores;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "test-replay-"));
    // In-memory DuckDB for tradelog mode
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

    process.env.MASSIVE_API_KEY = "test-key-replay";
  });

  afterEach(async () => {
    delete process.env.MASSIVE_API_KEY;
    delete process.env.MASSIVE_DATA_TIER;
    jest.restoreAllMocks();
    conn.closeSync();
    db.closeSync();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Seed option_quote_minutes for the option-leg tests. Bar inputs come from
  // the SPY_470C_BARS / SPY_475C_BARS fixtures (UTC-millisecond timestamps);
  // we convert to ET wallclock and persist as (bid, ask) so the (bid+ask)/2
  // mid in handleReplayTrade matches the bar close within rounding
  // tolerance.
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
      // Use HL2 as the quote spread anchor (close as mid is too tight here);
      // the replay handler computes mark = (bid+ask)/2 so a bid/ask split
      // around the bar's "c" close keeps the resulting mid faithful to
      // close. Keep a small spread for realism.
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

  // ---------------------------------------------------------------------------
  // Hypothetical mode
  // ---------------------------------------------------------------------------

  describe("hypothetical mode", () => {
    // Option-leg path is store-backed via stores.quote.readQuotes; option
    // quotes are seeded via seedOptionQuotes() (no provider fetch).
    test("single-leg replay returns P&L path with MFE/MAE", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      const result = await handleReplayTrade(
        {
          legs: [
            {
              ticker: "SPY",
              strike: 470,
              type: "C",
              expiry: "2025-01-17",
              quantity: 1,
              entry_price: 5.0,
            },
          ],
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          multiplier: 100,
        },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.length).toBe(3);
      expect(result.legs.length).toBe(1);
      expect(result.legs[0].occTicker).toBe("SPY250117C00470000");

      // Each point should have strategyPnl and legPrices
      for (const point of result.pnlPath) {
        expect(typeof point.strategyPnl).toBe("number");
        expect(point.legPrices.length).toBe(1);
        expect(point.timestamp).toBeTruthy();
      }

      // MFE/MAE should be numeric
      expect(typeof result.mfe).toBe("number");
      expect(typeof result.mae).toBe("number");
      expect(result.mfeTimestamp).toBeTruthy();
      expect(result.maeTimestamp).toBeTruthy();
      expect(typeof result.totalPnl).toBe("number");
    });

    // Option-leg quotes seeded directly into market.option_quote_minutes.
    test("multi-leg spread replay combines legs correctly", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      await seedOptionQuotes("SPY250117C00475000", "SPY", SPY_475C_BARS);

      const result = await handleReplayTrade(
        {
          legs: [
            {
              ticker: "SPY",
              strike: 470,
              type: "C",
              expiry: "2025-01-17",
              quantity: 1,
              entry_price: 5.0,
            },
            {
              ticker: "SPY",
              strike: 475,
              type: "C",
              expiry: "2025-01-17",
              quantity: -1,
              entry_price: 3.0,
            },
          ],
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          multiplier: 100,
        },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.length).toBe(3);
      expect(result.legs.length).toBe(2);

      // Each point should have combined P&L from both legs
      for (const point of result.pnlPath) {
        expect(point.legPrices.length).toBe(2);
      }

      // Verify spread P&L combines both legs (not just one)
      // Entry: long 470C at 5.0, short 475C at 3.0 → net debit 2.0
      // mark = (bid+ask)/2 where bid=c-0.05, ask=c+0.05 (per
      // seedOptionQuotes spread anchor) → mid = c (the bar close).
      // At minute 0: 470C mid=5.1 (c=5.1); 475C mid=3.05 (c=3.05)
      // Long leg: (5.1-5.0)*1*100=10, Short leg: (3.05-3.0)*-1*100=-5
      // Combined: 5
      expect(result.pnlPath[0].strategyPnl).toBeCloseTo(5, 0);
    });

    test("open_time starts the hypothetical path at entry", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      const result = await handleReplayTrade(
        {
          legs: [
            {
              ticker: "SPY",
              strike: 470,
              type: "C",
              expiry: "2025-01-17",
              quantity: 1,
              entry_price: 5.0,
            },
          ],
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          open_time: "09:33",
          multiplier: 100,
        },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.map((p) => p.timestamp)).toEqual([
        "2025-01-17 09:33",
        "2025-01-17 09:34",
      ]);
      expect(result.totalBars).toBe(2);
    });

    test("returns error when open_date missing in hypothetical mode", async () => {
      await expect(
        handleReplayTrade(
          {
            legs: [
              {
                ticker: "SPY",
                strike: 470,
                type: "C",
                expiry: "2025-01-17",
                quantity: 1,
                entry_price: 5.0,
              },
            ],
            close_date: "2025-01-17",
            multiplier: 100,
          },
          dataDir,
          stores,
        ),
      ).rejects.toThrow("open_date and close_date are required");
    });

    // handleReplayTrade reads option-leg quotes via stores.quote.readQuotes;
    // seed both underlying spot bars (for the greeks underlying-price map)
    // and option_quote_minutes (for the 470C option leg) directly into the
    // in-memory DuckDB. No provider fetch is issued at all — the path is
    // fully store-backed end-to-end.
    test("decompose_greeks reuses replay underlying prices and honors skip_quotes", async () => {
      process.env.MASSIVE_DATA_TIER = "quotes";

      // Seed SPY underlying bars (greeks underlying-price map source).
      for (const b of SPY_UNDERLYING_BARS) {
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

      // Seed the 470C option leg quotes for 2025-01-17.
      await seedOptionQuotes("SPY250124C00470000", "SPY", SPY_470C_BARS);

      // Spy on fetch so we can assert no provider calls are issued — the
      // entire path is now store-backed.
      const fetchSpy = jest.spyOn(globalThis, "fetch");

      const result = await handleDecomposeGreeks(
        {
          legs: [
            {
              ticker: "SPY",
              strike: 470,
              type: "C",
              expiry: "2025-01-24",
              quantity: 1,
              entry_price: 5.0,
            },
          ],
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          multiplier: 100,
          skip_quotes: true,
        },
        dataDir,
        stores,
        conn,
      );

      expect(result.totalPnlChange).not.toBeNaN();
      // No provider fetches should occur — replay.ts and the underlying
      // path both flow through stores now.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Tradelog mode
  // ---------------------------------------------------------------------------

  describe("tradelog mode", () => {
    // Option-leg quotes seeded directly into market.option_quote_minutes via
    // seedOptionQuotes.
    test("resolves trade from block and replays it", async () => {
      // Insert a test trade
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '2025-01-17', 'SPY 470C', 500.0, 1, 50.0, 'SPY')
      `);

      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      const result = await handleReplayTrade(
        {
          block_id: "test-block",
          trade_index: 0,
          multiplier: 100,
        },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.length).toBe(3);
      expect(result.legs.length).toBe(1);
      expect(result.legs[0].occTicker).toBe("SPY250117C00470000");
      expect(typeof result.mfe).toBe("number");
      expect(typeof result.mae).toBe("number");
      expect(typeof result.totalPnl).toBe("number");
    });

    test("path starts at time_opened and ends at time_closed", async () => {
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, time_opened, date_closed, time_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '09:33:00', '2025-01-17', '09:33:00', 'SPY 470C', 5.0, 1, 50.0, 'SPY')
      `);

      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      const result = await handleReplayTrade(
        { block_id: "test-block", trade_index: 0, multiplier: 100, close_at: "trade" },
        dataDir,
        stores,
        conn,
      );

      // 09:32 is before entry; 09:34 is after the close.
      expect(result.pnlPath.map((p) => p.timestamp)).toEqual(["2025-01-17 09:33"]);
      // Entry 5.0 (premium / 1 contract); mark at 09:33 = bar close 5.3 → (5.3 - 5.0) * 100 = 30
      expect(result.totalPnl).toBeCloseTo(30, 2);
      expect(result.mfe).toBeCloseTo(30, 2);
      expect(result.mae).toBeCloseTo(30, 2);
    });

    test("close_at=expiry still starts the path at time_opened", async () => {
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, time_opened, date_closed, time_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '09:33', '2025-01-17', '09:33', 'SPY 470C', 500.0, 1, 50.0, 'SPY')
      `);

      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      const result = await handleReplayTrade(
        { block_id: "test-block", trade_index: 0, multiplier: 100, close_at: "expiry" },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.map((p) => p.timestamp)).toEqual([
        "2025-01-17 09:33",
        "2025-01-17 09:34",
      ]);
    });

    test("drops opening-rotation quotes before 09:32", async () => {
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '2025-01-17', 'SPY 470C', 500.0, 1, 50.0, 'SPY')
      `);

      // Seed the whole ticker batch: writeQuotes replaces that ticker's series.
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      const existing = (
        await stores.quote.readQuotes(["SPY250117C00470000"], "2025-01-17", "2025-01-17")
      ).get("SPY250117C00470000")!;
      await stores.quote.writeQuotes("SPY", "2025-01-17", [
        ...["09:30", "09:31"].map((time) => ({
          occ_ticker: "SPY250117C00470000",
          timestamp: `2025-01-17 ${time}`,
          bid: 0.95,
          ask: 1.05,
        })),
        ...existing,
      ]);

      const result = await handleReplayTrade(
        { block_id: "test-block", trade_index: 0, multiplier: 100 },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath[0].timestamp).toBe("2025-01-17 09:32");
      expect(result.pnlPath.length).toBe(3);
      // The $1.00 opening-rotation mark must not appear anywhere on the path.
      expect(result.pnlPath.every((p) => p.legPrices[0] > 4)).toBe(true);
    });

    test("drops a zero quote and forward-fills the previous mark", async () => {
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '2025-01-17', 'SPY 470C', 5.0, 1, 50.0, 'SPY')
      `);

      // 09:32 and 09:34 priced; 09:33 reported as bid=ask=0.
      await seedOptionQuotes("SPY250117C00470000", "SPY", [SPY_470C_BARS[0], SPY_470C_BARS[2]]);
      const existing = (
        await stores.quote.readQuotes(["SPY250117C00470000"], "2025-01-17", "2025-01-17")
      ).get("SPY250117C00470000")!;
      await stores.quote.writeQuotes("SPY", "2025-01-17", [
        ...existing,
        { occ_ticker: "SPY250117C00470000", timestamp: "2025-01-17 09:33", bid: 0, ask: 0 },
      ]);

      const result = await handleReplayTrade(
        { block_id: "test-block", trade_index: 0, multiplier: 100 },
        dataDir,
        stores,
        conn,
      );

      // The zero row contributes no timestamp of its own and never marks the leg at $0.
      expect(result.pnlPath.map((p) => p.timestamp)).toEqual([
        "2025-01-17 09:32",
        "2025-01-17 09:34",
      ]);
      expect(result.pnlPath.every((p) => p.legPrices[0] > 0)).toBe(true);
      expect(result.mae).toBeGreaterThan(-100);
    });

    test("a single usable quote yields a single-point path", async () => {
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('test-block', '2025-01-17', '2025-01-17', 'SPY 470C', 5.0, 1, 50.0, 'SPY')
      `);
      await seedOptionQuotes("SPY250117C00470000", "SPY", [SPY_470C_BARS[0]]);

      const result = await handleReplayTrade(
        { block_id: "test-block", trade_index: 0, multiplier: 100 },
        dataDir,
        stores,
        conn,
      );

      expect(result.pnlPath.length).toBe(1);
      expect(result.totalPnl).toBeCloseTo(10, 2);
    });

    test("returns error for unparseable tradelog legs", async () => {
      // Insert trade with unparseable legs string
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('bad-block', '2025-01-17', '2025-01-17', 'SPX Put Spread', 200.0, 1, -100.0, 'SPX')
      `);

      await expect(
        handleReplayTrade(
          {
            block_id: "bad-block",
            trade_index: 0,
            multiplier: 100,
          },
          dataDir,
          stores,
          conn,
        ),
      ).rejects.toThrow("hypothetical mode");
    });

    test("returns error when trade not found at index", async () => {
      // Empty table — trade_index=0 will not find anything
      await expect(
        handleReplayTrade(
          {
            block_id: "missing-block",
            trade_index: 0,
            multiplier: 100,
          },
          dataDir,
          stores,
          conn,
        ),
      ).rejects.toThrow("No trade found");
    });
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe("input validation", () => {
    test("returns error when neither legs nor block_id provided", async () => {
      await expect(
        handleReplayTrade(
          {
            open_date: "2025-01-17",
            close_date: "2025-01-17",
            multiplier: 100,
          },
          dataDir,
          stores,
        ),
      ).rejects.toThrow("Provide either legs[]");
    });
  });

  // ---------------------------------------------------------------------------
  // SPX root resolution and missing quotes (enterprise#4502, tradeblocks#585)
  // ---------------------------------------------------------------------------

  describe("SPX root resolution and missing quotes", () => {
    // A put spread on SPX: short 5900P / long 5800P, priced off the SPY fixture
    // bar closes. Quotes are ingested under the SPXW root, as providers name
    // SPX weeklies, and partitioned by underlying SPX.
    const spreadLegs = (ticker: string, expiry: string) => [
      { ticker, strike: 5900, type: "P" as const, expiry, quantity: -1, entry_price: 5.1 },
      { ticker, strike: 5800, type: "P" as const, expiry, quantity: 1, entry_price: 3.05 },
    ];
    const seedSpread = async (root: string, yymmdd: string) => {
      await seedOptionQuotes(`${root}${yymmdd}P05900000`, "SPX", SPY_470C_BARS);
      await seedOptionQuotes(`${root}${yymmdd}P05800000`, "SPX", SPY_475C_BARS);
    };
    const replaySpread = (
      ticker: string,
      expiry: string,
      format: "full" | "sampled" | "summary" = "full",
    ) =>
      handleReplayTrade(
        {
          legs: spreadLegs(ticker, expiry),
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          multiplier: 100,
          format,
          close_at: "trade",
          skip_quotes: false,
        },
        "/tmp/test-replay",
        stores,
        conn,
      );

    test("an SPXW replay keeps its output in every format (compatibility)", async () => {
      await seedSpread("SPXW", "250124");

      // Snapshot recorded against the pre-change replay (tradeblocks f98d3f7d).
      for (const format of ["full", "sampled", "summary"] as const) {
        expect(await replaySpread("SPXW", "2025-01-24", format)).toMatchSnapshot(format);
      }
    });

    test("explicit SPX-root legs on a PM-series expiry replay the SPXW contract", async () => {
      await seedSpread("SPXW", "250124");

      const spx = await replaySpread("SPX", "2025-01-24");
      const spxw = await replaySpread("SPXW", "2025-01-24");

      expect(spx.legs.map((leg) => leg.occTicker)).toEqual([
        "SPXW250124P05900000",
        "SPXW250124P05800000",
      ]);
      expect(spx.pnlPath.length).toBe(3);
      expect(spx).toEqual(spxw);
    });

    test("a tradelog SPX trade on a PM-series expiry replays the SPXW contract", async () => {
      // tradeblocks#585: the Option Omega Underlying column is "SPX" for SPXW trades.
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('spx-block', '2025-01-17', '2025-01-17',
           '1 Jan 24 5900 P STO 5.1 | 1 Jan 24 5800 P BTO 3.05', 205.0, 1, 50.0, 'SPX')
      `);
      await seedSpread("SPXW", "250124");

      const fromTradelog = await handleReplayTrade(
        { block_id: "spx-block", trade_index: 0, multiplier: 100, format: "full" },
        "/tmp/test-replay",
        stores,
        conn,
      );
      const explicit = await handleReplayTrade(
        {
          legs: spreadLegs("SPXW", "2025-01-24"),
          open_date: "2025-01-17",
          close_date: "2025-01-24",
          multiplier: 100,
          format: "full",
        },
        "/tmp/test-replay",
        stores,
        conn,
      );

      expect(fromTradelog.legs.map((leg) => leg.occTicker)).toEqual([
        "SPXW250124P05900000",
        "SPXW250124P05800000",
      ]);
      expect(fromTradelog.pnlPath.length).toBe(3);
      expect(fromTradelog).toEqual(explicit);
    });

    test("an SPX-root leg on the AM-settled monthly expiry is refused, not substituted", async () => {
      // 2025-01-17 is the third Friday: SPX250117 is the AM-settled monthly,
      // a different contract from the PM-settled SPXW250117.
      await seedSpread("SPXW", "250117");

      await expect(replaySpread("SPX", "2025-01-17")).rejects.toThrow(
        /2 of 2 legs.*leg 1 SPX250117P05900000: no quote rows in the local cache; 2025-01-17 is the AM-settled SPX monthly expiration, so the PM-settled SPXW250117P05900000 is a different contract and is not substituted/,
      );
    });

    test("an SPX-root leg replays its own SPX quotes when they exist", async () => {
      await seedSpread("SPX", "250117");

      const result = await replaySpread("SPX", "2025-01-17");

      expect(result.legs.map((leg) => leg.occTicker)).toEqual([
        "SPX250117P05900000",
        "SPX250117P05800000",
      ]);
      expect(result.pnlPath.length).toBe(3);
    });

    const spyCallSpread = [
      {
        ticker: "SPY",
        strike: 470,
        type: "C" as const,
        expiry: "2025-01-17",
        quantity: 1,
        entry_price: 5.0,
      },
      {
        ticker: "SPY",
        strike: 475,
        type: "C" as const,
        expiry: "2025-01-17",
        quantity: -1,
        entry_price: 3.0,
      },
    ];
    const replaySpySpread = (open_time?: string) =>
      handleReplayTrade(
        {
          legs: spyCallSpread,
          open_date: "2025-01-17",
          close_date: "2025-01-17",
          open_time,
          multiplier: 100,
          format: "full",
        },
        "/tmp/test-replay",
        stores,
        conn,
      );

    test("one leg without quotes among quoted legs is refused by name, not zeroed", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);

      await expect(replaySpySpread()).rejects.toThrow(
        /^Replay unavailable: no usable option quotes for 1 of 2 legs between 2025-01-17 and 2025-01-17 — leg 2 SPY250117C00475000: no quote rows in the local cache\./,
      );
    });

    test("a leg whose quotes are all unusable is refused by name", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      await stores.quote.writeQuotes(
        "SPY",
        "2025-01-17",
        ["09:32", "09:33", "09:34"].map((time) => ({
          occ_ticker: "SPY250117C00475000",
          timestamp: `2025-01-17 ${time}`,
          bid: 0,
          ask: 3.1,
        })),
      );

      await expect(replaySpySpread()).rejects.toThrow(
        /leg 2 SPY250117C00475000: 3 quote rows, none usable \(bid and ask must both be positive, at or after 09:32 ET\)/,
      );
    });

    test("a quote-read failure is surfaced, not read as missing data", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      // Keep a real partition present but unreadable: an absent partition
      // would exercise missing data, not the read-failure contract.
      writeFileSync(
        join(
          dataDir,
          "market",
          "option_quote_minutes",
          "underlying=SPY",
          "date=2025-01-17",
          "data.parquet",
        ),
        "corrupted parquet fixture",
      );

      await expect(replaySpySpread()).rejects.toThrow(
        /^Replay unavailable: reading SPY option quotes for SPY250117C00470000, SPY250117C00475000 failed: .*option_quote_minutes/,
      );
    });

    test("no quote at or after entry is refused, not zeroed", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      await seedOptionQuotes("SPY250117C00475000", "SPY", SPY_475C_BARS);

      await expect(replaySpySpread("10:00")).rejects.toThrow(
        /^Replay unavailable: no usable option quotes at or after entry 2025-01-17 10:00 for SPY250117C00470000, SPY250117C00475000/,
      );
    });

    test("exit analysis, greeks decomposition and batch surface a missing leg", async () => {
      await seedOptionQuotes("SPY250117C00470000", "SPY", SPY_470C_BARS);
      const missingLeg = /leg 2 SPY250117C00475000: no quote rows in the local cache/;
      const replayInputs = {
        legs: spyCallSpread,
        open_date: "2025-01-17",
        close_date: "2025-01-17",
        multiplier: 100,
        format: "summary" as const,
      };

      await expect(
        handleAnalyzeExitTriggers(
          { ...replayInputs, triggers: [{ type: "profitTarget", threshold: 50 }] },
          "/tmp/test-replay",
          stores,
          conn,
        ),
      ).rejects.toThrow(missingLeg);
      await expect(
        handleDecomposeGreeks(
          { ...replayInputs, skip_quotes: false },
          "/tmp/test-replay",
          stores,
          conn,
        ),
      ).rejects.toThrow(missingLeg);

      // Batch: the quoted trade is analyzed, the unquoted one is skipped with
      // the named reason instead of counting as an evaluated trade.
      await conn.run(`
        INSERT INTO trades.trade_data
          (block_id, date_opened, date_closed, legs, premium, num_contracts, pl, ticker)
        VALUES
          ('batch-block', '2025-01-17', '2025-01-17', 'SPY 470C', 5.0, 1, 50.0, 'SPY'),
          ('batch-block', '2025-01-17', '2025-01-17', 'SPY 475C', 3.0, 1, 20.0, 'SPY')
      `);
      const batch = await handleBatchExitAnalysis(
        batchExitAnalysisSchema.parse({
          block_id: "batch-block",
          candidate_policy: [{ type: "profitTarget", threshold: 50 }],
        }),
        "/tmp/test-replay",
        stores,
        conn,
      );

      expect(batch.aggregate.totalTrades).toBe(1);
      expect(batch.skippedTrades).toEqual([
        expect.objectContaining({
          tradeIndex: 1,
          error: expect.stringMatching(
            /leg 1 SPY250117C00475000: no quote rows in the local cache/,
          ),
        }),
      ]);
    });
  });
});
