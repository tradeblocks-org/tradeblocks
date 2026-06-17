/**
 * DuckdbQuoteStore.readWindow tests (Phase 2 entry-pipeline-rebuild — A3).
 *
 * Reuses the `buildStoreFixture` helper used by quote-store.contract.test.ts to
 * stand up an in-memory DuckDB with `market.option_chain` + `market.option_quote_minutes`
 * physical tables. We seed both via `writeChain` / `writeQuotes` then exercise
 * `readWindow`.
 */
import { describe, it, expect } from "@jest/globals";
import { DuckdbQuoteStore, DuckdbChainStore } from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import type {
  ContractRow,
  QuoteRow,
} from "../../../../src/market/stores/types.ts";

/**
 * Set up a DuckDB-backed quote store with both chain rows and minute quotes
 * seeded for SPX on 2024-01-15. Returns the store + fixture handle (caller
 * must invoke `fixture.cleanup()` to close the connection and remove the tmp
 * dir) plus a tiny `conn.close()` shim that mirrors the task description's
 * fixture API.
 */
async function setUpDuckdbStoreWithFixtures(): Promise<{
  store: DuckdbQuoteStore;
  fixture: FixtureHandle;
  conn: { close: () => Promise<void> };
}> {
  const fixture = await buildStoreFixture({ parquetMode: false });
  const store = new DuckdbQuoteStore(fixture.ctx);
  const chainStore = new DuckdbChainStore(fixture.ctx);

  // Seed chain rows: a put grid 4500-4800 (step 100) and a call grid 4800-5100
  // (step 100), all expiring 2024-01-23 (8 DTE). Strikes outside this range
  // should NOT be returned by the put-leg envelope (4500-4800) or call-leg
  // envelope (4800-5100).
  const date = "2024-01-15";
  const expiration = "2024-01-23";
  const dte = 8;
  const chainRows: ContractRow[] = [];
  for (const strike of [4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200]) {
    const strikeStr = String(strike * 1000).padStart(8, "0");
    chainRows.push({
      underlying: "SPX",
      date,
      ticker: `SPXW240123P0${strikeStr}`,
      contract_type: "put",
      strike,
      expiration,
      dte,
      exercise_style: "european",
    });
    chainRows.push({
      underlying: "SPX",
      date,
      ticker: `SPXW240123C0${strikeStr}`,
      contract_type: "call",
      strike,
      expiration,
      dte,
      exercise_style: "european",
    });
  }

  // Also seed an out-of-DTE-band contract (dte=20) to verify dte filtering.
  chainRows.push({
    underlying: "SPX",
    date,
    ticker: "SPXW240204P04700000",
    contract_type: "put",
    strike: 4700,
    expiration: "2024-02-04",
    dte: 20,
    exercise_style: "european",
  });

  await chainStore.writeChain("SPX", date, chainRows);

  // Seed quote rows at minutes 09:34, 09:35, 09:36, 09:37 for every chain
  // ticker. The window 09:35-09:36 should return exactly the 09:35 and 09:36
  // quotes for the in-band contracts.
  const quoteRows: QuoteRow[] = [];
  for (const time of ["09:34", "09:35", "09:36", "09:37"]) {
    for (const c of chainRows) {
      quoteRows.push({
        occ_ticker: c.ticker,
        timestamp: `${date} ${time}`,
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
  await store.writeQuotes("SPX", date, quoteRows);

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

describe("DuckdbQuoteStore source round-trip", () => {
  it("persists and reads back QuoteRow.source verbatim", async () => {
    const { store, conn } = await setUpDuckdbStoreWithFixtures();
    const rows: QuoteRow[] = [
      {
        occ_ticker: "SPX250107C05000000",
        timestamp: "2025-01-07 09:30",
        bid: 13.20,
        ask: 13.20,
        source: "synth_close",
      },
      {
        occ_ticker: "SPX250107C05000000",
        timestamp: "2025-01-07 09:31",
        bid: 13.10,
        ask: 13.30,
        source: "nbbo",
      },
    ];
    await store.writeQuotes("SPX", "2025-01-07", rows);

    const readBack = await store.readQuotes(
      ["SPX250107C05000000"],
      "2025-01-07",
      "2025-01-07",
    );
    const persisted = readBack.get("SPX250107C05000000")!;
    expect(persisted).toHaveLength(2);
    expect(persisted[0].source).toBe("synth_close");
    expect(persisted[1].source).toBe("nbbo");
    await conn.close();
  });
});

describe("DuckdbQuoteStore.readWindow", () => {
  it("returns chain-joined rows for each minute matching the leg envelopes", async () => {
    const { store, conn } = await setUpDuckdbStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: "2024-01-15",
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
      // Strike must be within at least one envelope.
      const inPutBand =
        row.contract_type === "put" && row.strike >= 4500 && row.strike <= 4800;
      const inCallBand =
        row.contract_type === "call" && row.strike >= 4800 && row.strike <= 5100;
      expect(inPutBand || inCallBand).toBe(true);
    }
    await conn.close();
  });

  it("returns empty array when legEnvelopes is empty", async () => {
    const { store, conn } = await setUpDuckdbStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: "2024-01-15",
      timeStart: "09:35",
      timeEnd: "09:36",
      legEnvelopes: [],
    });
    expect(rows).toEqual([]);
    await conn.close();
  });

  it("excludes contracts outside the dte band", async () => {
    const { store, conn } = await setUpDuckdbStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: "2024-01-15",
      timeStart: "09:35",
      timeEnd: "09:35",
      legEnvelopes: [
        // 7-11 DTE band; the 20-DTE 2024-02-04 contract should be excluded.
        { contractType: "put", dteMin: 7, dteMax: 11, strikeMin: 4500, strikeMax: 4800 },
      ],
    });
    // Only 7-11 DTE contracts should appear.
    for (const row of rows) {
      expect(row.dte).toBeGreaterThanOrEqual(7);
      expect(row.dte).toBeLessThanOrEqual(11);
      expect(row.expiration).toBe("2024-01-23");
    }
    await conn.close();
  });

  it("populates greeks from the quote table", async () => {
    const { store, conn } = await setUpDuckdbStoreWithFixtures();
    const rows = await store.readWindow({
      underlying: "SPX",
      date: "2024-01-15",
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
    // (bid + ask) / 2 in `toMinuteQuoteRow`. Verify the inputs to that
    // derivation are correct; the derivation itself is covered in the
    // entry/data.test.ts MinuteQuoteRow assertions.
    await conn.close();
  });
});
