import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  MarketIngestor,
} from "../../../../src/market/ingestor/index.js";
import { createMarketStores } from "../../../../src/market/stores/index.js";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.js";
import { TickerRegistry } from "../../../../src/market/tickers/registry.js";
import type { MarketDataProvider, BarRow } from "../../../../src/utils/market-provider.js";

// ---------------------------------------------------------------------------
// Non-trading day short-circuit (weekend skip)
// ---------------------------------------------------------------------------
describe("MarketIngestor.refresh — weekend short-circuit", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-weekend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.option_chain (
        underlying      VARCHAR NOT NULL,
        date            VARCHAR NOT NULL,
        ticker          VARCHAR NOT NULL,
        contract_type   VARCHAR NOT NULL,
        strike          DOUBLE NOT NULL,
        expiration      VARCHAR NOT NULL,
        dte             INTEGER NOT NULL,
        exercise_style  VARCHAR,
        PRIMARY KEY (underlying, date, ticker)
      )
    `);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.option_quote_minutes (
        underlying      VARCHAR NOT NULL,
        date            VARCHAR NOT NULL,
        ticker          VARCHAR NOT NULL,
        time            VARCHAR NOT NULL,
        bid             DOUBLE,
        ask             DOUBLE,
        mid             DOUBLE,
        last_updated_ns BIGINT,
        source          VARCHAR,
        delta           DOUBLE,
        gamma           DOUBLE,
        theta           DOUBLE,
        vega            DOUBLE,
        iv              DOUBLE,
        greeks_source   VARCHAR,
        greeks_revision INTEGER,
        PRIMARY KEY (underlying, date, ticker, time)
      )
    `);
    tickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeSpyProvider(): { provider: MarketDataProvider; fetchBarsCalls: number; fetchSnapshotCalls: number } {
    const counts = { fetchBarsCalls: 0, fetchSnapshotCalls: 0 };
    const provider: MarketDataProvider = {
      name: "spy",
      capabilities: () => ({
        tradeBars: true, quotes: true, greeks: false,
        flatFiles: false, bulkByRoot: false, perTicker: true,
        minuteBars: true, dailyBars: true,
      }),
      fetchBars: async () => { counts.fetchBarsCalls++; return []; },
      fetchOptionSnapshot: async () => { counts.fetchSnapshotCalls++; return { contracts: [] }; },
    };
    return { provider, ...counts };
  }

  it("returns status=skipped with empty arrays for Sunday (2026-04-26)", async () => {
    const { provider } = makeSpyProvider();
    let fetchBarsCalled = false;
    const spyProvider: MarketDataProvider = {
      ...provider,
      fetchBars: async () => { fetchBarsCalled = true; return []; },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => spyProvider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-04-26",  // Sunday
      spotTickers: ["SPX", "VIX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: true,
    });

    expect(result.status).toBe("skipped");
    expect(result.perOperation.spot).toHaveLength(0);
    expect(result.perOperation.chain).toHaveLength(0);
    expect(result.perOperation.quotes).toHaveLength(0);
    expect(result.perOperation.vixContext).toBeNull();
    expect(result.errors).toHaveLength(0);
    expect(fetchBarsCalled).toBe(false);
  });

  it("returns status=skipped with empty arrays for Saturday (2026-04-25)", async () => {
    let fetchBarsCalled = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => ({
        name: "spy",
        capabilities: () => ({
          tradeBars: true, quotes: false, greeks: false,
          flatFiles: false, bulkByRoot: false, perTicker: true,
          minuteBars: true, dailyBars: true,
        }),
        fetchBars: async () => { fetchBarsCalled = true; return []; },
        fetchOptionSnapshot: async () => ({ contracts: [] }),
      }),
    });

    const result = await ingestor.refresh({
      asOf: "2026-04-25",  // Saturday
      spotTickers: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("skipped");
    expect(result.perOperation.spot).toHaveLength(0);
    expect(result.perOperation.chain).toHaveLength(0);
    expect(result.perOperation.quotes).toHaveLength(0);
    expect(result.perOperation.vixContext).toBeNull();
    expect(result.errors).toHaveLength(0);
    expect(fetchBarsCalled).toBe(false);
  });

  it("does NOT short-circuit on Monday (2026-04-27) — inner fan-out executes", async () => {
    const bars: BarRow[] = [
      { ticker: "SPX", date: "2026-04-27", open: 5000, high: 5020, low: 4990, close: 5010, volume: 0 },
    ];
    let fetchBarsCalled = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => ({
        name: "spy",
        capabilities: () => ({
          tradeBars: true, quotes: false, greeks: false,
          flatFiles: false, bulkByRoot: false, perTicker: true,
          minuteBars: true, dailyBars: true,
        }),
        fetchBars: async () => { fetchBarsCalled = true; return bars; },
        fetchOptionSnapshot: async () => ({ contracts: [] }),
      }),
    });

    const result = await ingestor.refresh({
      asOf: "2026-04-27",  // Monday — must NOT skip
      spotTickers: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).not.toBe("skipped");
    expect(fetchBarsCalled).toBe(true);
    expect(result.perOperation.spot).toHaveLength(1);
  });
});

