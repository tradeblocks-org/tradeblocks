import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketStores } from "../../src/test-exports.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import { getEnrichedThrough } from "../../src/db/json-adapters.ts";
import { isXnysSessionDate } from "../../src/market/provenance/xnys-session-calendar.ts";
import { ParquetSpotStore } from "../../src/market/stores/parquet-spot-store.ts";

describe("enrichment with unrelated published history", () => {
  let fixture: FixtureHandle | undefined;

  afterEach(() => {
    jest.restoreAllMocks();
    fixture?.cleanup();
  });

  it("computes and publishes the requested ticker under a bounded memory budget", async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    const { conn, dataDir } = fixture.ctx;
    const stores = createMarketStores(fixture.ctx);
    const template = join(dataDir, "enriched-template.parquet");
    await conn.run(`COPY (SELECT 42::DOUBLE AS RSI_14) TO '${template}' (FORMAT PARQUET)`);

    // The reporter has thousands of per-session slices across other tickers.
    // Sharing bytes via hard links keeps the fixture small while preserving the
    // real per-file Parquet metadata/planning work that caused the OOM.
    const irrelevantDir = join(dataDir, "market", "enriched", "ticker=SPY");
    const sessions: string[] = [];
    const cursor = new Date("2022-01-03T00:00:00Z");
    while (sessions.length < 2000) {
      const date = cursor.toISOString().slice(0, 10);
      if (isXnysSessionDate(date)) sessions.push(date);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (const date of sessions) {
      const dir = join(irrelevantDir, `date=${date}`);
      mkdirSync(dir, { recursive: true });
      linkSync(template, join(dir, "data.parquet"));
    }

    const targetDates = sessions.slice(0, 26);
    const existing = join(dataDir, "market", "enriched", "ticker=XLC", `date=${targetDates[0]}`);
    mkdirSync(existing, { recursive: true });
    linkSync(template, join(existing, "data.parquet"));
    for (const [index, date] of targetDates.entries()) {
      const close = 100 + index;
      await stores.spot.writeBars("XLC", date, [
        {
          ticker: "XLC",
          date,
          time: "09:30",
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1,
        },
      ]);
    }
    await createMarketParquetViews(conn, dataDir);
    await conn.run("SET memory_limit='128MB'");

    const through = targetDates.at(-1)!;
    await stores.enriched.compute("XLC", targetDates[0], through);
    await createMarketParquetViews(conn, dataDir);
    const rows = await stores.enriched.read({ ticker: "XLC", from: targetDates[0], to: through });
    expect(rows).toHaveLength(26);
    expect(rows[0].Prior_Close).toBeNull();
    expect(rows[1].Prior_Close).toBe(100);
    expect(rows[25].Prior_Close).toBe(124);
    expect(rows[25].RSI_14).toBe(100);
    expect(await getEnrichedThrough("XLC", dataDir)).toBe(through);
    expect(
      existsSync(
        join(dataDir, "market", "enriched", "ticker=XLC", `date=${through}`, "data.parquet"),
      ),
    ).toBe(true);

    // The refresh path calls the same compute seam with one bounded session and
    // persistWatermark=false; an older repair must not advance the ticker mark.
    await stores.enriched.compute("XLC", targetDates[24], targetDates[24], {
      persistWatermark: false,
    });
    expect(await getEnrichedThrough("XLC", dataDir)).toBe(through);
  }, 30_000);

  it("recovers missing history before a bounded refresh watermark", async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    const { conn, dataDir } = fixture.ctx;
    // The authority bundle snapshots prototype methods at construction time.
    const readBars = jest.spyOn(ParquetSpotStore.prototype, "readBars");
    const stores = createMarketStores(fixture.ctx);
    // Two real sessions precede the refresh by more than the 200-day
    // incremental lookback, so re-reading only the watermark window misses them.
    const sessions = ["2024-01-02", "2024-01-03", "2025-02-07"];
    for (const [index, date] of sessions.entries()) {
      const close = 100 + index;
      await stores.spot.writeBars("XLC", date, [
        {
          ticker: "XLC",
          date,
          time: "09:30",
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1,
        },
      ]);
    }
    await createMarketParquetViews(conn, dataDir);
    const through = sessions.at(-1)!;
    await stores.enriched.compute("XLC", through, through);
    expect((await stores.enriched.getCoverage("XLC")).totalDates).toBe(1);

    const blocked = join(dataDir, "market", "enriched", "ticker=XLC", `date=${sessions[0]}`);
    writeFileSync(blocked, "block publication of the oldest missing session");
    await expect(stores.enriched.compute("XLC", "", "")).rejects.toThrow();
    expect(await getEnrichedThrough("XLC", dataDir)).toBe(through);
    expect((await stores.enriched.getCoverage("XLC")).totalDates).toBe(1);
    unlinkSync(blocked);

    readBars.mockClear();
    await stores.enriched.compute("XLC", "", "");
    expect(readBars.mock.calls.filter(([ticker]) => ticker === "XLC")).toEqual([
      ["XLC", sessions[0], sessions[0]],
      ["XLC", sessions[1], sessions[1]],
    ]);
    await createMarketParquetViews(conn, dataDir);
    const rows = await stores.enriched.read({ ticker: "XLC", from: sessions[0], to: through });
    expect(rows).toHaveLength(3);
    expect(rows[0].Prior_Close).toBeNull();
    expect(rows[1].Prior_Close).toBe(100);
    expect(rows[2].Prior_Close).toBeNull();
    expect(rows[2].RSI_14).toBeNull();
    expect(await getEnrichedThrough("XLC", dataDir)).toBe(through);
  }, 30_000);
});
