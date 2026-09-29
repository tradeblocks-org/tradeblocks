import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const FIRST_DAY = "2022-06-01";
const LAST_DAY = "2024-03-29";
const PEAK_MARGIN_DAY = "2023-03-15";
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar arithmetic done in UTC, so the expectation never depends on this process's zone. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function weekdays(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

// Two strategies trade every weekday across two DST changes; one day carries the peak margin.
// Rows run newest first so every reported end must come from the data, not the file order.
const PEAK_MARGIN = 2 * 9000;
let peakDayFunds = 0;
let funds = 100_000;
const TRADE_ROWS = weekdays(FIRST_DAY, LAST_DAY).flatMap((day, index) =>
  ["Alpha", "Beta"].map((strategy, arm) => {
    const pl = ((index * 7 + arm * 3) % 11) * 40 - 180;
    const margin = day === PEAK_MARGIN_DAY ? PEAK_MARGIN / 2 : 1000;
    funds += pl;
    if (day === PEAK_MARGIN_DAY) peakDayFunds = funds;
    // Beta closes after Alpha so each row's Funds at Close follows the realization order.
    return `${day},09:35:00,${day},15:4${5 + arm * 4}:00,${pl},${strategy},SPY,${margin},1,${funds}`;
  }),
);
const TRADE_LOG = [
  "Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,Margin Req.,No. of Contracts,Funds at Close",
  ...TRADE_ROWS.reverse(),
  "",
].join("\n");

const REPORTING_FIRST_DAY = "2023-01-03";
const REPORTING_LAST_DAY = "2023-02-28";
const REPORTING_LOG = [
  "Date Opened,P/L,Strategy",
  `2023-01-10,50,Alpha`,
  `${REPORTING_LAST_DAY},75,Beta`,
  `${REPORTING_FIRST_DAY},-20,Alpha`,
  "",
].join("\n");

/** analyze_walk_forward_degradation windows for the default 365/90/90-day configuration. */
function degradationWindow(index: number) {
  const inSampleStart = addDays(FIRST_DAY, index * 90);
  const inSampleEnd = addDays(inSampleStart, 364);
  const outOfSampleStart = addDays(inSampleEnd, 1);
  return {
    inSampleStart,
    inSampleEnd,
    outOfSampleStart,
    outOfSampleEnd: addDays(outOfSampleStart, 89),
  };
}

type Structured = Record<string, unknown>;