function makeBarsProvider(bars: BarRow[]): MarketDataProvider {
  return {
    name: "test",
    capabilities: () => ({
      tradeBars: true, quotes: true, greeks: false,
      flatFiles: false, bulkByRoot: false, perTicker: true,
      minuteBars: true, dailyBars: true,
    }),
    fetchBars: async () => bars,
    fetchOptionSnapshot: async () => ({ contracts: [] }),
  };
}

describe("MarketIngestor.refresh", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.option_chain (
        underlying      VARCHAR NOT NULL,
        date            VARCHAR NOT NULL,
        ticker          VARCHAR NOT NULL,
        contract_type   VARCHAR NOT NULL,
        strike          DOUBLE NOT NULL,
        expiration      VARCHAR NOT NULL,
        dte             INTEGER NOT NULL,
        exercise_style  VARCHAR,
        PRIMARY KEY (underlying, date, ticker)
      )
    `);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.option_quote_minutes (
        underlying      VARCHAR NOT NULL,
        date            VARCHAR NOT NULL,
        ticker          VARCHAR NOT NULL,
        time            VARCHAR NOT NULL,
        bid             DOUBLE,
        ask             DOUBLE,
        mid             DOUBLE,
        last_updated_ns BIGINT,
        source          VARCHAR,
        delta           DOUBLE,
        gamma           DOUBLE,
        theta           DOUBLE,
        vega            DOUBLE,
        iv              DOUBLE,
        greeks_source   VARCHAR,
        greeks_revision INTEGER,
        PRIMARY KEY (underlying, date, ticker, time)
      )
    `);
    tickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs ingestBars per spot ticker and reports per-operation results", async () => {
    const bars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
    ];
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeBarsProvider(bars),
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX", "QQQ"],
      computeVixContext: false,
    });

    expect(result.status).toBe("ok");
    expect(result.perOperation.spot).toHaveLength(2);
    expect(result.perOperation).not.toHaveProperty("optionDerived");
    expect(result.perOperation.vixContext).toBeNull();
  });

  it("fires computeVixContext when VIX-family ticker is in spotTickers and flag is true", async () => {
    const bars: BarRow[] = [
      { ticker: "VIX", date: "2026-01-05", open: 15, high: 16, low: 14, close: 15.5, volume: 0 },
    ];
    let contextCalled = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    stores.enriched.computeContext = async () => {
      contextCalled = true;
    };
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeBarsProvider(bars),
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["VIX"],
      computeVixContext: true,
    });

    expect(contextCalled).toBe(true);
    expect(result.perOperation).not.toHaveProperty("optionDerived");
    expect(result.perOperation.vixContext).not.toBeNull();
  });

  it("skips computeVixContext when no VIX-family ticker is present, even if flag is true", async () => {
    const bars: BarRow[] = [
      { ticker: "QQQ", date: "2026-01-05", open: 400, high: 402, low: 399, close: 401, volume: 0 },
    ];
    let contextCalled = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    stores.enriched.computeContext = async () => {
      contextCalled = true;
    };
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeBarsProvider(bars),
    });

    await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["QQQ"],
      computeVixContext: true,
    });

    expect(contextCalled).toBe(false);
  });

  it("computes and persists minute greeks inline during bulk quote refresh when provider greeks are absent", async () => {
    const provider: MarketDataProvider = {
      name: "bulk",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: false,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async (options) => {
        if (options.timespan === "minute") {
          return [
            { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
            { ticker: "SPX", date: "2026-01-05", time: "09:31", open: 4801, high: 4803, low: 4800, close: 4802, volume: 0 },
          ];
        }
        return [
          { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
        ];
      },
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchContractList: async () => ({
        underlying: "SPX",
        contracts: [
          {
            ticker: "SPXW260107C04800000",
            contract_type: "call",
            strike: 4800,
            expiration: "2026-01-07",
            exercise_style: "european",
          },
        ],
      }),
      fetchBulkQuotes: async function* () {
        yield [
          { ticker: "SPXW260107C04800000", timestamp: "2026-01-05 09:30", bid: 10.0, ask: 10.5 },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    // Pre-seed an explicit minute bar at 09:30. Without this, the test relies
    // on refresh's daily-bar ingest writing a row with the spot store's
    // implicit time="09:30" default; that path is correct but more fragile
    // (any swallowed read error in enrichQuoteRows leaves the underlying
    // price map empty and silently produces null greeks). Pre-seeding the
    // exact minute the quote needs makes the underlying-price lookup
    // unambiguous so the test exercises the inline-greeks logic, not the
    // daily-bar fallback.
    await stores.spot.writeBars("SPX", "2026-01-05", [
      { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
    ]);
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("ok");
    const quotes = await stores.quote.readQuotes(["SPXW260107C04800000"], "2026-01-05", "2026-01-05");
    const row = quotes.get("SPXW260107C04800000")?.[0];
    expect(row).toEqual(expect.objectContaining({
      bid: 10,
      ask: 10.5,
      timestamp: "2026-01-05 09:30",
      greeks_source: "computed",
      greeks_revision: 3,
      rate_type: "sofr",
      rate_value: expect.any(Number),
      gamma_source: "computed_sofr_q0",
    }));
    expect(row?.rate_value).toBeGreaterThan(0);
    expect(row?.rate_value).toBeLessThan(0.1);
    expect(row?.delta).not.toBeNull();
    expect(row?.gamma).not.toBeNull();
    expect(row?.theta).not.toBeNull();
    expect(row?.vega).not.toBeNull();
    expect(row?.iv).not.toBeNull();
  });

  it("logs and skips the batch when enrichQuoteRows reads fail (no silent null-greeks persist)", async () => {
    const provider: MarketDataProvider = {
      name: "bulk",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: false,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async (options) => options.timespan === "minute"
        ? [
            { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
          ]
        : [
            { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
          ],
      fetchOptionSnapshot: async () => emptySnapshot(),
      fetchContractList: async () => ({
        underlying: "SPX",
        contracts: [
          {
            ticker: "SPXW260107C04800000",
            contract_type: "call",
            strike: 4800,
            expiration: "2026-01-07",
            exercise_style: "european",
          },
        ],
      }),
      fetchBulkQuotes: async function* () {
        yield [
          { ticker: "SPXW260107C04800000", timestamp: "2026-01-05 09:30", bid: 10.0, ask: 10.5 },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    // Force the enrichment read to fail. Previously this would be swallowed
    // by .catch(() => []) in enrichQuoteRows and a row with intact bid/ask
    // but null greeks would silently persist. The fix surfaces the error:
    // the batch logs a structured warning and is skipped (no row persisted).
    const readChainSpy = jest.spyOn(stores.chain, "readChain").mockImplementation(async () => {
      throw new Error("simulated transient DuckDB flake");
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    // Partial-status is the load-bearing signal; warn is supplementary.
    expect(result.status).toBe("partial");
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped![0]).toEqual(expect.objectContaining({
      underlying: "SPX",
      date: "2026-01-05",
      rows: 1,
      error: "simulated transient DuckDB flake",
    }));
    // Restore the real chain reader so the post-condition read isn't itself broken.
    readChainSpy.mockRestore();
    const quotes = await stores.quote.readQuotes(["SPXW260107C04800000"], "2026-01-05", "2026-01-05");
    const row = quotes.get("SPXW260107C04800000")?.[0];
    // The batch must be skipped — no row with null greeks persisted.
    expect(row).toBeUndefined();
    // The structured warn is still emitted for live tail-following.
    const warnCall = warnSpy.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("enrichQuoteRows failed"),
    );
    expect(warnCall).toBeDefined();
    const ctx = warnCall![1] as Record<string, unknown>;
    expect(ctx).toEqual(expect.objectContaining({
      underlying: "SPX",
      date: "2026-01-05",
      error: "simulated transient DuckDB flake",
    }));
    warnSpy.mockRestore();
  });

  it("skips the batch with reason=coverage_gap when enrichment reads return empty (issue #167)", async () => {
    // Companion to the throw-path test above: enrichQuoteRows succeeds but
    // stores.spot.readBars returns [] (e.g. partial-day spot coverage,
    // missing chain partition). Without the coverage-gap guard, applyQuoteGreeks
    // would resolve no underlying prices, every row would increment
    // missingUnderlyingRows, and the batch would silently persist with
    // intact bid/ask but null greeks. The fix surfaces this as a distinct
    // reason="coverage_gap" skipped[] entry and refuses to write.
    const provider: MarketDataProvider = {
      name: "bulk",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: false,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async (options) => options.timespan === "minute"
        ? [
            { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
          ]
        : [
            { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
          ],
      fetchOptionSnapshot: async () => emptySnapshot(),
      fetchContractList: async () => ({
        underlying: "SPX",
        contracts: [
          {
            ticker: "SPXW260107C04800000",
            contract_type: "call",
            strike: 4800,
            expiration: "2026-01-07",
            exercise_style: "european",
          },
        ],
      }),
      fetchBulkQuotes: async function* () {
        yield [
          { ticker: "SPXW260107C04800000", timestamp: "2026-01-05 09:30", bid: 10.0, ask: 10.5 },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    // Force the spot read to return empty rows for the enrichment lookup.
    // The provider still writes daily/minute spot bars upstream of this point
    // (refresh.spot ingest), but the in-memory readBars used by enrichQuoteRows
    // is intercepted to simulate the coverage-gap scenario.
    const readBarsSpy = jest.spyOn(stores.spot, "readBars").mockResolvedValue([]);
    const writeQuotesSpy = jest.spyOn(stores.quote, "writeQuotes");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("partial");
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toHaveLength(1);
    const entry = result.skipped![0];
    expect(entry).toEqual(expect.objectContaining({
      underlying: "SPX",
      date: "2026-01-05",
      rows: 1,
      reason: "coverage_gap",
    }));
    expect(typeof entry.resolveRatio).toBe("number");
    expect(entry.resolveRatio).toBeGreaterThan(0.5);
    expect(entry.resolveRatio).toBeLessThanOrEqual(1);
    expect(entry.error).toMatch(/coverage gap/);

    // writeQuotes must NOT have been called for the affected partition —
    // that's the whole point: we refuse to persist null-greeks rows.
    const quotePartitionWrites = writeQuotesSpy.mock.calls.filter(
      (call) => call[0] === "SPX" && call[1] === "2026-01-05",
    );
    expect(quotePartitionWrites).toHaveLength(0);

    readBarsSpy.mockRestore();
    const quotes = await stores.quote.readQuotes(["SPXW260107C04800000"], "2026-01-05", "2026-01-05");
    const row = quotes.get("SPXW260107C04800000")?.[0];
    expect(row).toBeUndefined();

    const warnCall = warnSpy.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("coverage gap"),
    );
    expect(warnCall).toBeDefined();
    warnSpy.mockRestore();
    writeQuotesSpy.mockRestore();
  });

  it("persists provider minute greeks inline when bulk quotes already carry them", async () => {
    const provider: MarketDataProvider = {
      name: "thetadata",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: true,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: false,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async (options) => options.timespan === "minute"
        ? [
            { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
          ]
        : [
            { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
          ],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchContractList: async () => ({
        underlying: "SPX",
        contracts: [
          {
            ticker: "SPXW260107C04800000",
            contract_type: "call",
            strike: 4800,
            expiration: "2026-01-07",
            exercise_style: "european",
          },
        ],
      }),
      fetchBulkQuotes: async function* () {
        yield [
          {
            ticker: "SPXW260107C04800000",
            timestamp: "2026-01-05 09:30",
            bid: 10.0,
            ask: 10.5,
            delta: 0.22,
            gamma: 0.05,
            theta: -0.12,
            vega: 0.31,
            iv: 0.19,
            greeks_source: "thetadata",
          },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("ok");
    const quotes = await stores.quote.readQuotes(["SPXW260107C04800000"], "2026-01-05", "2026-01-05");
    expect(quotes.get("SPXW260107C04800000")).toEqual([
      expect.objectContaining({
        delta: 0.22,
        gamma: 0.05,
        theta: -0.12,
        vega: 0.31,
        iv: 0.19,
        greeks_source: "thetadata",
        greeks_revision: null,
      }),
    ]);
  });

  it("degrades Massive 403 spot failures to cached-coverage skips instead of failing refresh", async () => {
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    await stores.spot.writeBars("SPX", "2026-01-05", [
      { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
    ]);
    const provider: MarketDataProvider = {
      name: "massive",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: false,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => {
        throw new Error("Massive.com API error: HTTP 403 Forbidden");
      },
      fetchOptionSnapshot: async () => ({ contracts: [] }),
    };
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.perOperation.spot).toEqual([
      expect.objectContaining({
        status: "skipped",
        details: expect.objectContaining({
          reason: "using_cached_coverage",
          dataset: "spot",
          symbol: "SPX",
          originalStatus: "unsupported",
        }),
      }),
    ]);
    expect(result.coverage.SPX?.totalDates).toBe(1);
  });

  it("preflights Massive SPX refreshes to unsupported instead of attempting index spot or chain calls", async () => {
    const fetchBars = jest.fn(async () => {
      throw new Error("fetchBars should not be called");
    });
    const fetchContractList = jest.fn(async () => {
      throw new Error("fetchContractList should not be called");
    });
    const provider: MarketDataProvider = {
      name: "massive",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: false,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars,
      fetchContractList,
      fetchOptionSnapshot: async () => ({ contracts: [] }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    expect(fetchBars).not.toHaveBeenCalled();
    expect(fetchContractList).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.perOperation.spot).toEqual([
      expect.objectContaining({ status: "unsupported" }),
    ]);
    expect(result.perOperation.chain).toEqual([
      expect.objectContaining({ status: "unsupported" }),
    ]);
    expect(result.perOperation.quotes).toEqual([
      expect.objectContaining({ status: "unsupported" }),
    ]);
    expect(result.perOperation).not.toHaveProperty("optionDerived");
  });

  it("reports unsupported bulk quote refreshes cleanly when the provider lacks bulk mode", async () => {
    const bars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
    ];
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeBarsProvider(bars),
    });

    const result = await ingestor.refresh({
      asOf: "2026-01-05",
      spotTickers: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: false,
    });

    expect(result.status).toBe("ok");
    expect(result.perOperation.quotes).toEqual([
      expect.objectContaining({
        status: "unsupported",
      }),
    ]);
    expect(result.perOperation).not.toHaveProperty("optionDerived");
    expect(result.errors).toEqual([]);
  });
});
