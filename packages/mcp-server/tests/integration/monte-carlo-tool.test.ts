/**
 * Integration tests for the run_monte_carlo MCP tool
 *
 * Covers the resampling and ruin-risk surface: the resampleMode default,
 * meanBlockLength (explicit and auto), ruinThresholdPct validation, and the
 * statistics the tool reports back (zeroBalancePaths, probabilityOfRuin).
 *
 * Uses the drawdown-test-block fixture (15 trades, two strategies, a losing
 * stretch in the middle) so paths dip below starting capital often enough to
 * exercise the ruin counter.
 */
import * as path from "path";
import { fileURLToPath } from "url";
import type { z } from "zod";
import { registerAnalysisTools } from "../../src/tools/analysis.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const BLOCK_ID = "drawdown-test-block";

// ---------------------------------------------------------------------------
// Tool capture harness
// ---------------------------------------------------------------------------

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

interface ToolConfig {
  inputSchema: z.ZodType<Record<string, unknown>>;
}

function captureMonteCarloTool(): { schema: ToolConfig["inputSchema"]; handler: ToolHandler } {
  const tools = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      tools.set(name, { config, handler });
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAnalysisTools(server as any, FIXTURES_DIR);

  const captured = tools.get("run_monte_carlo");
  if (!captured) throw new Error("run_monte_carlo was not registered");
  return { schema: captured.config.inputSchema, handler: captured.handler };
}

const { schema, handler } = captureMonteCarloTool();

interface MonteCarloOutput {
  parameters: {
    resampleMethod: string;
    resampleMode: string;
    meanBlockLength: number | null;
    ruinThresholdPct: number | null;
  };
  statistics: {
    probabilityOfProfit: number;
    zeroBalancePaths: number;
    probabilityOfRuin: number | null;
  };
  actualResamplePoolSize: number;
}

/** Parse input through the tool's own schema (so defaults apply), then run it. */
async function runTool(
  input: Record<string, unknown>,
): Promise<{ data: MonteCarloOutput; summary: string }> {
  const parsed = schema.parse({ blockId: BLOCK_ID, ...input });
  const result = await handler(parsed);
  if (result.isError) {
    throw new Error(`Tool returned an error: ${result.content[0]?.text}`);
  }
  return {
    data: result.structuredContent as unknown as MonteCarloOutput,
    summary: result.content[0]?.text ?? "",
  };
}

// Small, seeded, no synthetic-loss injection: keeps the resample pool equal to
// the fixture's 15 trades so the auto mean block length is exactly predictable.
const BASE_INPUT = {
  numSimulations: 200,
  randomSeed: 42,
  includeWorstCase: false,
};

describe("run_monte_carlo input schema", () => {
  it("defaults resampleMode to stationary-block and leaves the rest auto", () => {
    const parsed = schema.parse({ blockId: BLOCK_ID }) as Record<string, unknown>;

    expect(parsed.resampleMode).toBe("stationary-block");
    expect(parsed.meanBlockLength).toBeUndefined();
    expect(parsed.ruinThresholdPct).toBeUndefined();
  });

  it("accepts iid as the explicit opt-out", () => {
    const parsed = schema.parse({ blockId: BLOCK_ID, resampleMode: "iid" }) as Record<
      string,
      unknown
    >;
    expect(parsed.resampleMode).toBe("iid");
  });

  it("rejects a fractional or sub-1 meanBlockLength", () => {
    expect(() => schema.parse({ blockId: BLOCK_ID, meanBlockLength: 2.5 })).toThrow();
    expect(() => schema.parse({ blockId: BLOCK_ID, meanBlockLength: 0 })).toThrow();
  });

  it("rejects a ruinThresholdPct outside the 0-1 decimal range", () => {
    expect(() => schema.parse({ blockId: BLOCK_ID, ruinThresholdPct: 50 })).toThrow();
    expect(() => schema.parse({ blockId: BLOCK_ID, ruinThresholdPct: -0.1 })).toThrow();
    expect(schema.parse({ blockId: BLOCK_ID, ruinThresholdPct: 0.5 })).toMatchObject({
      ruinThresholdPct: 0.5,
    });
  });

  it("rejects a zero ruinThresholdPct", () => {
    // A zero threshold puts the ruin floor at starting capital, so essentially
    // every path that ever dipped would read as ruined. Reject it rather than
    // return a ~100% figure from a valid-looking request.
    expect(() => schema.parse({ blockId: BLOCK_ID, ruinThresholdPct: 0 })).toThrow();
  });

  it("accepts a ruinThresholdPct of exactly 1", () => {
    // A 100% decline floor is a zero balance: a well-defined question whose
    // answer coincides with zeroBalancePaths, and the percent-scale input on
    // the risk simulator page allows it, so keep the surfaces aligned.
    expect(schema.parse({ blockId: BLOCK_ID, ruinThresholdPct: 1 })).toMatchObject({
      ruinThresholdPct: 1,
    });
  });
});

