/**
 * Integration tests for portfolio_structure_map and profile-aware tool enhancements
 *
 * Tests the portfolio_structure_map handler which builds a Vol_Regime x Trend_Direction
 * matrix across profiled strategies, detecting overlaps and blind spots.
 *
 * Requirements covered:
 *   ANLZ-03: portfolio_structure_map builds regime x structure matrix across profiled strategies
 */
import * as path from "path";
import * as fs from "fs/promises";
import { tmpdir } from "os";

// @ts-expect-error - importing from bundled output
import {
  getConnection,
  closeConnection,
  upgradeToReadWrite,
  handlePortfolioStructureMap,
  upsertProfile,
  ensureProfilesSchema,
} from "../../src/test-exports.ts";

let tempDir: string;

/**
 * Create a tradelog.csv in a block directory with the given trades.
 * Each trade needs: dateOpened, strategy, pl
 */
async function createBlockWithTrades(
  baseDir: string,
  blockId: string,
  trades: Array<{ date: string; strategy: string; pl: number }>,
): Promise<void> {
  const blockPath = path.join(baseDir, blockId);
  await fs.mkdir(blockPath, { recursive: true });

  const header =
    "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees";
  const rows = trades.map(
    (t) =>
      `${t.date},09:31:00,1.50,SPX Put Spread,1.50,0.50,${t.date},15:00:00,0.50,Profit Target,${t.pl},1,10000,5000,${t.strategy},0,0`,
  );
  const csv = [header, ...rows].join("\n");
  await fs.writeFile(path.join(blockPath, "tradelog.csv"), csv);
}

/**
 * Insert market data rows into DuckDB. Writes to v3.0 canonical tables
 * (market.enriched + market.enriched_context + market.spot) that Phase 6 Wave 1
 * SQL builders target. Each row needs: date, Vol_Regime, Trend_Direction.
 */
async function insertMarketData(
  conn: unknown,
  rows: Array<{
    date: string;
    volRegime: number;
    trendDirection: string | null;
  }>,
): Promise<void> {
  const c = conn as {
    run: (sql: string) => Promise<void>;
  };

  for (const row of rows) {
    // market.enriched (SPX) — computed indicators (no OHLCV).
    await c.run(
      `INSERT OR IGNORE INTO market.enriched (ticker, date, Prior_Close, Gap_Pct)
       VALUES ('SPX', '${row.date}', 4490, 0.1)`,
    );

    // market.spot (SPX minute bars) — two bars so spot_daily VIEW aggregates.
    await c.run(
      `INSERT OR IGNORE INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('SPX', '${row.date}', '09:30', 4500, 4520, 4480, 4505, 4499, 4501),
              ('SPX', '${row.date}', '16:00', 4505, 4520, 4480, 4510, 4509, 4511)`,
    );

    // market.enriched (VIX) — VIX-family IVR/IVP post-Phase-6.
    await c.run(
      `INSERT OR IGNORE INTO market.enriched (ticker, date, ivr, ivp)
       VALUES ('VIX', '${row.date}', 50, 50)`,
    );

    // market.spot (VIX minute bars) — source for spot_daily VIX OHLCV.
    await c.run(
      `INSERT OR IGNORE INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('VIX', '${row.date}', '09:30', 18.0, 18.5, 17.5, 18.0, 17.9, 18.1),
              ('VIX', '${row.date}', '16:00', 18.0, 18.5, 17.5, 17.5, 17.4, 17.6)`,
    );

    // market.enriched_context — cross-ticker Vol_Regime + Trend_Direction.
    const trendVal = row.trendDirection === null ? "NULL" : `'${row.trendDirection}'`;
    await c.run(
      `INSERT OR IGNORE INTO market.enriched_context (date, Vol_Regime, Trend_Direction)
       VALUES ('${row.date}', ${row.volRegime}, ${trendVal})`,
    );
  }
}

/**
 * Create a strategy profile in the database.
 */
async function createProfile(
  conn: unknown,
  blockId: string,
  strategyName: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const c = conn as {
    run: (sql: string) => Promise<void>;
  };
  await upsertProfile(c, {
    blockId,
    strategyName,
    structureType: overrides.structureType || "iron_condor",
    greeksBias: overrides.greeksBias || "theta_positive",
    thesis: overrides.thesis || "Test strategy",
    legs: overrides.legs || [],
    entryFilters: overrides.entryFilters || [],
    exitRules: overrides.exitRules || [],
    expectedRegimes: overrides.expectedRegimes || [],
    keyMetrics: overrides.keyMetrics || {},
  });
}

