/**
 * SpotStore dual-backend contract tests (Phase 2 Plan 03 Task 1).
 *
 * Runs the same test suite against ParquetSpotStore and DuckdbSpotStore via
 * `describe.each([parquet, duckdb])`. The final parity describe block asserts
 * that identical `writeBars` input yields `deepEqual` output from `readBars`
 * across both backends — the strongest evidence that the D-02 "no parquetMode
 * branching in method bodies" invariant produces observationally-identical
 * behavior.
 *
 * Tests cover:
 *   - writeBars + readBars round-trip (3 minute bars)
 *   - empty-array writeBars is a no-op
 *   - readDailyBars RTH aggregation (first(open)/max(high)/min(low)/last(close))
 *   - getCoverage on populated ticker
 *   - getCoverage on missing ticker returns empty report
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
  MarketDataAuthorityError,
  ParquetSpotStore,
  DuckdbSpotStore,
} from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import { makeBars } from "../../../fixtures/market-stores/bars-fixture.ts";
import { createMarketParquetViews } from "../../../../src/db/market-views.ts";

async function makeParquetSpot(): Promise<{
  store: ParquetSpotStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  return { store: new ParquetSpotStore(fixture.ctx), fixture };
}

async function makeDuckdbSpot(): Promise<{
  store: DuckdbSpotStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: false });
  return { store: new DuckdbSpotStore(fixture.ctx), fixture };
}

describe.each([
  {
    name: "parquet",
    make: makeParquetSpot,
    refreshViews: async (f: FixtureHandle) => {
      await createMarketParquetViews(f.ctx.conn, f.ctx.dataDir);
    },
  },
  {
    name: "duckdb",
    make: makeDuckdbSpot,
    refreshViews: async (_f: FixtureHandle) => {
      /* no-op */
    },
  },
])("SpotStore contract — $name backend", ({ make, refreshViews }) => {
  let fixture: FixtureHandle;
  let store: ParquetSpotStore | DuckdbSpotStore;

  beforeEach(async () => {
    const built = await make();
    fixture = built.fixture;
    store = built.store;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("writeBars + readBars round-trip (3 minute bars)", async () => {
    const bars = makeBars("SPX", "2025-01-06");
    await store.writeBars("SPX", "2025-01-06", bars);
    await refreshViews(fixture);

    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read.length).toBe(3);
    expect(read.map((r) => r.time)).toEqual(["09:30", "10:30", "15:45"]);
    expect(read[0].ticker).toBe("SPX");
    expect(read[0].date).toBe("2025-01-06");
    expect(read[0].open).toBe(100);
  });

  it("writeBars with empty array is a no-op", async () => {
    await store.writeBars("SPX", "2025-01-06", []);
    await refreshViews(fixture);
    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read).toEqual([]);
  });

  it("readDailyBars aggregates RTH minute bars via first/last/max/min", async () => {
    const bars = makeBars("SPX", "2025-01-06");
    await store.writeBars("SPX", "2025-01-06", bars);
    await refreshViews(fixture);

    const daily = await store.readDailyBars("SPX", "2025-01-06", "2025-01-06");
    expect(daily.length).toBe(1);
    expect(daily[0].ticker).toBe("SPX");
    expect(daily[0].date).toBe("2025-01-06");
    // first(open ORDER BY time) → 09:30 bar → open=100
    expect(daily[0].open).toBe(100);
    // max(high) across 3 bars — bar 2 has high=106
    expect(daily[0].high).toBeGreaterThanOrEqual(106);
    // min(low) across 3 bars — bar 1 has low=99 (basePrice 100 - 1)
    expect(daily[0].low).toBeLessThanOrEqual(99);
    // last(close ORDER BY time) → 15:45 bar → close=99.5
    expect(daily[0].close).toBeCloseTo(99.5, 5);
  });

  it("getCoverage reports written dates with correct earliest/latest/totalDates", async () => {
    await store.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await store.writeBars("SPX", "2025-01-08", makeBars("SPX", "2025-01-08"));
    await refreshViews(fixture);

    const cov = await store.getCoverage("SPX", "2025-01-01", "2025-01-31");
    expect(cov.earliest).toBe("2025-01-06");
    expect(cov.latest).toBe("2025-01-08");
    expect(cov.totalDates).toBe(2);
    expect(cov.missingDates).toEqual([]);
  });

  it("getCoverage on ticker with no rows returns empty report", async () => {
    await refreshViews(fixture);
    const cov = await store.getCoverage("QQQ", "2025-01-01", "2025-01-31");
    expect(cov.earliest).toBeNull();
    expect(cov.latest).toBeNull();
    expect(cov.totalDates).toBe(0);
    expect(cov.missingDates).toEqual([]);
  });

  it("writeFromSelect lands rows in the partition and is readable via readBars", async () => {
    // The SELECT produces the same 3-column-subset shape that writeBars writes.
    // A typical LLM-composed SELECT would pull from read_parquet('/some/file');
    // here we use a VALUES clause so the test doesn't depend on filesystem state.
    const selectSql = `
      SELECT * FROM (VALUES
        ('SPX', '2025-01-06', '09:30', 100.0, 101.0,  99.0, 100.5, NULL::DOUBLE, NULL::DOUBLE),
        ('SPX', '2025-01-06', '10:30', 100.5, 106.0, 100.0, 105.0, NULL::DOUBLE, NULL::DOUBLE)
      ) t(ticker, date, time, open, high, low, close, bid, ask)
    `;
    const { rowCount } = await store.writeFromSelect(
      { ticker: "SPX", date: "2025-01-06" },
      selectSql,
    );
    expect(rowCount).toBe(2);
    await refreshViews(fixture);

    const read = await store.readBars("SPX", "2025-01-06", "2025-01-06");
    expect(read.length).toBe(2);
    expect(read.map((r) => r.time).sort()).toEqual(["09:30", "10:30"]);
  });
});

