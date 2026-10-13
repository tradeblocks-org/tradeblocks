import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import type { MarketDataProvider } from "../../../../src/utils/market-provider.ts";
import { MassiveProvider } from "../../../../src/utils/providers/massive.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMarketFetchTools } from "../../../../src/tools/market-fetch.ts";
import { closeConnection } from "../../../../src/db/connection.ts";

describe("MarketIngestor.ingestQuotes", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `ingestor-quotes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    // option_chain + option_quote_minutes are not created by ensureMarketDataTables
    // (they're Parquet views in production; tests must create the physical fallback
    // tables directly). option_chain is required because enrichQuoteRows reads it
    // for every (underlying, date) batch — the .catch(() => []) swallow that
    // previously hid the missing-table error here has been removed.
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
        PRIMARY KEY (underlying, date, ticker, time)
      )
    `);
    tickers = new TickerRegistry([{ underlying: "SPXW", roots: ["SPXW"] }]);
  });

  afterEach(() => {
    try {
      instance.closeSync();
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns unsupported when provider lacks fetchQuotes", async () => {
    const provider: MarketDataProvider = {
      name: "no-quotes",
      capabilities: () => ({
        tradeBars: true,
        quotes: false,
        greeks: false,
        flatFiles: false,
        bulkByRoot: false,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260319C04800000"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/fetchQuotes|per-ticker/i);
  });

  it("writes quotes when provider supports fetchQuotes", async () => {
    const provider: MarketDataProvider = {
      name: "has-quotes",
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
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchQuotes: async () => {
        const map = new Map<string, { bid: number; ask: number }>();
        map.set("2026-01-05 09:30", { bid: 10.0, ask: 10.5 });
        map.set("2026-01-05 09:31", { bid: 10.1, ask: 10.6 });
        return map;
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260319C04800000"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBe(2);
  });

  it("reports error when the only trading day in a Fri–Sun range fails", async () => {
    const savedKey = process.env.MASSIVE_API_KEY;
    const savedTier = process.env.MASSIVE_DATA_TIER;
    process.env.MASSIVE_API_KEY = "test-key";
    process.env.MASSIVE_DATA_TIER = "quotes";
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    try {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const result = await new MarketIngestor({
        stores,
        dataRoot: dataDir,
        providerFactory: () => new MassiveProvider(),
      }).ingestQuotes({
        tickers: ["SPXW260319C04800000"],
        from: "2026-01-09",
        to: "2026-01-11",
      });
      expect(result.status).toBe("error");
      expect(result.rowsWritten).toBe(0);
      expect(result.requests).toEqual([
        {
          ticker: "SPXW260319C04800000",
          date: "2026-01-09",
          outcome: "error",
          httpStatus: 403,
          errorClass: "http_status",
          pagesFetched: 0,
          rows: 0,
        },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      if (savedKey === undefined) delete process.env.MASSIVE_API_KEY;
      else process.env.MASSIVE_API_KEY = savedKey;
      if (savedTier === undefined) delete process.env.MASSIVE_DATA_TIER;
      else process.env.MASSIVE_DATA_TIER = savedTier;
    }
  });

  it("declares mixed Massive quote requests partial and never caches a failed date", async () => {
    const savedKey = process.env.MASSIVE_API_KEY;
    const savedTier = process.env.MASSIVE_DATA_TIER;
    process.env.MASSIVE_API_KEY = "test-key";
    process.env.MASSIVE_DATA_TIER = "quotes";
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const quote = {
      bid_price: 10,
      ask_price: 11,
      bid_size: 1,
      ask_size: 1,
      sequence_number: 1,
      sip_timestamp: Date.parse("2026-01-05T14:30:00Z") * 1_000_000,
    };
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "OK",
            request_id: "first",
            results: [quote],
            next_url: "https://api.massive.com/page2",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "OK",
            request_id: "second",
            results: [
              {
                ...quote,
                sip_timestamp: Date.parse("2026-01-06T14:30:00Z") * 1_000_000,
              },
            ],
          }),
        ),
      );
    try {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({
        stores,
        dataRoot: dataDir,
        providerFactory: () => new MassiveProvider(),
      });
      const result = await ingestor.ingestQuotes({
        tickers: ["SPXW260319C04800000"],
        from: "2026-01-05",
        to: "2026-01-06",
      });
      expect(result.status).toBe("partial");
      expect(result.rowsWritten).toBe(1);
      expect(result.requests).toEqual([
        {
          ticker: "SPXW260319C04800000",
          date: "2026-01-05",
          outcome: "error",
          httpStatus: 403,
          errorClass: "http_status",
          pagesFetched: 1,
          rows: 0,
        },
        {
          ticker: "SPXW260319C04800000",
          date: "2026-01-06",
          outcome: "ok",
          pagesFetched: 1,
          rows: 1,
        },
      ]);
      const failed = await stores.quote.readQuotes(
        ["SPXW260319C04800000"],
        "2026-01-05",
        "2026-01-05",
        [],
      );
      const complete = await stores.quote.readQuotes(
        ["SPXW260319C04800000"],
        "2026-01-06",
        "2026-01-06",
        [],
      );
      expect(failed.get("SPXW260319C04800000") ?? []).toHaveLength(0);
      expect(complete.get("SPXW260319C04800000")).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      if (savedKey === undefined) delete process.env.MASSIVE_API_KEY;
      else process.env.MASSIVE_API_KEY = savedKey;
      if (savedTier === undefined) delete process.env.MASSIVE_DATA_TIER;
      else process.env.MASSIVE_DATA_TIER = savedTier;
    }
  });

  it("fetch_quotes reports failures and genuine emptiness through actual MCP output", async () => {
    const savedKey = process.env.MASSIVE_API_KEY;
    const savedTier = process.env.MASSIVE_DATA_TIER;
    process.env.MASSIVE_API_KEY = "test-key";
    process.env.MASSIVE_DATA_TIER = "quotes";
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const server = new McpServer({ name: "quotes-test", version: "1.0.0" });
    const client = new Client({ name: "quotes-client", version: "1.0.0" });
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    registerMarketFetchTools(server, dataDir, stores);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const scenarios = [
        {
          response: new Response("", { status: 403 }),
          outcome: "error",
          errorClass: "http_status",
          httpStatus: 403,
          pagesFetched: 0,
        },
        {
          response: new Response(JSON.stringify({ broken: true })),
          outcome: "error",
          errorClass: "invalid_payload",
          httpStatus: 200,
          pagesFetched: 0,
        },
        { error: new Error("network"), outcome: "error", errorClass: "exception", pagesFetched: 0 },
        {
          error: new DOMException("deadline", "TimeoutError"),
          outcome: "error",
          errorClass: "timeout",
          pagesFetched: 0,
        },
        {
          response: new Response(
            JSON.stringify({ status: "OK", request_id: "empty", results: [] }),
          ),
          outcome: "empty",
          pagesFetched: 1,
        },
      ];
      for (const scenario of scenarios) {
        fetchSpy.mockReset();
        if (scenario.error) fetchSpy.mockRejectedValueOnce(scenario.error);
        else fetchSpy.mockResolvedValueOnce(scenario.response!);
        const output = await client.callTool({
          name: "fetch_quotes",
          arguments: {
            tickers: ["SPXW260319C04800000"],
            from: "2026-01-05",
            to: "2026-01-05",
            provider: "massive",
          },
        });
        const structured = output.structuredContent as Record<string, unknown>;
        expect(structured.status).toBe(scenario.outcome === "error" ? "error" : "ok");
        expect(structured.rowsWritten).toBe(0);
        expect(structured.requests).toEqual([
          {
            ticker: "SPXW260319C04800000",
            date: "2026-01-05",
            outcome: scenario.outcome,
            rows: 0,
            pagesFetched: scenario.pagesFetched,
            ...(scenario.errorClass ? { errorClass: scenario.errorClass } : {}),
            ...(scenario.httpStatus !== undefined ? { httpStatus: scenario.httpStatus } : {}),
          },
        ]);
        const text = (output.content as { text: string }[]).map((item) => item.text).join("\n");
        if (scenario.outcome === "error") expect(text).toMatch(/Error:.*failed/);
        else expect(text).toContain("ok: wrote 0 quote rows");
      }
    } finally {
      await client.close();
      await server.close();
      await closeConnection();
      fetchSpy.mockRestore();
      if (savedKey === undefined) delete process.env.MASSIVE_API_KEY;
      else process.env.MASSIVE_API_KEY = savedKey;
      if (savedTier === undefined) delete process.env.MASSIVE_DATA_TIER;
      else process.env.MASSIVE_DATA_TIER = savedTier;
    }
  });

  it("errors when neither tickers nor underlyings is provided", async () => {
    const provider: MarketDataProvider = {
      name: "any",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({ from: "2026-01-05", to: "2026-01-05" });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/tickers.*underlyings/i);
  });

  it("errors when both tickers and underlyings are provided", async () => {
    const provider: MarketDataProvider = {
      name: "any",
      capabilities: () => ({
        tradeBars: true,
        quotes: true,
        greeks: false,
        flatFiles: false,
        bulkByRoot: true,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260319C04800000"],
      underlyings: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("error");
  });

  it("bulk path: returns unsupported when provider lacks fetchBulkQuotes", async () => {
    const provider: MarketDataProvider = {
      name: "per-ticker-only",
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
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchQuotes: async () => new Map(),
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      underlyings: ["SPX"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/bulk-by-underlying/i);
  });

  it("bulk path: writes all rows yielded by fetchBulkQuotes", async () => {
    let bulkCalls = 0;
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
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchBulkQuotes: async function* ({ underlying, date }) {
        bulkCalls++;
        expect(underlying).toBe("SPXW");
        expect(date).toBe("2026-01-05");
        yield [
          { ticker: "SPXW260319C04800000", timestamp: "2026-01-05 09:30", bid: 10.0, ask: 10.5 },
          { ticker: "SPXW260319C04800000", timestamp: "2026-01-05 09:31", bid: 10.1, ask: 10.6 },
        ];
        yield [
          { ticker: "SPXW260319P04800000", timestamp: "2026-01-05 09:30", bid: 20.0, ask: 20.5 },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      underlyings: ["SPXW"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("ok");
    expect(bulkCalls).toBe(1);
    expect(result.rowsWritten).toBe(3);
    expect(result.dateRange).toEqual({ from: "2026-01-05", to: "2026-01-05" });
  });

  it("bulk path: non-standard wide-strike tickers land in the requested underlying (regression: 2024-07-09 leak)", async () => {
    // Before the resolver.ts OCC_RE fix, tickers with 9- or 10-digit strikes
    // (e.g. SPX240719C1262721200, SPX240719P845310800 — real examples from
    // ThetaData on 2024-07-09) failed extractRoot and leaked into per-OCC
    // partitions via the registry identity-fallback. This test writes one of
    // each and asserts every row lands under underlying="SPX".
    const spxTickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
    const provider: MarketDataProvider = {
      name: "bulk-wide-strike",
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
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchBulkQuotes: async function* () {
        yield [
          // 8-digit (standard) — sanity row
          { ticker: "SPX240719C00560000", timestamp: "2024-07-09 09:30", bid: 1.0, ask: 1.2 },
          // 9-digit (non-standard, observed in the 2024-07-09 leak)
          { ticker: "SPX240719C845310800", timestamp: "2024-07-09 09:30", bid: 2.0, ask: 2.2 },
          // 10-digit (non-standard, observed in the 2024-07-09 leak)
          { ticker: "SPX240719C1262721200", timestamp: "2024-07-09 09:30", bid: 3.0, ask: 3.2 },
        ];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers: spxTickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      underlyings: ["SPX"],
      from: "2024-07-09",
      to: "2024-07-09",
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBe(3);

    // All three rows must sit under underlying="SPX" — not under the raw OCC strings.
    const reader = await conn.runAndReadAll(
      `SELECT underlying, COUNT(*) AS n FROM market.option_quote_minutes GROUP BY underlying ORDER BY underlying`,
    );
    const rows = reader.getRows() as Array<[string, bigint | number]>;
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("SPX");
    expect(Number(rows[0][1])).toBe(3);
  });

  it("bulk path: resolution mismatch aborts the ingest (defense-in-depth)", async () => {
    // A row whose ticker resolves to a different underlying than requested
    // must throw instead of silently writing to the wrong partition. We force
    // the mismatch by yielding a QQQ ticker from a request for underlying=SPX.
    const mixedTickers = new TickerRegistry([
      { underlying: "SPX", roots: ["SPX", "SPXW"] },
      { underlying: "QQQ", roots: ["QQQ"] },
    ]);
    const provider: MarketDataProvider = {
      name: "bulk-mismatch",
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
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchBulkQuotes: async function* () {
        yield [{ ticker: "QQQ241227P00500000", timestamp: "2024-12-20 09:30", bid: 1.0, ask: 1.2 }];
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers: mixedTickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    await expect(
      ingestor.ingestQuotes({
        underlyings: ["SPX"],
        from: "2024-12-20",
        to: "2024-12-20",
      }),
    ).rejects.toThrow(/root resolution mismatch/);
  });

  it("ingestQuotes per-ticker mode dispatches to provider.fetchQuotes even when caps.quotes=false", async () => {
    // Massive's Developer-tier shape: capability strict-NBBO=false, but the
    // provider has its own internal tier-aware fallback in fetchQuotes.
    const provider: MarketDataProvider = {
      name: "test-provider",
      capabilities: () => ({
        tradeBars: true,
        quotes: false,
        greeks: false,
        flatFiles: false,
        bulkByRoot: false,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      fetchQuotes: async () => {
        const m = new Map<string, { bid: number; ask: number }>();
        m.set("2026-01-05 09:30", { bid: 10.0, ask: 10.5 });
        return m;
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260319C04800000"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("ok"); // not "unsupported"
    expect(result.rowsWritten).toBe(1);
  });

  it("ingestQuotes per-ticker mode returns unsupported when provider has no fetchQuotes method", async () => {
    const provider: MarketDataProvider = {
      name: "no-quotes-provider",
      capabilities: () => ({
        tradeBars: true,
        quotes: false,
        greeks: false,
        flatFiles: false,
        bulkByRoot: false,
        perTicker: true,
        minuteBars: true,
        dailyBars: true,
      }),
      fetchBars: async () => [],
      fetchOptionSnapshot: async () => ({ contracts: [] }),
      // fetchQuotes intentionally omitted
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260319C04800000"],
      from: "2026-01-05",
      to: "2026-01-05",
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toMatch(/fetchQuotes|per-ticker/i);
  });

  it("ingestQuotes uses fetchBars fallback synthesis when MASSIVE_DATA_TIER is unset", async () => {
    delete process.env.MASSIVE_DATA_TIER;
    process.env.MASSIVE_API_KEY = "test-key";

    const fetchSpy = jest.spyOn(globalThis, "fetch") as unknown as jest.SpiedFunction<typeof fetch>;
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ticker: "O:SPX250107C05000000",
          queryCount: 1,
          resultsCount: 1,
          adjusted: false,
          results: [
            { v: 50, vw: 13.0, o: 12.8, c: 13.2, h: 13.5, l: 12.5, t: 1736260200000, n: 10 },
          ],
          status: "OK",
          request_id: "req-001",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const provider = new MassiveProvider();
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      tickers: ["SPX250107C05000000"],
      from: "2025-01-07",
      to: "2025-01-07",
    });

    expect(result.status).toBe("ok");
    expect(result.rowsWritten).toBe(1);

    // Read back via the store reader. parquetMode: false → DuckdbQuoteStore.
    // Both backends now persist `source` (Task 5).
    const persisted = await stores.quote.readQuotes(
      ["SPX250107C05000000"],
      "2025-01-07",
      "2025-01-07",
    );
    const rows = persisted.get("SPX250107C05000000")!;
    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBe(13.2);
    expect(rows[0].ask).toBe(13.2);
    expect(rows[0].source).toBe("synth_close");
    expect(rows[0].occ_ticker).toBe("SPX250107C05000000");

    fetchSpy.mockRestore();
    delete process.env.MASSIVE_API_KEY;
  });
});
