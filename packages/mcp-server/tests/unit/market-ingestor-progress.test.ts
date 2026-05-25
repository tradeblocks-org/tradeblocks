import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../src/market/ingestor/index.js";
import { createMarketStores } from "../../src/market/stores/index.js";
import { ensureMarketDataTables } from "../../src/db/market-schemas.js";
import { TickerRegistry } from "../../src/market/tickers/registry.js";
import type {
  BulkProgressEvent,
  BulkProgressReporter,
} from "../../src/market/ingestor/types.js";
import type {
  BulkQuoteRow,
  BulkQuotesOptions,
  MarketDataProvider,
} from "../../src/utils/market-provider.js";
import { countBulkQuoteGroupsPerDate } from "../../src/utils/providers/thetadata.js";

/**
 * Tests for the bulk-quote progress reporter plumbing. Asserts that an
 * `onProgress` callback passed into `ingestQuotes(...)`:
 *   - fires once per (root, right, date) group when the bulk branch is taken
 *   - fires once per (underlying, date) "date-flushed" event after writes
 *   - does NOT fire on the per-ticker branch
 *   - never lets a reporter exception escape and fail the ingest
 * Also asserts the small helper `countBulkQuoteGroupsPerDate` used by the
 * tool-handler total-count calculation.
 */

