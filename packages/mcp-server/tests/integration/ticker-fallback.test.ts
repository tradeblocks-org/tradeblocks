import { afterEach, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeConnection,
  getConnection,
  getCurrentConnection,
  upgradeToReadWrite,
} from "../../src/db/connection.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerMarketDataTools } from "../../src/tools/market-data.ts";
import { createMarketStores } from "../../src/market/stores/index.ts";
import { TickerRegistry } from "../../src/market/tickers/registry.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";
import { loadBlock } from "../../src/utils/block-loader.ts";
import { resolveTradeTicker, tickerFallbackWarnings } from "../../src/utils/ticker.ts";
import { registerSQLTools } from "../../src/tools/sql.ts";
import { registerFieldTools } from "../../src/tools/reports/fields.ts";
import { registerPredictiveTools } from "../../src/tools/reports/predictive.ts";
import { upsertProfile } from "../../src/db/profile-schemas.ts";
import { registerProfileAnalysisTools } from "../../src/tools/profile-analysis.ts";
import { registerRegimeAdvisorTools } from "../../src/tools/regime-advisor.ts";
import { registerHealthBlockTools } from "../../src/tools/blocks/health.ts";

const header =
  "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,P/L Basis,P/L %,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,Underlying";
let root: string;
afterEach(async () => {
  await closeConnection();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture(tickers: string[], strategies?: string[]) {
  root = await mkdtemp(path.join(tmpdir(), "tb-ticker-fallback-"));
  await mkdir(path.join(root, "blocks"));
  await getConnection(root);
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolOutput>> = {};
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<ToolOutput>,
    ) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerImportTools(server, root);
  registerMarketDataTools(
    server,
    root,
    createMarketStores({
      get conn() {
        return getCurrentConnection();
      },
      dataDir: root,
      parquetMode: false,
      tickers: new TickerRegistry([
        { underlying: "SPX", roots: ["SPX"] },
        { underlying: "TSLA", roots: ["TSLA"] },
      ]),
    }),
  );
  registerSQLTools(server, root);
  registerFieldTools(server, root);
  registerPredictiveTools(server, root);
  registerProfileAnalysisTools(server, root);
  registerRegimeAdvisorTools(server, root);
  registerHealthBlockTools(server, root);
  const csvPath = path.join(root, "capture.csv");
  await writeFile(
    csvPath,
    [
      header,
      ...tickers.map(
        (ticker, index) =>
          `2025-01-03,10:00:00,1,Put Spread,100,0,2025-01-03,15:00:00,0,Profit Target,75,net_includes_fees,75,1,10075,500,${strategies?.[index] ?? "Test"},1,2,${ticker}`,
      ),
    ].join("\n"),
  );
  const imported = await handlers.import_csv({ csvPath, blockName: "capture" });
  expect(imported.isError).not.toBe(true);
  expect(imported.structuredContent).toMatchObject({ recordCount: tickers.length });
  const conn = await upgradeToReadWrite(root);
  await conn.run(
    "INSERT INTO market.enriched (ticker, date, RSI_14) VALUES ('SPX', '2025-01-02', 40), ('SPX', '2025-01-03', 60), ('TSLA', '2025-01-02', 20), ('TSLA', '2025-01-03', 30)",
  );
  return handlers;
}

test("successful market joins warn for fallback trades only, counting trades rather than keys", async () => {
  const handlers = await fixture(["", "", "SPX", "TSLA"]);
  const output = await handlers.enrich_trades({
    blockId: "capture",
    limit: 50,
    offset: 0,
    includeOutcomeFields: false,
    includeIntradayContext: false,
  });
  expect(output.isError).not.toBe(true);
  expect(output.structuredContent).toMatchObject({ returned: 4, tradesMatched: 4 });
  const warnings = output.structuredContent?.warnings as string[];
  expect(warnings).toEqual(
    expect.arrayContaining([expect.stringMatching(/assum.*SPX.*2 trades/i)]),
  );
  expect(warnings.some((warning) => /Underlying/.test(warning))).toBe(true);
  expect(warnings.some((warning) => /VIX/.test(warning))).toBe(true);
});

test("producer-shaped Underlying CSV preserves TSLA and economics in loaded trades and synced ticker rows", async () => {
  const handlers = await fixture(["TSLA"]);
  const { trades } = await loadBlock(root, "capture");
  expect(trades).toHaveLength(1);
  expect(resolveTradeTicker(trades[0])).toBe("TSLA");
  expect(trades[0]).toMatchObject({
    pl: 75,
    plBasis: "net_includes_fees",
    strategy: "Test",
    openingCommissionsFees: 1,
    closingCommissionsFees: 2,
  });
  const result = await handlers.run_sql({
    query:
      "SELECT ticker, pl, reported_pl, pl_basis, strategy, opening_commissions, closing_commissions FROM trades.trade_data WHERE block_id = 'capture'",
    limit: 10,
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.rows).toEqual([
    {
      ticker: "TSLA",
      pl: 75,
      reported_pl: 75,
      pl_basis: "net_includes_fees",
      strategy: "Test",
      opening_commissions: 1,
      closing_commissions: 2,
    },
  ]);
});

test.each(["SPX", "TSLA"])(
  "explicit %s trades do not warn about a ticker assumption",
  async (ticker) => {
    const handlers = await fixture([ticker]);
    const result = await handlers.enrich_trades({
      blockId: "capture",
      limit: 50,
      offset: 0,
      includeOutcomeFields: false,
      includeIntradayContext: false,
    });
    expect(result.structuredContent).toMatchObject({ tradesMatched: 1 });
    const warnings = result.structuredContent?.warnings as string[] | undefined;
    expect(warnings?.some((warning) => /assuming.*SPX/i.test(warning)) ?? false).toBe(false);
    const { trades } = await loadBlock(root, "capture");
    expect(tickerFallbackWarnings(trades)).toEqual([]);
  },
);

test.each([
  ["get_field_statistics", { field: "RSI_14", histogramBuckets: 3 }],
  ["analyze_regime_performance", { field: "RSI_14" }],
  ["analyze_regime_performance", { segmentBy: "dayOfWeek" }],
  ["suggest_filters", { fields: ["RSI_14"], objective: "winRate", minImprovementPct: 3 }],
  ["filter_curve", { field: "RSI_14", mode: "exclude" }],
  ["filter_curve", { fields: ["RSI_14"], mode: "exclude" }],
  [
    "find_predictive_fields",
    { targetField: "pl", minSamples: 2, topN: 5, includeCustomFields: false },
  ],
] as const)("%s output carries the market ticker fallback count (%j)", async (tool, args) => {
  const handlers = await fixture(["", "", "SPX", "TSLA"]);
  const result = await handlers[tool]({ blockId: "capture", ...args });
  expect(result.isError ? result.content : null).toBeNull();
  expect(result.structuredContent?.warnings).toEqual(
    expect.arrayContaining([expect.stringMatching(/assum.*SPX.*2 trades/i)]),
  );
});

test("trade-only field statistics do not warn about an unused market assumption", async () => {
  const handlers = await fixture(["", "", "SPX", "TSLA"]);
  const result = await handlers.get_field_statistics({
    blockId: "capture",
    field: "pl",
    histogramBuckets: 3,
  });
  expect(result.structuredContent).not.toHaveProperty("warnings");
});

test.each([4, 12])(
  "default filter suggestions retain fallback warnings with %s trades",
  async (count) => {
    const handlers = await fixture(["", "", ...Array<string>(count - 2).fill("SPX")]);
    const result = await handlers.suggest_filters({ blockId: "capture" });
    expect(result.isError ?? false).toBe(count < 10);
    expect(result.structuredContent?.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/assum.*SPX.*2 trades/i)]),
    );
  },
);

