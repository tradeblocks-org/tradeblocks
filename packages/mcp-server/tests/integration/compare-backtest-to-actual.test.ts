import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPerformanceTools } from "../../src/tools/performance.ts";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ text?: string }>;
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

const TRADE_HEADERS =
  "Date Opened,Time Opened,Date Closed,Time Closed,Opening Price,Closing Price,Legs,Premium,No. of Contracts,P/L,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,Reason For Close,Funds at Close,Margin Req.";
const REPORTING_HEADERS =
  "Date Opened,Time Opened,Date Closed,Time Closed,Opening Price,Closing Price,Legs,Initial Premium,No. of Contracts,P/L,Strategy,Reason For Close,Avg. Closing Cost";

// Backtest trades 10 contracts, live trades 2. Hand-computed under toReported (factor 2/10):
//   01-02 Alpha  backtest 1000 -> 200, actual 150, slippage -50
//   01-03 Alpha  backtest  500 -> 100, actual 110, slippage +10
//   01-04 Alpha  backtest 3000, unmatched (no reported size to scale to)
//   01-04 Beta   actual 40 on 1 contract, unmatched
// Matched totals: backtest 300, actual 260, slippage -40 (-13.33%).
const TRADES = [
  TRADE_HEADERS,
  "2024-01-02,09:35:00,2024-01-02,15:30:00,2.50,0.50,SPX 4800P/4750P,250,10,1000,Alpha,0,0,Target,101000,5000",
  "2024-01-03,09:35:00,2024-01-03,15:30:00,2.50,0.50,SPX 4800P/4750P,250,10,500,Alpha,0,0,Target,101500,5000",
  "2024-01-04,09:35:00,2024-01-04,15:30:00,2.50,0.50,SPX 4800P/4750P,250,10,3000,Alpha,0,0,Target,104500,5000",
].join("\n");
const REPORTING = [
  REPORTING_HEADERS,
  "2024-01-02,09:35:00,2024-01-02,15:30:00,2.50,0.50,SPX 4800P/4750P,250,2,150,Alpha,Target,0.50",
  "2024-01-03,09:35:00,2024-01-03,15:30:00,2.50,0.50,SPX 4800P/4750P,250,2,110,Alpha,Target,0.50",
  "2024-01-04,09:35:00,2024-01-04,15:30:00,2.50,0.50,SPX 4800P/4750P,250,1,40,Beta,Target,0.50",
].join("\n");

async function compare(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-compare-"));
  try {
    const blockPath = path.join(root, "live");
    await fs.mkdir(blockPath, { recursive: true });
    await fs.writeFile(path.join(blockPath, "tradelog.csv"), TRADES);
    await fs.writeFile(path.join(blockPath, "reportinglog.csv"), REPORTING);
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerPerformanceTools(server, root);
    const result = await handlers.get("compare_backtest_to_actual")!({
      blockId: "live",
      matchedOnly: false,
      detailLevel: "summary",
      outliersOnly: false,
      outliersThreshold: 2,
      groupBy: "none",
      ...args,
    });
    expect(result.isError).not.toBe(true);
    return result.structuredContent!;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

type Summary = {
  totalBacktestPl: number;
  totalActualPl: number;
  totalSlippage: number;
  avgSlippagePercent: number | null;
  unmatchedBacktestPl: number;
  unmatchedActualPl: number;
  matchedComparisons: number;
  unmatchedBacktestCount: number;
  unmatchedActualCount: number;
};

describe("compare_backtest_to_actual summary totals", () => {
  it.each([
    ["summary", false],
    ["summary", true],
    ["trades", false],
    ["trades", true],
  ] as const)(
    "toReported (%s, matchedOnly=%s) totals only matched rows at the reported size",
    async (detailLevel, matchedOnly) => {
      const data = await compare({ scaling: "toReported", detailLevel, matchedOnly });
      const summary = data.summary as Summary;
      expect(summary.totalBacktestPl).toBeCloseTo(300, 6);
      expect(summary.totalActualPl).toBeCloseTo(260, 6);
      expect(summary.totalSlippage).toBeCloseTo(-40, 6);
      expect(summary.avgSlippagePercent).toBeCloseTo((-40 / 300) * 100, 6);
      expect(summary.matchedComparisons).toBe(2);
      // Unmatched P/L stays visible separately, each row at its own size.
      expect(summary.unmatchedBacktestPl).toBe(3000);
      expect(summary.unmatchedActualPl).toBe(40);
      expect(summary.unmatchedBacktestCount).toBe(1);
      expect(summary.unmatchedActualCount).toBe(1);
      expect(data.comparisons as unknown[]).toHaveLength(matchedOnly ? 2 : 4);
    },
  );

  it("toReported grouped slippage agrees with the matched rows", async () => {
    const data = await compare({ scaling: "toReported", groupBy: "strategy" });
    const groups = data.groups as Array<{ groupKey: string; totalSlippage: number }>;
    expect(groups.find((g) => g.groupKey === "Alpha")?.totalSlippage).toBeCloseTo(-40, 6);
    expect(groups.find((g) => g.groupKey === "Beta")?.totalSlippage).toBe(0);
  });

  it("raw with matchedOnly=false still totals every row on its shared raw scale", async () => {
    const summary = (await compare({ scaling: "raw" })).summary as Summary;
    expect(summary.totalBacktestPl).toBe(4500);
    expect(summary.totalActualPl).toBe(300);
    expect(summary.totalSlippage).toBe(-4200);
  });
});