describe("MarketIngestor bulk progress reporter", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `ingestor-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    // option_chain is required because enrichQuoteRows reads it for every
    // (underlying, date) batch — the .catch(() => []) swallow that previously
    // hid the missing-table error here has been removed. Without this
    // fixture the per-ticker quote ingest returns "partial".
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
    tickers = new TickerRegistry([
      { underlying: "SPX", roots: ["SPX", "SPXW"] },
      { underlying: "QQQ", roots: ["QQQ"] },
    ]);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeBulkProvider(opts: {
    /** group tuples the fake provider should emit per call */
    groupsPerCall: Array<{ root: string; right: "call" | "put" }>;
    /** optional rows yielded per call — default: empty (writeQuotes no-op) */
    rowsPerCall?: BulkQuoteRow[];
  }): MarketDataProvider {
    const groups = opts.groupsPerCall;
    const rows = opts.rowsPerCall ?? [];
    return {
      name: "fake-bulk",
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
      fetchOptionSnapshot: async () => ({
        contracts: [],
        underlying_price: 0,
        underlying_ticker: "",
      }),
      fetchBulkQuotes: async function* (
        options: BulkQuotesOptions,
      ): AsyncGenerator<BulkQuoteRow[], void, void> {
        // Simulate one producer per group finishing — in production this is
        // the producer's `finally` block; here we invoke the callback
        // synchronously after each logical "stream" completes.
        for (const g of groups) {
          try {
            // nothing to do — no rows per group in this fake
          } finally {
            (options as BulkQuotesOptions & {
              onGroupComplete?: (info: {
                root: string;
                right: "call" | "put";
                date: string;
                status: "ok" | "error";
              }) => void;
            }).onGroupComplete?.({
              root: g.root,
              right: g.right,
              date: options.date,
              status: "ok",
            });
          }
        }
        if (rows.length > 0) yield rows;
      },
    };
  }

  it("countBulkQuoteGroupsPerDate('SPX') === 4, else === 2", () => {
    expect(countBulkQuoteGroupsPerDate("SPX")).toBe(4);
    expect(countBulkQuoteGroupsPerDate("SPXW")).toBe(2);
    expect(countBulkQuoteGroupsPerDate("QQQ")).toBe(2);
    expect(countBulkQuoteGroupsPerDate("AAPL")).toBe(2);
  });

  it("bulk path: fires onProgress once per (root,right,date) group + once per (underlying,date) flush", async () => {
    // Single SPX day → 4 group events + 1 date-flushed event
    const provider = makeBulkProvider({
      groupsPerCall: [
        { root: "SPX", right: "call" },
        { root: "SPX", right: "put" },
        { root: "SPXW", right: "call" },
        { root: "SPXW", right: "put" },
      ],
    });
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const events: BulkProgressEvent[] = [];
    const onProgress: BulkProgressReporter = (ev) => { events.push(ev); };

    const result = await ingestor.ingestQuotes({
      underlyings: ["SPX"],
      from: "2026-04-15",
      to: "2026-04-15",
      onProgress,
    });

    expect(result.status).toBe("ok");

    const groupEvents = events.filter((e) => e.kind === "group");
    const flushEvents = events.filter((e) => e.kind === "date-flushed");

    expect(groupEvents.length).toBe(4); // SPX/SPXW × call/put
    expect(flushEvents.length).toBe(1); // 1 underlying × 1 date

    // Each group event carries the underlying, root, right, date, status
    const tuples = new Set(groupEvents.map((e) => {
      if (e.kind !== "group") throw new Error("unreachable");
      return `${e.underlying}/${e.root}/${e.right}/${e.date}/${e.status}`;
    }));
    expect(tuples).toContain("SPX/SPX/call/2026-04-15/ok");
    expect(tuples).toContain("SPX/SPX/put/2026-04-15/ok");
    expect(tuples).toContain("SPX/SPXW/call/2026-04-15/ok");
    expect(tuples).toContain("SPX/SPXW/put/2026-04-15/ok");

    const flush = flushEvents[0];
    expect(flush.kind).toBe("date-flushed");
    if (flush.kind === "date-flushed") {
      expect(flush.underlying).toBe("SPX");
      expect(flush.date).toBe("2026-04-15");
      expect(flush.rowsWritten).toBe(0);
    }
  });

  it("bulk path: emits events across multiple dates monotonically", async () => {
    const provider = makeBulkProvider({
      groupsPerCall: [
        { root: "QQQ", right: "call" },
        { root: "QQQ", right: "put" },
      ],
    });
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const events: BulkProgressEvent[] = [];
    const onProgress: BulkProgressReporter = (ev) => { events.push(ev); };

    await ingestor.ingestQuotes({
      underlyings: ["QQQ"],
      from: "2026-04-15",
      to: "2026-04-16",
      onProgress,
    });

    // 2 dates × 2 groups = 4 group events, plus 2 date-flushed events
    expect(events.filter((e) => e.kind === "group").length).toBe(4);
    expect(events.filter((e) => e.kind === "date-flushed").length).toBe(2);

    // Events for date 1 precede events for date 2 (dates iterate sequentially)
    const dates = events.map((e) => ("date" in e ? e.date : ""));
    const firstDate2Idx = dates.indexOf("2026-04-16");
    const lastDate1Idx = dates.lastIndexOf("2026-04-15");
    expect(lastDate1Idx).toBeLessThan(firstDate2Idx);
  });

  it("per-ticker path: onProgress is never invoked", async () => {
    const provider: MarketDataProvider = {
      name: "per-ticker",
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
        underlying_ticker: "",
      }),
      fetchQuotes: async () => {
        const map = new Map<string, { bid: number; ask: number }>();
        map.set("2026-04-15 09:30", { bid: 1.0, ask: 1.1 });
        return map;
      },
    };
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const events: BulkProgressEvent[] = [];
    const onProgress: BulkProgressReporter = (ev) => { events.push(ev); };

    const result = await ingestor.ingestQuotes({
      tickers: ["SPXW260417C04800000"],
      from: "2026-04-15",
      to: "2026-04-15",
      onProgress,
    });

    expect(result.status).toBe("ok");
    expect(events).toHaveLength(0);
  });

  it("reporter that throws does not fail the ingest", async () => {
    const provider = makeBulkProvider({
      groupsPerCall: [
        { root: "QQQ", right: "call" },
        { root: "QQQ", right: "put" },
      ],
    });
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const onProgress: BulkProgressReporter = () => {
      throw new Error("reporter boom");
    };

    const result = await ingestor.ingestQuotes({
      underlyings: ["QQQ"],
      from: "2026-04-15",
      to: "2026-04-15",
      onProgress,
    });

    expect(result.status).toBe("ok");
  });

  it("bulk path: absent onProgress behaves like today (no error)", async () => {
    const provider = makeBulkProvider({
      groupsPerCall: [
        { root: "QQQ", right: "call" },
        { root: "QQQ", right: "put" },
      ],
    });
    const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => provider,
    });

    const result = await ingestor.ingestQuotes({
      underlyings: ["QQQ"],
      from: "2026-04-15",
      to: "2026-04-15",
    });

    expect(result.status).toBe("ok");
  });
});
