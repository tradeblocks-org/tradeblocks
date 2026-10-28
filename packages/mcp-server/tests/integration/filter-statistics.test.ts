import { beforeEach, afterEach, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPredictiveTools } from "../../src/tools/reports/predictive.ts";
import { registerDatasetTools } from "../../src/tools/datasets.ts";
import { registerMarketDataTools } from "../../src/tools/market-data.ts";
import { createMarketStores } from "../../src/market/stores/index.ts";
import { TickerRegistry } from "../../src/market/tickers/registry.ts";
import {
  getConnection,
  closeConnection,
  getCurrentConnection,
  upgradeToReadWrite,
  downgradeToReadOnly,
} from "../../src/db/connection.ts";
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
  for (const [selection, reason] of [
    [
      { fields: ["custom.signal", "custom.noise", "custom.trend", "openingPrice"] },
      "permutation_request_work_limit",
    ],
    [
      { field: "custom.signal", thresholds: Array.from({ length: 100 }, (_, i) => i / 100) },
      "permutation_work_limit",
    ],
  ] as const) {
    const request = { blockId: "sample", mode: "both", ...selection };
    const refused = (
      await handlers.filter_curve({
        ...request,
        permutation: { iterations: 499, block: "month", seed: 42 },
      })
    ).structuredContent!;
    expect(refused.reason).toBe(reason);
    expect(refused.maxIterationsThatFit).toEqual(expect.any(Number));
    const iterations = refused.maxIterationsThatFit as number;
    expect(iterations).toBeGreaterThanOrEqual(1);
    expect(iterations).toBeLessThan(499);
    const admitted = (
      await handlers.filter_curve({
        ...request,
        permutation: { iterations, block: "month", seed: 42 },
      })
    ).structuredContent!;
    expect(admitted.status).not.toBe("refused");
    const next = (
      await handlers.filter_curve({
        ...request,
        permutation: { iterations: iterations + 1, block: "month", seed: 42 },
      })
    ).structuredContent!;
    expect(next).toMatchObject({ status: "refused", reason });
  }
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

test("large daily dataset filter completes or names its work refusal", async () => {
  const days = Array.from({ length: 2200 }, (_, i) => {
    const date = new Date(2022, 0, 1 + i);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  await fixture(
    days.flatMap((date, i) =>
      Array.from({ length: 11 }, () => ({ date, pl: i % 2 ? 10 : -9, signal: i % 2 })),
    ),
  );
  const imported = await handlers.import_daily_dataset({
    name: "signal",
    content: ["date,score", ...days.map((date, i) => `${date},${i % 2}`)].join("\n"),
    columnTiming: { score: "open" },
    knownBy: "09:30",
  });
  expect(imported).not.toMatchObject({ isError: true });
  const unrelated = await handlers.import_daily_dataset({
    name: "unrelated",
    content: "timestamp,old\n2025-01-02T09:00:00-05:00,1",
    columnTiming: { old: "open" },
  });
  expect(unrelated.isError).not.toBe(true);
  for (const unit of ["trade", "day"]) {
    const started = performance.now();
    const output = await handlers.filter_curve({
      blockId: "sample",
      field: "signal.score",
      unit,
      mode: "both",
      permutation: { iterations: 99, block: "month", seed: 42 },
    });
    console.log(
      "large-filter-timing",
      unit,
      performance.now() - started,
      output.structuredContent?.reason ?? output.structuredContent?.permutation,
    );
    expect(output.isError).not.toBe(true);
    if (unit === "day") {
      expect(output.structuredContent?.baseline).toMatchObject({ count: 2200 });
      expect(output.structuredContent?.permutation).toMatchObject({ status: "ok" });
      expect(performance.now() - started).toBeLessThan(10_000);
    } else expect(output.structuredContent).toMatchObject({ status: "refused" });
  }
  const dayRefusal = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "signal.score",
      unit: "day",
      mode: "both",
      permutation: { iterations: 499, block: "month", seed: 42 },
    })
  ).structuredContent!;
  // n=2200 days: 501 * (2200*12 + 6*2200*7 + 3*7*4).
  expect(dayRefusal).toMatchObject({
    reason: "permutation_work_limit",
    estimatedWork: 59_560_884,
    fields: [{ field: "signal.score", coveredCount: 2200, estimatedWork: 59_560_884 }],
  });
  const noneFits = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "signal.score",
      mode: "both",
      thresholds: Array.from({ length: 100 }, (_, i) => i / 100),
      permutation: { iterations: 499, block: "month", seed: 42 },
    })
  ).structuredContent!;
  expect(noneFits).toMatchObject({
    reason: "permutation_work_limit",
    maxIterationsThatFit: null,
    iterationsFitReason: "minimum_iterations_exceeds_work_limit",
  });
}, 180_000);