describe("SpotStore backend parity", () => {
  it("Parquet and DuckDB return identical readBars output for the same input", async () => {
    const p = await makeParquetSpot();
    const d = await makeDuckdbSpot();
    try {
      const bars = makeBars("SPX", "2025-01-06");
      await p.store.writeBars("SPX", "2025-01-06", bars);
      await d.store.writeBars("SPX", "2025-01-06", bars);
      await createMarketParquetViews(p.fixture.ctx.conn, p.fixture.ctx.dataDir);

      const fromP = await p.store.readBars("SPX", "2025-01-06", "2025-01-06");
      const fromD = await d.store.readBars("SPX", "2025-01-06", "2025-01-06");
      expect(fromP).toEqual(fromD);
    } finally {
      p.fixture.cleanup();
      d.fixture.cleanup();
    }
  });
});

describe("ParquetSpotStore XNYS partition boundary", () => {
  it("excludes a 2026-07-03 holiday partition from minute and daily range reads", async () => {
    const { store, fixture } = await makeParquetSpot();
    try {
      await store.writeBars("SPX", "2026-07-02", makeBars("SPX", "2026-07-02"));
      // July 3 is a weekday-shaped directory, but XNYS is closed for the
      // observed Independence Day holiday in 2026.
      await store.writeBars("SPX", "2026-07-03", makeBars("SPX", "2026-07-03"));
      await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

      const minute = await store.readBars("SPX", "2026-07-02", "2026-07-06");
      expect(new Set(minute.map((row) => row.date))).toEqual(new Set(["2026-07-02"]));

      const daily = await store.readDailyBars("SPX", "2026-07-02", "2026-07-06");
      expect(daily.map((row) => row.date)).toEqual(["2026-07-02"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("raises a named authority error when excluded partitions are the only data", async () => {
    const { store, fixture } = await makeParquetSpot();
    try {
      await store.writeBars("SPX", "2026-07-03", makeBars("SPX", "2026-07-03"));
      await expect(store.readBars("SPX", "2026-07-03", "2026-07-03")).rejects.toBeInstanceOf(
        MarketDataAuthorityError,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("raises a named authority error instead of hiding global-layout spot data", async () => {
    const { store, fixture } = await makeParquetSpot();
    try {
      await store.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
      const spotDir = path.join(fixture.ctx.dataDir, "market", "spot");
      const tickerDir = path.join(spotDir, "ticker=SPX");
      const globalDir = path.join(spotDir, "date=2025-01-06");
      mkdirSync(globalDir, { recursive: true });
      renameSync(
        path.join(tickerDir, "date=2025-01-06", "data.parquet"),
        path.join(globalDir, "data.parquet"),
      );
      rmSync(tickerDir, { recursive: true, force: true });

      await expect(store.readDailyBars("SPX", "2025-01-06", "2025-01-06")).rejects.toBeInstanceOf(
        MarketDataAuthorityError,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not report empty when another canonical date keeps the ticker directory alive", async () => {
    const { store, fixture } = await makeParquetSpot();
    try {
      await store.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
      await store.writeBars("SPX", "2025-01-07", makeBars("SPX", "2025-01-07"));
      const spotDir = path.join(fixture.ctx.dataDir, "market", "spot");
      const globalDir = path.join(spotDir, "date=2025-01-07");
      mkdirSync(globalDir, { recursive: true });
      renameSync(
        path.join(spotDir, "ticker=SPX", "date=2025-01-07", "data.parquet"),
        path.join(globalDir, "data.parquet"),
      );

      await expect(store.readBars("SPX", "2025-01-07", "2025-01-07")).rejects.toBeInstanceOf(
        MarketDataAuthorityError,
      );
      // A disjoint canonical date remains readable; global evidence outside
      // its requested window does not poison the read.
      await expect(store.readBars("SPX", "2025-01-06", "2025-01-06")).resolves.toHaveLength(3);
    } finally {
      fixture.cleanup();
    }
  });

  it("excludes an unsupported pre-2022 partition without turning it into an authority error", async () => {
    const { store, fixture } = await makeParquetSpot();
    try {
      await store.writeBars("SPX", "2021-12-31", makeBars("SPX", "2021-12-31"));

      await expect(store.readBars("SPX", "1970-01-01", "9999-12-31")).resolves.toEqual([]);
      await expect(store.readDailyBars("SPX", "1970-01-01", "9999-12-31")).resolves.toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
