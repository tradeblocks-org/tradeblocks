import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDatasetTools } from "../../src/tools/datasets.ts";
import { closeConnection } from "../../src/db/connection.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";
import { getConnection, upgradeToReadWrite } from "../../src/db/connection.ts";
import { upsertProfile } from "../../src/db/profile-schemas.ts";
import { handleValidateEntryFilters } from "../../src/tools/profile-analysis.ts";
import { mkdir, writeFile } from "node:fs/promises";

let baseDir: string;
const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutput>> = {};
beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "tb-datasets-"));
  await getConnection(baseDir);
  registerDatasetTools(
    {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: Record<string, unknown>) => Promise<ToolOutput>,
      ) {
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
function data(output: ToolOutput) {
  return output.structuredContent as {
    fields: { field: string; type: string; timing: string }[];
    datasets: unknown[];
  };
}

test("import, replace, discover and delete a daily dataset through tool handlers", async () => {
  const imported = await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score,state\n2025-01-02,0.0001,calm\n2025-01-03,0.0002,hot",
  });
  expect(imported.isError).not.toBe(true);
  expect(data(imported).fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: "signal.score", type: "numeric", timing: "close" }),
      expect.objectContaining({ field: "signal.state", type: "categorical" }),
    ]),
  );
  expect(data(await handlers.list_analysis_fields({})).fields).toEqual(
    expect.arrayContaining([expect.objectContaining({ field: "signal.score" })]),
  );
  await handlers.import_daily_dataset({
    name: "signal",
    content: "date,replacement\n2025-01-04,7",
  });
  const fields = data(await handlers.list_analysis_fields({})).fields.map((entry) => entry.field);
  expect(fields).toContain("signal.replacement");
  expect(fields).not.toContain("signal.score");
  await handlers.delete_daily_dataset({ name: "signal" });
  expect(data(await handlers.list_daily_datasets({})).datasets).toEqual([]);
});

test("date-only open timing without knownBy is refused by the shared parser", async () => {
  const output = await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score\n2025-01-02,1",
    columnTiming: { score: "open" },
  });
  expect(output.isError).toBe(true);
  expect(output.content[0].text).toContain("known-by");
  expect(data(await handlers.list_daily_datasets({})).datasets).toEqual([]);
});

test("profile filters use close carry-forward and open known-by rather than same-day close", async () => {
  const imported = await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score,open\n2025-01-02,1,10\n2025-01-03,9,20",
    columnTiming: { score: "close", open: "open" },
    knownBy: "09:30",
  });
  expect(imported.isError ? imported.content : null).toBeNull();
  await mkdir(path.join(baseDir, "sample"));
  await writeFile(
    path.join(baseDir, "sample", "tradelog.csv"),
    [
      "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees",
      "2025-01-03,10:00:00,1,SPX Put Spread,1,0,2025-01-03,15:00:00,0,Profit Target,100,1,10000,500,Test,0,0",
      "2025-01-06,10:00:00,1,SPX Put Spread,1,0,2025-01-06,15:00:00,0,Stop,-50,1,10000,500,Test,0,0",
    ].join("\n"),
  );
  await upgradeToReadWrite(baseDir);
  await upsertProfile(await getConnection(baseDir), {
    blockId: "sample",
    strategyName: "Test",
    structureType: "iron_condor",
    greeksBias: "theta_positive",
    thesis: "",
    legs: [],
    entryFilters: [{ field: "signal.score", operator: "<", value: 5, source: "market" }],
    exitRules: [],
    expectedRegimes: [],
    keyMetrics: {},
  });
  const output = await handleValidateEntryFilters(
    { blockId: "sample", strategyName: "Test", minTrades: 1, maxAblationFilters: 8 },
    baseDir,
  );
  expect(output.structuredContent?.unresolvable_filters).toEqual([]);
  expect(output.structuredContent?.per_filter).toEqual(
    expect.objectContaining({
      "signal.score < 5": expect.objectContaining({
        entered: expect.objectContaining({ tradeCount: 1 }),
        filtered_out: expect.objectContaining({ tradeCount: 1 }),
      }),
    }),
  );
});
