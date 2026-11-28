/**
 * Integration tests for the opt-in capital basis and top-day figures of
 * get_statistics and get_period_returns, on a synthetic block imported with
 * import_csv. No real trading data is used.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeConnection } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerCoreBlockTools } from "../../src/tools/blocks/core.ts";
import { registerPerformanceTools } from "../../src/tools/performance.ts";

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (input: Record<string, unknown>) => Promise<Result>;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One 1-day trade per weekday 2021-2023, +10 each, except:
 *   2021-03-15 +5,000, 2022-06-15 +3,000, 2023-09-15 +2,000 (the three best days)
 *   all other days of 2022 are -20 instead of +10, so 2022 loses even with its best day.
 */
const BEST = new Map([
  ["2021-03-15", 5_000],
  ["2022-06-15", 3_000],
  ["2023-09-15", 2_000],
]);
function tradeLog(): { csv: string; total: number; days: number } {
  const rows = [
    "Date Opened,Time Opened,Date Closed,Time Closed,Legs,Premium,No. of Contracts,P/L,Strategy",
  ];
  let total = 0;
  let days = 0;
  for (let d = "2021-01-04"; d <= "2023-12-29"; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const pl = BEST.get(d) ?? (d.startsWith("2022") ? -20 : 10);
    rows.push(`${d},09:35:00,${d},15:00:00,SPX 4000P/3950P,100,1,${pl},Synthetic`);
    total += pl;
    days++;
  }
  return { csv: rows.join("\n") + "\n", total, days };
}