test("day sweeps and month permutations equal an entry-day oracle, not an eleven-fold trade shuffle", async () => {
  const days = Array.from({ length: 120 }, (_, i) => ({
    date: `${2024 + Math.floor(i / 120)}-${String(1 + Math.floor(i / 10)).padStart(2, "0")}-${String(1 + (i % 10)).padStart(2, "0")}`,
    pl: i % 10 < (Math.floor(i / 10) % 2 ? 8 : 2) ? 11 : -11,
    signal: Math.floor(i / 10) % 2,
  }));
  await fixture(
    days.flatMap((day) =>
      Array.from({ length: 11 }, (_, i) => ({ ...day, pl: i < 10 ? 1 : day.pl - 10 })),
    ),
  );
  const input = {
    blockId: "sample",
    field: "custom.signal",
    thresholds: [0.5],
    mode: "both",
    objective: "winRate",
    permutation: { iterations: 99, block: "month", seed: 42 },
  };
  const actual = (await handlers.filter_curve({ ...input, unit: "day" })).structuredContent!;
  expect(actual.baseline).toMatchObject({ count: 120, totalPl: 0, winRate: 0.5 });
  await rm(path.join(baseDir, "sample"), { recursive: true });
  await fixture(days);
  const oracle = (await handlers.filter_curve(input)).structuredContent!;
  for (const key of ["baseline", "thresholds", "bestThreshold", "perYear", "permutation"])
    expect(actual[key]).toEqual(oracle[key]);
});

test("day mode names every date with a varying field", async () => {
  await fixture([
    { date: "2025-01-02", pl: 1, signal: 0 },
    { date: "2025-01-02", pl: 2, signal: 1 },
    { date: "2025-01-03", pl: 3, signal: 2 },
    { date: "2025-01-03", pl: 4, signal: 3 },
  ]);
  expect(
    (
      await handlers.filter_curve({
        blockId: "sample",
        field: "custom.signal",
        unit: "day",
        mode: "both",
      })
    ).structuredContent,
  ).toMatchObject({
    status: "refused",
    reason: "day_field_varies",
    days: ["2025-01-02", "2025-01-03"],
  });
});

test("insurance ranks ahead for drawdown and MAR, not total P&L; daily risk metrics have a fixed-capital oracle", async () => {
  const pls = [-150, -150, 310, -10, -10, 100, 100, 100, 100, 100];
  await fixture(
    Array.from({ length: 120 }, (_, i) => ({
      date: `2025-${String(1 + Math.floor(i / 10)).padStart(2, "0")}-${String(1 + (i % 10)).padStart(2, "0")}`,
      pl: pls[i % 10],
      signal: i % 10 < 3 ? 2 : i % 10 === 3 ? 0 : 1,
    })),
  );
  const input = {
    blockId: "sample",
    field: "custom.signal",
    unit: "day",
    mode: "both",
    thresholds: [0.5, 1.5],
  };
  for (const objective of ["maxDrawdown", "mar", "totalPl", "sharpe"]) {
    const output = await handlers.filter_curve(schemas.filter_curve.parse({ ...input, objective }));
    expect(output.isError).not.toBe(true);
    const result = output.structuredContent!;
    expect(result.bestThreshold).toMatchObject(
      objective === "totalPl"
        ? { threshold: 0.5, direction: "gt" }
        : { threshold: 1.5, direction: "lt" },
    );
    if (objective === "maxDrawdown") {
      expect(result.baseline).toMatchObject({ maxDrawdown: { dollars: 300 } });
      expect(result.bestThreshold).toMatchObject({
        kept: { maxDrawdown: { dollars: 20 } },
        objectiveDelta: 280,
      });
    }
  }
});

