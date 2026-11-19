/**
 * paired_bootstrap_comparison through MCP stdio: strategy presence messages and
 * coverage refusals as a client sees them.
 *
 * Synthetic fixtures only; no real trading data.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "paired-coverage-test", version: "1.0.0" });
let root: string;

// A trades in 2023 only, B in 2023 and 2024.
const rows: string[] = [];
for (let m = 1; m <= 12; m++) {
  const mm = String(m).padStart(2, "0");
  for (const [d, pl] of [
    ["03", 120],
    ["10", -40],
    ["17", 60],
    ["24", -20],
  ] as const) {
    rows.push(`2023-${mm}-${d},09:30:00,2023-${mm}-${d},15:00:00,${pl},A,SPY,1000,1,100000`);
    rows.push(
      `2023-${mm}-${d},09:30:00,2023-${mm}-${d},15:00:00,${pl / 2 + 5},B,SPY,1000,1,100000`,
    );
    rows.push(
      `2024-${mm}-${d},09:30:00,2024-${mm}-${d},15:00:00,${pl / 2 - 5},B,SPY,1000,1,100000`,
    );
  }
}
const csv = [
  "Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,Margin Req.,No. of Contracts,Funds at Close",
  ...rows,
].join("\n");

// Straddle block: A holds one trade from Thursday 2023-02-23 through Monday
// 2023-03-06; B trades flat one-day trades through 2023-02-24.
const straddleRows: string[] = [];
for (let d = new Date(Date.UTC(2023, 0, 2)); d <= new Date(Date.UTC(2023, 1, 24));) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
    const iso = d.toISOString().slice(0, 10);
    straddleRows.push(`${iso},09:30:00,${iso},15:00:00,10,A,SPY,1000,1,100000`);
    straddleRows.push(`${iso},09:30:00,${iso},15:00:00,0,B,SPY,1000,1,100000`);
  }
  d = new Date(d.getTime() + 86_400_000);
}
straddleRows.push("2023-02-23,09:30:00,2023-03-06,15:00:00,700,A,SPY,1000,1,100000");

const YEAR_2024 = { start: "2024-01-01", end: "2024-12-31" };
const COV_2024 = { from: "2024-01-01", through: "2024-12-31" };

function text(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("\n");
}

const call = (args: Record<string, unknown>) =>
  client.callTool({
    name: "paired_bootstrap_comparison",
    arguments: { blockId: "cov", resamples: 300, ...args },
  });

describe("paired_bootstrap_comparison strategy presence and coverage (stdio)", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-paired-coverage-"));
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
      arguments: { csvPath, blockName: "Cov" },
    });
    expect(imported.isError).not.toBe(true);
    const straddlePath = path.join(root, "straddle.csv");
    await fs.writeFile(straddlePath, [csv.split("\n")[0], ...straddleRows].join("\n"));
    const importedStraddle = await client.callTool({
      name: "import_csv",
      arguments: { csvPath: straddlePath, blockName: "Straddle" },
    });
    expect(importedStraddle.isError).not.toBe(true);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("names an unknown strategy differently from a known one without trades in range", async () => {
    const unknown = await call({ strategyA: "Ghost", strategyB: "B" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Strategy "Ghost" is not in this block.');

    const unknownB = await call({ strategyA: "A", strategyB: "Ghost" });
    expect(unknownB.isError).toBe(true);
    expect(text(unknownB)).toContain('Strategy "Ghost" is not in this block.');

    const knownEmpty = await call({ strategyA: "A", strategyB: "B", dateRange: YEAR_2024 });
    expect(knownEmpty.isError).toBe(true);
    expect(text(knownEmpty)).toContain('Strategy "A" has no trades in the selected date range.');
  });

  it("compares a known strategy without trades in range as an all-flat arm when coverage is given", async () => {
    const result = await call({
      strategyA: "A",
      strategyB: "B",
      dateRange: YEAR_2024,
      unobservedDays: "zero",
      coverage: { A: COV_2024, B: COV_2024 },
    });
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.coverage).toEqual({ A: COV_2024, B: COV_2024 });
    expect(data.coverageSource).toBe("caller");
    expect((data.tradeCounts as { armA: number }).armA).toBe(0);
    // A is flat: the point is minus B's mean daily P&L over B's 48 trade days
    // (2024 P&L per month: 55, -25, 25, -15).
    const bMean = (55 - 25 + 25 - 15) / 4;
    expect(data.point as number).toBeCloseTo(-bMean, 9);
  });

  it("refuses when both arms have no trades in range, even with coverage", async () => {
    const result = await call({
      strategyA: "A",
      strategyB: "B",
      dateRange: { start: "2025-01-01", end: "2025-12-31" },
      unobservedDays: "zero",
      coverage: {
        A: { from: "2025-01-01", through: "2025-12-31" },
        B: { from: "2025-01-01", through: "2025-12-31" },
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Neither strategy has trades in the selected date range");
  });

  it("refuses coverage without unobservedDays zero, naming the reason", async () => {
    const result = await call({
      strategyA: "A",
      strategyB: "B",
      coverage: {
        A: { from: "2023-01-01", through: "2023-12-31" },
        B: { from: "2023-01-01", through: "2024-12-31" },
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('coverage requires unobservedDays "zero"');
  });

  it("refuses coverage for one arm only and an impossible date", async () => {
    const oneArm = await call({
      strategyA: "A",
      strategyB: "B",
      unobservedDays: "zero",
      coverage: { A: { from: "2023-01-01", through: "2023-12-31" } },
    });
    expect(oneArm.isError).toBe(true);
    expect(text(oneArm)).toContain("coverage must give both A and B");

    const badDate = await call({
      strategyA: "A",
      strategyB: "B",
      unobservedDays: "zero",
      coverage: {
        A: { from: "2023-01-01", through: "2023-13-01" },
        B: { from: "2023-01-01", through: "2024-12-31" },
      },
    });
    expect(badDate.isError).toBe(true);
    expect(text(badDate)).toContain('coverage.A.through "2023-13-01" is not a valid date');
  });

  it("refuses a trade outside the stated coverage", async () => {
    const result = await call({
      strategyA: "A",
      strategyB: "B",
      unobservedDays: "zero",
      coverage: {
        A: { from: "2023-01-01", through: "2023-12-31" },
        B: { from: "2023-01-01", through: "2023-12-31" },
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /Strategy "B" has a trade opened 2024-01-03.*outside its coverage 2023-01-01 to 2023-12-31/,
    );
  });

  it("refuses a kept trade that closes after dateRange end instead of dropping its P&L", async () => {
    const window = { from: "2023-01-02", through: "2023-03-31" };
    const result = await call({
      blockId: "straddle",
      strategyA: "A",
      strategyB: "B",
      grid: "xnys",
      unobservedDays: "zero",
      coverage: { A: window, B: window },
      dateRange: { start: "2023-01-02", end: "2023-02-27" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /Strategy "A" has a trade opened 2023-02-23, closed 2023-03-06, after dateRange end 2023-02-27.*widen dateRange or omit it/,
    );
  });
});
