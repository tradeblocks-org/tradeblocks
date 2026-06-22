/**
 * Integration test for the exact matching issue from GitHub issue
 *
 * This test reproduces the exact scenario from the bug report:
 * - Trade with date "2025-12-16" and time "15:19:00"
 * - Static dataset with timestamp "2025-12-16 15:19:00"
 * - Match strategy "Exact"
 *
 * Expected: Should match
 */

import {
  processStaticDatasetContent,
  matchTradeToDataset,
  calculateMatchStats,
  Trade,
} from "@tradeblocks/lib";
import type { StaticDataset, StaticDatasetRow } from "@tradeblocks/lib";

/**
 * processStaticDatasetContent returns rows without datasetId (it is assigned on
 * persistence). The matcher takes fully-formed StaticDatasetRow[], so stamp the
 * parent dataset id onto each row for the test.
 */
function withDatasetId(
  dataset: StaticDataset,
  rows: Omit<StaticDatasetRow, "datasetId">[],
): StaticDatasetRow[] {
  return rows.map((row) => ({ ...row, datasetId: dataset.id }));
}

describe("Static dataset exact matching - GitHub issue reproduction", () => {
  it("matches trade to dataset with exact timestamp from bug report", async () => {
    // Process the static dataset CSV from the bug report
    const staticDatasetCsv = `t,somevalue
2025-12-16 15:19:00,42`;

    const datasetResult = await processStaticDatasetContent(staticDatasetCsv, {
      name: "test_data",
      fileName: "static-data.csv",
      matchStrategy: "exact",
    });

    expect(datasetResult.errors).toHaveLength(0);
    expect(datasetResult.rows).toHaveLength(1);

    // Create a trade matching the tradelog from the bug report
    // Date: 2025-12-16, Time: 15:19:00
    const trade: Trade = {
      // Parsed as UTC midnight to match how CSV dates are parsed by the application
      // (new Date('YYYY-MM-DD') creates a Date at UTC midnight, not local midnight)
      dateOpened: new Date("2025-12-16"),
      timeOpened: "15:19:00",
      openingPrice: 6794.55,
      legs: "1 Dec 18 6725 P STO 9.50 | 1 Dec 18 6880 C STO 3.10 | 1 Dec 23 6725 P BTO 24.20 | 1 Dec 23 6880 C BTO 13.15",
      premium: -2485,
      pl: -525.4,
      numContracts: 1,
      fundsAtClose: 1766488.6,
      marginReq: 2485,
      strategy: "",
      openingCommissionsFees: 5.2,
      closingCommissionsFees: 5.2,
      openingShortLongRatio: 0.337,
    };

    // Try to match with exact strategy
    const matchResult = matchTradeToDataset(
      trade,
      withDatasetId(datasetResult.dataset, datasetResult.rows),
      "exact",
    );

    // Should find a match
    expect(matchResult).not.toBeNull();
    expect(matchResult?.values.somevalue).toBe(42);
  });

  it("calculates 100% match rate for the scenario from bug report", async () => {
    const staticDatasetCsv = `t,somevalue
2025-12-16 15:19:00,42`;

    const datasetResult = await processStaticDatasetContent(staticDatasetCsv, {
      name: "test_data",
      fileName: "static-data.csv",
      matchStrategy: "exact",
    });

    const trade: Trade = {
      dateOpened: new Date("2025-12-16"),
      timeOpened: "15:19:00",
      openingPrice: 6794.55,
      legs: "",
      premium: -2485,
      pl: -525.4,
      numContracts: 1,
      fundsAtClose: 1766488.6,
      marginReq: 2485,
      strategy: "",
      openingCommissionsFees: 5.2,
      closingCommissionsFees: 5.2,
      openingShortLongRatio: 0.337,
    };

    const stats = calculateMatchStats(
      [trade],
      datasetResult.dataset,
      withDatasetId(datasetResult.dataset, datasetResult.rows),
    );

    // Should be 100% matched (not 0% as reported in the bug)
    expect(stats.totalTrades).toBe(1);
    expect(stats.matchedTrades).toBe(1);
    expect(stats.matchPercentage).toBe(100);
    expect(stats.outsideDateRange).toBe(0);
  });

  it("matches with Nearest Before strategy as mentioned in bug report", async () => {
    const staticDatasetCsv = `t,somevalue
2025-12-16 15:19:00,42`;

    const datasetResult = await processStaticDatasetContent(staticDatasetCsv, {
      name: "test_data",
      fileName: "static-data.csv",
      matchStrategy: "nearest-before",
    });

    const trade: Trade = {
      dateOpened: new Date("2025-12-16"),
      timeOpened: "15:19:00",
      openingPrice: 6794.55,
      legs: "",
      premium: -2485,
      pl: -525.4,
      numContracts: 1,
      fundsAtClose: 1766488.6,
      marginReq: 2485,
      strategy: "",
      openingCommissionsFees: 5.2,
      closingCommissionsFees: 5.2,
      openingShortLongRatio: 0.337,
    };

    const matchResult = matchTradeToDataset(
      trade,
      withDatasetId(datasetResult.dataset, datasetResult.rows),
      "nearest-before",
    );

    // Should find a match (as mentioned in the bug report)
    expect(matchResult).not.toBeNull();
    expect(matchResult?.values.somevalue).toBe(42);
  });

  it("matches with Nearest After strategy (bug fix verification)", async () => {
    // Bug report stated that Nearest After did not produce a match
    // This test verifies that the fix resolves this issue
    const staticDatasetCsv = `t,somevalue
2025-12-16 15:19:00,42`;

    const datasetResult = await processStaticDatasetContent(staticDatasetCsv, {
      name: "test_data",
      fileName: "static-data.csv",
      matchStrategy: "nearest-after",
    });

    const trade: Trade = {
      dateOpened: new Date("2025-12-16"),
      timeOpened: "15:19:00",
      openingPrice: 6794.55,
      legs: "",
      premium: -2485,
      pl: -525.4,
      numContracts: 1,
      fundsAtClose: 1766488.6,
      marginReq: 2485,
      strategy: "",
      openingCommissionsFees: 5.2,
      closingCommissionsFees: 5.2,
      openingShortLongRatio: 0.337,
    };

    const matchResult = matchTradeToDataset(
      trade,
      withDatasetId(datasetResult.dataset, datasetResult.rows),
      "nearest-after",
    );

    // Should now find a match (the fix resolves the bug where it didn't match)
    expect(matchResult).not.toBeNull();
    expect(matchResult?.values.somevalue).toBe(42);
  });
});