test("risk objectives refuse trade units and MAR refuses an assumed capital basis", async () => {
  await fixture([
    { date: "2025-01-02", pl: -10, signal: 0 },
    { date: "2025-01-03", pl: 20, signal: 1 },
  ]);
  const input = { blockId: "sample", field: "custom.signal", mode: "both", thresholds: [0.5] };
  for (const objective of ["sharpe", "mar", "maxDrawdown"])
    expect((await handlers.filter_curve({ ...input, objective })).structuredContent).toMatchObject({
      status: "refused",
      reason: "objective_requires_day",
      objective,
    });
  const csvPath = path.join(baseDir, "sample", "tradelog.csv");
  await writeFile(
    csvPath,
    (await readFile(csvPath, "utf8")).replace("Funds at Close", "No Capital"),
  );
  expect(
    (await handlers.filter_curve({ ...input, unit: "day", objective: "mar" })).structuredContent,
  ).toMatchObject({ status: "refused", reason: "mar_requires_capital" });
  for (const objective of ["sharpe", "maxDrawdown"]) {
    const result = (await handlers.filter_curve({ ...input, unit: "day", objective }))
      .structuredContent!;
    expect(result.baseline).toMatchObject({ maxDrawdown: { dollars: 10, percent: null } });
    expect(result.objectiveMetadata).toMatchObject({ startingCapital: null });
  }
});

test("maxDrawdown month permutation on balanced noise is non-significant", async () => {
  await fixture(
    Array.from({ length: 240 }, (_, i) => ({
      date: `${2024 + Math.floor(i / 120)}-${String(1 + (Math.floor(i / 10) % 12)).padStart(2, "0")}-${String(1 + (i % 10)).padStart(2, "0")}`,
      pl: i % 2 ? 10 : -10,
      signal: i % 5,
    })),
  );
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      mode: "both",
      unit: "day",
      objective: "maxDrawdown",
      thresholds: [1.5, 2.5],
      permutation: { iterations: 99, block: "month", seed: 42 },
    })
  ).structuredContent!;
  expect(result.permutation).toMatchObject({ status: "ok", pValue: 1 });
});

test("daily risk definitions match an independent four-date oracle with filtered days flat", async () => {
  await fixture(
    [-10, 30, -20, 40].map((pl, i) => ({
      date: `2025-01-0${i + 2}`,
      pl,
      signal: i === 2 ? 0 : 1,
    })),
  );
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      unit: "day",
      mode: "gt",
      objective: "sharpe",
      thresholds: [0.5],
    })
  ).structuredContent as unknown as {
    baseline: { sharpe: number; maxDrawdown: { dollars: number; percent: number }; mar: number };
    bestThreshold: { kept: { sharpe: number; mar: number } };
  };
  // Sample variance: (400 + 400 + 900 + 900) / 3; kept [-10,30,0,40] mean 15, variance 1700/3.
  expect(result.baseline.sharpe).toBeCloseTo((10 / Math.sqrt(2600 / 3)) * Math.sqrt(252), 12);
  expect(result.bestThreshold.kept.sharpe).toBeCloseTo(
    (15 / Math.sqrt(1700 / 3)) * Math.sqrt(252),
    12,
  );
  // Funds at first close 10000 minus first P&L -10 = initial capital 10010.
  expect(result.baseline.maxDrawdown).toEqual({ dollars: 20, percent: (20 / 10010) * 100 });
  const cagrPct = (Math.pow(10050 / 10010, 365.25 / 3) - 1) * 100;
  expect(result.baseline.mar).toBeCloseTo(cagrPct / ((20 / 10010) * 100), 10);
});

