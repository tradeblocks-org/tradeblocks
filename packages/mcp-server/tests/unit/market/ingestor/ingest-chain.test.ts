import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import type { MarketDataProvider } from "../../../../src/utils/market-provider.ts";

describe("MarketIngestor.ingestChain", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    // option_chain is NOT created by ensureMarketDataTables — in production it is a
    // Parquet-backed view. Tests must create the physical fallback table directly.
    await conn.run(`
      CREATE TABLE IF NOT EXISTS market.option_chain (
        underlying     VARCHAR NOT NULL,
        date           VARCHAR NOT NULL,
        ticker         VARCHAR NOT NULL,
        contract_type  VARCHAR NOT NULL,
        strike         DOUBLE,
        expiration     VARCHAR,
        dte            INTEGER,
        exercise_style VARCHAR,
        PRIMARY KEY (underlying, date, ticker)
      )
    `);
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

  it("returns unsupported when provider lacks fetchContractList", async () => {
    const provider: MarketDataProvider = {
      name: "no-chain",
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
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestChain({
      underlyings: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/does not support/i);
  });

  it("writes chain rows when provider supports fetchContractList", async () => {
    const provider: MarketDataProvider = {
      name: "has-chain",
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
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "SPX",
      }),
      // Real signature: fetchContractList(opts: FetchContractListOptions): Promise<FetchContractListResult>
      // FetchContractListOptions: { underlying, as_of, expired?, expiration_date_gte?, expiration_date_lte? }
      // FetchContractListResult: { contracts: ContractReference[], underlying: string }
      // ContractReference: { ticker, contract_type, strike, expiration, exercise_style }
      fetchContractList: async () => ({
        underlying: "SPX",
        contracts: [
          {
            ticker: "SPXW260319C04800000",
            contract_type: "call" as const,
            strike: 4800,
            expiration: "2026-03-19",
            exercise_style: "european",
          },
          {
            ticker: "SPXW260319P04800000",
            contract_type: "put" as const,
            strike: 4800,
            expiration: "2026-03-19",
            exercise_style: "european",
          },
        ],
      }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestChain({
      underlyings: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});
