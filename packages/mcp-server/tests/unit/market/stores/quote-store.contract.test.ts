/**
 * QuoteStore dual-backend contract tests (Phase 2 Plan 03 Task 3).
 *
 * Asserts:
 *   - The new multi-ticker grouped-series readQuotes (D-06 / D-08) returns
 *     Map<occTicker, QuoteRow[]> with timestamp-sorted values
 *   - Empty occTickers input short-circuits to an empty Map
 *   - Mixed-underlying input throws clearly naming BOTH conflicting OCC
 *     tickers (D-07 / Pitfall 4)
 *   - Underlying resolution flows through `extractRoot` +
 *     `ctx.tickers.resolve` — SPXW_CALL (root "SPXW") resolves to "SPX"
 *   - getCoverage reports written dates per underlying
 *   - Backend parity: Parquet and DuckDB return identical Maps
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { ParquetQuoteStore, DuckdbQuoteStore } from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import { makeQuotes } from "../../../fixtures/market-stores/quotes-fixture.ts";
import { createMarketParquetViews } from "../../../../src/db/market-views.ts";

const SPX_CALL = "SPXW250106C05000000"; // root SPXW → underlying SPX
const SPX_PUT = "SPXW250106P05000000"; // root SPXW → underlying SPX
const QQQ_CALL = "QQQ250106C00400000"; // root QQQ  → underlying QQQ

async function makeParquetQuote(): Promise<{
  store: ParquetQuoteStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  return { store: new ParquetQuoteStore(fixture.ctx), fixture };
}

async function makeDuckdbQuote(): Promise<{
  store: DuckdbQuoteStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: false });
  return { store: new DuckdbQuoteStore(fixture.ctx), fixture };
}

describe.each([
  {
    name: "parquet",
    make: makeParquetQuote,
    refreshViews: async (f: FixtureHandle) => {
      await createMarketParquetViews(f.ctx.conn, f.ctx.dataDir);
    },
  },
  {
    name: "duckdb",
    make: makeDuckdbQuote,
    refreshViews: async (_f: FixtureHandle) => {
      /* no-op */
    },
  },
])("QuoteStore contract — $name backend", ({ make, refreshViews }) => {
  let fixture: FixtureHandle;
  let store: ParquetQuoteStore | DuckdbQuoteStore;

  beforeEach(async () => {
    const built = await make();
    fixture = built.fixture;
    store = built.store;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("writeQuotes + readQuotes multi-ticker round-trip returns Map<occTicker, QuoteRow[]>", async () => {
    await store.writeQuotes("SPX", "2025-01-06", [
      ...makeQuotes(SPX_CALL, "2025-01-06"),
      ...makeQuotes(SPX_PUT, "2025-01-06"),
    ]);
    await refreshViews(fixture);

    const result = await store.readQuotes([SPX_CALL, SPX_PUT], "2025-01-06", "2025-01-06");
    expect(result.size).toBe(2);
    expect(result.get(SPX_CALL)?.length).toBe(3);
    expect(result.get(SPX_PUT)?.length).toBe(3);

    // Timestamp-sorted within each series — values follow "YYYY-MM-DD HH:MM"
    const callTimes = result.get(SPX_CALL)!.map((q) => q.timestamp.split(" ")[1]);
    expect(callTimes).toEqual(["09:30", "10:30", "15:45"]);

    // Bid/ask values round-trip
    const firstCall = result.get(SPX_CALL)![0];
    expect(firstCall.bid).toBeCloseTo(1.0, 5);
    expect(firstCall.ask).toBeCloseTo(1.1, 5);
  });

  it("readQuotes with empty occTickers returns empty Map", async () => {
    await refreshViews(fixture);
    const result = await store.readQuotes([], "2025-01-01", "2025-01-31");
    expect(result.size).toBe(0);
    expect(result).toBeInstanceOf(Map);
  });

  it("readQuotes with mixed underlyings throws clear error naming tickers (D-07 / Pitfall 4)", async () => {
    await refreshViews(fixture);

    await expect(
      store.readQuotes([SPX_CALL, QQQ_CALL], "2025-01-06", "2025-01-06"),
    ).rejects.toThrow(/mixed underlyings/i);

    await expect(
      store.readQuotes([SPX_CALL, QQQ_CALL], "2025-01-06", "2025-01-06"),
    ).rejects.toThrow(new RegExp(SPX_CALL));

    await expect(
      store.readQuotes([SPX_CALL, QQQ_CALL], "2025-01-06", "2025-01-06"),
    ).rejects.toThrow(new RegExp(QQQ_CALL));
  });

  it("readQuotes resolves underlying via ctx.tickers.resolve(extractRoot(...)) — SPXW root → SPX underlying", async () => {
    // Write into partition labelled "SPX"; OCC ticker root is "SPXW" which
    // the seeded registry maps to "SPX". Round-trip should succeed.
    await store.writeQuotes("SPX", "2025-01-06", makeQuotes(SPX_CALL, "2025-01-06"));
    await refreshViews(fixture);

    const result = await store.readQuotes([SPX_CALL], "2025-01-06", "2025-01-06");
    expect(result.get(SPX_CALL)?.length).toBe(3);
  });

  it("getCoverage reports written dates per underlying", async () => {
    await store.writeQuotes("SPX", "2025-01-06", makeQuotes(SPX_CALL, "2025-01-06"));
    await store.writeQuotes("SPX", "2025-01-07", makeQuotes(SPX_CALL, "2025-01-07"));
    await refreshViews(fixture);

    const cov = await store.getCoverage("SPX", "2025-01-01", "2025-01-31");
    expect(cov.earliest).toBe("2025-01-06");
    expect(cov.latest).toBe("2025-01-07");
    expect(cov.totalDates).toBe(2);
    expect(cov.missingDates).toEqual([]);
  });

  it("getCoverage on underlying with no rows returns empty report", async () => {
    await refreshViews(fixture);
    const cov = await store.getCoverage("QQQ", "2025-01-01", "2025-01-31");
    expect(cov.earliest).toBeNull();
    expect(cov.latest).toBeNull();
    expect(cov.totalDates).toBe(0);
  });

  it("writeFromSelect lands rows in the partition and is readable via readQuotes", async () => {
    const selectSql = `
      SELECT * FROM (VALUES
        ('SPX', '2025-01-06', '${SPX_CALL}', '09:30', 1.0, 1.1, 1.05, NULL::BIGINT, NULL::VARCHAR),
        ('SPX', '2025-01-06', '${SPX_CALL}', '10:30', 1.2, 1.3, 1.25, NULL::BIGINT, NULL::VARCHAR)
      ) t(underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source)
    `;
    const { rowCount } = await store.writeFromSelect(
      { underlying: "SPX", date: "2025-01-06" },
      selectSql,
    );
    expect(rowCount).toBe(2);
    await refreshViews(fixture);

    const result = await store.readQuotes([SPX_CALL], "2025-01-06", "2025-01-06");
    expect(result.get(SPX_CALL)?.length).toBe(2);
  });
});

describe("QuoteStore backend parity", () => {
  it("Parquet and DuckDB return identical readQuotes output for the same input", async () => {
    const p = await makeParquetQuote();
    const d = await makeDuckdbQuote();
    try {
      const quotes = makeQuotes(SPX_CALL, "2025-01-06");
      await p.store.writeQuotes("SPX", "2025-01-06", quotes);
      await d.store.writeQuotes("SPX", "2025-01-06", quotes);
      await createMarketParquetViews(p.fixture.ctx.conn, p.fixture.ctx.dataDir);

      const fromP = await p.store.readQuotes([SPX_CALL], "2025-01-06", "2025-01-06");
      const fromD = await d.store.readQuotes([SPX_CALL], "2025-01-06", "2025-01-06");
      expect(Array.from(fromP.keys()).sort()).toEqual(Array.from(fromD.keys()).sort());
      expect(fromP.get(SPX_CALL)).toEqual(fromD.get(SPX_CALL));
    } finally {
      p.fixture.cleanup();
      d.fixture.cleanup();
    }
  });
});
