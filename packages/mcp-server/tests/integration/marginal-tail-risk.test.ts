import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

const armSchema = z.object({
  expectedShortfall: z.number().nullable(),
  reason: z.string().nullable(),
  observations: z.number(),
  dateRange: z.object({ start: z.string(), end: z.string() }).nullable(),
});
const tailSchema = z.object({
  confidence: z.number(),
  attribution: z.string(),
  unit: z.string(),
  baseline: armSchema,
  removedStrategyArms: z.array(
    armSchema.extend({
      strategy: z.string(),
      changeVsBaseline: z.number().nullable(),
    }),
  ),
});
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "marginal-tail-test", version: "1.0.0" });
let root: string;
const csv = [
  "Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,Margin Req.,No. of Contracts,Funds at Close",
  "2024-01-08,09:30:00,2024-01-08,15:00:00,-1000,Alpha,SPY,1000,1,99000",
  "2024-01-09,09:30:00,2024-01-09,15:00:00,-2000,Beta,SPY,1000,1,97000",
  "2024-01-10,09:30:00,2024-01-10,15:00:00,3000,Alpha,SPY,1000,1,100000",
].join("\n");
const call = (args: Record<string, unknown>) =>
  client.callTool({ name: "marginal_contribution", arguments: { blockId: "tail", ...args } });

describe("marginal contribution tail risk through MCP stdio", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-marginal-tail-"));
    const packageDir = path.resolve(import.meta.dirname, "../..");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--experimental-strip-types", path.join(packageDir, "src/index.ts"), root],
        cwd: path.resolve(packageDir, "../.."),
        env: { ...getDefaultEnvironment(), TZ: "America/New_York" },
        stderr: "pipe",
      }),
    );
    const csvPath = path.join(root, "trades.csv");
    await fs.writeFile(csvPath, csv);
    const imported = await client.callTool({
      name: "import_csv",
      arguments: { csvPath, blockName: "Tail" },
    });
    expect(imported.isError).not.toBe(true);
  }, 60_000);
  afterAll(async () => {
    await client.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves the pre-tail default response byte for byte", async () => {
    expect(await call({})).toMatchSnapshot();
    expect(await call({ includeTailRisk: false, tailConfidence: 0 })).toEqual(await call({}));
  });

  it("reports signed ES and a positive removal improvement on the ratio arms", async () => {
    const result = await call({ includeTailRisk: true });
    expect(result.isError).not.toBe(true);
    const tail = tailSchema.parse(result.structuredContent?.tailRisk);
    expect(tail).toMatchObject({
      confidence: 0.95,
      attribution: "incremental (leave-one-out), non-additive",
      unit: "signed decimal return",
    });
    expect(tail.baseline).toMatchObject({
      observations: 3,
      dateRange: { start: "2024-01-08", end: "2024-01-10" },
      reason: null,
    });
    expect(tail.baseline.expectedShortfall).toBeCloseTo(-2000 / 99000, 14);
    const alpha = tail.removedStrategyArms.find((arm) => arm.strategy === "Alpha");
    const beta = tail.removedStrategyArms.find((arm) => arm.strategy === "Beta");
    expect(alpha).toMatchObject({
      expectedShortfall: -0.02,
      observations: 1,
      dateRange: { start: "2024-01-09", end: "2024-01-09" },
    });
    expect(beta).toMatchObject({
      expectedShortfall: -0.01,
      observations: 3,
      dateRange: { start: "2024-01-08", end: "2024-01-10" },
    });
    expect(beta?.changeVsBaseline).toBeCloseTo(2000 / 99000 - 0.01, 14);
  });

  it("uses net ratio-series returns for fee-bearing gross_before_fees arms", async () => {
    const csvPath = path.join(root, "gross.csv");
    const grossCsv = csv
      .split("\n")
      .map((row, index) =>
        index === 0
          ? `${row},Opening Commissions + Fees,Closing Commissions + Fees`
          : `${row},${index === 1 ? 500 : 0},0`,
      )
      .join("\n");
    await fs.writeFile(csvPath, grossCsv);
    expect(
      (
        await client.callTool({
          name: "import_csv",
          arguments: { csvPath, blockName: "Gross", plBasis: "gross_before_fees" },
        })
      ).isError,
    ).not.toBe(true);
    const result = await call({ blockId: "gross", includeTailRisk: true });
    expect(result.isError).not.toBe(true);
    const tail = tailSchema.parse(result.structuredContent?.tailRisk);
    expect(tail.baseline.expectedShortfall).toBeCloseTo(-2000 / 99000, 14);
    expect(tail.baseline.dateRange).toEqual({ start: "2024-01-08", end: "2024-01-10" });
    const alpha = tail.removedStrategyArms.find((arm) => arm.strategy === "Alpha");
    const beta = tail.removedStrategyArms.find((arm) => arm.strategy === "Beta");
    expect(alpha?.expectedShortfall).toBeCloseTo(-2000 / 100500, 14);
    expect(beta?.expectedShortfall).toBeCloseTo(-1500 / 100500, 14);
    expect(beta?.changeVsBaseline).toBeCloseTo(2000 / 99000 - 1500 / 100500, 14);
  });

  it("uses the requested confidence and respects targetStrategy and topN", async () => {
    const result = await call({
      includeTailRisk: true,
      tailConfidence: 0.5,
      targetStrategy: "bEtA",
      topN: 1,
    });
    const tail = tailSchema.parse(result.structuredContent?.tailRisk);
    expect(tail.confidence).toBe(0.5);
    expect(tail.baseline.expectedShortfall).toBeCloseTo((-0.01 - 2000 / 99000) / 2, 14);
    expect(tail.removedStrategyArms).toHaveLength(1);
    expect(tail.removedStrategyArms[0]).toMatchObject({
      strategy: "Beta",
      expectedShortfall: -0.005,
    });
    const limited = await call({ includeTailRisk: true, topN: 1 });
    expect(
      tailSchema
        .parse(limited.structuredContent?.tailRisk)
        .removedStrategyArms.map((arm) => arm.strategy),
    ).toEqual(["Beta"]);
  });

  it.each([0, 1, -0.1, 1.1])(
    "surfaces the estimator's confidence error for %s",
    async (tailConfidence) => {
      const result = await call({ includeTailRisk: true, tailConfidence });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: `Error calculating marginal contribution: Confidence must be finite and strictly between 0 and 1; received ${tailConfidence}`,
        },
      ]);
    },
  );

  it("reports unavailable ES and delta for the empty single-strategy removal arm", async () => {
    const csvPath = path.join(root, "single.csv");
    await fs.writeFile(
      csvPath,
      csv
        .split("\n")
        .filter((row) => !row.includes("Beta"))
        .join("\n"),
    );
    expect(
      (await client.callTool({ name: "import_csv", arguments: { csvPath, blockName: "Single" } }))
        .isError,
    ).not.toBe(true);
    const result = await call({ blockId: "single", includeTailRisk: true });
    const tail = tailSchema.parse(result.structuredContent?.tailRisk);
    expect(tail.baseline.expectedShortfall).toBe(-0.01);
    expect(tail.removedStrategyArms).toEqual([
      {
        strategy: "Alpha",
        expectedShortfall: null,
        changeVsBaseline: null,
        reason: "No return observations available for this arm.",
        observations: 0,
        dateRange: null,
      },
    ]);
  });
});
