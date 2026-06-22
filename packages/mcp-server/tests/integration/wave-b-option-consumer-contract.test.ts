/**
 * Option-consumer contract tests.
 *
 * Exercises the option-quote read paths that flow through
 * `stores.quote.readQuotes` / `stores.chain.readChain` /
 * `stores.quote.writeQuotes` in:
 *
 *   - tools/replay.ts                         (option-leg reads)
 *   - tools/greeks-attribution.ts             (trading-days coverage)
 *   - backtest/loading/market-data-loader.ts  (per-date option-quote bulk read)
 *   - utils/quote-minute-cache.ts             (chain read + queue-drain writes)
 *
 * Pattern:
 *   - parquet-mode store fixture so chain.writeChain/readChain +
 *     quote.writeQuotes hit a real Parquet directory and
 *     createMarketParquetViews registers a market.option_chain /
 *     market.option_quote_minutes view backed by it.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import {
  createMarketStores,
  type MarketStores,
  type ContractRow,
  type QuoteRow,
} from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// Fixture seeding helpers — small SPX 5000-strike call chain + 5 minute quotes.
// ---------------------------------------------------------------------------

const SPX_DATE = "2025-01-02";
const SPX_5000C_OCC = "SPXW250117C05000000";
const SPX_5000P_OCC = "SPXW250117P05000000";
const SPX_5100C_OCC = "SPXW250117C05100000";

function makeContractRow(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    underlying: "SPX",
    date: SPX_DATE,
    ticker: SPX_5000C_OCC,
    contract_type: "call",
    strike: 5000,
    expiration: "2025-01-17",
    dte: 15,
    exercise_style: "european",
    ...overrides,
  };
}

/**
 * Seed 5 minute quotes for a single SPX call contract on SPX_DATE.
 * Bid/ask widen mid-day to give the contract a deterministic mid trace.
 *
 * 09:30 → bid=4.20 ask=4.40 mid=4.30
 * 09:31 → bid=4.30 ask=4.50 mid=4.40
 * 09:32 → bid=4.40 ask=4.60 mid=4.50
 * 09:33 → bid=4.45 ask=4.65 mid=4.55
 * 09:34 → bid=4.50 ask=4.70 mid=4.60
 */
