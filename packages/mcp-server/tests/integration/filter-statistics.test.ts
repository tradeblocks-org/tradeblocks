import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPredictiveTools } from "../../src/tools/reports/predictive.ts";
import { getConnection, closeConnection } from "../../src/db/connection.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";

let baseDir: string;
const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutput>> = {};
beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "tb-filter-stats-"));
  await getConnection(baseDir);
  registerPredictiveTools(
    {
      registerTool(name: string, _config: unknown, handler: (typeof handlers)[string]) {
        handlers[name] = handler;
      },
    } as unknown as McpServer,
    baseDir,
  );
});
afterEach(async () => {
  await closeConnection();
  await rm(baseDir, { recursive: true, force: true });
});

async function fixture(rows: Array<{ date: string; pl: number; signal: number; noise?: number }>) {
  await mkdir(path.join(baseDir, "sample"));
  await writeFile(
    path.join(baseDir, "sample", "tradelog.csv"),
    [
      "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,signal,noise",
      ...rows.map(
        ({ date, pl, signal, noise = 0 }) =>
          `${date},10:00:00,1,SPX Put Spread,1,0,${date},15:00:00,0,Exit,${pl},1,10000,500,Test,0,0,${signal},${noise}`,
      ),
    ].join("\n"),
  );
}

test("predictive methods disagree on nonlinear monotone data and omission preserves Pearson output", async () => {
  await fixture(
    Array.from({ length: 40 }, (_, i) => ({ date: "2025-01-02", pl: (i + 1) ** 4, signal: i + 1 })),
  );
  const input = { blockId: "sample", targetField: "pl", minSamples: 10, includeCustomFields: true };
  const original = await handlers.find_predictive_fields(input);
  expect(original.isError).not.toBe(true);
  for (const method of ["pearson", "spearman", "kendall"]) {
    const output = await handlers.find_predictive_fields({ ...input, method });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent?.method).toBe(method);
    const content = output.structuredContent as {
      rankedFields: Array<{ field: string; correlation: number }>;
    };
    const coefficient = content.rankedFields.find(
      ({ field }) => field === "custom.signal",
    )!.correlation;
    if (method === "pearson") {
      expect(coefficient).toBeLessThan(0.9);
      const { method: _method, ...unchanged } = output.structuredContent!;
      expect(unchanged).toEqual(original.structuredContent);
    } else expect(coefficient).toBe(1);
  }
});