test("chosen threshold groups partition covered and uncovered totals with numeric quantiles or categories", async () => {
  await fixture(
    Array.from({ length: 80 }, (_, i) => ({
      date: `2025-01-${String(2 + Math.floor(i / 20)).padStart(2, "0")}`,
      pl: i % 2 ? 20 : -10,
      signal: i % 2,
    })),
  );
  expect(
    (
      await handlers.import_daily_dataset({
        name: "regime",
        content: "date,score,label\n2025-01-03,1,uncovered\n2025-01-04,2,busy\n2025-01-05,3,busy",
        columnTiming: { score: "open", label: "open" },
        knownBy: "09:30",
      })
    ).isError,
  ).not.toBe(true);
  const input = {
    blockId: "sample",
    field: "custom.signal",
    mode: "gt",
    objective: "totalPl",
    thresholds: [0.5],
  };
  for (const groupBy of ["regime.score", "regime.label"]) {
    const result = (await handlers.filter_curve(schemas.filter_curve.parse({ ...input, groupBy })))
      .structuredContent!;
    const rows = result.perGroup as Array<{
      group: string | null;
      uncoveredGroup?: boolean;
      baseline: Stats & { uncoveredCount: number };
      kept: Stats;
      removed: Stats;
      lowSampleWarning?: string;
    }>;
    expect(rows.reduce((sum, row) => sum + row.baseline.count, 0)).toBe(80);
    expect(rows.reduce((sum, row) => sum + row.kept.count, 0)).toBe(40);
    expect(rows.reduce((sum, row) => sum + row.removed.totalPl, 0)).toBe(-400);
    expect(rows.find((row) => row.uncoveredGroup)).toMatchObject({
      group: null,
      baseline: { count: 20 },
      kept: { count: 10 },
      removed: { count: 10 },
      lowSampleWarning: expect.any(String),
    });
    expect(rows.filter((row) => !row.uncoveredGroup).map((row) => row.group)).toEqual(
      groupBy === "regime.label" ? ["busy", "uncovered"] : ["[1, 2)", "[2, 3)", "[3, ∞)"],
    );
  }
});

test("day groups honor causal freshness, retain uncovered totals, and refuse intraday group variation", async () => {
  await fixture(
    Array.from({ length: 88 }, (_, i) => ({
      date: ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"][Math.floor(i / 22)],
      pl: i % 22 < 11 ? 2 : -1,
      signal: i % 22 < 11 ? 1 : 0,
    })),
  );
  await handlers.import_daily_dataset({
    name: "grouping",
    content: "date,value\n2025-01-02,1\n2025-01-03,2",
    columnTiming: { value: "open" },
    knownBy: "09:30",
  });
  const input = {
    blockId: "sample",
    field: "grouping.value",
    unit: "day",
    mode: "gt",
    thresholds: [1.5],
    groupBy: "grouping.value",
    bins: [1.5],
    maxMissedSessions: 0,
  };
  const result = (await handlers.filter_curve(schemas.filter_curve.parse(input)))
    .structuredContent!;
  const rows = result.perGroup as Array<{
    baseline: Stats & { uncoveredCount: number };
    kept: Stats;
    removed: Stats;
  }>;
  // Friday's open value is stale on Monday/Tuesday; both fields use the same freshness rule.
  expect(rows.reduce((sum, row) => sum + row.baseline.count + row.baseline.uncoveredCount, 0)).toBe(
    4,
  );
  expect(rows.reduce((sum, row) => sum + row.kept.count, 0)).toBe(1);
  expect(rows.reduce((sum, row) => sum + row.removed.count, 0)).toBe(1);
  expect(result.perGroup).toContainEqual(
    expect.objectContaining({
      uncoveredGroup: true,
      baseline: expect.objectContaining({ count: 0, uncoveredCount: 2, uncoveredTotalPl: 22 }),
    }),
  );
  // Two entry times on each day see different timestamped group values.
  const csvPath = path.join(baseDir, "sample", "tradelog.csv");
  const csv = await readFile(csvPath, "utf8");
  await writeFile(
    csvPath,
    csv
      .split("\n")
      .map((line, i) => (i > 0 && i % 2 ? line.replace("10:00:00", "11:00:00") : line))
      .join("\n"),
  );
  await handlers.import_daily_dataset({
    name: "intraday",
    content: "timestamp,value\n2025-01-02T09:00:00-05:00,1\n2025-01-02T10:30:00-05:00,2",
    columnTiming: { value: "open" },
  });
  const refused = (
    await handlers.filter_curve({
      ...input,
      groupBy: "intraday.value",
      maxMissedSessions: undefined,
    })
  ).structuredContent!;
  expect(refused).toMatchObject({
    status: "refused",
    reason: "day_group_varies",
    groupBy: "intraday.value",
    days: ["2025-01-02"],
  });
});

