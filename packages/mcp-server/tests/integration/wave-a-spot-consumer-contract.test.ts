/**
 * Spot-consumer contract tests.
 *
 * Exercises the `checkDataAvailability`, `queryCoverage`, and
 * `importFlatFileDay` consumers against a real `MarketStores` bundle backed by
 * a tmp Parquet fixture. Every read in these consumers flows through
 * `stores.spot.getCoverage` / `stores.enriched.getCoverage` /
 * `stores.quote.getCoverage`; every write flows through `stores.spot.writeBars`.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { makeBars } from "../fixtures/market-stores/bars-fixture.ts";
import { makeQuotes } from "../fixtures/market-stores/quotes-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import {
  ParquetSpotStore,
  ParquetQuoteStore,
  ParquetEnrichedStore,
  createMarketStores,
  type MarketStores,
} from "../../src/test-exports.ts";
import { writeEnrichedTickerFile } from "../../src/db/market-datasets.ts";
import { checkDataAvailability } from "../../src/utils/data-availability.ts";
import { queryCoverage } from "../../src/utils/data-quality.ts";

// Helper — seed an enriched row for a ticker so checkDataAvailability sees it
async function seedEnriched(fixture: FixtureHandle, ticker: string, date: string): Promise<void> {
  await fixture.ctx.conn.run(
    `INSERT OR REPLACE INTO market.enriched (ticker, date, Prior_Close, Gap_Pct, RSI_14)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticker, date, 100.0, 0.5, 55.0],
  );
  // Materialize to Parquet so getCoverage's filesystem-backed check sees it
  const safe = ticker.replace(/'/g, "''");
  await writeEnrichedTickerFile(fixture.ctx.conn, {
    dataDir: fixture.ctx.dataDir,
    ticker,
    selectQuery: `SELECT * FROM market.enriched WHERE ticker = '${safe}'`,
  });
}

describe("spot-consumer contract: checkDataAvailability", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns hasDailyData / hasContextData / hasIntradayData via stores", async () => {
    // Seed: SPX enriched + VIX enriched + 1 SPX spot bar.
    await seedEnriched(fixture, "SPX", "2025-01-06");
    await seedEnriched(fixture, "VIX", "2025-01-06");
    await stores.spot.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const report = await checkDataAvailability(stores, "SPX", { checkIntraday: true });
    expect(report.hasDailyData).toBe(true);
    expect(report.hasContextData).toBe(true);
    expect(report.hasIntradayData).toBe(true);
    expect(report.dailyDateRange).toEqual({ min: "2025-01-06", max: "2025-01-06" });
    expect(report.intradayDateRange).toEqual({ min: "2025-01-06", max: "2025-01-06" });
    // No warnings expected on the populated path
    expect(report.warnings).toEqual([]);
  });

  it("returns hasDailyData=false / warnings non-empty when ticker has no data", async () => {
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const report = await checkDataAvailability(stores, "NVDA", { checkIntraday: false });
    expect(report.hasDailyData).toBe(false);
    expect(report.hasIntradayData).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
    // Warning text must reference the missing ticker so the user can act on it.
    expect(report.warnings.some((w) => w.includes("NVDA"))).toBe(true);
  });
});

describe("spot-consumer contract: queryCoverage", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns spot + quote coverage pair via stores", async () => {
    // Seed 3 spot bars across 2 days for SPX, plus 1 day of quote rows for an SPX option contract.
    await stores.spot.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await stores.spot.writeBars("SPX", "2025-01-07", makeBars("SPX", "2025-01-07"));
    await stores.quote.writeQuotes(
      "SPX",
      "2025-01-06",
      makeQuotes("SPXW250106C05000000", "2025-01-06"),
    );
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const result = await queryCoverage(stores, "SPX", "2025-01-01", "2025-01-31");
    // Two spot dates → totalDates >= 2 in the breakdown
    expect(result.dateBreakdown.length).toBeGreaterThanOrEqual(2);
    expect(result.totalBars).toBeGreaterThan(0);
    expect(result.summary).toContain("SPX");
  });

  it("returns empty coverage cleanly when neither store has data", async () => {
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    const result = await queryCoverage(stores, "SPX", "2025-01-01", "2025-01-31");
    expect(result.totalBars).toBe(0);
    expect(result.dateBreakdown).toEqual([]);
    expect(result.summary).toMatch(/no .*data/i);
  });
});

describe("spot-consumer contract: importFlatFileDay (parsed-row write path)", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("writes parsed rows through stores.spot.writeBars and round-trips via readBars", async () => {
    // Direct write-bars round-trip — importFlatFileDay groups by ticker/date
    // and calls stores.spot.writeBars under the hood. This contract test
    // simulates the post-parse step (the parse step is unit-tested
    // separately).
    const bars = makeBars("SPX", "2025-01-06");
    await stores.spot.writeBars("SPX", "2025-01-06", bars);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const read = await stores.spot.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read.length).toBe(bars.length);
    expect(read.map((r) => r.time).sort()).toEqual(bars.map((b) => b.time).sort());
  });

  it("getCoverage skip-check returns totalDates>0 once a date is written", async () => {
    // importFlatFileDay uses stores.spot.getCoverage(ticker, date, date) as
    // the per-day "already imported" skip check. Verify that contract directly.
    await stores.spot.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const cov = await stores.spot.getCoverage("SPX", "2025-01-06", "2025-01-06");
    expect(cov.totalDates).toBeGreaterThan(0);
    expect(cov.earliest).toBe("2025-01-06");
  });
});

// Sanity reference — keep the concrete classes referenced in this file so
// ts-jest does not drop them as unused.
void ParquetSpotStore;
void ParquetQuoteStore;
void ParquetEnrichedStore;