/**
 * Parse the JSON data from a createToolOutput response.
 */
function parseToolData(result: {
  content: Array<{
    type: string;
    text?: string;
    resource?: { text: string };
  }>;
}): Record<string, unknown> {
  const resource = result.content.find((c: { type: string }) => c.type === "resource");
  if (!resource || !("resource" in resource)) {
    throw new Error("No resource content in tool output");
  }
  return JSON.parse((resource as { resource: { text: string } }).resource.text);
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), "profile-analysis-map-"));
  await getConnection(tempDir);
  const conn = await upgradeToReadWrite(tempDir);
  await ensureProfilesSchema(conn);
});

afterEach(async () => {
  await closeConnection();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("portfolio_structure_map", () => {
  // Generate enough dates for market data spanning multiple regimes
  // We need consecutive dates so that the LAG CTE works (prev_ fields come from the prior row)
  const marketDates = [
    "2025-01-02",
    "2025-01-03",
    "2025-01-06",
    "2025-01-07",
    "2025-01-08",
    "2025-01-09",
    "2025-01-10",
    "2025-01-13",
    "2025-01-14",
    "2025-01-15",
    "2025-01-16",
    "2025-01-17",
    "2025-01-21",
    "2025-01-22",
    "2025-01-23",
    "2025-01-24",
    "2025-01-27",
    "2025-01-28",
    "2025-01-29",
    "2025-01-30",
  ];

  // Trade dates (use dates AFTER the first market date so LAG has a prior row)
  const tradeDates = marketDates.slice(1);

  async function setupTwoStrategyScenario(): Promise<void> {
    const conn = await getConnection(tempDir);

    // Insert market data with various regimes and trends
    // Dates get Vol_Regime cycling 1-6 and Trend_Direction cycling up/down/flat
    const regimes = [1, 2, 3, 4, 5, 6];
    const trends: Array<string | null> = ["up", "down", "flat"];
    const marketRows = marketDates.map((date, i) => ({
      date,
      volRegime: regimes[i % 6],
      trendDirection: trends[i % 3],
    }));
    await insertMarketData(conn, marketRows);

    // Strategy A trades on odd-indexed trade dates (different regime/trend combos)
    const stratADates = tradeDates.filter((_, i) => i % 2 === 0);
    // Strategy B trades on even-indexed trade dates
    const stratBDates = tradeDates.filter((_, i) => i % 2 === 1);
    // Also add some overlapping dates for overlap detection
    const overlapDates = tradeDates.slice(0, 3);

    const blockATrades = [
      ...stratADates.map((d) => ({
        date: d,
        strategy: "Iron Condor",
        pl: 50,
      })),
      ...overlapDates.map((d) => ({
        date: d,
        strategy: "Iron Condor",
        pl: 30,
      })),
    ];

    const blockBTrades = [
      ...stratBDates.map((d) => ({
        date: d,
        strategy: "Calendar Spread",
        pl: -20,
      })),
      ...overlapDates.map((d) => ({
        date: d,
        strategy: "Calendar Spread",
        pl: -10,
      })),
    ];

    await createBlockWithTrades(tempDir, "block-a", blockATrades);
    await createBlockWithTrades(tempDir, "block-b", blockBTrades);

    // Create profiles
    await createProfile(conn, "block-a", "Iron Condor", {
      structureType: "iron_condor",
      greeksBias: "theta_positive",
      expectedRegimes: ["low_vol"],
      entryFilters: [{ field: "VIX_Close", operator: "<", value: 20 }],
    });
    await createProfile(conn, "block-b", "Calendar Spread", {
      structureType: "calendar_spread",
      greeksBias: "vega_positive",
      expectedRegimes: ["high_vol"],
      entryFilters: [{ field: "Vol_Regime", operator: ">=", value: 4 }],
    });
  }

  it("returns 18-cell matrix with Vol_Regime x Trend_Direction", async () => {
    await setupTwoStrategyScenario();
    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    const matrix = data.matrix as Record<string, Record<string, unknown>>;

    // Should have 6 regime levels
    const regimeLabels = ["very_low", "low", "below_avg", "above_avg", "high", "extreme"];
    for (const label of regimeLabels) {
      expect(matrix[label]).toBeDefined();
    }

    // Each regime should have 3 trend directions (even if empty object)
    for (const label of regimeLabels) {
      expect(matrix[label]).toHaveProperty("up");
      expect(matrix[label]).toHaveProperty("down");
      expect(matrix[label]).toHaveProperty("flat");
    }
  });

  it("detects overlap when 2+ strategies trade in same cell", async () => {
    await setupTwoStrategyScenario();
    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    const overlaps = data.overlaps as Array<{
      regime: string;
      trend: string;
      strategies: string[];
      totalTrades: number;
    }>;

    // With overlapping dates, at least one cell should have both strategies
    const multiStrategyOverlaps = overlaps.filter((o) => o.strategies.length >= 2);
    // We should have some overlap since both strategies trade on the first 3 dates
    expect(multiStrategyOverlaps.length).toBeGreaterThanOrEqual(1);

    // Verify overlap structure
    for (const overlap of multiStrategyOverlaps) {
      expect(overlap.regime).toBeDefined();
      expect(overlap.trend).toBeDefined();
      expect(overlap.strategies.length).toBeGreaterThanOrEqual(2);
      expect(overlap.totalTrades).toBeGreaterThan(0);
    }
  });

  it("detects blind spots with zero trades", async () => {
    await setupTwoStrategyScenario();
    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    const blindSpots = data.blind_spots as Array<{
      regime: string;
      trend: string;
    }>;

    // With only ~19 trade dates cycling through 6 regimes x 3 trends,
    // not all 18 cells can be covered, so there must be blind spots
    expect(blindSpots.length).toBeGreaterThan(0);

    // Every blind spot should reference valid regime/trend labels
    const validRegimes = new Set(["very_low", "low", "below_avg", "above_avg", "high", "extreme"]);
    const validTrends = new Set(["up", "down", "flat"]);
    for (const spot of blindSpots) {
      expect(validRegimes.has(spot.regime)).toBe(true);
      expect(validTrends.has(spot.trend)).toBe(true);
    }
  });

  it("includes coverage_summary with correct counts", async () => {
    await setupTwoStrategyScenario();
    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    const summary = data.coverage_summary as {
      totalCells: number;
      coveredCells: number;
      blindSpotCells: number;
      overlapCells: number;
    };

    expect(summary.totalCells).toBe(18);
    expect(summary.coveredCells + summary.blindSpotCells).toBe(18);
    expect(summary.coveredCells).toBeGreaterThan(0);
    expect(summary.overlapCells).toBeGreaterThanOrEqual(0);
    expect(summary.overlapCells).toBeLessThanOrEqual(summary.coveredCells);
  });

  it("handles missing Trend_Direction with warning", async () => {
    const conn = await getConnection(tempDir);

    // Insert market data with NULL Trend_Direction
    const nullTrendRows = marketDates.map((date, i) => ({
      date,
      volRegime: ((i % 6) + 1) as number,
      trendDirection: null as string | null,
    }));
    await insertMarketData(conn, nullTrendRows);

    // Create block and profile
    const trades = tradeDates.map((d) => ({
      date: d,
      strategy: "Null Trend Strategy",
      pl: 25,
    }));
    await createBlockWithTrades(tempDir, "block-null", trades);
    await createProfile(conn, "block-null", "Null Trend Strategy");

    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    // Should have warnings about missing Trend_Direction
    const warnings = data.warnings as string[];
    expect(warnings.some((w) => w.includes("Trend_Direction"))).toBe(true);

    // Should have unknown_trend stats
    expect(data.unknown_trend).toBeDefined();
  });

  it("single block mode filters to that block only", async () => {
    await setupTwoStrategyScenario();

    const result = await handlePortfolioStructureMap({ blockId: "block-a" }, tempDir);
    const data = parseToolData(result);

    const strategies = data.strategies as string[];
    expect(strategies).toContain("Iron Condor");
    expect(strategies).not.toContain("Calendar Spread");
  });

  it("cross-block mode includes all profiles", async () => {
    await setupTwoStrategyScenario();

    const result = await handlePortfolioStructureMap({}, tempDir);
    const data = parseToolData(result);

    const strategies = data.strategies as string[];
    expect(strategies).toContain("Iron Condor");
    expect(strategies).toContain("Calendar Spread");
  });

  it("returns early message when no profiles exist", async () => {
    // No profiles created, just an empty temp dir
    const result = await handlePortfolioStructureMap({}, tempDir);
    expect(result.content[0].text).toContain("No strategy profiles found");
  });
});
