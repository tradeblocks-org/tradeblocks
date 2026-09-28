import { afterEach, describe, expect, it } from "@jest/globals";
import { existsSync, linkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketStores } from "../../src/test-exports.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import { getEnrichedThrough } from "../../src/db/json-adapters.ts";
import { isXnysSessionDate } from "../../src/market/provenance/xnys-session-calendar.ts";

describe("enrichment with unrelated published history", () => {
  let fixture: FixtureHandle | undefined;

  afterEach(() => {
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
});