test("group declarations refuse unknown fields and incompatible bins by name", async () => {
  await fixture([
    { date: "2025-01-02", pl: 10, signal: 1 },
    { date: "2025-01-03", pl: -5, signal: 0 },
  ]);
  await handlers.import_daily_dataset({
    name: "category",
    content: "date,value\n2025-01-02,calm",
    columnTiming: { value: "open" },
    knownBy: "09:30",
  });
  const input = { blockId: "sample", field: "custom.signal", mode: "both", thresholds: [0.5] };
  for (const options of [
    { bins: [1] },
    { groupBy: "category.value", bins: [1] },
    { groupBy: "category.value", bins: [2, 1] },
  ])
    expect((await handlers.filter_curve({ ...input, ...options })).structuredContent).toMatchObject(
      { status: "refused", reason: "group_bins_invalid" },
    );
  expect(
    (await handlers.filter_curve({ ...input, groupBy: "missing.value" })).structuredContent,
  ).toMatchObject({ status: "refused", reason: "group_field_unavailable" });
});

test("MAR with zero baseline drawdown reports undefined candidates and a named refusal", async () => {
  await fixture([
    { date: "2025-01-02", pl: 10, signal: 1 },
    { date: "2025-01-03", pl: 20, signal: 0 },
  ]);
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      unit: "day",
      objective: "mar",
      mode: "both",
      thresholds: [0.5],
    })
  ).structuredContent!;
  expect(result).toMatchObject({ status: "refused", reason: "mar_undefined", bestThreshold: null });
  expect(result.thresholds).toEqual([
    expect.objectContaining({
      lt: expect.objectContaining({ objectiveDelta: null, objectiveReason: "mar_undefined" }),
      gt: expect.objectContaining({ objectiveDelta: null, objectiveReason: "mar_undefined" }),
    }),
  ]);
});

test("day P&L aggregation does not rewrite the constant field value being swept", async () => {
  await fixture(
    [1, 1, 1, 2, 2, 2].map((pl, i) => ({
      date: i < 3 ? "2025-01-02" : "2025-01-03",
      pl,
      signal: 0,
    })),
  );
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "pl",
      unit: "day",
      mode: "both",
      thresholds: [1.5],
    })
  ).structuredContent!;
  expect(result.baseline).toMatchObject({ count: 2, totalPl: 9 });
  expect(result.thresholds).toEqual([
    expect.objectContaining({
      lt: expect.objectContaining({ count: 1, totalPl: 3 }),
      gt: expect.objectContaining({ count: 1, totalPl: 6 }),
    }),
  ]);
});

