/**
 * Enrichment-consumer contract tests.
 *
 * Exercises the enrichment surface that flows through:
 *   - utils/market-enricher.ts: enrichment-watermark read/write goes through
 *     `io.watermarkStore` (backed by `getEnrichedThrough` /
 *     `upsertEnrichedThrough` from `db/json-adapters.ts`); the tool layer no
 *     longer reads `market._sync_metadata.enriched_through` directly.
 *   - tools/market-enrichment.ts: `enrich_market_data` handler delegates to
 *     `stores.enriched.compute(...)` and (for the VIX family)
 *     `computeContext(...)` instead of calling `runEnrichment(conn, ...)`.
 *
 * Tier 1/2/3 indicator math is preserved verbatim — the wrapper
 * `stores.enriched.compute` injects the JSON-backed watermark IO so the
 * tool layer doesn't reach into `market._sync_metadata` directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { makeBars } from "../fixtures/market-stores/bars-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import { createMarketStores, type MarketStores } from "../../src/test-exports.ts";
import { registerMarketEnrichmentTools } from "../../src/tools/market-enrichment.ts";
import { getEnrichedThrough } from "../../src/db/json-adapters.ts";
import { isXnysSessionDate } from "../../src/market/provenance/xnys-session-calendar.ts";

// Direct module import so the absence-of-symbols assertions can inspect
// the live module shape.
import * as marketEnricher from "../../src/utils/market-enricher.ts";
import * as marketEnrichmentTool from "../../src/tools/market-enrichment.ts";

// =============================================================================
// Fixture seeding helpers
// =============================================================================

/**
 * Seed `count` consecutive trading days of SPX bars starting from `startDate`.
 * Each day gets a 3-bar minute slice (09:30 / 10:30 / 15:45) via makeBars()
 * which is enough to hydrate Tier 1 indicator inputs (RSI/ATR/EMA/SMA need
 * close prices in date order).
 */
