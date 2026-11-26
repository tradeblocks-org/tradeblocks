/**
 * Enrichment recompute after re-import, and targeted recompute.
 *
 * Reported by steffdax (v4.6.2):
 *   1. Re-importing daily bars over dates that already exist updated
 *      market.spot_daily but left the derived market.enriched fields stale.
 *      SPX 2021-02-23 open was revised 3857.07 -> 3885.55; Gap_Pct stayed
 *      -0.50 instead of +0.23, while the import result claimed the whole
 *      span had been enriched.
 *   2. enrich_market_data force_full was a documented no-op, so there was no
 *      supported way to recompute one ticker or a date range.
 *
 * Both store backends are exercised: the DuckDB physical-table backend
 * (default) and the Parquet backend (TRADEBLOCKS_PARQUET=true).
 */
import * as fs from "fs/promises";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { registerMarketImportTools } from "../../src/tools/market-imports.ts";
import { registerMarketEnrichmentTools } from "../../src/tools/market-enrichment.ts";
import { closeConnection, createMarketStores, getDataRoot } from "../../src/test-exports.ts";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import type { MarketStores } from "../../src/market/stores/index.ts";
import { isXnysSessionDate } from "../../src/market/provenance/xnys-session-calendar.ts";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  >;
  isError?: boolean;
}>;

function makeServer() {
  const tools = new Map<string, { config: Record<string, unknown>; handler: ToolHandler }>();
  return {
    tools,
    server: {
      registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler) {
        tools.set(name, { config, handler });
      },
    },
  };
}

function textOf(out: Awaited<ReturnType<ToolHandler>>): string {
  const text = out.content.find((item) => item.type === "text");
  return text && text.type === "text" ? text.text : "";
}

function jsonOf(out: Awaited<ReturnType<ToolHandler>>): Record<string, unknown> {
  const resource = out.content.find((item) => item.type === "resource");
  if (!resource || resource.type !== "resource") throw new Error(textOf(out));
  return JSON.parse(resource.resource.text);
}

const MAPPING = {
  date: "date",
  time: "time",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
};

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// The calendar authority starts in 2022; the reported bars are from 2021,
// so older sessions are weekdays minus that window's full-day NYSE holidays.
const PRE_2022_HOLIDAYS = new Set(["2020-12-25", "2021-01-01", "2021-01-18", "2021-02-15"]);
function isSession(date: string): boolean {
  if (date >= "2022-01-01") return isXnysSessionDate(date);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !PRE_2022_HOLIDAYS.has(date);
}

