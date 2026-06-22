/**
 * Round-trip integration test for spot backfill → enriched layout →
 * verification.
 *
 * Drives a small-scale backfill-compute-verify cycle end-to-end against a
 * tmp Parquet fixture with a mocked provider. Asserts that:
 *   - spot/ticker=X/date=Y/data.parquet exists after SpotStore.writeBars
 *   - enriched/ticker=X/data.parquet exists, no OHLCV columns (via
 *     writeEnrichedTickerFile — the canonical write primitive that the
 *     stores-based `EnrichedStore.compute` is wired through; some legacy
 *     daily.parquet plumbing remains and is exercised separately)
 *   - enriched/context/data.parquet exists with cross-ticker fields (via
 *     writeEnrichedContext)
 *   - compareRow.anyFailure=true when Gap_Pct drift exceeds 1e-9
 *   - In-process round-trip: MockProvider.fetchBars → SpotStore.writeBars
 *     surfaces as coverage and via the canonical view
 *
 * Pattern adapted from tests/unit/quote-backfill.test.ts (MockProvider +
 * buildStoreFixture) and tests/integration/parquet-read-layer.test.ts
 * (Parquet COPY / DESCRIBE verification).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync } from "fs";
import { join } from "path";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import {
  createMarketStores,
  writeEnrichedTickerFile,
  writeEnrichedContext,
  compareRow,
  DOUBLE_EPSILON,
  ENRICHED_FIELD_TYPES,
  selectVerificationSampleDates,
  type MarketStores,
} from "../../src/test-exports.ts";
import type {
  MarketDataProvider,
  ProviderCapabilities,
  BarRow,
  FetchBarsOptions,
  FetchSnapshotOptions,
  FetchSnapshotResult,
} from "../../src/utils/market-provider.ts";

// ---------------------------------------------------------------------------
// MockProvider — deterministic synthetic minute bars for RTH 09:30–16:00 ET.
// Returns 391 bars per day with close = 5000 + (dayIdx*0.25) + (minuteIdx*0.01)
// so downstream enrichment math runs cleanly against monotonic inputs.
// ---------------------------------------------------------------------------
class MockProvider implements MarketDataProvider {
  readonly name = "mock";

  capabilities(): ProviderCapabilities {
    return {
      tradeBars: true,
      quotes: false,
      greeks: false,
      flatFiles: false,
      bulkByRoot: false,
      perTicker: true,
      minuteBars: true,
      dailyBars: true,
    };
  }

  async fetchBars(opts: FetchBarsOptions): Promise<BarRow[]> {
    // Emit synthetic 1-minute bars 09:30..16:00 ET inclusive (391 bars).
    const bars: BarRow[] = [];
    const epoch = new Date(opts.from + "T12:00:00Z").getTime();
    const dayIdx = Math.floor(epoch / (1000 * 60 * 60 * 24));
    for (let mi = 0; mi <= 390; mi++) {
      const totalMinutes = 9 * 60 + 30 + mi;
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const close = 5000 + dayIdx * 0.25 + mi * 0.01;
      bars.push({
        ticker: opts.ticker,
        date: opts.from,
        time,
        open: close,
        high: close + 0.05,
        low: close - 0.05,
        close,
        volume: 1000,
      });
    }
    return bars;
  }

  async fetchOptionSnapshot(_opts: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
    return { contracts: [], underlying_price: 0, underlying_ticker: "SPX" };
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("market data round-trip — spot backfill → enriched layout → verification", () => {
  let handle: FixtureHandle;
  let stores: MarketStores;
  const mockProvider = new MockProvider();

  beforeEach(async () => {
    handle = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(handle.ctx);
    // Register views so market.spot / market.enriched /
    // market.enriched_context resolve when their partitions exist.
    await createMarketParquetViews(handle.ctx.conn, handle.ctx.dataDir);
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("spot layout — spot/ticker=X/date=Y/data.parquet exists after writeBars", async () => {
    const bars = await mockProvider.fetchBars({
      ticker: "SPX",
      from: "2024-08-05",
      to: "2024-08-05",
      timespan: "minute",
      multiplier: 1,
      assetClass: "index",
    });
    await stores.spot.writeBars("SPX", "2024-08-05", bars);

    const expected = join(
      handle.ctx.dataDir,
      "market/spot/ticker=SPX/date=2024-08-05/data.parquet",
    );
    expect(existsSync(expected)).toBe(true);

    // Coverage reflects the write end-to-end.
    const cov = await stores.spot.getCoverage("SPX", "2024-08-05", "2024-08-05");
    expect(cov.totalDates).toBe(1);
    expect(cov.earliest).toBe("2024-08-05");
    expect(cov.latest).toBe("2024-08-05");
  });

  it("enriched layout — enriched/ticker=X/data.parquet exists, no OHLCV columns", async () => {
    // Stage an enriched row via the canonical write primitive. Eventually
    // `stores.enriched.compute` calls this helper directly; here we exercise
    // it on its own to prove the target layout is buildable independent of
    // any legacy daily.parquet plumbing.
    await handle.ctx.conn.run(
      `CREATE TEMP TABLE _enriched_stage AS
        SELECT 'SPX' AS ticker, '2024-08-05' AS date,
               4999.5::DOUBLE AS Prior_Close, 0.05::DOUBLE AS Gap_Pct,
               0.8::DOUBLE AS ATR_Pct, 55.0::DOUBLE AS RSI_14,
               1::INTEGER AS Gap_Filled, 1::INTEGER AS Day_of_Week,
               8::INTEGER AS Month, 0::INTEGER AS Is_Opex`,
    );
    await writeEnrichedTickerFile(handle.ctx.conn, {
      dataDir: handle.ctx.dataDir,
      ticker: "SPX",
      selectQuery: `SELECT * FROM _enriched_stage`,
    });

    const expected = join(handle.ctx.dataDir, "market/enriched/ticker=SPX/data.parquet");
    expect(existsSync(expected)).toBe(true);

    // Assert the enriched file schema does NOT include OHLCV — enriched
    // holds computed fields only.
    const schema = await handle.ctx.conn.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet('${expected}')`,
    );
    const cols = schema.getRows().map((r) => String(r[0]).toLowerCase());
    for (const ohlcv of ["open", "high", "low", "close", "volume"]) {
      expect(cols).not.toContain(ohlcv);
    }
    // And it MUST include at least the computed fields we staged.
    expect(cols).toContain("rsi_14");
    expect(cols).toContain("atr_pct");
    expect(cols).toContain("gap_pct");
  });

  it("context layout — enriched/context/data.parquet exists with cross-ticker fields", async () => {
    await handle.ctx.conn.run(
      `CREATE TEMP TABLE _context_stage AS
        SELECT '2024-08-05' AS date,
               6::INTEGER AS Vol_Regime,
               0::INTEGER AS Term_Structure_State,
               'bear'::VARCHAR AS Trend_Direction,
               65.0::DOUBLE AS VIX_Spike_Pct,
               20.0::DOUBLE AS VIX_Gap_Pct`,
    );
    await writeEnrichedContext(handle.ctx.conn, {
      dataDir: handle.ctx.dataDir,
      selectQuery: `SELECT * FROM _context_stage`,
    });

    const expected = join(handle.ctx.dataDir, "market/enriched/context/data.parquet");
    expect(existsSync(expected)).toBe(true);

    const schema = await handle.ctx.conn.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet('${expected}')`,
    );
    const cols = schema.getRows().map((r) => String(r[0]));
    expect(cols).toContain("Vol_Regime");
    expect(cols).toContain("Term_Structure_State");
    expect(cols).toContain("Trend_Direction");
  });

  it("drift detection — Gap_Pct delta 5e-8 exceeds 1e-9 tolerance", () => {
    const oldRow = { Gap_Pct: 0.01 };
    const newRow = { Gap_Pct: 0.01 + 5e-8 };
    const diff = compareRow(oldRow, newRow, "enriched", "SPX", "2024-08-05");
    expect(diff.anyFailure).toBe(true);
    const gap = diff.fields.find((f) => f.field === "Gap_Pct");
    expect(gap?.passed).toBe(false);
    expect(gap?.delta).toBeGreaterThan(DOUBLE_EPSILON);
    // Sanity — ENRICHED_FIELD_TYPES knows Gap_Pct is a double.
    expect(ENRICHED_FIELD_TYPES.Gap_Pct).toBe("double");
  });

  it("in-process backfill via MockProvider writes spot/ partition and coverage reports it", async () => {
    // Small 3-date backfill — first 3 sample dates that are ≥ 2024 so MockProvider's
    // deterministic close values are reasonable.
    const allSamples = selectVerificationSampleDates("2024-01-01", "2024-12-31", 20260418, 1);
    const dates = allSamples.slice(0, 3).map((s) => s.date);
    for (const d of dates) {
      const bars = await mockProvider.fetchBars({
        ticker: "SPX",
        from: d,
        to: d,
        timespan: "minute",
        multiplier: 1,
        assetClass: "index",
      });
      await stores.spot.writeBars("SPX", d, bars);
    }

    // Every written partition is now reflected in coverage.
    const cov = await stores.spot.getCoverage("SPX", dates[0], dates[dates.length - 1]);
    expect(cov.totalDates).toBe(dates.length);

    // Re-read via the view and count.
    await createMarketParquetViews(handle.ctx.conn, handle.ctx.dataDir);
    const res = await handle.ctx.conn.runAndReadAll(
      `SELECT COUNT(*) FROM market.spot WHERE ticker = 'SPX'`,
    );
    const total = Number(res.getRows()[0][0]);
    // MockProvider emits 391 bars/day × dates.length
    expect(total).toBe(391 * dates.length);
  });
});
