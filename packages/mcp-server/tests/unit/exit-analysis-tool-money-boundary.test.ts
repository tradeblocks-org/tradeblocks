import { jest } from "@jest/globals";
import type { z } from "zod";

const handleReplayTrade = jest.fn();

jest.unstable_mockModule("../../src/tools/replay.ts", () => ({
  handleReplayTrade,
}));

const { registerExitAnalysisTools } = await import("../../src/tools/exit-analysis.ts");

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

interface ToolConfig {
  inputSchema: z.ZodType<Record<string, unknown>>;
}

function captureAnalyzeTool(): { schema: ToolConfig["inputSchema"]; handler: ToolHandler } {
  const tools = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      tools.set(name, { config, handler });
    },
  };

  const stores = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExitAnalysisTools(server as any, "/unused", stores as any);

  const tool = tools.get("analyze_exit_triggers");
  if (!tool) throw new Error("analyze_exit_triggers was not registered");
  return { schema: tool.config.inputSchema, handler: tool.handler };
}

const { schema, handler } = captureAnalyzeTool();

const BASE_LEG = {
  ticker: "SPY260105C00470000",
  strike: 470,
  type: "C" as const,
  expiry: "2026-01-05",
};

function pnlPath(values: number[]) {
  return values.map((strategyPnl, index) => ({
    timestamp: `2026-01-05 09:${String(30 + index).padStart(2, "0")}`,
    strategyPnl,
    legPrices: [],
    netDelta: null,
  }));
}

async function runAnalyzeTool(input: Record<string, unknown>, path: number[]) {
  const parsed = schema.parse(input);
  const legs = parsed.legs as Array<{
    ticker: string;
    quantity: number;
    entry_price: number;
  }>;
  handleReplayTrade.mockResolvedValueOnce({
    pnlPath: pnlPath(path),
    legs: legs.map((leg) => ({
      occTicker: leg.ticker,
      quantity: leg.quantity,
      entryPrice: leg.entry_price,
      multiplier: parsed.multiplier,
    })),
  });
  return handler(parsed);
}

function analysis(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as {
    overall: {
      triggers: Array<{ fireEvent: { detail: string; pnlAtFire: number } | null }>;
      firstToFire: { detail: string; pnlAtFire: number } | null;
    };
  };
}

describe("registered analyze_exit_triggers money boundaries", () => {
  it("analyses a percentage target after near-cancelling explicit leg prices", async () => {
    const result = await runAnalyzeTool(
      {
        legs: [
          { ...BASE_LEG, quantity: 1, entry_price: 1.01 },
          { ...BASE_LEG, quantity: -1, entry_price: 1.009999 },
        ],
        multiplier: 100,
        triggers: [{ type: "profitTarget", unit: "percent", threshold: 1 }],
      },
      [0, 0.0001, 0.0001],
    );

    const data = analysis(result);
    expect(data.overall.firstToFire).not.toBeNull();
    expect(data.overall.firstToFire!.detail).toContain("($0.0001)");
  });

  it("analyses a percentage target when explicit leg prices cancel to zero", async () => {
    const result = await runAnalyzeTool(
      {
        legs: [
          { ...BASE_LEG, quantity: 3, entry_price: 0.1 },
          { ...BASE_LEG, quantity: -1, entry_price: 0.3 },
        ],
        multiplier: 100,
        triggers: [{ type: "profitTarget", unit: "percent", threshold: 1 }],
      },
      [0, 0],
    );

    const data = analysis(result);
    expect(data.overall.firstToFire).not.toBeNull();
    expect(data.overall.firstToFire!.detail).toContain("($0.00)");
  });

  it("fires and reports a high-domain target at its resolved figure", async () => {
    const resolvedTarget = 281_474_976.710656;
    const result = await runAnalyzeTool(
      {
        legs: [{ ...BASE_LEG, quantity: 1, entry_price: 1 }],
        multiplier: 100,
        triggers: [{ type: "profitTarget", threshold: 281_474_976.7106564 }],
      },
      [0, resolvedTarget, resolvedTarget],
    );

    const data = analysis(result);
    expect(data.overall.firstToFire).not.toBeNull();
    expect(data.overall.firstToFire!.pnlAtFire).toBe(resolvedTarget);
    expect(data.overall.firstToFire!.detail).toContain("target $281474976.710656");
  });
});
