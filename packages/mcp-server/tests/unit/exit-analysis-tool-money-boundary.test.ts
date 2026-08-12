import { jest } from "@jest/globals";
import type { z } from "zod";

const handleReplayTrade = jest.fn();
const runAndReadAll = jest.fn(async () => ({
  getRows: () => [[0, 0, "2026-01-05"]],
}));
const getConnection = jest.fn(async () => ({ runAndReadAll }));

jest.unstable_mockModule("../../src/tools/replay.ts", () => ({
  handleReplayTrade,
}));

jest.unstable_mockModule("../../src/db/connection.ts", () => ({
  getConnection,
}));

const [
  { registerExitAnalysisTools },
  { registerBatchExitAnalysisTools },
  { computeStrategyPnlPath },
] = await Promise.all([
  import("../../src/tools/exit-analysis.ts"),
  import("../../src/tools/batch-exit-analysis.ts"),
  import("../../src/utils/trade-replay.ts"),
]);

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

interface ToolConfig {
  inputSchema: z.ZodType<Record<string, unknown>>;
}

function captureTool(name: "analyze_exit_triggers" | "batch_exit_analysis"): {
  schema: ToolConfig["inputSchema"];
  handler: ToolHandler;
} {
  const tools = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      tools.set(name, { config, handler });
    },
  };

  const stores = {};
  const registeredServer = server as unknown as Parameters<typeof registerExitAnalysisTools>[0];
  const marketStores = stores as unknown as Parameters<typeof registerExitAnalysisTools>[2];
  if (name === "analyze_exit_triggers") {
    registerExitAnalysisTools(registeredServer, "/unused", marketStores);
  } else {
    registerBatchExitAnalysisTools(registeredServer, "/unused", marketStores);
  }

  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return { schema: tool.config.inputSchema, handler: tool.handler };
}

const { schema, handler } = captureTool("analyze_exit_triggers");
const { schema: batchSchema, handler: batchHandler } = captureTool("batch_exit_analysis");

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

const ENTRY_COST_TERMS = [-0.52964374, -0.774253, 0.52964374, 0.774253, 0.0000005];

function exactEntryCostReplay(order: number[], pnl = 0) {
  const legs = order.map((termIndex, index) => ({
    occTicker: `SPY260105C${String(47000000 + index).padStart(8, "0")}`,
    quantity: Math.sign(ENTRY_COST_TERMS[termIndex]),
    entryPrice: Math.abs(ENTRY_COST_TERMS[termIndex]),
    multiplier: 1,
  }));
  const pnlLegIndex = legs.findIndex((leg) => leg.quantity > 0);
  const barsByLeg = legs.map((leg, index) => {
    const mark = leg.entryPrice + (index === pnlLegIndex ? pnl : 0);
    return ["09:30", "09:31"].map((time) => ({
      date: "2026-01-05",
      time,
      open: mark,
      high: mark,
      low: mark,
      close: mark,
      volume: 1,
      ticker: leg.occTicker,
    }));
  });
  return { legs, pnlPath: computeStrategyPnlPath(legs, barsByLeg) };
}

function explicitLegs(replay: ReturnType<typeof exactEntryCostReplay>) {
  return replay.legs.map((leg) => ({
    ...BASE_LEG,
    ticker: leg.occTicker,
    quantity: leg.quantity,
    entry_price: leg.entryPrice,
  }));
}

async function runExactAnalyze(order: number[], pnl = 0) {
  const replay = exactEntryCostReplay(order, pnl);
  handleReplayTrade.mockResolvedValueOnce(replay);
  return runAnalyzeTool(
    {
      legs: explicitLegs(replay),
      multiplier: 1,
      triggers: [{ type: "profitTarget", unit: "percent", threshold: 1 }],
    },
    [],
    false,
  );
}

async function runExactBatch(order: number[], pnl = 0) {
  handleReplayTrade.mockResolvedValueOnce(exactEntryCostReplay(order, pnl));
  const parsed = batchSchema.parse({
    block_id: "exact-entry-cost",
    candidate_policy: [{ type: "profitTarget", unit: "percent", threshold: 1 }],
    baseline_mode: "actual",
    limit: 1,
    multiplier: 1,
    format: "full",
  });
  return batchHandler(parsed);
}

async function runAnalyzeTool(input: Record<string, unknown>, path: number[], mockReplay = true) {
  const parsed = schema.parse(input);
  const legs = parsed.legs as Array<{
    ticker: string;
    quantity: number;
    entry_price: number;
  }>;
  if (mockReplay) {
    handleReplayTrade.mockResolvedValueOnce({
      pnlPath: pnlPath(path),
      legs: legs.map((leg) => ({
        occTicker: leg.ticker,
        quantity: leg.quantity,
        entryPrice: leg.entry_price,
        multiplier: parsed.multiplier,
      })),
    });
  }
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
  const authoredOrder = [0, 1, 2, 3, 4];
  const reversedOrder = [...authoredOrder].reverse();

  it("derives the same percentage threshold across authored leg orders", async () => {
    const results = await Promise.all([
      runExactAnalyze(authoredOrder, 0.000001),
      runExactAnalyze(reversedOrder, 0.000001),
    ]);

    for (const result of results) {
      const firstToFire = analysis(result).overall.firstToFire;
      expect(firstToFire).not.toBeNull();
      expect(firstToFire!.detail).toContain("($0.000001)");
    }
  });

  it("makes the same zero-P&L exit decision across authored leg orders", async () => {
    const results = await Promise.all([
      runExactAnalyze(authoredOrder),
      runExactAnalyze(reversedOrder),
    ]);

    for (const result of results) {
      expect(analysis(result).overall.firstToFire).toBeNull();
    }
  });

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

describe("registered batch_exit_analysis money boundaries", () => {
  it("derives the same percentage threshold across authored leg orders", async () => {
    const authoredOrder = [0, 1, 2, 3, 4];
    for (const order of [authoredOrder, [...authoredOrder].reverse()]) {
      const result = await runExactBatch(order, 0.000001);
      expect(result.isError).not.toBe(true);
      const trade = (
        result.structuredContent as {
          perTrade: Array<{ triggerFired: string; candidatePnl: number }>;
        }
      ).perTrade[0];
      expect(trade.triggerFired).toBe("profitTarget");
      expect(trade.candidatePnl).toBe(0.000001);
    }
  });

  it("makes the same zero-P&L exit decision across authored leg orders", async () => {
    const authoredOrder = [0, 1, 2, 3, 4];
    const results = [];
    for (const order of [authoredOrder, [...authoredOrder].reverse()]) {
      const result = await runExactBatch(order);
      expect(result.isError).not.toBe(true);
      results.push(
        (result.structuredContent as { perTrade: Array<{ triggerFired: string }> }).perTrade[0]
          .triggerFired,
      );
    }

    expect(results).toEqual(["noTrigger", "noTrigger"]);
  });
});