test("built-in categorical group values use prior-session categories rather than numeric buckets", async () => {
  await fixture([
    { date: "2025-01-03", pl: -10, signal: 0 },
    { date: "2025-01-06", pl: 20, signal: 1 },
  ]);
  const conn = await upgradeToReadWrite(baseDir);
  await conn.run(
    "INSERT INTO market.enriched (ticker, date) VALUES ('SPX', '2025-01-02'), ('SPX', '2025-01-03'), ('SPX', '2025-01-06')",
  );
  await conn.run(`INSERT INTO market.enriched_context (date, "Trend_Direction") VALUES
    ('2025-01-02', 'up'), ('2025-01-03', 'down'), ('2025-01-06', 'flat')`);
  await downgradeToReadOnly(baseDir);
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      groupBy: "Trend_Direction",
      thresholds: [0.5],
      mode: "both",
    })
  ).structuredContent!;
  expect(result.perGroup).toEqual([
    expect.objectContaining({
      group: "down",
      baseline: expect.objectContaining({ count: 1, totalPl: 20 }),
    }),
    expect.objectContaining({
      group: "up",
      baseline: expect.objectContaining({ count: 1, totalPl: -10 }),
    }),
  ]);
  registerMarketDataTools(
    {
      registerTool(name: string, _config: unknown, handler: (typeof handlers)[string]) {
        handlers[name] = handler;
      },
    } as unknown as McpServer,
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
  const regimes = (
    await handlers.analyze_regime_performance({
      blockId: "sample",
      field: "Trend_Direction",
    })
  ).structuredContent!;
  expect(regimes.segments).toEqual([
    expect.objectContaining({ segment: "down", tradeCount: 1, totalPl: 20 }),
    expect.objectContaining({ segment: "up", tradeCount: 1, totalPl: -10 }),
  ]);
  const suggestions = (
    await handlers.suggest_filters({
      blockId: "sample",
      fields: ["Trend_Direction"],
      objective: "totalPl",
    })
  ).structuredContent!;
  expect(suggestions.suggestedFilters).toEqual([
    expect.objectContaining({
      condition: expect.objectContaining({ field: "Trend_Direction", operator: "==", value: "up" }),
      newTotalPl: 20,
    }),
  ]);
});

test("per-year and per-group MAR suppress spans below 90 calendar days but retain the 90-day boundary", async () => {
  await fixture([
    { date: "2024-01-01", pl: -10, signal: 1 },
    { date: "2024-01-02", pl: 30, signal: 1 },
    { date: "2024-03-31", pl: -5, signal: 0 },
    { date: "2025-01-02", pl: -20, signal: 1 },
    { date: "2025-01-03", pl: 40, signal: 0 },
  ]);
  await handlers.import_daily_dataset({
    name: "duration",
    content: "date,label\n2024-01-01,long\n2025-01-01,short",
    columnTiming: { label: "open" },
    knownBy: "09:30",
  });
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      unit: "day",
      objective: "mar",
      groupBy: "duration.label",
      thresholds: [0.5],
      mode: "both",
    })
  ).structuredContent!;
  expect(result.baseline).toMatchObject({ mar: expect.any(Number) });
  expect(result.bestThreshold).toMatchObject({ objectiveDelta: expect.any(Number) });
  for (const rows of [result.perYear, result.perGroup]) {
    expect(rows).toEqual([
      expect.objectContaining({
        baseline: expect.objectContaining({ mar: expect.any(Number) }),
        kept: expect.objectContaining({ mar: expect.any(Number) }),
        removed: expect.objectContaining({ mar: expect.any(Number) }),
        objectiveDelta: expect.any(Number),
      }),
      expect.objectContaining({
        marUnstable: true,
        objectiveDelta: null,
        baseline: expect.objectContaining({ mar: null, marUnstable: true }),
        kept: expect.objectContaining({ mar: null, marUnstable: true }),
        removed: expect.objectContaining({ mar: null, marUnstable: true }),
      }),
    ]);
  }
});

