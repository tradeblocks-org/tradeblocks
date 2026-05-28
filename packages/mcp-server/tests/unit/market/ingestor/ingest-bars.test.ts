import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";
import type { MarketDataProvider, BarRow } from "../../../../src/utils/market-provider.ts";

function makeFakeProvider(bars: BarRow[]): MarketDataProvider {
  return {
    name: "fake",
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
    fetchBars: async () => bars,
    fetchOptionSnapshot: async () => ({ contracts: [] }),
  };
}

describe("MarketIngestor.ingestBars", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-bars-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes daily bars for a single ticker and reports rowsWritten", async () => {
    const fakeBars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 1000000 },
      { ticker: "SPX", date: "2026-01-06", open: 4810, high: 4830, low: 4800, close: 4825, volume: 1100000 },
    ];
    const stores = createMarketStores({ conn, dataDir, parquetMode: false });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeFakeProvider(fakeBars),
    });

    const result = await ingestor.ingestBars({
      tickers: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-06",
      timespan: "1d",
      skipEnrichment: true,
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBe(2);
    expect(result.dateRange).toEqual({ from: "2026-01-05", to: "2026-01-06" });
  });

  it("writes bars for multiple tickers", async () => {
    const fakeBars: BarRow[] = [
      { ticker: "VIX", date: "2026-01-05", open: 15, high: 16, low: 14, close: 15.5, volume: 0 },
      { ticker: "VIX9D", date: "2026-01-05", open: 14, high: 15, low: 13, close: 14.5, volume: 0 },
    ];
    const stores = createMarketStores({ conn, dataDir, parquetMode: false });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeFakeProvider(fakeBars),
    });

    const result = await ingestor.ingestBars({
      tickers: ["VIX", "VIX9D"],
      from: "2026-01-05",
      to: "2026-01-05",
      skipEnrichment: true,
    });

    expect(result.status).toBe("ok");
    // Fake provider returns the full bar list per fetchBars call, so both
    // tickers receive all rows. Real providers filter by ticker. Validate
    // that the per-ticker write loop runs — expect total = bars.length * 2.
    expect(result.rowsWritten).toBe(4);
  });

  it("routes intraday timespan to minute bars", async () => {
    const intradayBars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", time: "09:30", open: 4800, high: 4802, low: 4799, close: 4801, volume: 0 },
    ];
    let capturedTimespan: string | undefined;
    const provider: MarketDataProvider = {
      ...makeFakeProvider(intradayBars),
      fetchBars: async (opts) => {
        capturedTimespan = opts.timespan;
        return intradayBars;
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    await ingestor.ingestBars({
      tickers: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
      timespan: "1m",
      skipEnrichment: true,
    });

    expect(capturedTimespan).toBe("minute");
  });

  it("honors skipEnrichment=false and fires enricher", async () => {
    const fakeBars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
    ];
    let enrichCalled = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false });
    stores.enriched.compute = async (...args) => {
      enrichCalled = true;
      return { status: "skipped", ticker: args[0], fieldsWritten: 0 } as unknown;
    };
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => makeFakeProvider(fakeBars),
    });

    await ingestor.ingestBars({
      tickers: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
      skipEnrichment: false,
    });

    expect(enrichCalled).toBe(true);
  });
});
