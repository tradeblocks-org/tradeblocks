import { beforeAll, describe, expect, it } from "@jest/globals";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let assessRefreshResult;
let exitCodeForRefreshAssessment;

beforeAll(async () => {
  const scriptUrl = pathToFileURL(resolve(__dirname, "../refresh-market-data.mjs")).href;
  ({ assessRefreshResult, exitCodeForRefreshAssessment } = await import(scriptUrl));
});

function refreshResult(overrides = {}) {
  return {
    status: "ok",
    perOperation: {
      spot: [],
      chain: [],
      quotes: [],
      openInterest: [],
      vixContext: null,
    },
    errors: [],
    ...overrides,
  };
}

describe("refresh-market-data result assessment", () => {
  it("hostile regression: rejects trading-day status=ok when requested spot wrote zero rows", () => {
    const assessment = assessRefreshResult(
      "2026-07-30",
      refreshResult({
        perOperation: {
          spot: [{ status: "ok", rowsWritten: 0 }],
          chain: [],
          quotes: [],
          openInterest: [],
          vixContext: null,
        },
      }),
      { expectedSpotOperations: 1, nonTradingDay: false },
    );

    expect(assessment.success).toBe(false);
    expect(assessment.status).toBe("error");
    expect(assessment.operationCounts.spot).toBe(1);
    expect(assessment.rowTotals.spot).toBe(0);
    expect(assessment.failures).toContain(
      "spot operation 1 for 2026-07-30 reported ok with zero rows",
    );
    expect(exitCodeForRefreshAssessment(assessment)).toBe(1);
  });

  it("reports operation counts and actual row totals", () => {
    const assessment = assessRefreshResult(
      "2026-07-30",
      refreshResult({
        perOperation: {
          spot: [{ status: "ok", rowsWritten: 391 }],
          chain: [{ status: "ok", rowsWritten: 2400 }],
          quotes: [{ status: "ok", rowsWritten: 18000 }],
          openInterest: [{ status: "ok", rowsWritten: 1200 }],
          vixContext: { status: "ok", rowsWritten: 0 },
        },
      }),
      { expectedSpotOperations: 1 },
    );

    expect(assessment.success).toBe(true);
    expect(assessment.operationCounts).toEqual({
      spot: 1,
      chain: 1,
      quote: 1,
      openInterest: 1,
      vixContext: 1,
    });
    expect(assessment.rowTotals).toEqual({
      spot: 391,
      chain: 2400,
      quote: 18000,
      openInterest: 1200,
      vixContext: 0,
    });
  });

  it("accepts exact-date cached coverage as a satisfied spot operation", () => {
    const assessment = assessRefreshResult(
      "2026-07-30",
      refreshResult({
        perOperation: {
          spot: [
            {
              status: "skipped",
              rowsWritten: 0,
              details: { reason: "using_cached_coverage" },
            },
          ],
          chain: [],
          quotes: [],
          openInterest: [],
          vixContext: null,
        },
      }),
      { expectedSpotOperations: 1 },
    );

    expect(assessment.success).toBe(true);
    expect(assessment.status).toBe("ok");
    expect(assessment.rowTotals.spot).toBe(0);
  });

  it("treats an explicit known-closure skip as benign", () => {
    const assessment = assessRefreshResult("2026-07-03", refreshResult({ status: "skipped" }), {
      expectedSpotOperations: 1,
      nonTradingDay: true,
    });

    expect(assessment.success).toBe(true);
    expect(assessment.status).toBe("skipped");
    expect(assessment.benignClosureSkip).toBe(true);
    expect(exitCodeForRefreshAssessment(assessment)).toBe(0);
  });

  it("rejects a closure skip that contains child operations", () => {
    const assessment = assessRefreshResult(
      "2026-07-03",
      refreshResult({
        status: "skipped",
        perOperation: {
          spot: [{ status: "error", rowsWritten: 0 }],
          chain: [],
          quotes: [],
          openInterest: [],
          vixContext: null,
        },
      }),
      { expectedSpotOperations: 1, nonTradingDay: true },
    );

    expect(assessment.success).toBe(false);
    expect(assessment.benignClosureSkip).toBe(false);
    expect(exitCodeForRefreshAssessment(assessment)).toBe(1);
    expect(assessment.failures).toContain("spot operation 1 status=error");
  });

  it("rejects a skipped or otherwise non-success result on a trading day", () => {
    const assessment = assessRefreshResult("2026-07-30", refreshResult({ status: "skipped" }), {
      expectedSpotOperations: 1,
      nonTradingDay: false,
    });

    expect(assessment.success).toBe(false);
    expect(assessment.status).toBe("skipped");
    expect(assessment.failures).toContain(
      "spot operation count 0 did not match 1 requested targets for 2026-07-30",
    );
  });

  it("rejects a non-success child operation even when the aggregate reports ok", () => {
    const assessment = assessRefreshResult(
      "2026-07-30",
      refreshResult({
        perOperation: {
          spot: [{ status: "ok", rowsWritten: 391 }],
          chain: [{ status: "unsupported", rowsWritten: 0 }],
          quotes: [],
          openInterest: [],
          vixContext: null,
        },
      }),
      { expectedSpotOperations: 1 },
    );

    expect(assessment.success).toBe(false);
    expect(assessment.status).toBe("error");
    expect(assessment.failures).toContain("chain operation 1 status=unsupported");
  });

  it("rejects a non-empty error list even when the aggregate reports ok", () => {
    const assessment = assessRefreshResult(
      "2026-07-30",
      refreshResult({
        perOperation: {
          spot: [{ status: "ok", rowsWritten: 391 }],
          chain: [],
          quotes: [],
          openInterest: [],
          vixContext: null,
        },
        errors: ["provider inconsistency"],
      }),
      { expectedSpotOperations: 1 },
    );

    expect(assessment.success).toBe(false);
    expect(assessment.status).toBe("error");
    expect(exitCodeForRefreshAssessment(assessment)).toBe(1);
    expect(assessment.failures).toContain("refresh reported 1 error(s)");
  });
});

describe("--missing date selection", () => {
  let selectMissingDates;

  beforeAll(async () => {
    const scriptUrl = pathToFileURL(resolve(__dirname, "../refresh-market-data.mjs")).href;
    ({ selectMissingDates } = await import(scriptUrl));
  });

  it("hands back exactly the refreshable sessions an incomplete report names", () => {
    expect(
      selectMissingDates({
        status: "incomplete",
        incompleteSessions: [
          { date: "2026-07-21", classes: {} },
          { date: "2026-07-30", classes: {} },
        ],
      }),
    ).toEqual(["2026-07-21", "2026-07-30"]);
  });

  it("does nothing when the corpus is complete", () => {
    expect(selectMissingDates({ status: "complete", incompleteSessions: [] })).toEqual([]);
  });

  it("hostile regression: refuses an undetermined corpus instead of reading it as nothing-to-do", () => {
    // `unknown` carries the same empty session list a clean corpus does.
    // Returning [] here would let an unreadable tree render as a successful
    // no-op night — the defect this whole mode exists to close.
    expect(() =>
      selectMissingDates({
        status: "unknown",
        reason: "3 partition(s) could not be read",
        incompleteSessions: [],
      }),
    ).toThrow(/refusing to treat an undetermined corpus as complete/);
    expect(() => selectMissingDates(undefined)).toThrow(/refusing/);
  });
});
