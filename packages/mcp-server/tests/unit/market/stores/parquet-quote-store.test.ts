/**
 * ParquetQuoteStore.readWindow tests (Phase 2 entry-pipeline-rebuild — A4).
 *
 * Seeds chain and quote partitions and exercises the direct-Parquet read seam.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  ParquetQuoteStore,
  ParquetChainStore,
  hasQuoteGreeks,
  createMarketParquetViews,
  writeQuoteMinutesPartition,
  writeSpotPartition,
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

describe("ParquetQuoteStore partition updates", () => {
  const date = "2025-01-07";
  const tickerA = "SPXW250107C05000000";
  const tickerB = "SPXW250107P05000000";

  it("replaces incoming tickers and preserves every other ticker's rows and columns", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const store = new ParquetQuoteStore(fixture.ctx);
      const rows: QuoteRow[] = [tickerA, tickerB].flatMap((occ_ticker) =>
        ["09:30", "09:31"].map((time) => ({
          occ_ticker,
          timestamp: `${date} ${time}`,
          bid: 10,
          ask: 12,
          source: "nbbo" as const,
          delta: 0.5,
          gamma: 0.125,
          theta: -0.25,
          vega: 0.75,
          iv: 0.25,
          greeks_source: "computed" as const,
          greeks_revision: 3,
          rate_type: "sofr",
          rate_value: 0.0432,
          gamma_source: "computed",
        })),
      );
      await store.writeQuotes("SPX", date, rows);
      await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
      const before = await fixture.ctx.conn.runAndReadAll(
        `SELECT * FROM market.option_quote_minutes WHERE ticker = '${tickerB}' ORDER BY time`,
      );
      const replacement: QuoteRow = { ...rows[0], bid: 20, ask: 24, source: "synth_close" };
      const replacements = [replacement, { ...replacement, timestamp: `${date} 09:32` }];
      await store.writeQuotes("SPX", date, replacements);
      const readBack = await store.readQuotes([tickerA, tickerB], date, date);
      expect(readBack.get(tickerA)).toEqual(replacements);
      expect(readBack.get(tickerB)).toEqual(rows.filter((row) => row.occ_ticker === tickerB));
      const after = await fixture.ctx.conn.runAndReadAll(
        `SELECT * FROM market.option_quote_minutes WHERE ticker = '${tickerB}' ORDER BY time`,
      );
      expect(after.getRows()).toEqual(before.getRows());
    } finally {
      fixture.cleanup();
    }
  });

  function quoteSelect(count: number): string {
    return `SELECT 'SPX' AS underlying, '${date}' AS date, '${tickerA}' AS ticker,
      '09:' || lpad(CAST(i AS VARCHAR), 2, '0') AS time,
      10.0::DOUBLE AS bid, 12.0::DOUBLE AS ask FROM range(${count}) AS t(i)`;
  }

  it("refuses shrinking publications by name before changing any existing bytes", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const store = new ParquetQuoteStore(fixture.ctx);
      const partition = { underlying: "SPX", date };
      await store.writeFromSelect(partition, quoteSelect(8));
      const dir = join(
        fixture.ctx.dataDir,
        "market/option_quote_minutes/underlying=SPX",
        `date=${date}`,
      );
      const file = join(dir, "data.parquet");
      const before = readFileSync(file);
      for (const count of [3, 0]) {
        await expect(store.writeFromSelect(partition, quoteSelect(count))).rejects.toMatchObject({
          name: "QuotePartitionShrinkError",
          message: expect.stringMatching(
            new RegExp(
              `underlying=SPX/date=${date}.*existing=8.*candidate=${count}.*threshold=0\\.5`,
            ),
          ),
        });
        expect(readFileSync(file)).toEqual(before);
        expect(readdirSync(dir)).toEqual(["data.parquet"]);
        expect((await store.readQuotes([tickerA], date, date)).get(tickerA)).toHaveLength(8);
      }
      // Exactly half is allowed, not mistaken for "less than half".
      expect(await store.writeFromSelect(partition, quoteSelect(4))).toEqual({ rowCount: 4 });
      expect((await store.readQuotes([tickerA], date, date)).get(tickerA)).toHaveLength(4);
    } finally {
      fixture.cleanup();
    }
  });

  it("allows empty and tiny partitions to grow through whole-partition import", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const store = new ParquetQuoteStore(fixture.ctx);
      const partition = { underlying: "SPX", date };
      for (const count of [0, 1, 8]) {
        expect(await store.writeFromSelect(partition, quoteSelect(count))).toEqual({
          rowCount: count,
        });
        const rows = await store.readQuotes([tickerA], date, date);
        expect(rows.get(tickerA) ?? []).toHaveLength(count);
      }
      const tinyDate = "2025-01-08";
      await store.writeFromSelect(
        { underlying: "SPX", date: tinyDate },
        quoteSelect(1).replaceAll(date, tinyDate),
      );
      await expect(
        store.writeFromSelect(
          { underlying: "SPX", date: tinyDate },
          quoteSelect(0).replaceAll(date, tinyDate),
        ),
      ).rejects.toMatchObject({ name: "QuotePartitionShrinkError" });
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves legacy DOUBLE greeks and stored metadata without rounding retained rows", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const store = new ParquetQuoteStore(fixture.ctx);
      await writeQuoteMinutesPartition(fixture.ctx.conn, {
        dataDir: fixture.ctx.dataDir,
        underlying: "SPX",
        date,
        selectQuery: `SELECT *, 11.25::DOUBLE AS mid, 1234567890123456789::BIGINT AS last_updated_ns,
          'nbbo' AS source, 0.123456789012345::DOUBLE AS delta, 0.012345678901234::DOUBLE AS gamma,
          -0.23456789012345::DOUBLE AS theta, 0.34567890123456::DOUBLE AS vega,
          0.45678901234567::DOUBLE AS iv, 'computed' AS greeks_source, 3 AS greeks_revision,
          'sofr' AS rate_type, 0.04321::DOUBLE AS rate_value, 'computed' AS gamma_source
          FROM (${quoteSelect(2).replaceAll(tickerA, tickerB)})`,
      });
      await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
      const before = (
        await fixture.ctx.conn.runAndReadAll(
          "SELECT * FROM market.option_quote_minutes ORDER BY time",
        )
      ).getRows();
      await store.writeQuotes("SPX", date, [
        { occ_ticker: tickerA, timestamp: `${date} 09:30`, bid: 1, ask: 2 },
      ]);
      expect((await store.readQuotes([tickerB], date, date)).get(tickerB)?.[0].delta).toBe(
        0.123456789012345,
      );
      const after = (
        await fixture.ctx.conn.runAndReadAll(
          `SELECT * FROM market.option_quote_minutes WHERE ticker = '${tickerB}' ORDER BY time`,
        )
      ).getRows();
      expect(after).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not apply the quote shrink guard to spot partition publications", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      for (const count of [8, 1]) {
        expect(
          await writeSpotPartition(fixture.ctx.conn, {
            dataDir: fixture.ctx.dataDir,
            ticker: "SPX",
            date,
            selectQuery: `SELECT '${date}' AS date, '09:30' AS time, i AS close FROM range(${count}) t(i)`,
          }),
        ).toMatchObject({ rowCount: count });
      }
    } finally {
      fixture.cleanup();
    }
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

  it("default read (no neededGreeks) carries every greek and no projectedGreeks stamp", async () => {
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
    // Byte-identity: the exact historic key set, no projectedGreeks key present.
    expect(Object.keys(row).sort()).toEqual(
      [
        "ticker",
        "time",
        "contract_type",
        "strike",
        "expiration",
        "dte",
        "bid",
        "ask",
        "delta",
        "gamma",
        "theta",
        "vega",
        "iv",
        "greeks_source",
      ].sort(),
    );
    expect("projectedGreeks" in row).toBe(false);
    for (const g of ["delta", "gamma", "theta", "vega", "iv"] as const) {
      expect(typeof row[g]).toBe("number");
    }
    await conn.close();
  });

  it("projected read returns only requested greeks, NULLs the rest, and stamps projectedGreeks", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:35",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4700, strikeMax: 4700 },
      ],
      neededGreeks: ["delta", "iv"],
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.delta).toBeCloseTo(0.5, 5);
    expect(row.iv).toBeCloseTo(0.2, 5);
    expect(row.gamma).toBeNull();
    expect(row.theta).toBeNull();
    expect(row.vega).toBeNull();
    // Non-greek metadata is always projected in full.
    expect(row.bid).toBeCloseTo(1.0, 5);
    expect(row.ask).toBeCloseTo(1.2, 5);
    expect(row.projectedGreeks).toEqual(["delta", "iv"]);
    await conn.close();
  });

  it("a projected row survives the collapse contract when the projection is honored", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: DATE,
      timeStart: "09:35",
      timeEnd: "09:35",
      legEnvelopes: [
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4700, strikeMax: 4700 },
      ],
      neededGreeks: ["delta", "iv"],
    });
    const row = rows[0];
    // The failure mode the projection prevents: the default full contract sees
    // NULL gamma/theta/vega and would collapse the row.
    expect(hasQuoteGreeks(row)).toBe(false);
    // Honoring the projection carried on the row keeps it valid.
    expect(hasQuoteGreeks(row, row.projectedGreeks)).toBe(true);
    await conn.close();
  });

  it("rejects an unknown greek name with a clear error", async () => {
    const { store, conn } = await setUpParquetStoreWithFixtures();
    await expect(
      store.readWindow({
        underlying: "SPX",
        date: DATE,
        timeStart: "09:35",
        timeEnd: "09:35",
        legEnvelopes: [
          { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4700, strikeMax: 4700 },
        ],
        neededGreeks: ["rho"] as never,
      }),
    ).rejects.toThrow(/Unknown greek "rho"/);
    await conn.close();
  });
});
