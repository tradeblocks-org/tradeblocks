/**
 * ParquetOiDailyStore write+read roundtrip tests.
 *
 * Seeds daily open-interest rows through the store (which writes Hive-
 * partitioned data.parquet files under the fixture tmp dir at
 * option_oi_daily/underlying=X/date=Y/data.parquet) and reads them back via
 * `read_parquet(...)` SQL composed by the store.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync } from "fs";
import { join } from "path";
import { ParquetOiDailyStore } from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import type { OiDailyRow } from "../../../../src/market/stores/types.ts";

const DATE = "2024-01-16";
const EXPIRATION = "2024-01-23";

function buildRows(): OiDailyRow[] {
  return [
    {
      occ_ticker: "SPXW240123P04700000",
      underlying: "SPX",
      date: DATE,
      expiration: EXPIRATION,
      strike: 4700,
      right: "put",
      open_interest: 12345,
      source: "thetadata",
    },
    {
      occ_ticker: "SPXW240123C04800000",
      underlying: "SPX",
      date: DATE,
      expiration: EXPIRATION,
      strike: 4800,
      right: "call",
      open_interest: 6789,
      source: "thetadata",
    },
  ];
}

async function setUp(): Promise<{
  store: ParquetOiDailyStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  const store = new ParquetOiDailyStore(fixture.ctx);
  return { store, fixture };
}

describe("ParquetOiDailyStore", () => {
  it("persists and reads back daily open-interest rows verbatim", async () => {
    const { store, fixture } = await setUp();
    await store.writeOiDaily("SPX", DATE, buildRows());

    const readBack = await store.readOiDaily("SPX", DATE, DATE);
    expect(readBack).toHaveLength(2);

    const byTicker = new Map(readBack.map((r) => [r.occ_ticker, r]));
    const put = byTicker.get("SPXW240123P04700000")!;
    expect(put).toMatchObject({
      underlying: "SPX",
      date: DATE,
      expiration: EXPIRATION,
      strike: 4700,
      right: "put",
      open_interest: 12345,
      source: "thetadata",
    });
    const call = byTicker.get("SPXW240123C04800000")!;
    expect(call.open_interest).toBe(6789);
    expect(call.right).toBe("call");

    fixture.cleanup();
  });

  it("writes the Hive-partitioned layout underlying=X/date=Y/data.parquet", async () => {
    const { store, fixture } = await setUp();
    await store.writeOiDaily("SPX", DATE, buildRows());

    const expected = join(
      fixture.ctx.dataDir,
      "market",
      "option_oi_daily",
      "underlying=SPX",
      `date=${DATE}`,
      "data.parquet",
    );
    expect(existsSync(expected)).toBe(true);

    fixture.cleanup();
  });

  it("filters reads by the requested date range", async () => {
    const { store, fixture } = await setUp();
    await store.writeOiDaily("SPX", DATE, buildRows());
    await store.writeOiDaily("SPX", "2024-02-01", [
      {
        occ_ticker: "SPXW240204P04700000",
        underlying: "SPX",
        date: "2024-02-01",
        expiration: "2024-02-04",
        strike: 4700,
        right: "put",
        open_interest: 999,
        source: "thetadata",
      },
    ]);

    const onlyJan = await store.readOiDaily("SPX", DATE, DATE);
    expect(onlyJan).toHaveLength(2);
    expect(onlyJan.every((r) => r.date === DATE)).toBe(true);

    const both = await store.readOiDaily("SPX", DATE, "2024-02-01");
    expect(both).toHaveLength(3);

    fixture.cleanup();
  });

  it("excludes a 2026-07-03 holiday partition from range reads", async () => {
    const { store, fixture } = await setUp();
    const row = buildRows()[0];
    await store.writeOiDaily("SPX", "2026-07-02", [
      { ...row, date: "2026-07-02", expiration: "2026-07-10" },
    ]);
    await store.writeOiDaily("SPX", "2026-07-03", [
      { ...row, date: "2026-07-03", expiration: "2026-07-10" },
    ]);

    const rows = await store.readOiDaily("SPX", "2026-07-02", "2026-07-06");
    expect(rows.map((value) => value.date)).toEqual(["2026-07-02"]);

    fixture.cleanup();
  });

  it("preserves a valid pre-2022 partition in ordinary range reads", async () => {
    const { store, fixture } = await setUp();
    const row = buildRows()[0];
    await store.writeOiDaily("SPX", "2021-12-31", [
      { ...row, date: "2021-12-31", expiration: "2022-01-07" },
    ]);

    const rows = await store.readOiDaily("SPX", "1970-01-01", "9999-12-31");
    expect(rows.map((value) => value.date)).toEqual(["2021-12-31"]);

    fixture.cleanup();
  });

  it("returns an empty array for an underlying with no partitions", async () => {
    const { store, fixture } = await setUp();
    const rows = await store.readOiDaily("QQQ", DATE, DATE);
    expect(rows).toEqual([]);
    fixture.cleanup();
  });

  it("is a no-op write when given no rows", async () => {
    const { store, fixture } = await setUp();
    await store.writeOiDaily("SPX", DATE, []);
    const rows = await store.readOiDaily("SPX", DATE, DATE);
    expect(rows).toEqual([]);
    fixture.cleanup();
  });
});
