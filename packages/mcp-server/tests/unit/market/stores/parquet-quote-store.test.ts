/**
 * ParquetQuoteStore.readWindow tests (Phase 2 entry-pipeline-rebuild — A4).
 *
 * Mirrors A3's DuckdbQuoteStore.readWindow tests but seeds the same fixture
 * data through ParquetChainStore + ParquetQuoteStore (which write Hive-
 * partitioned data.parquet files under the fixture's tmp dir) and reads via
 * `read_parquet(...)` SQL composed by `ParquetQuoteStore.readWindow`.
 *
 * Adds a parity check: write the same fixture rows to both backends, run the
 * same `readWindow` params against each, and assert identical row counts and
 * sorted ticker|time|strike keys.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ParquetQuoteStore,
  ParquetChainStore,
  DuckdbQuoteStore,
  DuckdbChainStore,
} from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import type { ContractRow, QuoteRow } from "../../../../src/market/stores/types.ts";

const DATE = "2024-01-15";
const EXPIRATION = "2024-01-23";
const DTE = 8;

/**
 * Build the same chain + quote rows used in A3 so both stores see identical
 * input data.
 */
function buildFixtureRows(): { chainRows: ContractRow[]; quoteRows: QuoteRow[] } {
  const chainRows: ContractRow[] = [];
  for (const strike of [4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200]) {
    const strikeStr = String(strike * 1000).padStart(8, "0");
    chainRows.push({
      underlying: "SPX",
      date: DATE,
      ticker: `SPXW240123P0${strikeStr}`,
      contract_type: "put",
      strike,
      expiration: EXPIRATION,
      dte: DTE,
      exercise_style: "european",
    });
    chainRows.push({
      underlying: "SPX",
      date: DATE,
      ticker: `SPXW240123C0${strikeStr}`,
      contract_type: "call",
      strike,
      expiration: EXPIRATION,
      dte: DTE,
      exercise_style: "european",
    });
  }

  // Out-of-DTE-band contract — should not be returned by 7-11 DTE filters.
  chainRows.push({
    underlying: "SPX",
    date: DATE,
    ticker: "SPXW240204P04700000",
    contract_type: "put",
    strike: 4700,
    expiration: "2024-02-04",
    dte: 20,
    exercise_style: "european",
  });

  const quoteRows: QuoteRow[] = [];
  for (const time of ["09:34", "09:35", "09:36", "09:37"]) {
    for (const c of chainRows) {
      quoteRows.push({
        occ_ticker: c.ticker,
        timestamp: `${DATE} ${time}`,
        bid: 1.0,
        ask: 1.2,
        delta: 0.5,
        gamma: 0.01,
        theta: -0.02,
        vega: 0.1,
        iv: 0.2,
      });
    }
  }
  return { chainRows, quoteRows };
}

/**
 * Set up a Parquet-backed quote store with chain rows and minute quotes seeded
 * for SPX on 2024-01-15. Writes hit the fixture's tmp directory as Hive-
 * partitioned Parquet files.
 */
async function setUpParquetStoreWithFixtures(): Promise<{
  store: ParquetQuoteStore;
  fixture: FixtureHandle;
  conn: { close: () => Promise<void> };
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  const store = new ParquetQuoteStore(fixture.ctx);
  const chainStore = new ParquetChainStore(fixture.ctx);

  const { chainRows, quoteRows } = buildFixtureRows();
  await chainStore.writeChain("SPX", DATE, chainRows);
  await store.writeQuotes("SPX", DATE, quoteRows);

  return {
    store,
    fixture,
    conn: {
      close: async () => {
        fixture.cleanup();
      },
    },
  };
}

/**
 * Set up parity fixtures: build a Parquet-backed store and a DuckDB-backed
 * store seeded with identical chain + quote rows so cross-backend equality
 * tests can compare `readWindow(...)` output.
 */
async function setUpParquetAndDuckdbWithFixtures(): Promise<{
  parquet: ParquetQuoteStore;
  duckdb: DuckdbQuoteStore;
  conn: { close: () => Promise<void> };
}> {
  const parquetFixture = await buildStoreFixture({ parquetMode: true });
  const parquetStore = new ParquetQuoteStore(parquetFixture.ctx);
  const parquetChainStore = new ParquetChainStore(parquetFixture.ctx);

  const duckdbFixture = await buildStoreFixture({ parquetMode: false });
  const duckdbStore = new DuckdbQuoteStore(duckdbFixture.ctx);
  const duckdbChainStore = new DuckdbChainStore(duckdbFixture.ctx);

  const { chainRows, quoteRows } = buildFixtureRows();

  await parquetChainStore.writeChain("SPX", DATE, chainRows);
  await parquetStore.writeQuotes("SPX", DATE, quoteRows);
  await duckdbChainStore.writeChain("SPX", DATE, chainRows);
  await duckdbStore.writeQuotes("SPX", DATE, quoteRows);

  return {
    parquet: parquetStore,
    duckdb: duckdbStore,
    conn: {
      close: async () => {
        parquetFixture.cleanup();
        duckdbFixture.cleanup();
      },
    },
  };
}

