/**
 * paired_bootstrap_comparison through MCP stdio: the same two strategies give
 * the same result whether or not an unrelated strategy shares their block.
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

const client = new Client({ name: "paired-grid-tool-test", version: "1.0.0" });
let root: string;

const HEADER =
  "Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,Margin Req.,No. of Contracts,Funds at Close";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function row(open: string, close: string, pl: number, strategy: string): string {
  return `${open},09:30:00,${close},15:00:00,${pl},${strategy},SPY,1000,1,100000`;
}

// A and B hold Monday to Wednesday once a week; the unrelated strategy trades
// every weekday, so its Tuesdays, Thursdays and Fridays would split the arms'
// runs if the grid came from the whole block.
const WEEKS = 40;
const armRows: string[] = [];
const thirdRows: string[] = [];
for (let w = 0; w < WEEKS; w++) {
  const monday = new Date(Date.UTC(2023, 0, 2 + 7 * w));
  const wednesday = new Date(monday.getTime() + 2 * 86_400_000);
  const plA = 40 + ((w * 37) % 11) * 30 - 150;
  const plB = 10 + ((w * 53) % 13) * 25 - 150;
  armRows.push(row(iso(monday), iso(wednesday), plA, "A"));
  armRows.push(row(iso(monday), iso(wednesday), plB, "B"));
  for (let d = 0; d < 5; d++) {
    const day = iso(new Date(monday.getTime() + d * 86_400_000));
    thirdRows.push(row(day, day, 5, "unrelated daily"));
  }
}

function text(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("\n");
}

async function importBlock(name: string, rows: string[]): Promise<void> {
  const csvPath = path.join(root, `${name}.csv`);
  await fs.writeFile(csvPath, [HEADER, ...rows].join("\n"));
  const imported = await client.callTool({
    name: "import_csv",
    arguments: { csvPath, blockName: name },
  });
  expect(imported.isError).not.toBe(true);
}

async function compare(blockId: string): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "paired_bootstrap_comparison",
    arguments: { blockId, strategyA: "A", strategyB: "B", resamples: 500 },
  });
  expect(text(result)).not.toContain("Error");
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe("paired_bootstrap_comparison day grid through the tool (stdio)", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-paired-grid-"));
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
    await importBlock("Three", [...armRows, ...thirdRows]);
    await importBlock("Two", armRows);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("gives identical point, ci and blockDays with and without an unrelated strategy", async () => {
    const three = await compare("three");
    const two = await compare("two");
    expect(three.point).toBe(two.point);
    expect(three.ci).toEqual(two.ci);
    expect(three.blockDays).toBe(two.blockDays);
    expect(three.tradeCounts).toEqual({ armA: WEEKS, armB: WEEKS });
  });
});