/** Deterministic SPX-like daily series over XNYS sessions [from, to]. */
function buildSeries(from: string, to: string): DailyBar[] {
  const out: DailyBar[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  let close = 3600;
  let i = 0;
  while (cursor.toISOString().slice(0, 10) <= to) {
    const date = cursor.toISOString().slice(0, 10);
    if (isSession(date)) {
      const drift = Math.sin(i * 0.7) * 12 + 1.5;
      const open = close + Math.cos(i * 1.3) * 6;
      close = open + drift;
      out.push({
        date,
        open: Number(open.toFixed(2)),
        high: Number((Math.max(open, close) + 8).toFixed(2)),
        low: Number((Math.min(open, close) - 8).toFixed(2)),
        close: Number(close.toFixed(2)),
      });
      i++;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  // Pin the reported bars: 2021-02-22 close 3876.50 and the original
  // 2021-02-23 open 3857.07 (Gap_Pct -0.50%).
  const prior = out.find((b) => b.date === "2021-02-22")!;
  prior.close = 3876.5;
  prior.high = Math.max(prior.high, 3876.5);
  prior.low = Math.min(prior.low, 3876.5);
  const day = out.find((b) => b.date === "2021-02-23")!;
  day.open = 3857.07;
  day.high = Math.max(day.high, 3900);
  day.low = Math.min(day.low, 3850);
  return out;
}

function toCsv(bars: DailyBar[]): string {
  return (
    "date,time,open,high,low,close\n" +
    bars.map((b) => `${b.date},09:30,${b.open},${b.high},${b.low},${b.close}`).join("\n") +
    "\n"
  );
}

async function enrichedRow(stores: MarketStores, date: string): Promise<Record<string, unknown>> {
  const rows = await stores.enriched.read({ ticker: "SPX", from: date, to: date });
  expect(rows).toHaveLength(1);
  return rows[0];
}

function expectedGap(open: number, priorClose: number): number {
  return ((open - priorClose) / priorClose) * 100;
}

describe.each([
  { mode: "duckdb", parquetMode: false },
  { mode: "parquet", parquetMode: true },
])("enrichment recompute ($mode backend)", ({ parquetMode }) => {
  let fixture: FixtureHandle;
  let stores: MarketStores;
  let importCsv: ToolHandler;
  let enrich: ToolHandler;
  let series: DailyBar[];

  async function importBars(bars: DailyBar[], name: string, skip = false) {
    const csvPath = path.join(fixture.ctx.dataDir, name);
    await fs.writeFile(csvPath, toCsv(bars));
    const out = await importCsv({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: MAPPING,
      dry_run: false,
      skip_enrichment: skip,
    });
    expect(out.isError ? textOf(out) : "").toBe("");
    return out;
  }

  beforeEach(async () => {
    await closeConnection();
    fixture = await buildStoreFixture({ parquetMode });
    stores = createMarketStores(fixture.ctx);
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, fixture.ctx.dataDir, stores);
    registerMarketEnrichmentTools(server as never, fixture.ctx.dataDir, stores);
    importCsv = tools.get("import_market_csv")!.handler;
    enrich = tools.get("enrich_market_data")!.handler;
    series = buildSeries("2020-12-01", "2021-03-31");
    await importBars(series, "initial.csv");
  });

  afterEach(async () => {
    await closeConnection();
    fixture.cleanup();
  });

  it("initial import enriches the reported Gap_Pct (-0.50%)", async () => {
    const row = await enrichedRow(stores, "2021-02-23");
    expect(Number(row.Gap_Pct)).toBeCloseTo(expectedGap(3857.07, 3876.5), 6);
    expect(Number(row.Gap_Pct)).toBeCloseTo(-0.5, 2);
  });

  it("re-importing the full file with a revised open recomputes Gap_Pct (+0.23%)", async () => {
    const revised = series.map((b) => (b.date === "2021-02-23" ? { ...b, open: 3885.55 } : b));
    const out = await importBars(revised, "revised-full.csv");

    const row = await enrichedRow(stores, "2021-02-23");
    expect(Number(row.Gap_Pct)).toBeCloseTo(expectedGap(3885.55, 3876.5), 6);
    expect(Number(row.Gap_Pct)).toBeCloseTo(0.23, 2);

    // The result reports exactly the recomputed range: from the earliest
    // changed session through the ticker's latest session.
    const data = jsonOf(out);
    const enrichment = data.enrichment as {
      recomputed: Array<{ ticker: string; from: string; to: string }>;
      changedDates: string[];
    };
    expect(enrichment.changedDates).toEqual(["2021-02-23"]);
    expect(enrichment.recomputed).toEqual([
      { ticker: "SPX", from: "2021-02-23", to: "2021-03-31" },
    ]);
    expect(textOf(out)).toContain("2021-02-23 → 2021-03-31");
    expect(textOf(out)).not.toContain("2020-12-01 → 2021-03-31");
  });

  it("re-importing a single revised row recomputes that day and every later dependent day", async () => {
    // Revise the 2021-02-22 close: 02-23 Prior_Close/Gap_Pct depend on it,
    // and so does 02-24 Prev_Return_Pct (two sessions back).
    const day = series.find((b) => b.date === "2021-02-22")!;
    const revised = { ...day, close: 3900, high: Math.max(day.high, 3900) };
    const out = await importBars([revised], "revised-one.csv");

    const next = await enrichedRow(stores, "2021-02-23");
    expect(Number(next.Prior_Close)).toBeCloseTo(3900, 6);
    expect(Number(next.Gap_Pct)).toBeCloseTo(expectedGap(3857.07, 3900), 6);

    const after = await enrichedRow(stores, "2021-02-24");
    const feb23 = series.find((b) => b.date === "2021-02-23")!;
    expect(Number(after.Prev_Return_Pct)).toBeCloseTo(((feb23.close - 3900) / 3900) * 100, 6);

    const enrichment = jsonOf(out).enrichment as {
      recomputed: Array<{ ticker: string; from: string; to: string }>;
    };
    expect(enrichment.recomputed).toEqual([
      { ticker: "SPX", from: "2021-02-22", to: "2021-03-31" },
    ]);
  });

  it("re-importing identical bars reports no changed dates", async () => {
    const out = await importBars(series.slice(-5), "same.csv");
    const enrichment = jsonOf(out).enrichment as { changedDates: string[] };
    expect(enrichment.changedDates).toEqual([]);
  });

  it("enrich_market_data recomputes only the requested ticker date range", async () => {
    // Revise two sessions without enrichment, then recompute one of them.
    const revised = series.map((b) =>
      b.date === "2021-02-23" || b.date === "2021-03-10" ? { ...b, open: b.open + 20 } : b,
    );
    await importBars(revised, "revised-skip.csv", true);

    // Watermark-driven run alone does not touch existing dates.
    const out = await enrich({
      ticker: "SPX",
      start_date: "2021-02-01",
      end_date: "2021-02-28",
    });
    expect(out.isError ? textOf(out) : "").toBe("");
    const data = jsonOf(out);
    expect(data.recomputed).toEqual({ from: "2021-02-01", to: "2021-02-28" });

    const feb22 = series.find((b) => b.date === "2021-02-22")!;
    const inRange = await enrichedRow(stores, "2021-02-23");
    expect(Number(inRange.Gap_Pct)).toBeCloseTo(expectedGap(3857.07 + 20, feb22.close), 6);

    // Outside the window: still the stale pre-revision value.
    const mar9 = series.find((b) => b.date === "2021-03-09")!;
    const mar10 = series.find((b) => b.date === "2021-03-10")!;
    const outside = await enrichedRow(stores, "2021-03-10");
    expect(Number(outside.Gap_Pct)).toBeCloseTo(expectedGap(mar10.open, mar9.close), 6);
  });

  it("range recompute warms indicators from the lookback, matching a full recompute within tolerance", async () => {
    const full = await stores.enriched.read({
      ticker: "SPX",
      from: "2021-03-01",
      to: "2021-03-31",
    });
    const out = await enrich({ ticker: "SPX", start_date: "2021-03-01", end_date: "2021-03-31" });
    expect(out.isError ? textOf(out) : "").toBe("");
    const ranged = await stores.enriched.read({
      ticker: "SPX",
      from: "2021-03-01",
      to: "2021-03-31",
    });
    expect(ranged).toHaveLength(full.length);
    for (let i = 0; i < full.length; i++) {
      // SMA50 / Return_20D / Realized_Vol_20D need prior sessions; the
      // lookback padding must supply them so they are not null.
      for (const col of ["Price_vs_SMA50_Pct", "Return_20D", "Realized_Vol_20D", "Prior_Close"]) {
        expect(ranged[i][col]).not.toBeNull();
        expect(Number(ranged[i][col])).toBeCloseTo(Number(full[i][col]), 6);
      }
    }
  });

  it("force_full recomputes the whole ticker history", async () => {
    const revised = series.map((b) =>
      b.date === "2021-02-23" || b.date === "2021-03-10" ? { ...b, open: b.open + 20 } : b,
    );
    await importBars(revised, "revised-skip.csv", true);

    const out = await enrich({ ticker: "SPX", force_full: true });
    expect(out.isError ? textOf(out) : "").toBe("");
    const data = jsonOf(out);
    expect(data.recomputed).toEqual({ from: "2020-12-01", to: "2021-03-31" });
    expect(data.warning).toBeUndefined();

    const feb22 = series.find((b) => b.date === "2021-02-22")!;
    const mar9 = series.find((b) => b.date === "2021-03-09")!;
    const mar10 = series.find((b) => b.date === "2021-03-10")!;
    expect(Number((await enrichedRow(stores, "2021-02-23")).Gap_Pct)).toBeCloseTo(
      expectedGap(3857.07 + 20, feb22.close),
      6,
    );
    expect(Number((await enrichedRow(stores, "2021-03-10")).Gap_Pct)).toBeCloseTo(
      expectedGap(mar10.open + 20, mar9.close),
      6,
    );
  });

  describe("ticker with no watermark and history older than the 200-day lookback", () => {
    const FROM = "2021-03-01";

    async function seedLongHistoryWithoutWatermark() {
      // Start >200 days before FROM so the warmup rows read before FROM carry
      // real, fully warmed values that a cut-off recompute would clobber.
      const long = buildSeries("2020-01-02", "2021-03-31");
      await importBars(long, "long-history.csv");
      await fs.rm(
        path.join(getDataRoot(fixture.ctx.dataDir), "market-meta", "enrichment-watermarks.json"),
        { force: true },
      );
      const before = await stores.enriched.read({
        ticker: "SPX",
        from: "2020-01-02",
        to: "2021-02-26",
      });
      expect(before.length).toBeGreaterThan(200);
      // Sanity: the warmup rows we are protecting hold real values.
      const probe = before.find((r) => String(r.date).slice(0, 10) === "2020-08-13")!;
      expect(probe.Prior_Close).not.toBeNull();
      expect(probe.RSI_14).not.toBeNull();
      return { long, before };
    }

    it("enrich_market_data start/end leaves rows before start_date byte-identical", async () => {
      const { before } = await seedLongHistoryWithoutWatermark();
      const out = await enrich({ ticker: "SPX", start_date: FROM, end_date: "2021-03-10" });
      expect(out.isError ? textOf(out) : "").toBe("");

      const after = await stores.enriched.read({
        ticker: "SPX",
        from: "2020-01-02",
        to: "2021-02-26",
      });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it("re-import with a revised bar leaves rows before the change byte-identical", async () => {
      const { long, before } = await seedLongHistoryWithoutWatermark();
      const revised = long.map((b) => (b.date === FROM ? { ...b, open: b.open + 20 } : b));
      await importBars(revised, "long-revised.csv");

      const after = await stores.enriched.read({
        ticker: "SPX",
        from: "2020-01-02",
        to: "2021-02-26",
      });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });
  });

  it("rejects an inverted date range", async () => {
    const out = await enrich({ ticker: "SPX", start_date: "2021-03-31", end_date: "2021-03-01" });
    expect(out.isError).toBe(true);
  });
});
