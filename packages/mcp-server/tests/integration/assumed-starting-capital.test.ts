import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeConnection } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerCoreBlockTools } from "../../src/tools/blocks/core.ts";
import { registerPerformanceTools } from "../../src/tools/performance.ts";

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (input: Record<string, unknown>) => Promise<Result>;

async function withTools(
  run: (
    root: string,
    call: (name: string, args: Record<string, unknown>) => Promise<Result>,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-capital-"));
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
    await run(root, (name, args) => handlers.get(name)!(args));
  } finally {
    await closeConnection();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const missing =
  "Date Opened,Date Closed,Strategy,P/L,Legs\n2024-01-02,2024-01-02,Alpha,200,SPY\n2024-01-03,2024-01-03,Beta,-50,SPY\n";
const daily =
  "Date,Net Liquidity,P/L,Drawdown %\n2024-01-02,10200,200,0\n2024-01-03,10150,-50,0.49019607843137253\n";
const statistics = z.object({
  stats: z.object({
    initialCapital: z.number(),
    netPl: z.number(),
    sharpeRatio: z.number().optional(),
    cagr: z.number().optional(),
    maxDrawdown: z.number(),
    calmarRatio: z.number().optional(),
  }),
  calculationMethodology: z.object({ initialCapital: z.object({ source: z.string() }) }),
});
const performance = z.object({
  equityCurve: z.array(z.object({ equity: z.number() })),
  drawdown: z.array(z.object({ drawdownPct: z.number() })).optional(),
  equityCurveCapitalSource: z.string(),
});

async function importAndRead(
  root: string,
  call: (name: string, args: Record<string, unknown>) => Promise<Result>,
  contents: string,
  dailyContents?: string,
) {
  const csvPath = path.join(root, "source.csv");
  await fs.writeFile(csvPath, contents);
  const dailyLogPath = path.join(root, "daily.csv");
  if (dailyContents) await fs.writeFile(dailyLogPath, dailyContents);
  const imported = await call("import_csv", {
    csvPath,
    blockName: "Capital",
    ...(dailyContents ? { dailyLogPath } : {}),
  });
  expect(imported.isError).not.toBe(true);
  const stats = await call("get_statistics", { blockId: "capital", riskFreeRateAnnualPct: 0 });
  const charts = await call("get_performance_charts", {
    blockId: "capital",
    charts: ["equity_curve", "drawdown"],
  });
  expect(stats.isError).not.toBe(true);
  expect(charts.isError).not.toBe(true);
  return {
    stats: statistics.parse(stats.structuredContent),
    charts: performance.parse(charts.structuredContent),
  };
}

describe("import_csv starting capital across tools", () => {
  it("assumes 100000 for a trade-only log without Funds at Close", async () => {
    await withTools(async (root, call) => {
      const { stats, charts } = await importAndRead(root, call, missing);
      const expectedCagr = (Math.pow(100150 / 100000, 365.25) - 1) * 100;
      const expectedDrawdown = (50 / 100200) * 100;
      expect(stats.stats.initialCapital).toBe(100000);
      expect(stats.stats.cagr).toBeCloseTo(expectedCagr);
      expect(stats.stats.maxDrawdown).toBeCloseTo(expectedDrawdown);
      expect(stats.stats.calmarRatio).toBeCloseTo(expectedCagr / expectedDrawdown);
      expect(stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(charts.equityCurve[0].equity).toBe(100000);
      expect(charts.equityCurve[1].equity).toBe(100200);
      expect(Math.abs(charts.drawdown?.[2].drawdownPct ?? NaN)).toBeCloseTo(expectedDrawdown);
      expect(charts.equityCurveCapitalSource).toBe("assumed_default");
    });
  });
  it("uses the daily-derived start for the same unfunded trade log", async () => {
    await withTools(async (root, call) => {
      const { stats, charts } = await importAndRead(root, call, missing, daily);
      const expectedCagr = (Math.pow(10150 / 10000, 365.25) - 1) * 100;
      const expectedDrawdown = (50 / 10200) * 100;
      expect(stats.stats.initialCapital).toBe(10000);
      expect(stats.stats.cagr).toBeCloseTo(expectedCagr);
      expect(stats.stats.maxDrawdown).toBeCloseTo(expectedDrawdown);
      expect(stats.calculationMethodology.initialCapital.source).toBe("daily_log");
      expect(charts.equityCurve[0].equity).toBe(10000);
      expect(Math.abs(charts.drawdown?.[2].drawdownPct ?? NaN)).toBeCloseTo(expectedDrawdown);
      expect(charts.equityCurveCapitalSource).toBe("daily_log");
      const monthly = await call("get_performance_charts", {
        blockId: "capital",
        charts: ["monthly_returns_percent"],
      });
      const percent = z
        .object({ monthlyReturnsPercent: z.record(z.string(), z.record(z.string(), z.number())) })
        .parse(monthly.structuredContent);
      // January's +150 against the same 10000 start the equity curve uses.
      expect(percent.monthlyReturnsPercent["2024"]["1"]).toBeCloseTo(1.5);
    });
    await withTools(async (root, call) => {
      const [header, ...rows] = daily.trim().split("\n");
      const reversed = [header, ...rows.reverse()].join("\n") + "\n";
      const { stats, charts } = await importAndRead(root, call, missing, reversed);
      expect(stats.stats.initialCapital).toBe(10000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("daily_log");
      expect(charts.equityCurve[0].equity).toBe(10000);
      expect(charts.equityCurveCapitalSource).toBe("daily_log");
    });
  });

  it("agrees on a date-filtered start from the filtered daily log", async () => {
    await withTools(async (root, call) => {
      await importAndRead(root, call, missing, daily);
      const stats = statistics.parse(
        (
          await call("get_statistics", {
            blockId: "capital",
            startDate: "2024-01-03",
            riskFreeRateAnnualPct: 0,
          })
        ).structuredContent,
      );
      const charts = performance.parse(
        (
          await call("get_performance_charts", {
            blockId: "capital",
            charts: ["equity_curve"],
            dateRange: { from: "2024-01-03" },
          })
        ).structuredContent,
      );
      expect(stats.stats.initialCapital).toBe(10200);
      expect(stats.calculationMethodology.initialCapital.source).toBe("daily_log");
      expect(charts.equityCurve[0].equity).toBe(10200);
      expect(charts.equityCurveCapitalSource).toBe("daily_log");
    });
  });

  it("distinguishes an explicit zero after a loss from an omitted balance", async () => {
    const loss =
      "Date Opened,Date Closed,Strategy,P/L,Legs,Funds at Close\n2024-01-02,2024-01-02,Alpha,-200,SPY,0\n";
    await withTools(async (root, call) => {
      const observed = await importAndRead(root, call, loss);
      expect(observed.stats.stats.initialCapital).toBe(200);
      expect(observed.stats.calculationMethodology.initialCapital.source).toBe(
        "observed_trade_funds",
      );
      expect(observed.charts.equityCurve[0].equity).toBe(200);
      expect(observed.charts.equityCurveCapitalSource).toBe("observed_trade_funds");
    });
    await withTools(async (root, call) => {
      const absent = await importAndRead(
        root,
        call,
        loss.replace(",Funds at Close", "").replace(",-200,SPY,0", ",-200,SPY"),
      );
      expect(absent.stats.stats.initialCapital).toBe(100000);
      expect(absent.stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(absent.charts.equityCurve[0].equity).toBe(100000);
      expect(absent.charts.equityCurveCapitalSource).toBe("assumed_default");
    });
  });

  it("preserves a funded gross-basis block and deducts fees exactly once", async () => {
    const csv =
      "Date Opened,Date Closed,Strategy,P/L,Legs,Funds at Close,Opening Commissions + Fees,Closing Commissions + Fees\n2024-01-02,2024-01-02,Alpha,200,SPY,10190,5,5\n";
    await withTools(async (root, call) => {
      const csvPath = path.join(root, "source.csv");
      await fs.writeFile(csvPath, csv);
      const imported = await call("import_csv", {
        csvPath,
        blockName: "Capital",
        plBasis: "gross_before_fees",
      });
      expect(imported.isError).not.toBe(true);
      const stats = statistics.parse(
        (await call("get_statistics", { blockId: "capital" })).structuredContent,
      );
      const charts = performance.parse(
        (
          await call("get_performance_charts", {
            blockId: "capital",
            charts: ["equity_curve"],
          })
        ).structuredContent,
      );
      expect(stats.stats.initialCapital).toBe(10000);
      expect(stats.stats.netPl).toBe(190);
      expect(stats.calculationMethodology.initialCapital.source).toBe("observed_trade_funds");
      expect(charts.equityCurve.map((point) => point.equity)).toEqual([10000, 10190]);
      expect(charts.equityCurveCapitalSource).toBe("observed_trade_funds");
    });
  });
  it("preserves funded statistics when a daily log has no P/L column", async () => {
    const funded =
      "Date Opened,Date Closed,Strategy,P/L,Legs,Funds at Close\n2024-01-02,2024-01-02,Alpha,200,SPY,10200\n2024-01-03,2024-01-03,Beta,-50,SPY,10150\n";
    const dailyWithoutPl =
      "Date,Net Liquidity,Drawdown %\n2024-01-02,10200,0\n2024-01-03,10000,2\n";
    await withTools(async (root, call) => {
      const { stats, charts } = await importAndRead(root, call, funded, dailyWithoutPl);
      expect(stats.stats.initialCapital).toBe(10200);
      expect(stats.stats.sharpeRatio).toBeUndefined();
      expect(stats.stats.maxDrawdown).toBe(2);
      expect(stats.stats.calmarRatio).toBeCloseTo(-49.96387920766545);
      expect(stats.calculationMethodology.initialCapital.source).toBe("daily_log");
      expect(charts.equityCurve[0].equity).toBe(10000);
      expect(charts.equityCurveCapitalSource).toBe("observed_trade_funds");
      const subset = statistics.parse(
        (
          await call("get_statistics", {
            blockId: "capital",
            strategy: "Alpha",
            riskFreeRateAnnualPct: 0,
          })
        ).structuredContent,
      );
      expect(subset.stats.initialCapital).toBe(10200);
      expect(subset.calculationMethodology.initialCapital.source).toBe("daily_log");
    });
  });

  it("keeps daily-log metrics when a funded daily start is impossible", async () => {
    const funded =
      "Date Opened,Date Closed,Strategy,P/L,Legs,Funds at Close\n2024-01-02,2024-01-02,Alpha,200,SPY,10200\n";
    await withTools(async (root, call) => {
      const { stats, charts } = await importAndRead(
        root,
        call,
        funded,
        "Date,Net Liquidity,P/L,Drawdown %\n2024-01-02,0,200,0\n2024-01-03,0,0,3\n",
      );
      expect(stats.stats.initialCapital).toBe(10000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("observed_trade_funds");
      // The single winning trade has no realized drawdown; 3 comes from the daily log.
      expect(stats.stats.maxDrawdown).toBe(3);
      expect(charts.equityCurve[0].equity).toBe(10000);
      expect(charts.equityCurveCapitalSource).toBe("observed_trade_funds");
    });
  });

  it("does not treat a daily log without P/L or an impossible balance as observed", async () => {
    await withTools(async (root, call) => {
      const { stats, charts } = await importAndRead(
        root,
        call,
        missing,
        "Date,Net Liquidity\n2024-01-02,10200\n",
      );
      expect(stats.stats.initialCapital).toBe(100000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(charts.equityCurve[0].equity).toBe(100000);
      expect(charts.equityCurveCapitalSource).toBe("assumed_default");
    });
    await withTools(async (root, call) => {
      const impossible =
        "Date Opened,Date Closed,Strategy,P/L,Legs,Funds at Close\n2024-01-02,2024-01-02,Alpha,200,SPY,-100\n";
      const { stats, charts } = await importAndRead(root, call, impossible);
      expect(stats.stats.initialCapital).toBe(100000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(charts.equityCurve[0].equity).toBe(100000);
      expect(charts.equityCurveCapitalSource).toBe("assumed_default");
    });
  });

  it("keeps initial capital positive when the unfunded trade has no close date", async () => {
    await withTools(async (root, call) => {
      const open = "Date Opened,Strategy,P/L,Legs\n2024-01-02,Alpha,200,SPY\n";
      const { stats, charts } = await importAndRead(root, call, open);
      expect(stats.stats.initialCapital).toBe(100000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(charts.equityCurve[0].equity).toBe(100000);
    });
  });

  it("does not apply whole-portfolio daily capital to a strategy subset", async () => {
    await withTools(async (root, call) => {
      const csvPath = path.join(root, "source.csv");
      const dailyLogPath = path.join(root, "daily.csv");
      await fs.writeFile(csvPath, missing);
      await fs.writeFile(dailyLogPath, daily);
      expect(
        (await call("import_csv", { csvPath, dailyLogPath, blockName: "Capital" })).isError,
      ).not.toBe(true);
      const stats = statistics.parse(
        (await call("get_statistics", { blockId: "capital", strategy: "Alpha" })).structuredContent,
      );
      const charts = performance.parse(
        (
          await call("get_performance_charts", {
            blockId: "capital",
            strategy: "Alpha",
            charts: ["equity_curve"],
          })
        ).structuredContent,
      );
      expect(stats.stats.initialCapital).toBe(100000);
      expect(stats.calculationMethodology.initialCapital.source).toBe("assumed_default");
      expect(charts.equityCurve[0].equity).toBe(100000);
      expect(charts.equityCurveCapitalSource).toBe("assumed_default");
    });
  });
});