test("strategy-filtered risk objectives never use portfolio daily-log capital", async () => {
  await fixture(
    [-10, 30, -20, 40].map((pl, i) => ({
      date: ["2025-01-02", "2025-01-03", "2025-05-02", "2025-05-03"][i],
      pl,
      signal: i === 2 ? 0 : 1,
    })),
  );
  const csvPath = path.join(baseDir, "sample", "tradelog.csv");
  const csv = await readFile(csvPath, "utf8");
  await writeFile(
    csvPath,
    [
      csv,
      ...csv
        .split("\n")
        .slice(1)
        .map((row) => row.replace(",Test,", ",Other,").replace(",10000,", ",50000,")),
    ].join("\n"),
  );
  await writeFile(
    path.join(baseDir, "sample", "dailylog.csv"),
    "Date,Net Liquidity,P/L,Drawdown %\n2025-01-02,100100,100,0\n2025-05-03,100000,0,0\n",
  );
  const input = {
    blockId: "sample",
    field: "custom.signal",
    unit: "day",
    mode: "gt",
    thresholds: [0.5],
    strategy: "Test",
  };
  for (const objective of ["mar", "maxDrawdown", "sharpe"]) {
    const result = (await handlers.filter_curve({ ...input, objective })).structuredContent!;
    expect(result.objectiveMetadata).toMatchObject({ startingCapital: 10010 });
    expect(result.baseline).toMatchObject({
      count: 4,
      maxDrawdown: { dollars: 20, percent: (20 / 10010) * 100 },
    });
    expect(result.bestThreshold).toMatchObject({ objectiveDelta: expect.any(Number) });
  }
  const unscoped = (
    await handlers.filter_curve({
      ...input,
      strategy: undefined,
      objective: "mar",
    })
  ).structuredContent!;
  expect(unscoped.objectiveMetadata).toMatchObject({ startingCapital: 100000 });
  await writeFile(
    csvPath,
    (await readFile(csvPath, "utf8")).replace("Funds at Close", "No Capital"),
  );
  expect(
    (await handlers.filter_curve({ ...input, objective: "mar" })).structuredContent,
  ).toMatchObject({
    status: "refused",
    reason: "mar_requires_capital",
    capitalReason: "portfolio_capital_not_applicable_to_strategy",
  });
  for (const objective of ["sharpe", "maxDrawdown"]) {
    const result = (await handlers.filter_curve({ ...input, objective })).structuredContent!;
    expect(result.objectiveMetadata).toMatchObject({
      startingCapital: null,
      capitalReason: "portfolio_capital_not_applicable_to_strategy",
    });
    expect(result.baseline).toMatchObject({
      maxDrawdown: {
        dollars: 20,
        percent: null,
        percentReason: "portfolio_capital_not_applicable_to_strategy",
      },
    });
    expect(result.bestThreshold).toMatchObject({ objectiveDelta: expect.any(Number) });
  }
});

test("whole-population MAR uses two calendar days across the spring DST transition", async () => {
  await fixture([
    { date: "2025-03-08", pl: -10, signal: 0 },
    { date: "2025-03-09", pl: 30, signal: 1 },
    { date: "2025-03-10", pl: -5, signal: 0 },
  ]);
  const result = (
    await handlers.filter_curve({
      blockId: "sample",
      field: "custom.signal",
      unit: "day",
      objective: "mar",
      mode: "both",
      thresholds: [0.5],
    })
  ).structuredContent as unknown as {
    baseline: { annualizedReturnPct: number; mar: number };
  };
  // March 8 through March 10 is two calendar days, even when local midnights are 47 hours apart.
  const annualizedReturnPct = (Math.pow(10025 / 10010, 365.25 / 2) - 1) * 100;
  expect(result.baseline.annualizedReturnPct).toBeCloseTo(annualizedReturnPct, 10);
  expect(result.baseline.mar).toBeCloseTo(annualizedReturnPct / ((10 / 10010) * 100), 10);
});

