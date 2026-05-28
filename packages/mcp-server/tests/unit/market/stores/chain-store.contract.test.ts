/**
 * ChainStore dual-backend contract tests (Phase 2 Plan 03 Task 2).
 *
 * Mirrors spot-store.contract.test.ts: `describe.each([parquet, duckdb])` runs
 * the same suite against both backends, plus a final parity describe block
 * asserts that both backends return identical readChain output for the same
 * writeChain input.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  ParquetChainStore,
  DuckdbChainStore,
} from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import { makeContracts } from "../../../fixtures/market-stores/contracts-fixture.ts";
import { createMarketParquetViews } from "../../../../src/db/market-views.ts";

async function makeParquetChain(): Promise<{
  store: ParquetChainStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  return { store: new ParquetChainStore(fixture.ctx), fixture };
}

async function makeDuckdbChain(): Promise<{
  store: DuckdbChainStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: false });
  return { store: new DuckdbChainStore(fixture.ctx), fixture };
}

describe.each([
  {
    name: "parquet",
    make: makeParquetChain,
    refreshViews: async (f: FixtureHandle) => {
      await createMarketParquetViews(f.ctx.conn, f.ctx.dataDir);
    },
  },
  {
    name: "duckdb",
    make: makeDuckdbChain,
    refreshViews: async (_f: FixtureHandle) => {
      /* no-op */
    },
  },
])("ChainStore contract — $name backend", ({ make, refreshViews }) => {
  let fixture: FixtureHandle;
  let store: ParquetChainStore | DuckdbChainStore;

  beforeEach(async () => {
    const built = await make();
    fixture = built.fixture;
    store = built.store;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("writeChain + readChain round-trip (3 contracts)", async () => {
    const rows = makeContracts("SPX", "2025-01-06");
    await store.writeChain("SPX", "2025-01-06", rows);
    await refreshViews(fixture);

    const read = await store.readChain("SPX", "2025-01-06");
    expect(read.length).toBe(3);
    expect(read.map((r) => r.ticker).sort()).toEqual(
      rows.map((r) => r.ticker).sort(),
    );
    expect(read.every((r) => r.underlying === "SPX")).toBe(true);
    expect(read.every((r) => r.date === "2025-01-06")).toBe(true);
  });

  it("writeChain empty array is a no-op", async () => {
    await store.writeChain("SPX", "2025-01-06", []);
    await refreshViews(fixture);
    const read = await store.readChain("SPX", "2025-01-06");
    expect(read).toEqual([]);
  });

  it("getCoverage reports written dates with correct earliest/latest/totalDates", async () => {
    await store.writeChain("SPX", "2025-01-06", makeContracts("SPX", "2025-01-06"));
    await store.writeChain("SPX", "2025-01-07", makeContracts("SPX", "2025-01-07"));
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

  it("writeFromSelect lands rows in the partition and is readable via readChain", async () => {
    const selectSql = `
      SELECT * FROM (VALUES
        ('SPX', '2025-01-06', 'SPXW250106C04700000', 'call', 4700.0, '2025-01-06', 0, 'european'),
        ('SPX', '2025-01-06', 'SPXW250106P04700000', 'put',  4700.0, '2025-01-06', 0, 'european')
      ) t(underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style)
    `;
    const { rowCount } = await store.writeFromSelect(
      { underlying: "SPX", date: "2025-01-06" },
      selectSql,
    );
    expect(rowCount).toBe(2);
    await refreshViews(fixture);

    const read = await store.readChain("SPX", "2025-01-06");
    expect(read.length).toBe(2);
    expect(read.map((r) => r.contract_type).sort()).toEqual(["call", "put"]);
  });
});

describe("ChainStore backend parity", () => {
  it("Parquet and DuckDB return identical readChain output for the same input", async () => {
    const p = await makeParquetChain();
    const d = await makeDuckdbChain();
    try {
      const rows = makeContracts("SPX", "2025-01-06");
      await p.store.writeChain("SPX", "2025-01-06", rows);
      await d.store.writeChain("SPX", "2025-01-06", rows);
      await createMarketParquetViews(p.fixture.ctx.conn, p.fixture.ctx.dataDir);

      const fromP = (await p.store.readChain("SPX", "2025-01-06")).sort(
        (a, b) => a.ticker.localeCompare(b.ticker),
      );
      const fromD = (await d.store.readChain("SPX", "2025-01-06")).sort(
        (a, b) => a.ticker.localeCompare(b.ticker),
      );
      expect(fromP).toEqual(fromD);
    } finally {
      p.fixture.cleanup();
      d.fixture.cleanup();
    }
  });
});
