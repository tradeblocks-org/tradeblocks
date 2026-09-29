import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, afterAll } from "@jest/globals";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeConnection, loadBlock } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerFieldTools } from "../../src/tools/reports/fields.ts";
import { enrichTrades } from "../../src/tools/reports/helpers.ts";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ text?: string }>;
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;
type CallTool = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

// Real Option Omega export with a P/L % column. Every row's OO P/L % equals the recomputation,
// so the first row's cell is overwritten with a value the recomputation cannot produce; rows 2
// and 3 get a blank and a non-numeric cell, and rows 4 and 5 keep OO's own cells.
const ORB = path.resolve(
  import.meta.dirname,
  "../../../../tests/data/ORB Test Data/orb-tradelog.csv",
);
const COMPUTED = [
  (332.88 / 340) * 100,
  (165.76 / 680) * 100,
  (-2388.48 / 1000) * 100,
  (-641.76 / 2940) * 100,
  (9665.04 / 9900) * 100,
];
const DATES = ["2022-07-08", "2023-05-05", "2024-05-02", "2025-05-02", "2026-05-06"];

async function fixture(run: (root: string, call: CallTool) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-pl-pct-import-"));
  await fs.mkdir(path.join(root, "blocks"));
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as McpServer;
  registerImportTools(server, root);
  registerFieldTools(server, root);
  try {
    await run(root, (tool, args) => handlers.get(tool)!(args));
  } finally {
    await closeConnection();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Imports `lines` as a block and returns each trade's plPct from get_field_statistics. */
async function importedPlPct(root: string, call: CallTool, lines: string[][]): Promise<number[]> {
  const csvPath = path.join(root, "orb.csv");
  await fs.writeFile(csvPath, `${lines.map((cells) => cells.join(",")).join("\n")}\n`);
  const imported = await call("import_csv", { csvPath, blockName: "orb" });
  expect(imported.isError).not.toBe(true);
  expect(imported.structuredContent).toMatchObject({ recordCount: DATES.length });

  const values: number[] = [];
  for (const date of DATES) {
    const result = await call("get_field_statistics", {
      blockId: "orb",
      field: "plPct",
      startDate: date,
      endDate: date,
      histogramBuckets: 3,
    });
    expect(result.isError).not.toBe(true);
    const statistics = result.structuredContent?.statistics as { count: number; min: number };
    expect(statistics.count).toBe(1);
    values.push(statistics.min);
  }
  return values;
}

async function orbLines(): Promise<string[][]> {
  const content = await fs.readFile(ORB, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

afterAll(async () => {
  await closeConnection();
});

describe("import_csv trade-log P/L %", () => {
  it("prefers a numeric P/L % and falls back for blank or non-numeric cells", async () => {
    await fixture(async (root, call) => {
      const lines = await orbLines();
      const column = lines[0].indexOf("P/L %");
      lines[1][column] = "12.5";
      lines[2][column] = "";
      lines[3][column] = "abc";

      const reported = await importedPlPct(root, call, lines);
      expect(reported[0]).toBe(12.5);
      expect(reported[1]).toBeCloseTo(COMPUTED[1], 10);
      expect(reported[2]).toBeCloseTo(COMPUTED[2], 10);
      expect(reported.slice(3)).toEqual([-21.82857142857143, 97.62666666666668]);

      const { trades } = await loadBlock(root, "orb");
      expect(trades.map((trade) => trade.plPct)).toEqual([
        12.5,
        undefined,
        undefined,
        -21.82857142857143,
        97.62666666666668,
      ]);
      // Existing `custom.P/L %` report queries keep reading the raw column.
      expect(trades.map((trade) => trade.customFields?.["P/L %"])).toEqual([
        12.5,
        undefined,
        "abc",
        -21.82857142857143,
        97.62666666666668,
      ]);
      const enriched = enrichTrades(trades);
      expect(enriched[0].plPct).toBe(12.5);
      expect(enriched[0].netPlPct).toBeCloseTo(COMPUTED[0], 10);
    });
  });

  it("computes P/L % when the trade log has no P/L % column", async () => {
    await fixture(async (root, call) => {
      const lines = await orbLines();
      const column = lines[0].indexOf("P/L %");
      const withoutColumn = lines.map((cells) => cells.filter((_, index) => index !== column));

      const computed = await importedPlPct(root, call, withoutColumn);
      computed.forEach((value, index) => expect(value).toBeCloseTo(COMPUTED[index], 10));

      const { trades } = await loadBlock(root, "orb");
      expect(trades.every((trade) => trade.plPct === undefined)).toBe(true);
    });
  });
});