async function seedSpxOptionQuotes(stores: MarketStores): Promise<void> {
  const quotes: QuoteRow[] = [
    { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:30`, bid: 4.2, ask: 4.4 },
    { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:31`, bid: 4.3, ask: 4.5 },
    { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:32`, bid: 4.4, ask: 4.6 },
    { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:33`, bid: 4.45, ask: 4.65 },
    { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:34`, bid: 4.5, ask: 4.7 },
  ];
  await stores.quote.writeQuotes("SPX", SPX_DATE, quotes);
}

async function seedSpxChain(stores: MarketStores): Promise<ContractRow[]> {
  const chain: ContractRow[] = [
    makeContractRow({ ticker: SPX_5000C_OCC, contract_type: "call", strike: 5000 }),
    makeContractRow({ ticker: SPX_5000P_OCC, contract_type: "put", strike: 5000 }),
    makeContractRow({ ticker: SPX_5100C_OCC, contract_type: "call", strike: 5100 }),
  ];
  await stores.chain.writeChain("SPX", SPX_DATE, chain);
  return chain;
}

// ---------------------------------------------------------------------------
// 1. tools/replay.ts — option-leg reads via stores.quote.readQuotes
// ---------------------------------------------------------------------------

describe("tools/replay.ts — option-leg reads", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("readQuotes returns 5 minute quotes for the seeded SPX call", async () => {
    await seedSpxOptionQuotes(stores);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const result = await stores.quote.readQuotes([SPX_5000C_OCC], SPX_DATE, SPX_DATE);

    expect(result.has(SPX_5000C_OCC)).toBe(true);
    const quotes = result.get(SPX_5000C_OCC)!;
    expect(quotes.length).toBe(5);

    const firstMid = (quotes[0].bid + quotes[0].ask) / 2;
    expect(firstMid).toBeCloseTo(4.3, 2);

    const lastMid = (quotes[4].bid + quotes[4].ask) / 2;
    expect(lastMid).toBeCloseTo(4.6, 2);

    // Per replay.ts: each QuoteRow adapts to BarRow with mid as
    // open/high/low/close. Verify the timestamp split works.
    for (const q of quotes) {
      const [date, time] = q.timestamp.split(" ");
      expect(date).toBe(SPX_DATE);
      expect(time).toMatch(/^09:3[0-4]$/);
    }
  });

  it("returns empty Map when no quotes are seeded for the requested ticker", async () => {
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const result = await stores.quote.readQuotes([SPX_5000C_OCC], SPX_DATE, SPX_DATE);
    // No partitions exist → empty Map (silent-empty signal).
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. tools/greeks-attribution.ts — coverage / trading-days query
// ---------------------------------------------------------------------------

describe("tools/greeks-attribution.ts — trading-days coverage", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("stores.spot.getCoverage returns the seeded date as coverage", async () => {
    // greeks-attribution sources trading dates from spot coverage (or pure
    // tradingDays() weekday iteration). Seed two SPX bars on different
    // dates and assert coverage reports both.
    await stores.spot.writeBars("SPX", "2025-01-02", [
      {
        ticker: "SPX",
        date: "2025-01-02",
        time: "09:30",
        open: 5800,
        high: 5810,
        low: 5795,
        close: 5805,
        bid: 5800,
        ask: 5805,
        volume: 0,
      },
    ]);
    await stores.spot.writeBars("SPX", "2025-01-03", [
      {
        ticker: "SPX",
        date: "2025-01-03",
        time: "09:30",
        open: 5810,
        high: 5815,
        low: 5805,
        close: 5812,
        bid: 5810,
        ask: 5812,
        volume: 0,
      },
    ]);
    const coverage = await stores.spot.getCoverage("SPX", "2025-01-02", "2025-01-03");
    expect(coverage.totalDates).toBe(2);
    expect(coverage.earliest).toBe("2025-01-02");
    expect(coverage.latest).toBe("2025-01-03");
  });

  it("getCoverage reports 0 totalDates for an empty range", async () => {
    const coverage = await stores.spot.getCoverage("SPX", "2030-01-01", "2030-01-31");
    expect(coverage.totalDates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. backtest/loading/market-data-loader.ts — per-date option-quote bulk read
// ---------------------------------------------------------------------------

describe("backtest/loading/market-data-loader.ts — per-date option-quote bulk read", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("readQuotes returns Map<occTicker, QuoteRow[]> for a 3-OCC seed on one date", async () => {
    // Seed 3 distinct OCCs on the same date; assert per-OCC bucketing.
    const quotes: QuoteRow[] = [
      { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:30`, bid: 4.2, ask: 4.4 },
      { occ_ticker: SPX_5000P_OCC, timestamp: `${SPX_DATE} 09:30`, bid: 3.1, ask: 3.3 },
      { occ_ticker: SPX_5100C_OCC, timestamp: `${SPX_DATE} 09:30`, bid: 1.2, ask: 1.4 },
      { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:31`, bid: 4.25, ask: 4.45 },
      { occ_ticker: SPX_5000P_OCC, timestamp: `${SPX_DATE} 09:31`, bid: 3.15, ask: 3.35 },
    ];
    await stores.quote.writeQuotes("SPX", SPX_DATE, quotes);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const result = await stores.quote.readQuotes(
      [SPX_5000C_OCC, SPX_5000P_OCC, SPX_5100C_OCC],
      SPX_DATE,
      SPX_DATE,
    );

    // 3 distinct OCCs → 3 Map entries.
    expect(result.size).toBe(3);
    expect(result.get(SPX_5000C_OCC)!.length).toBe(2);
    expect(result.get(SPX_5000P_OCC)!.length).toBe(2);
    expect(result.get(SPX_5100C_OCC)!.length).toBe(1);
  });

  it("mixed-underlying batch throws a clear error", async () => {
    // QQQ vs SPX in the same batch should fail loudly with both tickers named.
    await expect(
      stores.quote.readQuotes([SPX_5000C_OCC, "QQQ250117C00400000"], SPX_DATE, SPX_DATE),
    ).rejects.toThrow(/mixed underlyings/i);
  });
});

// ---------------------------------------------------------------------------
// 4. utils/quote-minute-cache.ts — chain-read + queue-drain writes
// ---------------------------------------------------------------------------

describe("utils/quote-minute-cache.ts — chain read + quote write via stores", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("chain.readChain returns the seeded contracts", async () => {
    const seed = await seedSpxChain(stores);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const contracts = await stores.chain.readChain("SPX", SPX_DATE);
    expect(contracts.length).toBe(seed.length);
    const tickers = new Set(contracts.map((c) => c.ticker));
    expect(tickers.has(SPX_5000C_OCC)).toBe(true);
    expect(tickers.has(SPX_5000P_OCC)).toBe(true);
    expect(tickers.has(SPX_5100C_OCC)).toBe(true);
  });

  it("quote.writeQuotes round-trips via quote.readQuotes", async () => {
    const quotes: QuoteRow[] = [
      { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:30`, bid: 4.2, ask: 4.4 },
      { occ_ticker: SPX_5000C_OCC, timestamp: `${SPX_DATE} 09:31`, bid: 4.3, ask: 4.5 },
    ];
    await stores.quote.writeQuotes("SPX", SPX_DATE, quotes);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const result = await stores.quote.readQuotes([SPX_5000C_OCC], SPX_DATE, SPX_DATE);
    expect(result.get(SPX_5000C_OCC)!.length).toBe(2);
  });
});