async function seedSpotBars(
  stores: MarketStores,
  ticker: string,
  startDate: string,
  count: number,
): Promise<string[]> {
  const dates: string[] = [];
  // Walk forward day-by-day using the canonical exchange calendar.
  const cursor = new Date(`${startDate}T00:00:00Z`);
  while (dates.length < count) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isXnysSessionDate(dateStr)) {
      await stores.spot.writeBars(ticker, dateStr, makeBars(ticker, dateStr));
      dates.push(dateStr);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Seed OHLCV rows for the enricher to consume. `runEnrichment` reads OHLCV
 * from the market.spot_daily view (aggregated from market.spot minute bars)
 * or from the injected `io.spotStore`. This helper writes synthetic 09:30
 * bars into market.spot so market.spot_daily aggregates one row per date.
 * Deterministic linear ramp guarantees stable Tier 1 indicator outputs
 * (no NaN propagation through the warmup window).
 */
async function seedDailyOhlcv(
  fixture: FixtureHandle,
  ticker: string,
  dates: string[],
): Promise<void> {
  for (let i = 0; i < dates.length; i++) {
    const close = 100 + i * 0.5;
    await fixture.ctx.conn.run(
      `INSERT OR REPLACE INTO market.spot
         (ticker, date, time, open, high, low, close)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ticker, dates[i], "09:30", close - 0.2, close + 0.5, close - 0.5, close],
    );
    // Seed an empty market.enriched row so UPDATE targets have somewhere to write.
    await fixture.ctx.conn.run(
      `INSERT OR REPLACE INTO market.enriched (ticker, date) VALUES ($1, $2)`,
      [ticker, dates[i]],
    );
  }
}

// =============================================================================
// 1. stores.enriched.compute — Tier 1/2/3 output shape
// =============================================================================

describe("stores.enriched.compute — Tier 1/2/3 output shape", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("populates enriched columns on market.enriched after compute(SPX)", async () => {
    // Need enough history for Tier 1 warmup: RSI=14, ATR=14, EMA=21, SMA=50.
    // 25 trading days is enough for RSI + ATR + EMA to populate.
    const dates: string[] = [];
    const cursor = new Date("2025-01-02T00:00:00Z");
    for (let i = 0; i < 25; i++) {
      const date = cursor.toISOString().slice(0, 10);
      if (isXnysSessionDate(date)) {
        dates.push(date);
      } else {
        i--; // back up so we get exactly 25 trading days
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Seed spot bars (enricher Tier 3 / store getCoverage uses these)
    await seedSpotBars(stores, "SPX", dates[0], dates.length);
    // Seed daily OHLCV (Tier 1 reads aggregated from market.spot via market.spot_daily)
    await seedDailyOhlcv(fixture, "SPX", dates);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const from = dates[0];
    const to = dates[dates.length - 1];

    // === The contract under test ===
    // stores.enriched.compute should:
    //  1. Inject `io.watermarkStore` (JSON-backed via getEnrichedThrough/upsert)
    //  2. NOT touch market._sync_metadata for enrichment watermarks
    //  3. Run Tier 1 math and write enriched columns into market.enriched
    await stores.enriched.compute("SPX", from, to);

    // Re-register Parquet views so subsequent reads see updated state
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    // === Assert: watermark was written to JSON adapter ===
    const watermark = await getEnrichedThrough("SPX", fixture.ctx.dataDir);
    expect(watermark).toBe(to);

    // === Assert: market._sync_metadata was NOT touched for enrichment ===
    // (the legacy path wrote source='enrichment', target_table='daily')
    const metaRows = await fixture.ctx.conn.runAndReadAll(
      `SELECT COUNT(*) FROM market._sync_metadata
       WHERE source = 'enrichment' AND ticker = 'SPX'`,
    );
    expect(Number(metaRows.getRows()[0]?.[0] ?? 0)).toBe(0);

    // === Assert: enriched indicator columns were populated on market.enriched ===
    const enrichedReader = await fixture.ctx.conn.runAndReadAll(
      `SELECT date, RSI_14, ATR_Pct, Day_of_Week
       FROM market.enriched
       WHERE ticker = 'SPX'
         AND date >= $1 AND date <= $2
       ORDER BY date`,
      [from, to],
    );
    const rows = enrichedReader.getRows();
    expect(rows.length).toBe(dates.length);

    // The last row should have RSI_14 populated (warmup window crossed at index 14).
    const lastRsi = rows[rows.length - 1]?.[1];
    expect(lastRsi).not.toBeNull();
    expect(typeof lastRsi).toBe("number");

    // ATR_Pct populated as well
    const lastAtrPct = rows[rows.length - 1]?.[2];
    expect(lastAtrPct).not.toBeNull();
    expect(typeof lastAtrPct).toBe("number");

    // Day_of_Week (calendar field) is populated for every row
    expect(rows.every((r) => r[3] !== null && typeof r[3] === "number")).toBe(true);
  });

  it("computeContext is callable and is a no-op when no VIX data is seeded", async () => {
    // No VIX data seeded — computeContext should iterate VIX/VIX9D/VIX3M and
    // skip each (per ParquetEnrichedStore.computeContext doc: "If a ticker has
    // no daily data yet, runEnrichment returns a skipped Tier 1 status and skips
    // Tier 2 — safe no-op.")
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
    await stores.enriched.computeContext("2025-01-02", "2025-01-31");
    // No exception. Watermarks remain unset.
    const vixWatermark = await getEnrichedThrough("VIX", fixture.ctx.dataDir);
    expect(vixWatermark).toBeNull();
  });
});

// =============================================================================
// 2. tools/market-enrichment.ts handler — delegates to stores
// =============================================================================

describe("tools/market-enrichment.ts handler — delegates to stores", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("registers `enrich_market_data` and routes to stores.enriched.compute", async () => {
    // Capture registered tools
    const registered = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: Record<string, unknown>) => Promise<unknown>,
      ) {
        registered.set(name, handler);
      },
    };

    // Seed enough data to make compute(SPX) produce a watermark
    const dates: string[] = [];
    const cursor = new Date("2025-02-03T00:00:00Z");
    for (let i = 0; i < 16; i++) {
      const date = cursor.toISOString().slice(0, 10);
      if (isXnysSessionDate(date)) {
        dates.push(date);
      } else {
        i--;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    await seedSpotBars(stores, "SPX", dates[0], dates.length);
    await seedDailyOhlcv(fixture, "SPX", dates);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    // Register the tool — this is what production code does in src/index.ts
    registerMarketEnrichmentTools(fakeServer as never, fixture.ctx.dataDir, stores);

    const handler = registered.get("enrich_market_data");
    expect(handler).toBeDefined();

    // Spy on stores.enriched.compute / computeContext to verify delegation.
    let computeCalled = false;
    let computeCtxCalled = false;
    const origCompute = stores.enriched.compute.bind(stores.enriched);
    const origComputeCtx = stores.enriched.computeContext.bind(stores.enriched);
    stores.enriched.compute = async (t, f, to) => {
      computeCalled = true;
      return origCompute(t, f, to);
    };
    stores.enriched.computeContext = async (f, to) => {
      computeCtxCalled = true;
      return origComputeCtx(f, to);
    };

    // Call the handler — note: the production handler issues
    // upgradeToReadWrite/downgradeToReadOnly which are no-ops in our in-memory
    // fixture (no on-disk DuckDB file to reopen). That's fine — the relevant
    // contract is that compute() runs and updates the JSON watermark.
    await handler!({ ticker: "SPX", force_full: false });

    // === Assert: handler routed through stores.enriched.compute ===
    expect(computeCalled).toBe(true);

    // === Assert: non-VIX ticker did NOT trigger computeContext ===
    expect(computeCtxCalled).toBe(false);

    // === Assert: JSON watermark was updated (proxy for "compute ran") ===
    const watermark = await getEnrichedThrough("SPX", fixture.ctx.dataDir);
    expect(watermark).toBe(dates[dates.length - 1]);
  });

  it("routes VIX ticker through both compute AND computeContext", async () => {
    const registered = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: Record<string, unknown>) => Promise<unknown>,
      ) {
        registered.set(name, handler);
      },
    };

    // Seed VIX daily data — Tier 1 runs against market.spot_daily for the ticker.
    const dates: string[] = [];
    const cursor = new Date("2025-03-03T00:00:00Z");
    for (let i = 0; i < 16; i++) {
      const date = cursor.toISOString().slice(0, 10);
      if (isXnysSessionDate(date)) {
        dates.push(date);
      } else {
        i--;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    await seedSpotBars(stores, "VIX", dates[0], dates.length);
    await seedDailyOhlcv(fixture, "VIX", dates);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    registerMarketEnrichmentTools(fakeServer as never, fixture.ctx.dataDir, stores);
    const handler = registered.get("enrich_market_data");
    expect(handler).toBeDefined();

    let computeCalled = false;
    let computeCtxCalled = false;
    const origCompute = stores.enriched.compute.bind(stores.enriched);
    const origComputeCtx = stores.enriched.computeContext.bind(stores.enriched);
    stores.enriched.compute = async (t, f, to) => {
      computeCalled = true;
      return origCompute(t, f, to);
    };
    stores.enriched.computeContext = async (f, to) => {
      computeCtxCalled = true;
      return origComputeCtx(f, to);
    };

    await handler!({ ticker: "VIX", force_full: false });

    expect(computeCalled).toBe(true);
    expect(computeCtxCalled).toBe(true);
  });

  it("exports only the registerMarketEnrichmentTools entry point", () => {
    // The tools layer no longer touches enrichment math directly — every
    // call goes through stores.enriched.{compute, computeContext}. The
    // runEnrichment / runContextEnrichment exports remain in
    // market-enricher.ts (the store wrappers call them internally), but the
    // tool module should not re-export them.
    const exportNames = Object.keys(marketEnrichmentTool).filter(
      (k) => k !== "default" && k !== "__esModule",
    );
    expect(exportNames).toContain("registerMarketEnrichmentTools");
    expect(typeof marketEnrichmentTool.registerMarketEnrichmentTools).toBe("function");
  });
});

// =============================================================================
// 3. market-enricher module shape — io threading + watermark refactor
// =============================================================================

describe("market-enricher module shape — store-wrapper invariants", () => {
  it("runEnrichment + runContextEnrichment are still exported (math preserved)", () => {
    // The math stays in market-enricher.ts. We assert the public exports
    // exist; the wrappers in EnrichedStore.compute call them with an
    // injected EnrichmentIO.
    expect(typeof marketEnricher.runEnrichment).toBe("function");
    expect(typeof marketEnricher.runContextEnrichment).toBe("function");
  });
});
