import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
let client: Client;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-marked-mc-"));
  client = new Client({ name: "marked-monte-carlo-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", path.join(packageDir, "src/index.ts"), root],
      env: getDefaultEnvironment(),
      stderr: "ignore",
    }),
  );
}, 30000);

afterAll(async () => {
  await client?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function importBlock(name: string, rows?: number[][]) {
  const csvPath = path.join(root, `${name}-trades.csv`);
  await fs.writeFile(
    csvPath,
    "Date Opened,Date Closed,P/L,Strategy,Legs\n2024-01-02,2024-01-02,100,Alpha,SPY\n",
  );
  const dailyLogPath = path.join(root, `${name}-daily.csv`);
  if (rows)
    await fs.writeFile(
      dailyLogPath,
      "Date,Net Liquidity,P/L,Drawdown %\n" +
        rows
          .map(([nlv, pl], i) => `2024-01-${String(i + 2).padStart(2, "0")},${nlv},${pl},0`)
          .join("\n") +
        "\n",
    );
  const result = await client.callTool({
    name: "import_csv",
    arguments: {
      csvPath,
      blockName: name,
      ...(rows ? { dailyLogPath } : {}),
    },
  });
  expect(result.isError).not.toBe(true);
}

async function monteCarlo(blockId: string, input: Record<string, unknown> = {}) {
  return client.callTool({
    name: "run_monte_carlo",
    arguments: {
      blockId,
      resampleMethod: "marked-daily",
      numSimulations: 100,
      randomSeed: 42,
      ...input,
    },
  });
}

it("uses imported no-flow marked returns, not the one trade, and declares its quantiles", async () => {
  // Each no-flow observation has NLV_t / NLV_(t-1) - 1 = -0.5;
  // the first row's P/L also declares its pre-observation starting balance.
  await importBlock("no-flow", [
    [500, -500],
    [250, -250],
    [125, -125],
    [62.5, -62.5],
    [31.25, -31.25],
  ]);
  const result = await monteCarlo("no-flow");
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    parameters: {
      resampleMethod: "marked-daily",
      resampleMode: "stationary-block",
      meanBlockLength: 2,
      randomSeed: 42,
      initialCapital: 1000,
      worstCaseEnabled: false,
    },
    markedReturns: {
      source: "imported_daily_log",
      returnDefinition: "dailyPl / (netLiquidity - dailyPl); 0 when denominator <= 0",
      resampling: "stationary-block",
      worstCaseInjection: "disabled (marked-return input)",
      horizon: 5,
      horizonUnit: "daily_log_observations",
      units: "decimal_return",
      maxDrawdownQuantiles: { p50: 0.96875, p95: 0.96875, p99: 0.96875 },
      horizonReturnQuantiles: { p5: -0.96875, p50: -0.96875, p95: -0.96875, p99: -0.96875 },
    },
    actualResamplePoolSize: 5,
  });
  expect((await monteCarlo("no-flow")).structuredContent).toEqual(result.structuredContent);
});

it("retains the statistics formula on deposit and withdrawal days, rather than adjacent-NLV returns", async () => {
  // Each reported P/L is 10% of (NLV - P/L); account balances
  // also change by external flows, so adjacent-NLV ratios differ.
  await importBlock("flows", [
    [1100, 100],
    [550, 50],
    [2200, 200],
    [2750, 250],
    [3300, 300],
  ]);
  const result = await monteCarlo("flows");
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as {
    markedReturns: {
      maxDrawdownQuantiles: Record<string, number>;
      horizonReturnQuantiles: Record<string, number>;
    };
  };
  expect(data.markedReturns.maxDrawdownQuantiles).toEqual({ p50: 0, p95: 0, p99: 0 });
  for (const value of Object.values(data.markedReturns.horizonReturnQuantiles)) {
    expect(value).toBeCloseTo(0.61051, 12);
  }
});

it("refuses missing or insufficient daily logs without falling back to trades", async () => {
  await importBlock("missing");
  await importBlock("short", [
    [1000, 0],
    [1000, 0],
    [1000, 0],
    [1000, 0],
  ]);
  // A row without a usable P/L imports with dailyPl 0; sampling it would fabricate a zero return.
  await importBlock("no-pl", [
    [1000, 0],
    [1010, 10],
    [1010, Number.NaN],
    [1020, 10],
    [1030, 10],
  ]);
  for (const [blockId, message] of [
    ["missing", "requires an imported daily log"],
    ["short", "Found 4 samples, need at least 5"],
    ["no-pl", "1 row(s) lack it, first 2024-01-04"],
  ]) {
    const result = await monteCarlo(blockId);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(message) })]),
    );
  }
});

it.each([
  [{ strategy: "Alpha" }, "whole portfolio"],
  [{ includeWorstCase: true }, "refuses worst-case injection"],
  [{ resampleMode: "iid" }, "requires stationary-block"],
  [{ normalizeTo1Lot: true }, "cannot normalize"],
])("refuses incompatible marked inputs %j", async (input, message) => {
  const name = Object.keys(input)[0].toLowerCase();
  await importBlock(
    name,
    Array.from({ length: 5 }, () => [1000, 0]),
  );
  const result = await monteCarlo(name, input);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(message) })]),
  );
});

it("declares a generated seed that replays the same marked run and honors the recent pool and horizon", async () => {
  await importBlock("seed", [
    [1000, 0],
    [1050, 50],
    [1100, 50],
    [950, -150],
    [900, -50],
    [850, -50],
  ]);
  const result = await monteCarlo("seed", {
    randomSeed: undefined,
    resampleWindow: 5,
    simulationLength: 10,
    meanBlockLength: 3,
  });
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as {
    parameters: { randomSeed: number };
    markedReturns: {
      maxDrawdownQuantiles: { p50: number; p95: number; p99: number };
      horizonReturnQuantiles: { p5: number; p50: number; p95: number; p99: number };
    };
  };
  expect(data.parameters.randomSeed).toEqual(expect.any(Number));
  expect(result.structuredContent).toMatchObject({
    parameters: { meanBlockLength: 3, simulationLength: 10 },
    markedReturns: { horizon: 10 },
    actualResamplePoolSize: 5,
  });
  const repeated = await monteCarlo("seed", {
    randomSeed: data.parameters.randomSeed,
    resampleWindow: 5,
    simulationLength: 10,
    meanBlockLength: 3,
  });
  expect(repeated.structuredContent).toEqual(result.structuredContent);
  const dd = data.markedReturns.maxDrawdownQuantiles;
  const ret = data.markedReturns.horizonReturnQuantiles;
  expect(dd.p99).toBeGreaterThanOrEqual(dd.p95);
  expect(dd.p95).toBeGreaterThan(dd.p50);
  expect(ret.p99).toBeGreaterThanOrEqual(ret.p95);
  expect(ret.p95).toBeGreaterThan(ret.p50);
  expect(ret.p50).toBeGreaterThan(ret.p5);
});