async function withBlock(
  run: (call: (name: string, args: Record<string, unknown>) => Promise<Result>) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-capital-basis-"));
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as McpServer;
  registerImportTools(server, root);
  registerCoreBlockTools(server, root);
  registerPerformanceTools(server, root);
  try {
    const csvPath = path.join(root, "source.csv");
    await fs.writeFile(csvPath, tradeLog().csv);
    const imported = await handlers.get("import_csv")!({ csvPath, blockName: "Topdays" });
    expect(imported.isError).not.toBe(true);
    await run((name, args) => handlers.get(name)!(args));
  } finally {
    await closeConnection();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const OPT_IN_KEYS = [
  "capitalBasis",
  "plWithoutBestDays",
  "positiveYearShare",
  "yearlyNetPl",
  "topDaysMethodology",
];

describe("get_statistics opt-in figures", () => {
  it("reports P&L without the best days and the share of positive years", async () => {
    const { total } = tradeLog();
    await withBlock(async (call) => {
      const result = await call("get_statistics", {
        blockId: "topdays",
        riskFreeRateAnnualPct: 0,
        topDays: [1, 5, 10],
      });
      const data = result.structuredContent as Record<string, unknown>;
      const removed = data.plWithoutBestDays as Array<{
        n: number;
        pl: number;
        removedPl: number;
        shareOfTotal: number;
        days: string[];
      }>;
      expect(removed.map((r) => r.n)).toEqual([1, 5, 10]);
      expect(removed[0]).toEqual({
        n: 1,
        pl: total - 5_000,
        removedPl: 5_000,
        shareOfTotal: 5_000 / total,
        days: ["2021-03-15"],
      });
      // Best 5 = the three planted days + the two earliest +10 days.
      expect(removed[1].days.slice(0, 3)).toEqual(["2021-03-15", "2022-06-15", "2023-09-15"]);
      expect(removed[1].removedPl).toBe(10_020);
      expect(removed[2].removedPl).toBe(10_070);
      expect(data.positiveYearShare).toBeCloseTo(2 / 3, 12);
      const years = data.yearlyNetPl as Array<{ year: number; netPl: number }>;
      expect(years.map((y) => y.year)).toEqual([2021, 2022, 2023]);
      expect(years[1].netPl).toBeLessThan(0);
      expect(data).not.toHaveProperty("capitalBasis");
    });
  });

  it("adds a capital-basis summary and leaves the rest of the response unchanged", async () => {
    const { total } = tradeLog();
    await withBlock(async (call) => {
      const plain = (await call("get_statistics", { blockId: "topdays", riskFreeRateAnnualPct: 0 }))
        .structuredContent as Record<string, unknown>;
      for (const key of OPT_IN_KEYS) expect(plain).not.toHaveProperty(key);

      const withBasis = (
        await call("get_statistics", {
          blockId: "topdays",
          riskFreeRateAnnualPct: 0,
          capitalBasis: { mode: "fixed", amount: 50_000 },
          topDays: [5],
        })
      ).structuredContent as Record<string, unknown>;
      const basis = withBasis.capitalBasis as Record<string, number | string>;
      expect(basis.mode).toBe("fixed");
      expect(basis.amount).toBe(50_000);
      expect(basis.amountSource).toBe("input");
      expect(basis.netPl).toBeCloseTo(total, 6);
      expect(basis.totalReturnPct).toBeCloseTo((total / 50_000) * 100, 10);
      expect(basis.maxDrawdownDollars as number).toBeGreaterThan(0);

      // syncInfo appears only on the call that synced the block.
      const strip = (d: Record<string, unknown>, keys: string[]) => {
        const copy = { ...d };
        for (const key of keys) delete copy[key];
        return copy;
      };
      expect(strip(withBasis, [...OPT_IN_KEYS, "syncInfo"])).toEqual(strip(plain, ["syncInfo"]));
    });
  });

  it("compounding without an amount uses the block's resolved starting capital", async () => {
    await withBlock(async (call) => {
      const data = (
        await call("get_statistics", {
          blockId: "topdays",
          riskFreeRateAnnualPct: 0,
          capitalBasis: { mode: "compounding" },
        })
      ).structuredContent as Record<string, unknown>;
      const basis = data.capitalBasis as Record<string, number | string>;
      expect(basis.mode).toBe("compounding");
      expect(basis.amount).toBe((data.stats as { initialCapital: number }).initialCapital);
      expect(basis.amountSource).toBe("assumed_default");
    });
  });
});

describe("get_period_returns yearly + capital basis", () => {
  it("groups by year and adds returnPct on a fixed and a compounding basis", async () => {
    await withBlock(async (call) => {
      const fixed = (
        await call("get_period_returns", {
          blockId: "topdays",
          period: "yearly",
          capitalBasis: { mode: "fixed", amount: 100_000 },
        })
      ).structuredContent as Record<string, unknown>;
      const periods = fixed.periods as Array<{ period: string; netPl: number; returnPct: number }>;
      expect(periods.map((p) => p.period)).toEqual(["2021", "2022", "2023"]);
      for (const p of periods) expect(p.returnPct).toBeCloseTo(p.netPl / 1_000, 10);
      expect((fixed.capitalBasis as { amountSource: string }).amountSource).toBe("input");

      const comp = (
        await call("get_period_returns", {
          blockId: "topdays",
          period: "yearly",
          capitalBasis: { mode: "compounding", amount: 100_000 },
        })
      ).structuredContent as Record<string, unknown>;
      const cp = comp.periods as Array<{ netPl: number; returnPct: number }>;
      expect(cp[0].returnPct).toBeCloseTo(cp[0].netPl / 1_000, 10);
      expect(cp[1].returnPct).toBeCloseTo((cp[1].netPl / (100_000 + cp[0].netPl)) * 100, 10);
      const totals = comp.totals as { netPl: number; returnPct: number };
      expect(totals.returnPct).toBeCloseTo(totals.netPl / 1_000, 10);
    });
  });

  it("leaves the default response unchanged", async () => {
    await withBlock(async (call) => {
      const data = (
        await call("get_period_returns", {
          blockId: "topdays",
          period: "monthly",
          normalizeTo1Lot: false,
        })
      ).structuredContent as Record<string, unknown>;
      expect(data.periodType).toBe("monthly");
      expect(data).not.toHaveProperty("capitalBasis");
      const periods = data.periods as Array<Record<string, unknown>>;
      expect(periods[0]).not.toHaveProperty("returnPct");
      expect(data.totals).not.toHaveProperty("returnPct");
      expect(data.calculationMethodology).not.toHaveProperty("returnPct");
    });
  });
});