// Jest's sandboxed process.env cannot change the V8 time zone, so each zone runs the real
// MCP server in a child process started with that TZ.
describe.each(["UTC", "Pacific/Kiritimati", "America/Los_Angeles"])(
  "trade-calendar dates in %s",
  (timeZone) => {
    it("every tool reports the same calendar days as the CSV", async () => {
      const packageDir = path.resolve(import.meta.dirname, "../..");
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-calendar-tz-"));
      const client = new Client({ name: "calendar-trade-dates-test", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--experimental-strip-types", path.join(packageDir, "src/index.ts"), root],
        cwd: path.resolve(packageDir, "../.."),
        env: { ...getDefaultEnvironment(), TZ: timeZone },
        stderr: "pipe",
      });
      const call = async (name: string, args: Record<string, unknown>): Promise<Structured> => {
        const result = await client.callTool({ name, arguments: args });
        expect([name, result.isError === true]).toEqual([name, false]);
        return result.structuredContent as Structured;
      };

      try {
        await client.connect(transport);
        const csvPath = path.join(root, "trades.csv");
        await fs.writeFile(csvPath, TRADE_LOG);
        const reportingPath = path.join(root, "reporting.csv");
        await fs.writeFile(reportingPath, REPORTING_LOG);

        const imported = await call("import_csv", { csvPath, blockName: "Calendar" });
        const importedReporting = await call("import_csv", {
          csvPath: reportingPath,
          blockName: "Calendar Reporting",
          csvType: "reportinglog",
        });
        await fs.copyFile(reportingPath, path.join(String(imported.blockPath), "reportinglog.csv"));

        const tradeRange = { start: FIRST_DAY, end: LAST_DAY };
        const reportingRange = { start: REPORTING_FIRST_DAY, end: REPORTING_LAST_DAY };
        const listed = (await call("list_blocks", {})).blocks as Structured[];
        const block = listed.find((entry) => entry.id === "calendar")!;
        const info = await call("get_block_info", { blockId: "calendar" });
        const reporting = await call("get_reporting_log_stats", { blockId: "calendar" });
        const [sqlRange] = (
          await call("run_sql", {
            query:
              "SELECT MIN(date_opened) AS start, MAX(date_opened) AS \"end\" FROM trades.trade_data WHERE block_id = 'calendar'",
          })
        ).rows as Structured[];
        expect({
          importCsv: imported.dateRange,
          listBlocks: block.dateRange,
          getBlockInfo: info.dateRange,
          runSql: sqlRange,
          importReporting: importedReporting.dateRange,
          listBlocksReporting: (block.reportingLog as Structured).dateRange,
          getReportingLogStats: reporting.dateRange,
        }).toEqual({
          importCsv: tradeRange,
          listBlocks: tradeRange,
          getBlockInfo: tradeRange,
          runSql: tradeRange,
          importReporting: reportingRange,
          listBlocksReporting: reportingRange,
          getReportingLogStats: reportingRange,
        });

        const statistics = await call("get_statistics", { blockId: "calendar" });
        const peak = statistics.peakExposure as Record<string, Structured>;
        // The peak day's percentage must divide by that same day's closing equity.
        expect({
          byDollars: peak.byDollars.date,
          byPercent: peak.byPercent.date,
          percent: (peak.byPercent.exposurePercent as number).toFixed(6),
        }).toEqual({
          byDollars: PEAK_MARGIN_DAY,
          byPercent: PEAK_MARGIN_DAY,
          percent: ((PEAK_MARGIN / peakDayFunds) * 100).toFixed(6),
        });

        const charts = await call("get_performance_charts", {
          blockId: "calendar",
          charts: ["daily_exposure"],
          maxDataPoints: 2000,
        });
        const exposure = charts.dailyExposure as {
          timeSeries: Array<{ date: string }>;
          peakByDollars: Structured;
          peakByPercent: Structured;
        };
        expect({
          days: exposure.timeSeries.map((point) => point.date),
          byDollars: exposure.peakByDollars.date,
          byPercent: exposure.peakByPercent.date,
          percent: (exposure.peakByPercent.exposurePercent as number).toFixed(6),
        }).toEqual({
          days: weekdays(FIRST_DAY, LAST_DAY),
          byDollars: PEAK_MARGIN_DAY,
          byPercent: PEAK_MARGIN_DAY,
          percent: (peak.byPercent.exposurePercent as number).toFixed(6),
        });

        const tailRisk = await call("get_tail_risk", { blockId: "calendar" });
        expect(tailRisk.dateRange).toEqual(tradeRange);

        const paired = await call("paired_bootstrap_comparison", {
          blockId: "calendar",
          strategyA: "Alpha",
          strategyB: "Beta",
          resamples: 200,
        });
        expect(paired.overlapWindow).toEqual(tradeRange);

        const marginal = await call("marginal_contribution", { blockId: "calendar" });
        const scaling = await call("what_if_scaling", {
          blockId: "calendar",
          strategyWeights: { Alpha: 0.5 },
        });
        const returnRange = (methodology: unknown, arm: string) =>
          ((methodology as Record<string, Structured>)[arm].returns as Structured).dateRange;
        expect([
          returnRange(marginal.calculationMethodology, "baseline"),
          returnRange(scaling.calculationMethodology, "baseline"),
          returnRange(scaling.calculationMethodology, "scaled"),
        ]).toEqual([tradeRange, tradeRange, tradeRange]);

        const walkForward = await call("run_walk_forward", { blockId: "calendar" });
        const windowFields = [
          "inSampleStart",
          "inSampleEnd",
          "outOfSampleStart",
          "outOfSampleEnd",
        ] as const;
        const periods = walkForward.periods as Structured[];
        expect(periods.length).toBeGreaterThan(0);
        expect(periods[0].inSampleStart).toBe(FIRST_DAY);
        for (const period of periods) {
          for (const field of windowFields) expect(period[field]).toMatch(CALENDAR_DAY);
        }

        const degradation = await call("analyze_walk_forward_degradation", {
          blockId: "calendar",
        });
        const window = (entry: Structured) =>
          Object.fromEntries(windowFields.map((field) => [field, entry[field]]));
        expect({
          periods: (degradation.periods as Structured[]).map((period) =>
            window(period.window as Structured),
          ),
          skippedWindows: (degradation.skippedWindows as Structured[]).map(window),
        }).toEqual({
          periods: [0, 1, 2].map(degradationWindow),
          skippedWindows: [degradationWindow(3)],
        });

        const edgeDecay = await call("analyze_edge_decay", { blockId: "calendar" });
        const walkForwardSignal = (edgeDecay.signals as Record<string, Structured>).walkForward;
        expect(
          ((walkForwardSignal.detail as Structured).periods as Structured[]).map((period) =>
            window(period.window as Structured),
          ),
        ).toEqual([0, 1, 2].map(degradationWindow));
      } finally {
        await client.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