test("date-windowed risk capital uses the window's first daily log rather than the block's", async () => {
  await fixture([
    { date: "2025-01-02", pl: -10, signal: 0 },
    { date: "2025-04-01", pl: -20, signal: 0 },
    { date: "2025-04-02", pl: 40, signal: 1 },
    { date: "2025-06-01", pl: 10, signal: 1 },
  ]);
  await writeFile(
    path.join(baseDir, "sample", "dailylog.csv"),
    "Date,Net Liquidity,P/L,Drawdown %\n2025-01-02,100100,100,0\n2025-04-01,20050,50,0\n2025-04-02,20090,40,0\n2025-06-01,300100,100,0\n",
  );
  const input = {
    blockId: "sample",
    field: "custom.signal",
    unit: "day",
    mode: "both",
    thresholds: [0.5],
  };
  for (const objective of ["mar", "maxDrawdown", "sharpe"]) {
    const result = (
      await handlers.filter_curve({
        ...input,
        objective,
        startDate: "2025-04-01",
        endDate: "2025-04-02",
      })
    ).structuredContent!;
    expect(result.objectiveMetadata).toMatchObject({
      startingCapital: 20000,
      startingCapitalSource: "daily_log",
      maxDrawdownPercentBasis: expect.stringContaining("start of the analyzed window"),
    });
    expect(result.baseline).toMatchObject({
      count: 2,
      totalPl: 20,
      maxDrawdown: { dollars: 20, percent: 0.1 },
    });
  }
  const unwindowed = (await handlers.filter_curve({ ...input, objective: "mar" }))
    .structuredContent!;
  expect(unwindowed.objectiveMetadata).toMatchObject({ startingCapital: 100000 });
  const strategy = (
    await handlers.filter_curve({
      ...input,
      objective: "mar",
      strategy: "Test",
      startDate: "2025-04-01",
      endDate: "2025-04-02",
    })
  ).structuredContent!;
  expect(strategy.objectiveMetadata).toMatchObject({
    startingCapital: 10020,
    startingCapitalSource: "observed_trade_funds",
  });
});

test("kept-share floor restricts observed and shuffled selection without hiding descriptive rows", async () => {
  await fixture(
    Array.from({ length: 32 }, (_, i) => ({
      date: `2025-${String(Math.floor(i / 4) + 1).padStart(2, "0")}-${String((i % 4) + 1).padStart(2, "0")}`,
      signal: i,
      pl: i < 2 ? 100 : i < 16 ? -1 : -10,
    })),
  );
  const input = {
    blockId: "sample",
    field: "custom.signal",
    mode: "lt",
    thresholds: [1.5, 15.5],
    permutation: { iterations: 19, block: "month", seed: 42 },
  };
  const unfloored = (await handlers.filter_curve(input)).structuredContent!;
  expect(unfloored.bestThreshold).toMatchObject({ threshold: 1.5, kept: { count: 2 } });
  const floored = (await handlers.filter_curve({ ...input, minKeptFraction: 0.5 }))
    .structuredContent!;
  expect(floored.bestThreshold).toMatchObject({ threshold: 15.5, kept: { count: 16 } });
  expect(floored.keptShareFloor).toEqual({
    minKeptFraction: 0.5,
    minimumKeptCount: 16,
    coveredCount: 32,
    excludedCandidates: 1,
  });
  expect(floored.thresholds).toEqual(unfloored.thresholds);
  expect(floored.sweetSpots).toEqual(unfloored.sweetSpots);
  // None of the 19 seeded month draws keeps all four original first-half months.
  // Allowing the two-entry candidate in shuffled sweeps instead gives 2 exceedances.
  expect(floored.permutation).toMatchObject({ status: "ok", exceedances: 0, pValue: 0.05 });
  const excluded = (await handlers.filter_curve({ ...input, minKeptFraction: 1 }))
    .structuredContent!;
  expect(excluded.bestThreshold).toBeNull();
  expect(excluded.keptShareFloor).toMatchObject({ minimumKeptCount: 32, excludedCandidates: 2 });
  expect(excluded.permutation).toMatchObject({
    status: "refused",
    reason: "no_eligible_threshold",
  });
  expect(excluded.permutation).not.toHaveProperty("pValue");
  const implicit = (
    await handlers.filter_curve({ ...input, permutation: undefined, minKeptFraction: 0.5 })
  ).structuredContent!;
  expect(implicit).toMatchObject({ objective: "totalPl", bestThreshold: { threshold: 15.5 } });
  for (const minKeptFraction of [0, -0.1, 1.01])
    expect(schemas.filter_curve.safeParse({ ...input, minKeptFraction }).success).toBe(false);
});
