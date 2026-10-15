import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPredictiveTools } from "../../src/tools/reports/predictive.ts";
import { registerDatasetTools } from "../../src/tools/datasets.ts";
import { getConnection, closeConnection } from "../../src/db/connection.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";
import { holmAdjust } from "@tradeblocks/lib";
import type { ZodType } from "zod";

interface Stats {
  count: number;
  totalPl: number;
  winRate: number;
}
interface FieldResult {
  field: string;
  reason?: string;
  baseline: Stats;
  bestThreshold: {
    threshold: number;
    direction: string;
    kept: Stats;
    removed: Stats;
    objectiveDelta: number;
  } | null;
  perYear: Array<{
    year: number;
    baseline: Stats;
    kept: Stats;
    removed: Stats;
    objectiveDelta: number;
    lowSampleWarning?: string;
  }>;
  permutation: {
    status: string;
    pValue: number;
    pValueHolm: number;
    blockCount: number;
    reason?: string;
  };
}

let baseDir: string;
const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutput>> = {};
const schemas: Record<string, ZodType<Record<string, unknown>>> = {};
beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "tb-filter-stats-"));
  await getConnection(baseDir);
  registerPredictiveTools(
    {
      registerTool(
        name: string,
        config: { inputSchema: ZodType<Record<string, unknown>> },
        handler: (typeof handlers)[string],
      ) {
        schemas[name] = config.inputSchema;
        handlers[name] = handler;
      },
    } as unknown as McpServer,
    baseDir,
  );
  registerDatasetTools(
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

async function fixture(
  rows: Array<{ date: string; pl: number; signal: number; noise?: number; trend?: number }>,
) {
  await mkdir(path.join(baseDir, "sample"));
  await writeFile(
    path.join(baseDir, "sample", "tradelog.csv"),
    [
      "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees,signal,noise,trend",
      ...rows.map(
        ({ date, pl, signal, noise = 0, trend = 0 }) =>
          `${date},10:00:00,1,SPX Put Spread,1,0,${date},15:00:00,0,Exit,${pl},1,10000,500,Test,0,0,${signal},${noise},${trend}`,
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

test("multi-field selection-adjusted permutation separates planted signal from noise deterministically", async () => {
  await fixture(
    Array.from({ length: 360 }, (_, i) => {
      const month = Math.floor(i / 10);
      const signal = month % 2;
      return {
        date: `${2022 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}-${String((i % 10) + 1).padStart(2, "0")}`,
        pl: signal ? 100 : -100,
        signal,
        noise: i % 10,
        trend: month,
      };
    }),
  );
  const input = {
    blockId: "sample",
    fields: ["custom.signal", "custom.noise", "custom.trend"],
    mode: "both",
    percentileSteps: [25, 50, 75],
    permutation: { iterations: 199, block: "month", seed: 42 },
  };
  const output = await handlers.filter_curve(input);
  expect(output.isError).not.toBe(true);
  const result = output.structuredContent as unknown as { fields: FieldResult[] };
  expect(result.fields).toHaveLength(3);
  const [signal, noise] = result.fields;
  expect(signal.permutation.pValue).toBeLessThan(0.05);
  expect(noise.permutation.pValue).toBeGreaterThan(0.1);
  expect(signal.perYear.reduce((sum, row) => sum + row.kept.count + row.removed.count, 0)).toBe(
    signal.baseline.count,
  );
  expect(signal.perYear.reduce((sum, row) => sum + row.kept.totalPl + row.removed.totalPl, 0)).toBe(
    signal.baseline.totalPl,
  );
  expect(signal.perYear.reduce((sum, row) => sum + row.objectiveDelta, 0)).toBe(
    signal.bestThreshold!.objectiveDelta,
  );
  expect(result.fields.map((field) => field.permutation.pValueHolm)).toEqual(
    holmAdjust(result.fields.map((field) => field.permutation.pValue)),
  );
  expect(signal.permutation.blockCount).toBe(36);
  expect((await handlers.filter_curve(input)).structuredContent).toEqual(result);
  const outcomeField = await handlers.filter_curve({
    blockId: "sample",
    field: "pl",
    mode: "both",
    permutation: input.permutation,
  });
  const outcomeResult = outcomeField.structuredContent as unknown as FieldResult;
  // Field values must stay fixed even when the selected field itself is P/L.
  expect(outcomeResult.permutation.pValue).toBe(0.005);
});

test("full-sweep calendar blocks resist the chosen-threshold and iid significance mutations", async () => {
  // Independent scalar oracle: full sweep 155/200; chosen-only 50/200; iid 2/200.
  const x = [
    7, 7, 1, 2, 6, 0, 0, 3, 3, 2, 4, 1, 0, 6, 2, 5, 4, 3, 7, 3, 7, 2, 0, 0, 0, 7, 5, 6, 2, 5, 7, 7,
    5, 7, 3, 2,
  ];
  const y = [
    100, -100, -100, -100, 100, 100, -100, 100, -100, -100, 100, 100, -100, -100, 100, 100, -100,
    100, -100, -100, -100, 100, -100, -100, 100, 100, 100, 100, 100, 100, -100, 100, -100, 100,
    -100, 100,
  ];
  await fixture(
    Array.from({ length: 360 }, (_, i) => {
      const month = Math.floor(i / 10);
      return {
        date: `${2022 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}-${String((i % 10) + 1).padStart(2, "0")}`,
        pl: y[month],
        signal: x[month],
      };
    }),
  );
  const output = await handlers.filter_curve({
    blockId: "sample",
    field: "custom.signal",
    mode: "both",
    thresholds: [1, 2, 3, 4, 5, 6],
    permutation: { iterations: 199, block: "month", seed: 42 },
  });
  expect(output.isError).not.toBe(true);
  const result = output.structuredContent as unknown as FieldResult;
  expect(result.permutation.pValue).toBe(0.775);
  expect(result.permutation.pValueHolm).toBe(0.775);
  expect(result.permutation.blockCount).toBe(36);
  expect(result.bestThreshold!.objectiveDelta).toBe(2000);
});

test("default curve retains the legacy response and refuses short block histories by name", async () => {
  await fixture(
    Array.from({ length: 40 }, (_, i) => ({
      date: "2025-01-02",
      signal: i < 20 ? 0 : 1,
      pl: i < 20 ? -100 : 100,
    })),
  );
  const input = { blockId: "sample", field: "custom.signal", mode: "both", thresholds: [0.5] };
  const legacy = await handlers.filter_curve(input);
  const warning = "20 trades may be insufficient for reliable statistics (recommend >= 30)";
  expect(legacy.structuredContent).toEqual({
    blockId: "sample",
    field: "custom.signal",
    mode: "both",
    filters: { strategy: null, startDate: null, endDate: null },
    tradesAnalyzed: 40,
    baseline: {
      count: 40,
      totalPl: 0,
      avgPl: 0,
      winRate: 0.5,
      uncoveredCount: 0,
      uncoveredTotalPl: 0,
    },
    thresholds: [
      {
        threshold: 0.5,
        lt: {
          count: 20,
          percentOfTrades: 50,
          winRate: 0,
          avgPl: -100,
          totalPl: -2000,
          winRateDelta: -0.5,
          avgPlDelta: -100,
          lowSampleWarning: warning,
        },
        gt: {
          count: 20,
          percentOfTrades: 50,
          winRate: 1,
          avgPl: 100,
          totalPl: 2000,
          winRateDelta: 0.5,
          avgPlDelta: 100,
          lowSampleWarning: warning,
        },
      },
    ],
    sweetSpots: [
      {
        threshold: 0.5,
        direction: "gt",
        winRateDelta: 0.5,
        avgPlDelta: 100,
        percentOfTrades: 50,
        score: 50,
      },
    ],
    sweetSpotCriteria: {
      winRateDelta: "> 0 (win rate improves)",
      avgPlDelta: "> 0 (average P/L improves)",
      percentOfTrades: ">= 20% (retains meaningful sample)",
      scoreFormula: "winRateDelta * avgPlDelta (higher = better)",
    },
  });
  const extended = await handlers.filter_curve({
    ...input,
    permutation: { iterations: 199, block: "month", seed: 42 },
  });
  const result = extended.structuredContent as unknown as FieldResult;
  expect(result.permutation).toMatchObject({
    status: "refused",
    reason: "too_few_blocks",
    blockCount: 1,
  });
  expect(result.permutation.pValue).toBeUndefined();
  expect(result.perYear[0].lowSampleWarning).toBeDefined();
  const absent = await handlers.filter_curve({
    blockId: "sample",
    fields: ["custom.absent", "missing.column"],
    mode: "both",
  });
  expect(absent.structuredContent?.fields).toEqual([
    expect.objectContaining({ field: "custom.absent", reason: "no_covered_trades" }),
    expect.objectContaining({ field: "missing.column", reason: "field_unavailable" }),
  ]);
});

test("totalPl and winRate select different thresholds with the shared suggestion ranking rule", async () => {
  await fixture(
    Array.from({ length: 30 }, (_, i) => ({
      date: "2025-01-02",
      signal: Math.floor(i / 10),
      pl: i < 8 ? 1000 : i < 10 ? -1 : i < 20 ? -1000 : 10,
    })),
  );
  const input = { blockId: "sample", field: "custom.signal", mode: "both", thresholds: [0.5, 1.5] };
  const total = (await handlers.filter_curve({ ...input, objective: "totalPl" }))
    .structuredContent as unknown as FieldResult;
  const win = (await handlers.filter_curve({ ...input, objective: "winRate" }))
    .structuredContent as unknown as FieldResult;
  expect(total.bestThreshold).toMatchObject({
    threshold: 0.5,
    direction: "lt",
    kept: { totalPl: 7998, winRate: 0.8 },
    objectiveDelta: 9900,
  });
  expect(win.bestThreshold).toMatchObject({
    threshold: 1.5,
    direction: "gt",
    kept: { totalPl: 100, winRate: 1 },
    objectiveDelta: 40,
  });
});

test("causal dataset coverage retains uncovered-only years and honors freshness for rank methods", async () => {
  await fixture(
    Array.from({ length: 60 }, (_, i) => ({
      date: i < 20 ? "2025-01-03" : i < 40 ? "2025-01-06" : "2026-01-02",
      signal: i,
      pl: i < 20 ? -100 : 100,
    })),
  );
  const imported = await handlers.import_daily_dataset({
    name: "signal",
    content: "date,score\n2025-01-02,0\n2025-01-03,1",
    columnTiming: { score: "close" },
  });
  expect(imported.isError).not.toBe(true);
  const output = await handlers.filter_curve({
    blockId: "sample",
    fields: ["signal.score"],
    mode: "both",
    thresholds: [0.5],
    maxMissedSessions: 0,
  });
  expect(output.isError).not.toBe(true);
  const content = output.structuredContent as unknown as { fields: FieldResult[] };
  const result = content.fields[0];
  expect(result.baseline).toMatchObject({ count: 40, uncoveredCount: 20, uncoveredTotalPl: 2000 });
  expect(result.perYear).toEqual([
    expect.objectContaining({
      year: 2025,
      kept: { count: 20, totalPl: 2000, winRate: 1 },
      removed: { count: 20, totalPl: -2000, winRate: 0 },
    }),
    expect.objectContaining({
      year: 2026,
      baseline: { count: 0, totalPl: 0, winRate: 0, uncoveredCount: 20, uncoveredTotalPl: 2000 },
      lowSampleWarning: expect.any(String),
    }),
  ]);
  for (const method of ["spearman", "kendall"]) {
    const ranked = await handlers.find_predictive_fields({
      blockId: "sample",
      method,
      targetField: "pl",
      minSamples: 10,
      includeCustomFields: true,
      maxMissedSessions: 0,
    });
    expect(ranked.isError).not.toBe(true);
    expect(ranked.structuredContent?.rankedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "signal.score", correlation: 1, sampleSize: 40 }),
      ]),
    );
  }
});

test("permutation refuses too few covered trades even with enough calendar blocks", async () => {
  await fixture(
    Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, "0")}-02`,
      pl: i % 2 ? 100 : -100,
      signal: i,
    })),
  );
  const output = await handlers.filter_curve({
    blockId: "sample",
    field: "custom.signal",
    mode: "both",
    permutation: { iterations: 499, block: "month", seed: 42 },
  });
  expect(output.structuredContent?.permutation).toMatchObject({
    status: "refused",
    reason: "too_few_covered_trades",
    blockCount: 12,
    iterations: 499,
  });
  expect(output.structuredContent?.permutation).not.toHaveProperty("pValue");
});

test("request work admission refuses the combined field family before producing any sweeps", async () => {
  await fixture(
    Array.from({ length: 1100 }, (_, i) => ({
      date: `${2022 + Math.floor(i / 240)}-${String((Math.floor(i / 20) % 12) + 1).padStart(2, "0")}-${String((i % 20) + 1).padStart(2, "0")}`,
      pl: Math.floor(i / 20) % 2 ? 100 : -100,
      signal: Math.floor(i / 20) % 2,
      noise: i % 20,
      trend: i,
    })),
  );
  const realistic = await handlers.filter_curve({
    blockId: "sample",
    fields: ["custom.signal", "custom.noise", "custom.trend"],
    mode: "both",
    permutation: { iterations: 499, block: "month", seed: 42 },
  });
  const realisticContent = realistic.structuredContent as unknown as { fields: FieldResult[] };
  expect(realisticContent.fields).toHaveLength(3);
  for (const field of realisticContent.fields) {
    expect(field.baseline.count).toBe(1100);
    expect(field.permutation).toMatchObject({ status: "ok", iterations: 499, blockCount: 55 });
  }
  const output = await handlers.filter_curve({
    blockId: "sample",
    fields: ["custom.signal", "custom.noise", "custom.trend", "openingPrice"],
    mode: "both",
    percentileSteps: [5, 10, 25, 50, 75, 90, 95],
    permutation: { iterations: 499, block: "month", seed: 42 },
  });
  expect(output.structuredContent).toMatchObject({
    status: "refused",
    reason: "permutation_request_work_limit",
    workLimit: 90_000_000,
  });
  const content = output.structuredContent as unknown as {
    estimatedWork: number;
    fields: Array<{ field: string; estimatedWork: number; thresholds?: unknown }>;
  };
  expect(content.estimatedWork).toBeGreaterThan(90_000_000);
  expect(content.fields).toHaveLength(4);
  for (const field of content.fields) {
    expect(field.estimatedWork).toBeLessThanOrEqual(30_000_000);
    expect(field.thresholds).toBeUndefined();
  }
  const fieldRefusal = await handlers.filter_curve({
    blockId: "sample",
    field: "custom.signal",
    mode: "both",
    thresholds: Array.from({ length: 100 }, (_, i) => i / 100),
    permutation: { iterations: 499, block: "month", seed: 42 },
  });
  expect(fieldRefusal.structuredContent).toMatchObject({
    status: "refused",
    reason: "permutation_work_limit",
    workLimit: 30_000_000,
    permutation: { iterations: 499, block: "month", seed: 42, status: "refused" },
  });
  expect(fieldRefusal.structuredContent).not.toHaveProperty("thresholds");
});

test("Kendall admits realistic blocks and refuses excessive total pair work without restricting other methods", async () => {
  await fixture(
    Array.from({ length: 20_000 }, (_, i) => ({
      date: i < 1100 ? "2025-01-02" : "2025-01-03",
      pl: i ** 2,
      signal: i,
    })),
  );
  const input = { blockId: "sample", targetField: "pl", minSamples: 10, includeCustomFields: true };
  const refused = await handlers.find_predictive_fields({ ...input, method: "kendall" });
  expect(refused.structuredContent).toMatchObject({
    status: "refused",
    reason: "kendall_pair_work_limit",
    pairLimit: 75_000_000,
    tradeCount: 20_000,
  });
  expect(refused.structuredContent).not.toHaveProperty("rankedFields");
  const allowed = await handlers.find_predictive_fields({
    ...input,
    method: "kendall",
    endDate: "2025-01-02",
  });
  expect(allowed.structuredContent?.rankedFields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: "custom.signal", correlation: 1, sampleSize: 1100 }),
    ]),
  );
  for (const method of ["pearson", "spearman"]) {
    const output = await handlers.find_predictive_fields({ ...input, method });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent?.rankedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "custom.signal", sampleSize: 20_000 }),
      ]),
    );
  }
});

test("large threshold and percentile arrays retain legacy schema acceptance without permutation", async () => {
  await fixture(
    Array.from({ length: 40 }, (_, i) => ({
      date: "2025-01-02",
      signal: i,
      pl: i % 2 ? 100 : -100,
    })),
  );
  for (const selection of [
    { thresholds: Array.from({ length: 150 }, (_, i) => i) },
    { percentileSteps: Array.from({ length: 150 }, (_, i) => (i * 100) / 149) },
  ]) {
    const input = { blockId: "sample", field: "custom.signal", ...selection };
    const legacy = await handlers.filter_curve(schemas.filter_curve.parse(input));
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent?.thresholds).toHaveLength(150);
    const refused = await handlers.filter_curve(
      schemas.filter_curve.parse({
        ...input,
        permutation: { iterations: 1, block: "month", seed: 42 },
      }),
    );
    expect(refused.structuredContent).toMatchObject({
      status: "refused",
      reason: "permutation_candidate_limit",
      candidateLimit: 100,
    });
    expect(refused.structuredContent).not.toHaveProperty("thresholds");
  }
});
