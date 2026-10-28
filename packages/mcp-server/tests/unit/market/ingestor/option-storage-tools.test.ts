import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  closeConnection,
  getConnection,
  getCurrentConnection,
} from "../../../../src/db/connection.ts";
import {
  createMarketStores,
  getMarketStoresAuthority,
  type MarketStores,
} from "../../../../src/market/stores/index.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import { registerMarketFetchTools } from "../../../../src/tools/market-fetch.ts";
import { MassiveProvider } from "../../../../src/utils/providers/massive.ts";
import { ThetaDataProvider } from "../../../../src/utils/providers/thetadata.ts";

const DATE = "2026-01-05";
const TICKER = "SPY260116C00600000";

describe("option storage without TRADEBLOCKS_PARQUET", () => {
  let dataDir: string;
  let server: McpServer;
  let client: Client;
  let stores: MarketStores;
  let savedMode: string | undefined;

  beforeEach(async () => {
    savedMode = process.env.TRADEBLOCKS_PARQUET;
    delete process.env.TRADEBLOCKS_PARQUET;
    dataDir = mkdtempSync(join(tmpdir(), "option-tools-"));
    await getConnection(dataDir);
    stores = createMarketStores({
      get conn() {
        return getCurrentConnection();
      },
      dataDir,
      parquetMode: process.env.TRADEBLOCKS_PARQUET === "true",
      tickers: new TickerRegistry([{ underlying: "SPY", roots: ["SPY"] }]),
    });
    server = new McpServer({ name: "option-storage-test", version: "1.0.0" });
    client = new Client({ name: "option-storage-client", version: "1.0.0" });
    registerMarketFetchTools(server, dataDir, stores);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await closeConnection();
    jest.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
    if (savedMode === undefined) delete process.env.TRADEBLOCKS_PARQUET;
    else process.env.TRADEBLOCKS_PARQUET = savedMode;
  });

  it("fetch_quotes and fetch_chain persist on a fresh install and survive reconnect", async () => {
    jest.spyOn(MassiveProvider.prototype, "fetchQuotes").mockResolvedValue(
      new Map([
        [
          `${DATE} 09:30`,
          {
            bid: 2,
            ask: 2.5,
            source: "nbbo",
            delta: 0.5,
            gamma: 0.01,
            theta: -0.1,
            vega: 0.2,
            iv: 0.2,
          },
        ],
      ]),
    );
    jest.spyOn(MassiveProvider.prototype, "fetchContractList").mockResolvedValue({
      underlying: "SPY",
      contracts: [
        {
          ticker: TICKER,
          contract_type: "call",
          strike: 600,
          expiration: "2026-01-16",
          exercise_style: "american",
        },
      ],
    });
    const quotes = await client.callTool({
      name: "fetch_quotes",
      arguments: {
        tickers: [TICKER],
        from: DATE,
        to: DATE,
        provider: "massive",
      },
    });
    expect(quotes.isError).not.toBe(true);
    expect(quotes.structuredContent).toMatchObject({ status: "ok", rowsWritten: 1 });
    const chain = await client.callTool({
      name: "fetch_chain",
      arguments: {
        underlyings: ["SPY"],
        from: DATE,
        to: DATE,
        provider: "massive",
      },
    });
    expect(chain.isError).not.toBe(true);
    expect(chain.structuredContent).toMatchObject({ status: "ok", rowsWritten: 1 });
    expect(getMarketStoresAuthority(stores)?.parquetMode).toBe(false);
    for (const reconnect of [false, true]) {
      if (reconnect) {
        await closeConnection();
        await getConnection(dataDir);
      }
      expect((await stores.quote.readQuotes([TICKER], DATE, DATE)).get(TICKER)).toEqual([
        expect.objectContaining({ bid: 2, ask: 2.5, source: "nbbo", timestamp: `${DATE} 09:30` }),
      ]);
      expect(await stores.chain.readChain("SPY", DATE)).toEqual([
        expect.objectContaining({ ticker: TICKER, strike: 600, expiration: "2026-01-16" }),
      ]);
      expect(
        (
          await getCurrentConnection().runAndReadAll(
            "SELECT count(*) FROM market.option_quote_minutes",
          )
        ).getRows(),
      ).toEqual([[1n]]);
      expect(
        (
          await getCurrentConnection().runAndReadAll("SELECT count(*) FROM market.option_chain")
        ).getRows(),
      ).toEqual([[1n]]);
    }
  });

  it("fetch_quotes bulk mode persists on a fresh install without the setting", async () => {
    jest
      .spyOn(ThetaDataProvider.prototype, "fetchBulkQuotes")
      .mockImplementation(async function* () {
        yield [
          {
            ticker: TICKER,
            timestamp: `${DATE} 09:30`,
            bid: 3,
            ask: 3.5,
            delta: 0.5,
            gamma: 0.01,
            theta: -0.1,
            vega: 0.2,
            iv: 0.2,
          },
        ];
      });
    const output = await client.callTool({
      name: "fetch_quotes",
      arguments: {
        underlyings: ["SPY"],
        from: DATE,
        to: DATE,
        provider: "thetadata",
      },
    });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent).toMatchObject({ status: "ok", rowsWritten: 1 });
    expect((await stores.quote.readQuotes([TICKER], DATE, DATE)).get(TICKER)?.[0]).toMatchObject({
      bid: 3,
      ask: 3.5,
    });
  });

  it("import_flat_file writes option CSV datasets without a provider or setting", async () => {
    const path = join(dataDir, "quotes.csv");
    writeFileSync(
      path,
      `underlying,date,ticker,time,bid,ask,mid,last_updated_ns\nSPY,${DATE},${TICKER},09:30,2,2.5,2.25,0\n`,
    );
    const output = await client.callTool({
      name: "import_flat_file",
      arguments: {
        file_path: path,
        dataset_type: "option_quotes",
        select_sql: `SELECT underlying, CAST(date AS VARCHAR) AS date, ticker, CAST(time AS VARCHAR) AS time, bid, ask, mid, last_updated_ns FROM read_csv('${path}')`,
        partition: { underlying: "SPY", date: DATE },
      },
    });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent).toMatchObject({ status: "ok", rowsWritten: 1 });
    expect((await stores.quote.readQuotes([TICKER], DATE, DATE)).get(TICKER)?.[0]).toMatchObject({
      bid: 2,
      ask: 2.5,
    });
    const chainPath = join(dataDir, "chain.csv");
    writeFileSync(
      chainPath,
      `underlying,date,ticker,contract_type,strike,expiration,dte,exercise_style\nSPY,${DATE},${TICKER},call,600,2026-01-16,11,american\n`,
    );
    const chain = await client.callTool({
      name: "import_flat_file",
      arguments: {
        file_path: chainPath,
        dataset_type: "option_chain",
        select_sql: `SELECT underlying, CAST(date AS VARCHAR) AS date, ticker, contract_type, strike, CAST(expiration AS VARCHAR) AS expiration, dte, exercise_style FROM read_csv('${chainPath}')`,
        partition: { underlying: "SPY", date: DATE },
      },
    });
    expect(chain.isError).not.toBe(true);
    expect(chain.structuredContent).toMatchObject({ status: "ok", rowsWritten: 1 });
    expect(await stores.chain.readChain("SPY", DATE)).toEqual([
      expect.objectContaining({ ticker: TICKER, strike: 600, expiration: "2026-01-16" }),
    ]);
  });
});