test.each([
  ["analyze_structure_fit", { strategyName: "Test", minTrades: 30 }],
  ["validate_entry_filters", { strategyName: "Test", minTrades: 30, maxAblationFilters: 8 }],
  ["portfolio_structure_map", { minTrades: 30 }],
  ["regime_allocation_advisor", { minTrades: 30 }],
  ["portfolio_health_check", {}],
] as const)(
  "%s exposes the ticker fallback assumption in returned warnings or flags",
  async (tool, args) => {
    const handlers = await fixture(
      [...Array<string>(2).fill(""), ...Array<string>(18).fill("SPX")],
      Array.from({ length: 20 }, (_, i) => (i < 10 ? "Test" : "Other")),
    );
    const conn = await upgradeToReadWrite(root);
    await conn.run(
      "INSERT INTO market.enriched_context (date, Vol_Regime, Trend_Direction) VALUES ('2025-01-02', 2, 'up'), ('2025-01-03', 2, 'up')",
    );
    for (const strategyName of ["Test", "Other"]) {
      await upsertProfile(conn, {
        blockId: "capture",
        strategyName,
        structureType: "iron_condor",
        greeksBias: "theta_positive",
        thesis: "",
        legs: [],
        exitRules: [],
        expectedRegimes: ["low"],
        entryFilters: [{ field: "RSI_14", operator: ">", value: 10, source: "market" }],
        keyMetrics: {},
      });
    }
    const result = await handlers[tool]({ blockId: "capture", ...args });
    expect(result.isError ? result.content : null).toBeNull();
    const warnings =
      tool === "portfolio_health_check"
        ? (result.structuredContent?.flags as { message: string }[]).map((flag) => flag.message)
        : result.structuredContent?.warnings;
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/assum.*SPX.*2 trades/i)]),
    );
  },
);
