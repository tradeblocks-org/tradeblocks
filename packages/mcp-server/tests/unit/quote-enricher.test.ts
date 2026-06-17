/**
 * Unit tests for quote-enricher.ts pure functions.
 *
 * Covers:
 * - shouldSkipEnrichment: density check against default and custom thresholds
 * - buildEnrichmentPlan: planning logic for ticker+date combos needing enrichment
 */

import {
  shouldSkipEnrichment,
  buildEnrichmentPlan,
} from "../../src/test-exports.ts";
import type { EnrichmentPlanInput } from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// shouldSkipEnrichment
// ---------------------------------------------------------------------------

describe("shouldSkipEnrichment", () => {
  it("returns true when bar count equals the default threshold (200)", () => {
    expect(shouldSkipEnrichment(200)).toBe(true);
  });

  it("returns true when bar count exceeds the default threshold", () => {
    expect(shouldSkipEnrichment(390)).toBe(true);
    expect(shouldSkipEnrichment(201)).toBe(true);
  });

  it("returns false when bar count is below the default threshold", () => {
    expect(shouldSkipEnrichment(199)).toBe(false);
    expect(shouldSkipEnrichment(0)).toBe(false);
    expect(shouldSkipEnrichment(1)).toBe(false);
  });

  it("accepts a custom threshold", () => {
    expect(shouldSkipEnrichment(50, 50)).toBe(true);
    expect(shouldSkipEnrichment(49, 50)).toBe(false);
    expect(shouldSkipEnrichment(100, 50)).toBe(true);
  });

  it("returns true at exactly the custom threshold boundary", () => {
    expect(shouldSkipEnrichment(1, 1)).toBe(true);
    expect(shouldSkipEnrichment(0, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildEnrichmentPlan
// ---------------------------------------------------------------------------

describe("buildEnrichmentPlan", () => {
  it("returns empty array when providerSupportsQuotes is false", () => {
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker: "SPX250117C05000000", fromDate: "2025-01-10", toDate: "2025-01-10" }],
      existingCoverage: new Map(),
      providerSupportsQuotes: false,
    };
    expect(buildEnrichmentPlan(input)).toEqual([]);
  });

  it("returns empty array when tickers list is empty", () => {
    const input: EnrichmentPlanInput = {
      tickers: [],
      existingCoverage: new Map(),
      providerSupportsQuotes: true,
    };
    expect(buildEnrichmentPlan(input)).toEqual([]);
  });

  it("includes dates with no existing coverage", () => {
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker: "SPX250117C05000000", fromDate: "2025-01-10", toDate: "2025-01-10" }],
      existingCoverage: new Map(),
      providerSupportsQuotes: true,
    };
    const plan = buildEnrichmentPlan(input);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      ticker: "SPX250117C05000000",
      date: "2025-01-10",
      existingBarCount: 0,
    });
  });

  it("skips dates where coverage is already dense (>= 200 bars)", () => {
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker: "SPX250117C05000000", fromDate: "2025-01-10", toDate: "2025-01-10" }],
      existingCoverage: new Map([["SPX250117C05000000:2025-01-10", 200]]),
      providerSupportsQuotes: true,
    };
    expect(buildEnrichmentPlan(input)).toEqual([]);
  });

  it("skips dates with bar count above 200, includes dates with bar count below 200", () => {
    const ticker = "SPX250117C05000000";
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker, fromDate: "2025-01-10", toDate: "2025-01-12" }],
      existingCoverage: new Map([
        [`${ticker}:2025-01-10`, 390],   // dense — skip
        [`${ticker}:2025-01-11`, 50],    // sparse — include
        // 2025-01-12 not in map → 0 bars — include
      ]),
      providerSupportsQuotes: true,
    };
    const plan = buildEnrichmentPlan(input);
    expect(plan).toHaveLength(2);
    expect(plan.map(p => p.date)).toEqual(["2025-01-11", "2025-01-12"]);
    expect(plan.find(p => p.date === "2025-01-11")?.existingBarCount).toBe(50);
    expect(plan.find(p => p.date === "2025-01-12")?.existingBarCount).toBe(0);
  });

  it("expands a multi-day range into individual date entries", () => {
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker: "VIX250117C00015000", fromDate: "2025-01-06", toDate: "2025-01-08" }],
      existingCoverage: new Map(),
      providerSupportsQuotes: true,
    };
    const plan = buildEnrichmentPlan(input);
    expect(plan).toHaveLength(3);
    expect(plan.map(p => p.date)).toEqual(["2025-01-06", "2025-01-07", "2025-01-08"]);
  });

  it("handles multiple tickers independently", () => {
    const tickerA = "SPX250117C05000000";
    const tickerB = "VIX250117C00015000";
    const input: EnrichmentPlanInput = {
      tickers: [
        { ticker: tickerA, fromDate: "2025-01-10", toDate: "2025-01-10" },
        { ticker: tickerB, fromDate: "2025-01-10", toDate: "2025-01-10" },
      ],
      existingCoverage: new Map([
        [`${tickerA}:2025-01-10`, 250],  // dense — skip tickerA
        // tickerB not in map → 0 bars — include tickerB
      ]),
      providerSupportsQuotes: true,
    };
    const plan = buildEnrichmentPlan(input);
    expect(plan).toHaveLength(1);
    expect(plan[0].ticker).toBe(tickerB);
  });

  it("handles exactly 199 bars (just below threshold) as needing enrichment", () => {
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker: "SPX250117C05000000", fromDate: "2025-01-10", toDate: "2025-01-10" }],
      existingCoverage: new Map([["SPX250117C05000000:2025-01-10", 199]]),
      providerSupportsQuotes: true,
    };
    const plan = buildEnrichmentPlan(input);
    expect(plan).toHaveLength(1);
    expect(plan[0].existingBarCount).toBe(199);
  });

  it("returns empty when all tickers for all dates are already dense", () => {
    const ticker = "SPX250117C05000000";
    const input: EnrichmentPlanInput = {
      tickers: [{ ticker, fromDate: "2025-01-10", toDate: "2025-01-12" }],
      existingCoverage: new Map([
        [`${ticker}:2025-01-10`, 390],
        [`${ticker}:2025-01-11`, 390],
        [`${ticker}:2025-01-12`, 390],
      ]),
      providerSupportsQuotes: true,
    };
    expect(buildEnrichmentPlan(input)).toEqual([]);
  });
});