describe("run_monte_carlo resampling echo", () => {
  it("reports the auto mean block length actually used", async () => {
    const { data } = await runTool(BASE_INPUT);

    expect(data.actualResamplePoolSize).toBe(15);
    expect(data.parameters.resampleMode).toBe("stationary-block");
    // Auto default is the cube root of the pool size: round(cbrt(15)) = 2
    expect(data.parameters.meanBlockLength).toBe(2);
  });

  it("reports an explicitly requested mean block length", async () => {
    const { data } = await runTool({ ...BASE_INPUT, meanBlockLength: 5 });
    expect(data.parameters.meanBlockLength).toBe(5);
  });

  it("reports a null mean block length in iid mode", async () => {
    const { data } = await runTool({ ...BASE_INPUT, resampleMode: "iid" });

    expect(data.parameters.resampleMode).toBe("iid");
    expect(data.parameters.meanBlockLength).toBeNull();
  });

  it("is reproducible for a given seed", async () => {
    const first = await runTool(BASE_INPUT);
    const second = await runTool(BASE_INPUT);
    expect(second.data.statistics).toEqual(first.data.statistics);
  });
});

describe("run_monte_carlo ruin statistics", () => {
  it("always reports zeroBalancePaths", async () => {
    const { data } = await runTool(BASE_INPUT);

    // 15 trades of a few hundred dollars each against ~10k of capital: no path
    // can reach a zero balance.
    expect(data.statistics.zeroBalancePaths).toBe(0);
  });

  it("omits probabilityOfRuin until a threshold is supplied", async () => {
    const { data, summary } = await runTool(BASE_INPUT);

    expect(data.parameters.ruinThresholdPct).toBeNull();
    expect(data.statistics.probabilityOfRuin).toBeNull();
    expect(summary).not.toContain("P(Ruin)");
  });

  it("reports probabilityOfRuin when a threshold is supplied", async () => {
    const { data, summary } = await runTool({ ...BASE_INPUT, ruinThresholdPct: 0.02 });

    expect(data.parameters.ruinThresholdPct).toBe(0.02);
    expect(data.statistics.probabilityOfRuin).toBeGreaterThan(0);
    expect(data.statistics.probabilityOfRuin).toBeLessThanOrEqual(1);
    expect(summary).toContain("P(Ruin)");
  });

  it("reports fewer ruined paths as the threshold deepens", async () => {
    const shallow = await runTool({ ...BASE_INPUT, ruinThresholdPct: 0.02 });
    const deep = await runTool({ ...BASE_INPUT, ruinThresholdPct: 0.2 });

    expect(deep.data.statistics.probabilityOfRuin!).toBeLessThanOrEqual(
      shallow.data.statistics.probabilityOfRuin!,
    );
  });
});

describe("run_monte_carlo worst-case injection surface", () => {
  it("defaults the injection mode to probabilistic", () => {
    const parsed = schema.parse({ blockId: BLOCK_ID }) as Record<string, unknown>;
    expect(parsed.worstCaseMode).toBe("probabilistic");
  });

  it("accepts 'pool' as a legacy alias and 'guarantee' unchanged", () => {
    expect(schema.parse({ blockId: BLOCK_ID, worstCaseMode: "pool" })).toMatchObject({
      worstCaseMode: "pool",
    });
    expect(schema.parse({ blockId: BLOCK_ID, worstCaseMode: "guarantee" })).toMatchObject({
      worstCaseMode: "guarantee",
    });
  });

  it("'pool' produces the same results as 'probabilistic'", async () => {
    const input = {
      numSimulations: 200,
      randomSeed: 42,
      includeWorstCase: true,
      worstCasePercentage: 5,
      worstCaseSizing: "absolute",
    };
    const probabilistic = await runTool({ ...input, worstCaseMode: "probabilistic" });
    const pool = await runTool({ ...input, worstCaseMode: "pool" });
    expect(pool.data.statistics).toEqual(probabilistic.data.statistics);
  });

  it("rejects absolute sizing under the percentage method with the shared message", async () => {
    const parsed = schema.parse({
      blockId: BLOCK_ID,
      resampleMethod: "percentage",
      worstCaseSizing: "absolute",
      randomSeed: 42,
    });
    const result = await handler(parsed);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Historical-dollar loss sizing is not available with percentage returns",
    );
    expect(result.content[0]?.text).toContain("'trades' or 'daily'");
  });

  it("flags zeroBalancePaths as structurally 0 in percentage-mode summaries", async () => {
    // The field stays in the output (consumers may key on it), but an agent
    // reading the summary must not mistake it for a live risk signal:
    // percentage-mode returns clamp at -100% of current equity, so capital
    // can never cross zero and the field always reads 0.
    const { data, summary } = await runTool({ ...BASE_INPUT, resampleMethod: "percentage" });

    expect(data.statistics.zeroBalancePaths).toBe(0);
    expect(summary).toMatch(/structurally 0/);
    expect(summary).toMatch(/probabilityOfRuin/);
  });

  it("adds no zero-balance note for dollar sampling methods", async () => {
    const trades = await runTool(BASE_INPUT);
    expect(trades.summary).not.toMatch(/structurally 0/);

    const daily = await runTool({ ...BASE_INPUT, resampleMethod: "daily" });
    expect(daily.summary).not.toMatch(/structurally 0/);
  });

  it("allows relative sizing under the percentage method", async () => {
    const { data } = await runTool({
      numSimulations: 200,
      randomSeed: 42,
      resampleMethod: "percentage",
      includeWorstCase: true,
      worstCasePercentage: 5,
      worstCaseSizing: "relative",
    });
    expect(data.parameters.resampleMethod).toBe("percentage");
  });
});
