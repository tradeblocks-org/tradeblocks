import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDatasetTools } from "../../src/tools/datasets.ts";
import { closeConnection } from "../../src/db/connection.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";
import {
  getConnection,
  getCurrentConnection,
  upgradeToReadWrite,
} from "../../src/db/connection.ts";
import { upsertProfile } from "../../src/db/profile-schemas.ts";
import {
  handleValidateEntryFilters,
  handleAnalyzeStructureFit,
} from "../../src/tools/profile-analysis.ts";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { registerPredictiveTools } from "../../src/tools/reports/predictive.ts";
import { registerMarketDataTools } from "../../src/tools/market-data.ts";
import { createMarketStores } from "../../src/market/stores/index.ts";
import { TickerRegistry } from "../../src/market/tickers/registry.ts";
import { writeEnrichedTickerPartition } from "../../src/db/market-datasets.ts";

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
  const conn = await upgradeToReadWrite(baseDir);
  await conn.run(
    "INSERT INTO market.enriched (ticker, date, RSI_14) VALUES ('SPX', '2025-01-02', 50)",
  );
  await writeEnrichedTickerPartition(conn, {
    dataDir: baseDir,
    ticker: "SPX",
    date: "2025-01-02",
    selectQuery: "SELECT * FROM market.enriched",
  });
  await closeConnection();
  const partition = path.join(
    baseDir,
    "market",
    "enriched",
    "ticker=SPX",
    "date=2025-01-02",
    "data.parquet",
  );
  const marketBytes = await readFile(partition);
  const imported = await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score,state\n2025-01-02,0.0001,calm\n2025-01-03,0.0002,hot",
  });
  expect(imported.isError).not.toBe(true);
  await closeConnection();
  expect(await readFile(partition)).toEqual(marketBytes);
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
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (input: Record<string, unknown>) => Promise<ToolOutput>,
    ) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerPredictiveTools(server, baseDir);
  registerMarketDataTools(
    server,
    baseDir,
    createMarketStores({
      get conn() {
        return getCurrentConnection();
      },
      dataDir: baseDir,
      parquetMode: false,
      tickers: new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]),
    }),
  );
  const enrichment = await handlers.enrich_trades({
    blockId: "sample",
    limit: 50,
    offset: 0,
    includeOutcomeFields: false,
    includeIntradayContext: false,
  });
  expect(enrichment.isError ? enrichment.content : null).toBeNull();
  expect(enrichment.structuredContent?.trades).toEqual([
    expect.objectContaining({
      datasetFields: { "signal.score": 1, "signal.open": 20 },
      datasetProvenance: expect.objectContaining({
        "signal.score": {
          sourceTimestamp: "2025-01-02T05:00:00.000Z",
          availableAt: "2025-01-03T05:00:00.000Z",
        },
      }),
    }),
    expect.objectContaining({ datasetFields: { "signal.score": 9, "signal.open": 20 } }),
  ]);
  const curve = await handlers.filter_curve({
    blockId: "sample",
    field: "signal.score",
    mode: "both",
    thresholds: [5],
    percentileSteps: [50],
  });
  expect(curve.structuredContent?.thresholds).toEqual([
    expect.objectContaining({
      threshold: 5,
      lt: expect.objectContaining({ count: 1, totalPl: 100 }),
      gt: expect.objectContaining({ count: 1, totalPl: -50 }),
    }),
  ]);
  await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score,state\n2025-01-02,0.0001,calm\n2025-01-03,0.0009,hot",
  });
  const smallCurve = await handlers.filter_curve({
    blockId: "sample",
    field: "signal.score",
    mode: "both",
    percentileSteps: [25, 50, 75],
  });
  const smallThresholds = (smallCurve.structuredContent?.thresholds as { threshold: number }[]).map(
    ({ threshold }) => threshold,
  );
  expect(smallThresholds).toHaveLength(3);
  [0.0003, 0.0005, 0.0007].forEach((expected, i) =>
    expect(smallThresholds[i]).toBeCloseTo(expected, 12),
  );
  const smallFit = await handleAnalyzeStructureFit(
    { blockId: "sample", strategyName: "Test", minTrades: 1 },
    baseDir,
  );
  expect(smallFit.structuredContent?.dimensions).toEqual(
    expect.objectContaining({
      "signal.score": {
        "0.0001": expect.objectContaining({ tradeCount: 1, totalPl: 100 }),
        "0.0009": expect.objectContaining({ tradeCount: 1, totalPl: -50 }),
      },
    }),
  );
  const suggestions = await handlers.suggest_filters({
    blockId: "sample",
    fields: ["signal.score", "signal.state"],
    minImprovementPct: 1,
  });
  expect(suggestions.structuredContent?.suggestedFilters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        condition: expect.objectContaining({ field: "signal.score", operator: ">" }),
        newWinRate: 100,
      }),
      expect.objectContaining({
        condition: expect.objectContaining({ field: "signal.state", operator: "==", value: "hot" }),
        newWinRate: 100,
      }),
    ]),
  );
  const numeric = await handlers.analyze_regime_performance({
    blockId: "sample",
    field: "signal.score",
    bins: [0.0005],
  });
  expect(numeric.structuredContent?.segments).toEqual([
    expect.objectContaining({ segmentValue: 0, tradeCount: 1, totalPl: 100 }),
    expect.objectContaining({ segmentValue: 1, tradeCount: 1, totalPl: -50 }),
  ]);
  const categorical = await handlers.analyze_regime_performance({
    blockId: "sample",
    field: "signal.state",
  });
  expect(categorical.structuredContent?.segments).toEqual([
    expect.objectContaining({ segment: "calm", tradeCount: 1, totalPl: 100 }),
    expect.objectContaining({ segment: "hot", tradeCount: 1, totalPl: -50 }),
  ]);
  const quantiles = await handlers.analyze_regime_performance({
    blockId: "sample",
    field: "signal.score",
  });
  expect(quantiles.structuredContent?.tradesMatched).toBe(2);
  expect(quantiles.structuredContent?.segments).toHaveLength(2);
  const unknown = await handlers.analyze_regime_performance({
    blockId: "sample",
    field: "missing.value",
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("missing.value") }),
    ]),
  );
  await upgradeToReadWrite(baseDir);
  await upsertProfile(await getConnection(baseDir), {
    blockId: "sample",
    strategyName: "Test",
    structureType: "iron_condor",
    greeksBias: "theta_positive",
    thesis: "",
    legs: [],
    entryFilters: [{ field: "signal.state", operator: "==", value: "calm", source: "market" }],
    exitRules: [],
    expectedRegimes: [],
    keyMetrics: {},
  });
  const categoryFilter = await handleValidateEntryFilters(
    { blockId: "sample", strategyName: "Test", minTrades: 1, maxAblationFilters: 8 },
    baseDir,
  );
  expect(categoryFilter.structuredContent?.per_filter).toEqual(
    expect.objectContaining({
      'signal.state == "calm"': expect.objectContaining({
        entered: expect.objectContaining({ tradeCount: 1, totalPl: 100 }),
      }),
    }),
  );
  const fit = await handleAnalyzeStructureFit(
    { blockId: "sample", strategyName: "Test", minTrades: 1 },
    baseDir,
  );
  expect(fit.structuredContent?.dimensions).toEqual(
    expect.objectContaining({
      "signal.state": expect.objectContaining({
        calm: expect.objectContaining({ tradeCount: 1, totalPl: 100 }),
        hot: expect.objectContaining({ tradeCount: 1, totalPl: -50 }),
      }),
    }),
  );
  const csv = (await readFile(path.join(baseDir, "sample", "tradelog.csv"), "utf8")).split("\n");
  await writeFile(
    path.join(baseDir, "sample", "tradelog.csv"),
    [csv[0], ...Array.from({ length: 5 }, () => csv.slice(1)).flat()].join("\n"),
  );
  const conn = await getConnection(baseDir);
  await conn.run(
    "INSERT INTO market.enriched (ticker, date, Day_of_Week, Gap_Pct, Is_Opex) VALUES ('SPX', '2025-01-03', 6, 0, 0), ('SPX', '2025-01-06', 2, 0, 0)",
  );
  const defaults = await handlers.suggest_filters({ blockId: "sample", minImprovementPct: 3 });
  expect(defaults.structuredContent?.suggestedFilters).toEqual([
    expect.objectContaining({
      filter: "Skip Mondays",
      tradesRemoved: 5,
      newWinRate: 100,
      newTotalPl: 500,
    }),
  ]);
  const preset = await handlers.analyze_regime_performance({
    blockId: "sample",
    segmentBy: "dayOfWeek",
  });
  expect(preset.structuredContent?.segments).toEqual([
    expect.objectContaining({ segment: "Monday", tradeCount: 5, totalPl: -250 }),
    expect.objectContaining({ segment: "Friday", tradeCount: 5, totalPl: 500 }),
  ]);
  const predictive = await handlers.find_predictive_fields({
    blockId: "sample",
    targetField: "pl",
    minSamples: 10,
    includeCustomFields: true,
  });
  expect(predictive.structuredContent?.rankedFields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: "signal.score", sampleSize: 10, direction: "negative" }),
    ]),
  );
});
