import { jest } from "@jest/globals";

/**
 * Integration tests for replay_trade MCP tool (handleReplayTrade)
 *
 * Tests both hypothetical and tradelog replay modes with a real in-memory
 * DuckDB seeded via stores.spot.writeBars and direct option_quote_minutes
 * INSERTs; option-leg reads flow through stores.quote.readQuotes so the
 * full path is store-backed.
 */

import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { handleReplayTrade } from "../../src/tools/replay.ts";
import { handleDecomposeGreeks } from "../../src/tools/exit-analysis.ts";
import { buildTestStores } from "../fixtures/market-stores/build-stores.ts";
import type { MarketStores } from "../../src/market/stores/index.ts";

// Minute bars for SPY 470C — 3 minutes starting at 09:30 ET on 2025-01-17
// 2025-01-17 is in EST (UTC-5): 09:30 ET = 14:30 UTC = 1737124200000 ms
const SPY_470C_BARS = [
  { t: 1737124200000, o: 5.0, h: 5.2, l: 4.9, c: 5.1 }, // 09:30
  { t: 1737124260000, o: 5.1, h: 5.5, l: 5.0, c: 5.3 }, // 09:31
  { t: 1737124320000, o: 5.3, h: 5.4, l: 4.7, c: 4.8 }, // 09:32
];

// Minute bars for SPY 475C (short leg of spread)
const SPY_475C_BARS = [
  { t: 1737124200000, o: 3.0, h: 3.1, l: 2.9, c: 3.05 }, // 09:30
  { t: 1737124260000, o: 3.05, h: 3.3, l: 3.0, c: 3.2 }, // 09:31
  { t: 1737124320000, o: 3.2, h: 3.3, l: 2.6, c: 2.7 }, // 09:32
];

const SPY_UNDERLYING_BARS = [
  { t: 1737124200000, o: 470.0, h: 470.5, l: 469.8, c: 470.2 },
  { t: 1737124260000, o: 470.2, h: 471.0, l: 470.1, c: 470.8 },
  { t: 1737124320000, o: 470.8, h: 471.4, l: 470.6, c: 471.1 },
];

// =============================================================================
// Test suite
// =============================================================================

describe("replay_trade integration", () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let stores: MarketStores;

  beforeEach(async () => {
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

    // handleReplayTrade reads underlying bars via stores.spot.readBars and
    // VIX IVP via stores.enriched.read. Create the minimal market schema in
    // the in-memory DuckDB so those store calls succeed. The tests
    // intentionally leave these empty — option-leg bars are mocked via
    // fetch, and the underlying-bars empty result triggers the
    // readDailyBars fallback (also empty), then handleReplayTrade omits
    // greeks.
    await conn.run(`CREATE SCHEMA IF NOT EXISTS market`);
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

    // handleReplayTrade reads option-leg quotes via stores.quote.readQuotes
    // which queries market.option_quote_minutes. Schema mirrors the
    // production market-schemas.ts shape (PK underlying, date, ticker, time
    // + bid/ask/mid columns). Tests seed via seedOptionQuotes() below.
    await conn.run(`
      CREATE TABLE market.option_quote_minutes (
        underlying      VARCHAR NOT NULL,
        date            VARCHAR NOT NULL,
        ticker          VARCHAR NOT NULL,
        time            VARCHAR NOT NULL,
        bid             DOUBLE,
        ask             DOUBLE,
        mid             DOUBLE,
        last_updated_ns BIGINT,
        source          VARCHAR,
        PRIMARY KEY (underlying, date, ticker, time)
      )
    `);

    stores = buildTestStores({ conn, dataDir: "/tmp/test-replay" });

    process.env.MASSIVE_API_KEY = "test-key-replay";
  });

  afterEach(async () => {
    delete process.env.MASSIVE_API_KEY;
    delete process.env.MASSIVE_DATA_TIER;
    jest.restoreAllMocks();
    conn.closeSync();
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
      const mid = (bid + ask) / 2;
      await conn.run(
        `INSERT INTO market.option_quote_minutes
           (underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'fixture')`,
        [underlying, date, occTicker, etTime, bid, ask, mid],
      );
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
        "/tmp/test-replay",
        stores,
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
        "/tmp/test-replay",
        stores,
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
          "/tmp/test-replay",
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
        "/tmp/test-replay",
        stores,
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
        "/tmp/test-replay",
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
          "/tmp/test-replay",
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
          "/tmp/test-replay",
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
          "/tmp/test-replay",
          stores,
        ),
      ).rejects.toThrow("Provide either legs[]");
    });
  });
});
