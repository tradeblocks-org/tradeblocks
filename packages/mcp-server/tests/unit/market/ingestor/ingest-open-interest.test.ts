import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import type { MarketDataProvider, OpenInterestRow } from "../../../../src/utils/market-provider.ts";

const CAPS_BULK = {
  tradeBars: true,
  quotes: true,
  greeks: false,
  flatFiles: false,
  bulkByRoot: true,
  perTicker: false,
  minuteBars: true,
  dailyBars: true,
};

describe("MarketIngestor.ingestOpenInterest", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-oi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    tickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
  });

  afterEach(() => {
    try {
      instance.closeSync();
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns unsupported when provider lacks fetchOpenInterest", async () => {
    const provider: MarketDataProvider = {
      name: "no-oi",
      capabilities: () => CAPS_BULK,
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: true, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestOpenInterest({
      underlyings: ["SPX"],
      from: "2024-01-15",
      to: "2024-01-15",
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/does not support open-interest/i);
  });

  it("writes daily open-interest rows partitioned by resolved underlying and date", async () => {
    const rows: OpenInterestRow[] = [
      {
        ticker: "SPXW240123P04700000",
        underlying: "SPX",
        date: "2024-01-15",
        expiration: "2024-01-23",
        strike: 4700,
        right: "put",
        open_interest: 12345,
      },
      {
        ticker: "SPXW240123C04800000",
        underlying: "SPX",
        date: "2024-01-15",
        expiration: "2024-01-23",
        strike: 4800,
        right: "call",
        open_interest: 6789,
      },
    ];
    const provider: MarketDataProvider = {
      name: "has-oi",
      capabilities: () => CAPS_BULK,
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
      fetchOpenInterest: async () => rows,
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: true, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestOpenInterest({
      underlyings: ["SPX"],
      from: "2024-01-15",
      to: "2024-01-15",
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBe(2);

    const readBack = await stores.oiDaily.readOiDaily("SPX", "2024-01-15", "2024-01-15");
    expect(readBack).toHaveLength(2);
    expect(readBack.map((r) => r.occ_ticker).sort()).toEqual([
      "SPXW240123C04800000",
      "SPXW240123P04700000",
    ]);
    // source defaults to the provider name on the ingest path.
    expect(readBack.every((r) => r.source === "has-oi")).toBe(true);
  });

  it("returns skipped on dryRun without calling the provider", async () => {
    let called = false;
    const provider: MarketDataProvider = {
      name: "has-oi",
      capabilities: () => CAPS_BULK,
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
      fetchOpenInterest: async () => {
        called = true;
        return [];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: true, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestOpenInterest({
      underlyings: ["SPX"],
      from: "2024-01-15",
      to: "2024-01-15",
      dryRun: true,
    });

    expect(result.status).toBe("skipped");
    expect(called).toBe(false);
  });
});

describe("MarketIngestor.refresh open-interest gating", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `refresh-oi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    tickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
  });

  afterEach(() => {
    try {
      instance.closeSync();
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  function provider(onFetch: () => void): MarketDataProvider {
    return {
      name: "has-oi",
      capabilities: () => CAPS_BULK,
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
      fetchOpenInterest: async () => {
        onFetch();
        return [];
      },
    };
  }

  it("does NOT run the open-interest step when openInterestUnderlyings is omitted", async () => {
    let called = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: true, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () =>
        provider(() => {
          called = true;
        }),
    });

    const result = await ingestor.refresh({
      asOf: "2024-01-15",
      spotTickers: [],
    });

    expect(called).toBe(false);
    expect(result.perOperation.openInterest).toHaveLength(0);
  });

  it("runs the open-interest step only when openInterestUnderlyings is supplied", async () => {
    let called = false;
    const stores = createMarketStores({ conn, dataDir, parquetMode: true, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () =>
        provider(() => {
          called = true;
        }),
    });

    const result = await ingestor.refresh({
      asOf: "2024-01-15",
      spotTickers: [],
      openInterestUnderlyings: ["SPX"],
    });

    expect(called).toBe(true);
    expect(result.perOperation.openInterest).toHaveLength(1);
    expect(result.perOperation.openInterest[0].status).toBe("ok");
  });
});
