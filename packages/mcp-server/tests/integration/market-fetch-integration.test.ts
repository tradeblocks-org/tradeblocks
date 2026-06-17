import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../src/test-exports.ts";
import { createMarketStores } from "../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../src/db/market-schemas.ts";
import type { MarketDataProvider, BarRow } from "../../src/utils/market-provider.ts";

// Integration-level smoke: MarketIngestor wired against real stores on
// in-memory DuckDB, with a fake provider emitting deterministic bars.
// Full MCP-server smoke (live provider) runs in Task 3.4 via mcptools per
// CLAUDE.md "MANDATORY after implementation work on the MCP server".

describe("market-fetch integration", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `market-fetch-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it("ingestBars → readDailyBars round-trip writes and reads back SPX daily data", async () => {
    const bars: BarRow[] = [
      { ticker: "SPX", date: "2026-01-05", open: 4800, high: 4820, low: 4790, close: 4810, volume: 0 },
      { ticker: "SPX", date: "2026-01-06", open: 4810, high: 4830, low: 4800, close: 4825, volume: 0 },
    ];
    const provider: MarketDataProvider = {
      name: "integration",
      capabilities: () => ({
        tradeBars: true, quotes: false, greeks: false,
        flatFiles: false, bulkByRoot: false, perTicker: true,
        minuteBars: true, dailyBars: true,
      }),
      fetchBars: async () => bars,
      fetchOptionSnapshot: async () => ({ contracts: [] }),
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
      to: "2026-01-06",
      skipEnrichment: true,
    });

    const readBack = await stores.spot.readDailyBars("SPX", "2026-01-05", "2026-01-06");
    expect(readBack).toHaveLength(2);
    expect(readBack[0].close).toBe(4810);
    expect(readBack[1].close).toBe(4825);
  });
});