describe("ParquetQuoteStore source round-trip", () => {
  it("persists and reads back QuoteRow.source verbatim", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows: QuoteRow[] = [
      {
        occ_ticker: "SPX250107C05000000",
        timestamp: "2025-01-07 09:30",
        bid: 13.2,
        ask: 13.2,
        source: "synth_close",
      },
      {
        occ_ticker: "SPX250107C05000000",
        timestamp: "2025-01-07 09:31",
        bid: 13.1,
        ask: 13.3,
        source: "nbbo",
      },
    ];
    await store.writeQuotes("SPX", "2025-01-07", rows);

    const readBack = await store.readQuotes(["SPX250107C05000000"], "2025-01-07", "2025-01-07");
    const persisted = readBack.get("SPX250107C05000000")!;
    expect(persisted).toHaveLength(2);
    expect(persisted[0].source).toBe("synth_close");
    expect(persisted[1].source).toBe("nbbo");
    await conn.close();
  });
});

describe("ParquetQuoteStore.readWindow", () => {
  it("returns chain-joined rows for each minute matching the leg envelopes", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:36",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4500, strikeMax: 4800 },
        { contractType: "call", dteMin: 7, dteMax: 11, strikeMin: 4800, strikeMax: 5100 },
      ],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.time >= "09:35" && row.time <= "09:36").toBe(true);
      expect(["put", "call"]).toContain(row.contract_type);
      expect(row.dte).toBeGreaterThanOrEqual(7);
      expect(row.dte).toBeLessThanOrEqual(11);
      const inPutBand = row.contract_type === "put" && row.strike >= 4500 && row.strike <= 4800;
      const inCallBand = row.contract_type === "call" && row.strike >= 4800 && row.strike <= 5100;
      expect(inPutBand || inCallBand).toBe(true);
    }
    await conn.close();
  });

  it("returns empty array when legEnvelopes is empty", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:36",
      legEnvelopes: [],
    });
    expect(rows).toEqual([]);
    await conn.close();
  });

  it("returns empty array when the requested partition does not exist", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    // Same underlying but a date with no Parquet partition seeded — the store
    // should short-circuit to [] without raising on missing files.
    const rows = await store.readWindow({
      underlying: "SPX",
      date: "1999-01-01",
      timeStart: "09:35",
      timeEnd: "09:36",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4500, strikeMax: 4800 },
      ],
    });
    expect(rows).toEqual([]);
    await conn.close();
  });

  it("excludes contracts outside the dte band", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:35",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4500, strikeMax: 4800 },
      ],
    });
    for (const row of rows) {
      expect(row.dte).toBeGreaterThanOrEqual(7);
      expect(row.dte).toBeLessThanOrEqual(11);
      expect(row.expiration).toBe(EXPIRATION);
    }
    await conn.close();
  });

  it("populates greeks from the quote partition", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:35",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4700, strikeMax: 4700 },
      ],
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.delta).toBeCloseTo(0.5, 5);
    expect(row.gamma).toBeCloseTo(0.01, 5);
    expect(row.theta).toBeCloseTo(-0.02, 5);
    expect(row.vega).toBeCloseTo(0.1, 5);
    expect(row.iv).toBeCloseTo(0.2, 5);
    expect(row.bid).toBeCloseTo(1.0, 5);
    expect(row.ask).toBeCloseTo(1.2, 5);
    // `mid` is no longer projected on WindowQuoteRow — it's derived as
    // (bid + ask) / 2 in `toMinuteQuoteRow`.
    await conn.close();
  });

  it("returns same row count as DuckdbQuoteStore.readWindow for the same envelope", async () => {
    const { parquet, duckdb, conn } = await setUpParquetAndDuckdbWithFixtures();
    const params = {
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:36",
      legEnvelopes: [
        { contractType: "put" as const, dteMin: 7, dteMax: 11, strikeMin: 4500, strikeMax: 4800 },
        { contractType: "call" as const, dteMin: 7, dteMax: 11, strikeMin: 4800, strikeMax: 5100 },
      ],
    };
    const a = await parquet.readWindow(params);
    const b = await duckdb.readWindow(params);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    const keyA = a.map((r) => `${r.ticker}|${r.time}|${r.strike}`).sort();
    const keyB = b.map((r) => `${r.ticker}|${r.time}|${r.strike}`).sort();
    expect(keyA).toEqual(keyB);
    await conn.close();
  });
});
