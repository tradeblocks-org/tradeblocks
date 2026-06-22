/**
 * Performance Tools
 *
 * Tier 3 performance MCP tools for chart data, period returns, and backtest vs actual comparison.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../utils/block-loader.ts";
import { createToolOutput, formatPercent, formatCurrency } from "../utils/output-formatter.ts";
import type { Trade, ReportingTrade } from "@tradeblocks/lib";
import {
  normalizeToOneLot,
  calculateDailyExposure as calculateDailyExposureShared,
  formatDateKey,
  truncateTimeToMinute,
  calculateScaledPl,
  applyStrategyFilter,
  applyDateRangeFilter,
} from "@tradeblocks/lib";

/**
 * MFE/MAE data point for a single trade's excursion metrics
 * (Inline implementation to avoid dependency issues)
 */
interface MFEMAEDataPoint {
  tradeNumber: number;
  date: Date;
  strategy: string;
  mfe: number;
  mae: number;
  pl: number;
  mfePercent?: number;
  maePercent?: number;
  profitCapturePercent?: number;
  excursionRatio?: number;
  basis: "premium" | "margin" | "maxProfit" | "unknown";
  isWinner: boolean;
}

/**
 * Distribution bucket for MFE/MAE histogram
 */
interface MFEMAEDistributionBucket {
  bucket: string;
  mfeCount: number;
  maeCount: number;
  range: [number, number];
}

/**
 * Calculate total max profit from trade (handles multi-leg spreads)
 */
function computeTotalMaxProfit(trade: Trade): number {
  if (typeof trade.maxProfit === "number" && isFinite(trade.maxProfit)) {
    return Math.abs(trade.maxProfit);
  }
  return 0;
}

/**
 * Calculate total max loss from trade (handles multi-leg spreads)
 */
function computeTotalMaxLoss(trade: Trade): number {
  if (typeof trade.maxLoss === "number" && isFinite(trade.maxLoss)) {
    return Math.abs(trade.maxLoss);
  }
  return 0;
}

/**
 * Calculate total premium from trade
 */
function computeTotalPremium(trade: Trade): number {
  if (typeof trade.premium === "number" && isFinite(trade.premium)) {
    return Math.abs(trade.premium);
  }
  return 0;
}

/**
 * Calculate MFE/MAE metrics for a single trade
 */
function calculateTradeExcursionMetrics(trade: Trade, tradeNumber: number): MFEMAEDataPoint | null {
  const totalMFE = computeTotalMaxProfit(trade);
  const totalMAE = computeTotalMaxLoss(trade);

  // Skip trades without excursion data
  if (!totalMFE && !totalMAE) {
    return null;
  }

  // Determine denominator for percentage calculations
  const totalPremium = computeTotalPremium(trade);
  const margin =
    typeof trade.marginReq === "number" && isFinite(trade.marginReq) && trade.marginReq !== 0
      ? Math.abs(trade.marginReq)
      : undefined;

  let denominator: number | undefined;
  let basis: MFEMAEDataPoint["basis"] = "unknown";

  if (totalPremium && totalPremium > 0) {
    denominator = totalPremium;
    basis = "premium";
  } else if (margin && margin > 0) {
    denominator = margin;
    basis = "margin";
  } else if (totalMFE && totalMFE > 0) {
    denominator = totalMFE;
    basis = "maxProfit";
  }

  const dataPoint: MFEMAEDataPoint = {
    tradeNumber,
    date: trade.dateOpened,
    strategy: trade.strategy || "Unknown",
    mfe: totalMFE || 0,
    mae: totalMAE || 0,
    pl: trade.pl,
    isWinner: trade.pl > 0,
    basis,
  };

  // Calculate percentages if we have a denominator
  if (denominator && denominator > 0) {
    if (totalMFE) {
      dataPoint.mfePercent = (totalMFE / denominator) * 100;
    }
    if (totalMAE) {
      dataPoint.maePercent = (totalMAE / denominator) * 100;
    }
  }

  // Profit capture: what % of max profit was actually captured
  if (totalMFE && totalMFE > 0) {
    dataPoint.profitCapturePercent = (trade.pl / totalMFE) * 100;
  }

  // Excursion ratio: reward/risk
  if (totalMFE && totalMAE && totalMAE > 0) {
    dataPoint.excursionRatio = totalMFE / totalMAE;
  }

  return dataPoint;
}

/**
 * Calculate MFE/MAE data for all trades
 */
function calculateMFEMAEData(trades: Trade[]): MFEMAEDataPoint[] {
  const dataPoints: MFEMAEDataPoint[] = [];

  trades.forEach((trade, index) => {
    const point = calculateTradeExcursionMetrics(trade, index + 1);
    if (point) {
      dataPoints.push(point);
    }
  });

  return dataPoints;
}

/**
 * Create distribution buckets for MFE/MAE histogram visualization
 */
function createExcursionDistribution(
  dataPoints: MFEMAEDataPoint[],
  bucketSize: number = 10,
): MFEMAEDistributionBucket[] {
  const mfeValues = dataPoints.filter((d) => d.mfePercent !== undefined).map((d) => d.mfePercent!);
  const maeValues = dataPoints.filter((d) => d.maePercent !== undefined).map((d) => d.maePercent!);

  if (mfeValues.length === 0 && maeValues.length === 0) {
    return [];
  }

  const allValues = [...mfeValues, ...maeValues];
  const maxValue = Math.max(...allValues);
  const numBuckets = Math.max(1, Math.ceil(maxValue / bucketSize));

  const buckets: MFEMAEDistributionBucket[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const rangeStart = i * bucketSize;
    const rangeEnd = (i + 1) * bucketSize;
    const isLastBucket = i === numBuckets - 1;

    const inBucket = (value: number) =>
      value >= rangeStart && (isLastBucket ? value <= rangeEnd : value < rangeEnd);

    const mfeCount = mfeValues.filter(inBucket).length;
    const maeCount = maeValues.filter(inBucket).length;

    buckets.push({
      bucket: `${rangeStart}-${rangeEnd}%`,
      mfeCount,
      maeCount,
      range: [rangeStart, rangeEnd],
    });
  }

  return buckets;
}

/**
 * Filter trades by strategy
 */
function filterByStrategy(trades: Trade[], strategy?: string): Trade[] {
  if (!strategy) return trades;
  return trades.filter((t) => t.strategy.toLowerCase() === strategy.toLowerCase());
}

/**
 * Get the ISO week number
 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Calculate equity curve from trades
 */
function buildEquityCurve(trades: Trade[]): Array<{
  date: string;
  equity: number;
  highWaterMark: number;
  tradeNumber: number;
}> {
  if (trades.length === 0) {
    return [];
  }

  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
  );

  // Calculate initial capital from first trade
  const firstTrade = sortedTrades[0];
  let initialCapital = firstTrade.fundsAtClose - firstTrade.pl;
  if (!isFinite(initialCapital) || initialCapital <= 0) {
    initialCapital = 100000;
  }

  let runningEquity = initialCapital;
  let highWaterMark = runningEquity;

  const curve: Array<{
    date: string;
    equity: number;
    highWaterMark: number;
    tradeNumber: number;
  }> = [
    {
      date: formatDateKey(new Date(sortedTrades[0].dateOpened)),
      equity: runningEquity,
      highWaterMark,
      tradeNumber: 0,
    },
  ];

  sortedTrades.forEach((trade, index) => {
    runningEquity += trade.pl;
    highWaterMark = Math.max(highWaterMark, runningEquity);

    curve.push({
      date: formatDateKey(new Date(trade.dateOpened)),
      equity: runningEquity,
      highWaterMark,
      tradeNumber: index + 1,
    });
  });

  return curve;
}

/**
 * Calculate drawdown series from equity curve
 */
function buildDrawdownSeries(
  equityCurve: Array<{ date: string; equity: number; highWaterMark: number }>,
): Array<{ date: string; drawdownPct: number }> {
  return equityCurve.map((point) => ({
    date: point.date,
    drawdownPct:
      point.highWaterMark > 0
        ? ((point.equity - point.highWaterMark) / point.highWaterMark) * 100
        : 0,
  }));
}

/**
 * Calculate monthly returns matrix
 */
function buildMonthlyReturns(trades: Trade[]): Record<number, Record<number, number>> {
  const monthlyData: Record<string, number> = {};

  trades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    monthlyData[monthKey] = (monthlyData[monthKey] || 0) + trade.pl;
  });

  const monthlyReturns: Record<number, Record<number, number>> = {};
  const years = new Set<number>();

  trades.forEach((trade) => {
    years.add(new Date(trade.dateOpened).getFullYear());
  });

  Array.from(years)
    .sort()
    .forEach((year) => {
      monthlyReturns[year] = {};
      for (let month = 1; month <= 12; month++) {
        const monthKey = `${year}-${String(month).padStart(2, "0")}`;
        monthlyReturns[year][month] = monthlyData[monthKey] || 0;
      }
    });

  return monthlyReturns;
}

/**
 * Calculate return distribution histogram
 */
function buildReturnDistribution(
  trades: Trade[],
  bucketCount: number = 20,
): Array<{ rangeStart: number; rangeEnd: number; count: number }> {
  if (trades.length === 0) return [];

  const returns = trades.map((t) => t.pl);
  const minReturn = Math.min(...returns);
  const maxReturn = Math.max(...returns);
  const range = maxReturn - minReturn || 1;
  const bucketSize = range / bucketCount;

  const buckets: Array<{ rangeStart: number; rangeEnd: number; count: number }> = [];

  for (let i = 0; i < bucketCount; i++) {
    const rangeStart = minReturn + i * bucketSize;
    const rangeEnd = minReturn + (i + 1) * bucketSize;
    const count = returns.filter((r) => {
      if (i === bucketCount - 1) {
        return r >= rangeStart && r <= rangeEnd;
      }
      return r >= rangeStart && r < rangeEnd;
    }).length;
    buckets.push({ rangeStart, rangeEnd, count });
  }

  return buckets;
}

/**
 * Calculate day of week average P/L
 */
function buildDayOfWeekData(trades: Trade[]): Array<{
  day: string;
  count: number;
  avgPl: number;
  totalPl: number;
  avgPlPercent: number;
}> {
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dayData: Record<
    string,
    { count: number; totalPl: number; totalPlPercent: number; percentCount: number }
  > = {};

  trades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    const jsDay = date.getDay();
    const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
    const day = dayNames[pythonWeekday];

    if (!dayData[day]) {
      dayData[day] = { count: 0, totalPl: 0, totalPlPercent: 0, percentCount: 0 };
    }
    dayData[day].count++;
    dayData[day].totalPl += trade.pl;

    // Calculate ROM if margin available
    if (trade.marginReq && trade.marginReq > 0) {
      dayData[day].totalPlPercent += (trade.pl / trade.marginReq) * 100;
      dayData[day].percentCount++;
    }
  });

  return dayNames.map((day) => ({
    day,
    count: dayData[day]?.count || 0,
    avgPl: dayData[day]?.count > 0 ? dayData[day].totalPl / dayData[day].count : 0,
    totalPl: dayData[day]?.totalPl || 0,
    avgPlPercent:
      dayData[day]?.percentCount > 0 ? dayData[day].totalPlPercent / dayData[day].percentCount : 0,
  }));
}

/**
 * Calculate streak data with win/loss distribution and runs test
 */
function buildStreakData(trades: Trade[]): {
  winDistribution: Record<number, number>;
  lossDistribution: Record<number, number>;
  statistics: {
    maxWinStreak: number;
    maxLossStreak: number;
    avgWinStreak: number;
    avgLossStreak: number;
  };
  runsTest: {
    numRuns: number;
    expectedRuns: number;
    zScore: number;
    pValue: number;
    isNonRandom: boolean;
    patternType: "random" | "clustered" | "alternating";
  } | null;
} {
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
  );

  const winStreaks: number[] = [];
  const lossStreaks: number[] = [];
  let currentStreak = 0;
  let isWinStreak = false;

  sortedTrades.forEach((trade) => {
    const isWin = trade.pl > 0;

    if (currentStreak === 0) {
      currentStreak = 1;
      isWinStreak = isWin;
    } else if ((isWinStreak && isWin) || (!isWinStreak && !isWin)) {
      currentStreak++;
    } else {
      if (isWinStreak) {
        winStreaks.push(currentStreak);
      } else {
        lossStreaks.push(currentStreak);
      }
      currentStreak = 1;
      isWinStreak = isWin;
    }
  });

  if (currentStreak > 0) {
    if (isWinStreak) {
      winStreaks.push(currentStreak);
    } else {
      lossStreaks.push(currentStreak);
    }
  }

  const winDistribution: Record<number, number> = {};
  const lossDistribution: Record<number, number> = {};

  winStreaks.forEach((streak) => {
    winDistribution[streak] = (winDistribution[streak] || 0) + 1;
  });

  lossStreaks.forEach((streak) => {
    lossDistribution[streak] = (lossDistribution[streak] || 0) + 1;
  });

  // Calculate runs test
  const runsTest = calculateRunsTest(sortedTrades);

  return {
    winDistribution,
    lossDistribution,
    statistics: {
      maxWinStreak: Math.max(...winStreaks, 0),
      maxLossStreak: Math.max(...lossStreaks, 0),
      avgWinStreak:
        winStreaks.length > 0 ? winStreaks.reduce((a, b) => a + b) / winStreaks.length : 0,
      avgLossStreak:
        lossStreaks.length > 0 ? lossStreaks.reduce((a, b) => a + b) / lossStreaks.length : 0,
    },
    runsTest,
  };
}

/**
 * Calculate runs test for streakiness detection
 */
function calculateRunsTest(trades: Trade[]): {
  numRuns: number;
  expectedRuns: number;
  zScore: number;
  pValue: number;
  isNonRandom: boolean;
  patternType: "random" | "clustered" | "alternating";
} | null {
  if (trades.length < 20) return null;

  const outcomes = trades.map((t) => (t.pl > 0 ? 1 : 0));
  const n1 = outcomes.filter((o) => o === 1).length;
  const n0 = outcomes.filter((o) => o === 0).length;

  if (n1 === 0 || n0 === 0) return null;

  // Count runs
  let numRuns = 1;
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] !== outcomes[i - 1]) {
      numRuns++;
    }
  }

  const n = n1 + n0;
  const expectedRuns = (2 * n1 * n0) / n + 1;
  const variance = (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
  const stdDev = Math.sqrt(variance);

  const zScore = stdDev > 0 ? (numRuns - expectedRuns) / stdDev : 0;

  // Calculate two-tailed p-value using normal approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  const isNonRandom = pValue < 0.05;
  let patternType: "random" | "clustered" | "alternating" = "random";

  if (isNonRandom) {
    if (zScore < 0) {
      patternType = "clustered";
    } else {
      patternType = "alternating";
    }
  }

  return {
    numRuns,
    expectedRuns,
    zScore,
    pValue,
    isNonRandom,
    patternType,
  };
}

/**
 * Normal CDF approximation
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Build trade sequence data (P&L by trade number with ROM)
 */
function buildTradeSequence(trades: Trade[]): Array<{
  tradeNumber: number;
  pl: number;
  rom: number | null;
  date: string;
  marginReq: number | null;
  strategy: string;
}> {
  return trades.map((trade, index) => {
    const marginReq =
      typeof trade.marginReq === "number" && isFinite(trade.marginReq) ? trade.marginReq : null;
    return {
      tradeNumber: index + 1,
      pl: trade.pl,
      rom: marginReq && marginReq > 0 ? (trade.pl / marginReq) * 100 : null,
      date: formatDateKey(new Date(trade.dateOpened)),
      marginReq,
      strategy: trade.strategy || "Unknown",
    };
  });
}

/**
 * Build ROM timeline (Return on Margin over time)
 */
function buildRomTimeline(
  trades: Trade[],
): Array<{ date: string; rom: number; tradeNumber: number }> {
  return trades
    .map((trade, index) => {
      if (!trade.marginReq || trade.marginReq <= 0) return null;
      return {
        date: formatDateKey(new Date(trade.dateOpened)),
        rom: (trade.pl / trade.marginReq) * 100,
        tradeNumber: index + 1,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

/**
 * Build rolling metrics (30-trade rolling window)
 * Note: Uses fixed 2.0% risk-free rate for Sharpe as a simplification for visualization.
 * The accurate date-based Sharpe is computed by portfolio-stats.ts for actual statistics.
 */
function buildRollingMetrics(
  trades: Trade[],
  windowSize: number = 30,
): Array<{
  date: string;
  tradeNumber: number;
  winRate: number;
  sharpeRatio: number;
  profitFactor: number;
  volatility: number;
  avgPl: number;
}> {
  if (trades.length < windowSize) return [];

  const metrics: Array<{
    date: string;
    tradeNumber: number;
    winRate: number;
    sharpeRatio: number;
    profitFactor: number;
    volatility: number;
    avgPl: number;
  }> = [];

  const plValues = trades.map((t) => t.pl);

  // Initialize window state
  let windowSum = 0;
  let windowWins = 0;
  let windowPositiveSum = 0;
  let windowNegativeSum = 0;

  // Initialize first window
  for (let i = 0; i < windowSize; i++) {
    const pl = plValues[i];
    windowSum += pl;
    if (pl > 0) {
      windowWins++;
      windowPositiveSum += pl;
    } else if (pl < 0) {
      windowNegativeSum += Math.abs(pl);
    }
  }

  // Process each position using sliding window
  for (let i = windowSize - 1; i < trades.length; i++) {
    const winRate = (windowWins / windowSize) * 100;
    const avgReturn = windowSum / windowSize;

    // Calculate variance
    let varianceSum = 0;
    for (let j = i - windowSize + 1; j <= i; j++) {
      varianceSum += Math.pow(plValues[j] - avgReturn, 2);
    }
    const volatility = Math.sqrt(varianceSum / windowSize);

    const profitFactor =
      windowNegativeSum > 0
        ? windowPositiveSum / windowNegativeSum
        : windowPositiveSum > 0
          ? 999
          : 0;

    // Sharpe uses fixed 2.0% risk-free rate approximation for visualization
    // The accurate date-based rate is used in portfolio-stats.ts calculations
    const dailyRfr = 2.0 / 100 / 252;
    const excessReturn = avgReturn - dailyRfr;
    const sharpeRatio = volatility > 0 ? excessReturn / volatility : 0;

    metrics.push({
      date: formatDateKey(new Date(trades[i].dateOpened)),
      tradeNumber: i + 1,
      winRate,
      sharpeRatio,
      profitFactor,
      volatility,
      avgPl: avgReturn,
    });

    // Slide window
    if (i < trades.length - 1) {
      const oldPl = plValues[i - windowSize + 1];
      const newPl = plValues[i + 1];

      windowSum -= oldPl;
      if (oldPl > 0) {
        windowWins--;
        windowPositiveSum -= oldPl;
      } else if (oldPl < 0) {
        windowNegativeSum -= Math.abs(oldPl);
      }

      windowSum += newPl;
      if (newPl > 0) {
        windowWins++;
        windowPositiveSum += newPl;
      } else if (newPl < 0) {
        windowNegativeSum += Math.abs(newPl);
      }
    }
  }

  return metrics;
}

/**
 * Build exit reason breakdown
 */
function buildExitReasonBreakdown(trades: Trade[]): Array<{
  reason: string;
  count: number;
  avgPl: number;
  totalPl: number;
  avgRom: number | null;
}> {
  const summaryMap = new Map<
    string,
    { count: number; totalPl: number; totalRom: number; romCount: number }
  >();

  trades.forEach((trade) => {
    const reason =
      trade.reasonForClose && trade.reasonForClose.trim() ? trade.reasonForClose.trim() : "Unknown";
    const current = summaryMap.get(reason) || {
      count: 0,
      totalPl: 0,
      totalRom: 0,
      romCount: 0,
    };
    current.count += 1;
    current.totalPl += trade.pl;

    if (trade.marginReq && trade.marginReq > 0) {
      current.totalRom += (trade.pl / trade.marginReq) * 100;
      current.romCount++;
    }

    summaryMap.set(reason, current);
  });

  return Array.from(summaryMap.entries())
    .map(([reason, { count, totalPl, totalRom, romCount }]) => ({
      reason,
      count,
      totalPl,
      avgPl: count > 0 ? totalPl / count : 0,
      avgRom: romCount > 0 ? totalRom / romCount : null,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build holding periods data
 */
function buildHoldingPeriods(trades: Trade[]): Array<{
  tradeNumber: number;
  dateOpened: string;
  dateClosed: string | null;
  durationHours: number;
  durationDays: number;
  pl: number;
  strategy: string;
}> {
  return trades.map((trade, index) => {
    const openDate = new Date(trade.dateOpened);
    const closeDate = trade.dateClosed ? new Date(trade.dateClosed) : null;

    let durationHours = 0;
    if (closeDate && !isNaN(closeDate.getTime())) {
      durationHours = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60);
    }

    return {
      tradeNumber: index + 1,
      dateOpened: formatDateKey(openDate),
      dateClosed: closeDate ? formatDateKey(closeDate) : null,
      durationHours,
      durationDays: durationHours / 24,
      pl: trade.pl,
      strategy: trade.strategy || "Unknown",
    };
  });
}

/**
 * Build premium efficiency data
 */
function buildPremiumEfficiency(trades: Trade[]): Array<{
  tradeNumber: number;
  date: string;
  pl: number;
  premium: number | null;
  efficiencyPct: number | null;
  strategy: string;
}> {
  return trades.map((trade, index) => {
    const premium =
      typeof trade.premium === "number" && isFinite(trade.premium) ? trade.premium : null;
    let efficiencyPct: number | null = null;
    if (premium !== null && premium !== 0) {
      efficiencyPct = (trade.pl / Math.abs(premium)) * 100;
    }

    return {
      tradeNumber: index + 1,
      date: formatDateKey(new Date(trade.dateOpened)),
      pl: trade.pl,
      premium,
      efficiencyPct,
      strategy: trade.strategy || "Unknown",
    };
  });
}

/**
 * Build margin utilization data
 *
 * Note: When filtering by strategy, uses the rebuilt equity curve for fundsAtClose
 * values to provide accurate context. The original trade.fundsAtClose includes P&L
 * from all strategies, which would be misleading when viewing a single strategy.
 *
 * The equity curve is indexed by tradeNumber (0 = initial, 1 = after trade 1, etc.)
 * We use the equity AFTER the trade (i.e., at trade's close) for the fundsAtClose value.
 */
function buildMarginUtilization(
  trades: Trade[],
  equityCurve?: Array<{ date: string; equity: number; tradeNumber: number }>,
): Array<{
  tradeNumber: number;
  date: string;
  marginReq: number;
  fundsAtClose: number;
  utilizationPct: number | null;
  numContracts: number;
  pl: number;
}> {
  // Build equity lookup by trade number if curve provided
  // This is more reliable than date-based lookup since equity curve points are
  // keyed by close date and may have offset timestamps for uniqueness
  const equityByTradeNumber = new Map<number, number>();
  if (equityCurve) {
    for (const point of equityCurve) {
      equityByTradeNumber.set(point.tradeNumber, point.equity);
    }
  }

  return trades
    .map((trade, index) => {
      const marginReq =
        typeof trade.marginReq === "number" && isFinite(trade.marginReq) ? trade.marginReq : 0;
      const numContracts =
        typeof trade.numContracts === "number" && isFinite(trade.numContracts)
          ? trade.numContracts
          : 0;

      // Use equity curve value if available, otherwise fall back to trade's fundsAtClose
      // The equity after this trade = equityCurve[tradeNumber] where tradeNumber = index + 1
      let fundsAtClose: number;
      if (equityCurve && equityCurve.length > 0) {
        const tradeNumber = index + 1;
        const equityValue = equityByTradeNumber.get(tradeNumber);
        fundsAtClose =
          equityValue ??
          (typeof trade.fundsAtClose === "number" && isFinite(trade.fundsAtClose)
            ? trade.fundsAtClose
            : 0);
      } else {
        fundsAtClose =
          typeof trade.fundsAtClose === "number" && isFinite(trade.fundsAtClose)
            ? trade.fundsAtClose
            : 0;
      }

      if (marginReq === 0 && fundsAtClose === 0) return null;

      return {
        tradeNumber: index + 1,
        date: formatDateKey(new Date(trade.dateOpened)),
        marginReq,
        fundsAtClose,
        utilizationPct: fundsAtClose > 0 ? (marginReq / fundsAtClose) * 100 : null,
        numContracts,
        pl: trade.pl,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

/**
 * Build volatility regimes data (VIX-correlated)
 */
function buildVolatilityRegimes(trades: Trade[]): Array<{
  tradeNumber: number;
  date: string;
  openingVix: number | null;
  closingVix: number | null;
  pl: number;
  rom: number | null;
}> {
  return trades
    .map((trade, index) => {
      const openingVix =
        typeof trade.openingVix === "number" && isFinite(trade.openingVix)
          ? trade.openingVix
          : null;
      const closingVix =
        typeof trade.closingVix === "number" && isFinite(trade.closingVix)
          ? trade.closingVix
          : null;

      if (openingVix === null && closingVix === null) return null;

      return {
        tradeNumber: index + 1,
        date: formatDateKey(new Date(trade.dateOpened)),
        openingVix,
        closingVix,
        pl: trade.pl,
        rom: trade.marginReq && trade.marginReq > 0 ? (trade.pl / trade.marginReq) * 100 : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

/**
 * Build monthly returns percent (percentage-based)
 * Note: Uses trade-based calculation (initial capital derived from first trade)
 */
function buildMonthlyReturnsPercent(trades: Trade[]): Record<number, Record<number, number>> {
  if (trades.length === 0) return {};

  // Sort trades by date
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
  );

  // Calculate initial capital from first trade
  const firstTrade = sortedTrades[0];
  let runningCapital = firstTrade.fundsAtClose - firstTrade.pl;
  if (!isFinite(runningCapital) || runningCapital <= 0) {
    runningCapital = 100000;
  }

  // Group trades by month
  const monthlyData: Record<string, { pl: number; startingCapital: number }> = {};
  const years = new Set<number>();

  sortedTrades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;

    years.add(year);

    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = {
        pl: 0,
        startingCapital: runningCapital,
      };
    }

    monthlyData[monthKey].pl += trade.pl;
  });

  // Calculate percentage returns
  const monthlyReturnsPercent: Record<number, Record<number, number>> = {};
  const sortedMonthKeys = Object.keys(monthlyData).sort();

  sortedMonthKeys.forEach((monthKey) => {
    const [yearStr, monthStr] = monthKey.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    if (!monthlyReturnsPercent[year]) {
      monthlyReturnsPercent[year] = {};
    }

    const { pl, startingCapital } = monthlyData[monthKey];

    if (startingCapital > 0) {
      monthlyReturnsPercent[year][month] = (pl / startingCapital) * 100;
    } else {
      monthlyReturnsPercent[year][month] = 0;
    }

    // Update capital for next month (compounding)
    runningCapital = startingCapital + pl;

    const currentMonthIndex = sortedMonthKeys.indexOf(monthKey);
    if (currentMonthIndex < sortedMonthKeys.length - 1) {
      const nextMonthKey = sortedMonthKeys[currentMonthIndex + 1];
      if (monthlyData[nextMonthKey]) {
        monthlyData[nextMonthKey].startingCapital = runningCapital;
      }
    }
  });

  // Fill in zeros for months without data
  Array.from(years)
    .sort()
    .forEach((year) => {
      if (!monthlyReturnsPercent[year]) {
        monthlyReturnsPercent[year] = {};
      }
      for (let month = 1; month <= 12; month++) {
        if (monthlyReturnsPercent[year][month] === undefined) {
          monthlyReturnsPercent[year][month] = 0;
        }
      }
    });

  return monthlyReturnsPercent;
}

/**
 * Apply date range filter to trades
 */
function filterByDateRange(trades: Trade[], fromDate?: string, toDate?: string): Trade[] {
  if (!fromDate && !toDate) return trades;

  return trades.filter((trade) => {
    const tradeDate = formatDateKey(new Date(trade.dateOpened));
    if (fromDate && tradeDate < fromDate) return false;
    if (toDate && tradeDate > toDate) return false;
    return true;
  });
}

// Note: normalizeTradesToOneLot was removed and replaced with shared utility
// from @lib/utils/equity-curve that correctly rebuilds the equity curve.
// The old implementation had a bug: it scaled fundsAtClose directly instead
// of recalculating based on cumulative scaled P&L.

/**
 * Daily exposure data point
 */
interface DailyExposurePoint {
  date: string;
  exposure: number;
  exposurePercent: number;
  openPositions: number;
}

/**
 * Peak exposure data
 */
interface PeakExposure {
  date: string;
  exposure: number;
  exposurePercent: number;
}

/**
 * Wrapper around the shared daily exposure calculation.
 * Maps the result to the local interface format (date as string vs ISO string).
 */
function buildDailyExposure(
  trades: Trade[],
  equityCurve: Array<{ date: string; equity: number }>,
): {
  dailyExposure: DailyExposurePoint[];
  peakDailyExposure: PeakExposure | null;
  peakDailyExposurePercent: PeakExposure | null;
} {
  // Use the shared calculation from lib/calculations/daily-exposure.ts
  const result = calculateDailyExposureShared(trades, equityCurve);

  // Map the result to local format (convert ISO dates to YYYY-MM-DD format)
  return {
    dailyExposure: result.dailyExposure.map((d) => ({
      ...d,
      date: formatDateKey(new Date(d.date)),
    })),
    peakDailyExposure: result.peakDailyExposure
      ? {
          ...result.peakDailyExposure,
          date: formatDateKey(new Date(result.peakDailyExposure.date)),
        }
      : null,
    peakDailyExposurePercent: result.peakDailyExposurePercent
      ? {
          ...result.peakDailyExposurePercent,
          date: formatDateKey(new Date(result.peakDailyExposurePercent.date)),
        }
      : null,
  };
}

/**
 * Register all performance MCP tools
 */
export function registerPerformanceTools(server: McpServer, baseDir: string): void {
  // Tool 1: get_performance_charts
  server.registerTool(
    "get_performance_charts",
    {
      description:
        "Get chart data for performance visualizations: equity curves, drawdowns, return distributions, rolling metrics, and trade patterns. Use blockId from list_blocks.",
      inputSchema: z.object({
        blockId: z.string().describe("Block ID from list_blocks (e.g., 'main-port')"),
        strategy: z.string().optional().describe("Filter by strategy name (case-insensitive)"),
        charts: z
          .array(
            z.enum([
              "equity_curve",
              "drawdown",
              "monthly_returns",
              "monthly_returns_percent",
              "return_distribution",
              "day_of_week",
              "streak_data",
              "trade_sequence",
              "rom_timeline",
              "rolling_metrics",
              "exit_reason_breakdown",
              "holding_periods",
              "premium_efficiency",
              "margin_utilization",
              "volatility_regimes",
              "mfe_mae",
              "daily_exposure",
            ]),
          )
          .default(["equity_curve", "drawdown", "monthly_returns"])
          .describe(
            "Which charts to include. Options: equity_curve, drawdown, monthly_returns, monthly_returns_percent, return_distribution, day_of_week, streak_data (win/loss streaks + runs test), trade_sequence (P&L by trade #), rom_timeline (Return on Margin over time), rolling_metrics (30-trade rolling sharpe/win rate), exit_reason_breakdown, holding_periods, premium_efficiency, margin_utilization, volatility_regimes (VIX-correlated), mfe_mae (Maximum Favorable/Adverse Excursion for stop loss/take profit optimization), daily_exposure (daily margin exposure with peak tracking)",
          ),
        dateRange: z
          .object({
            from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
            to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
          })
          .optional()
          .describe("Filter trades to date range"),
        normalizeTo1Lot: z
          .boolean()
          .default(false)
          .describe(
            "Normalize all trades to 1 contract for fair comparison across different position sizes",
          ),
        bucketCount: z
          .number()
          .min(5)
          .max(100)
          .default(20)
          .describe("Number of histogram buckets for return_distribution (default: 20)"),
        rollingWindowSize: z
          .number()
          .min(10)
          .max(100)
          .default(30)
          .describe("Window size for rolling_metrics calculation (default: 30 trades)"),
        mfeMaeBucketSize: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Bucket size (in %) for MFE/MAE distribution histogram (default: 10%)"),
        maxDataPoints: z
          .number()
          .min(50)
          .max(10000)
          .default(500)
          .describe(
            "Maximum data points for per-trade chart types (volatility_regimes, mfe_mae, trade_sequence, holding_periods, premium_efficiency, margin_utilization, rom_timeline). When exceeded, data is truncated with a flag. Default: 500.",
          ),
      }),
    },
    async ({
      blockId,
      strategy,
      charts,
      dateRange,
      normalizeTo1Lot,
      bucketCount,
      rollingWindowSize,
      mfeMaeBucketSize,
      maxDataPoints,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter
        trades = filterByStrategy(trades, strategy);

        // Apply date range filter
        if (dateRange) {
          trades = filterByDateRange(trades, dateRange.from, dateRange.to);
        }

        // Apply normalization if requested
        // Uses shared utility that properly rebuilds equity curve after normalizing P&L
        if (normalizeTo1Lot) {
          trades = normalizeToOneLot(trades);
        }

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: strategy
                  ? `No trades found for strategy "${strategy}" in this block.`
                  : "No trades found in this block.",
              },
            ],
            isError: true,
          };
        }

        // Build requested chart data
        const chartData: Record<string, unknown> = {};
        let dataPoints = 0;
        let anyTruncated = false;

        // Helper to truncate per-trade arrays when they exceed maxDataPoints
        function truncateArray<T>(
          arr: T[],
        ): T[] | { data: T[]; truncated: true; totalPoints: number } {
          if (arr.length <= maxDataPoints) return arr;
          anyTruncated = true;
          return {
            data: arr.slice(0, maxDataPoints),
            truncated: true as const,
            totalPoints: arr.length,
          };
        }

        // Helper to count actual output length from possibly-truncated data
        function outputLength<T>(
          result: T[] | { data: T[]; truncated: true; totalPoints: number },
        ): number {
          return Array.isArray(result) ? result.length : result.data.length;
        }

        if (charts.includes("equity_curve")) {
          chartData.equityCurve = buildEquityCurve(trades);
          dataPoints += (chartData.equityCurve as unknown[]).length;
        }

        if (charts.includes("drawdown")) {
          const equityCurve =
            (chartData.equityCurve as Array<{
              date: string;
              equity: number;
              highWaterMark: number;
            }>) || buildEquityCurve(trades);
          chartData.drawdown = buildDrawdownSeries(equityCurve);
          dataPoints += (chartData.drawdown as unknown[]).length;
        }

        if (charts.includes("monthly_returns")) {
          chartData.monthlyReturns = buildMonthlyReturns(trades);
          const mr = chartData.monthlyReturns as Record<number, Record<number, number>>;
          for (const year of Object.keys(mr)) {
            for (const month of Object.keys(mr[Number(year)])) {
              if (mr[Number(year)][Number(month)] !== 0) dataPoints++;
            }
          }
        }

        if (charts.includes("monthly_returns_percent")) {
          chartData.monthlyReturnsPercent = buildMonthlyReturnsPercent(trades);
          const mrp = chartData.monthlyReturnsPercent as Record<number, Record<number, number>>;
          for (const year of Object.keys(mrp)) {
            for (const month of Object.keys(mrp[Number(year)])) {
              if (mrp[Number(year)][Number(month)] !== 0) dataPoints++;
            }
          }
        }

        if (charts.includes("return_distribution")) {
          chartData.returnDistribution = buildReturnDistribution(trades, bucketCount);
          dataPoints += (chartData.returnDistribution as unknown[]).length;
        }

        if (charts.includes("day_of_week")) {
          chartData.dayOfWeek = buildDayOfWeekData(trades);
          dataPoints += (chartData.dayOfWeek as unknown[]).length;
        }

        if (charts.includes("streak_data")) {
          chartData.streakData = buildStreakData(trades);
          // Count streak distribution entries
          const sd = chartData.streakData as {
            winDistribution: Record<number, number>;
            lossDistribution: Record<number, number>;
          };
          dataPoints += Object.keys(sd.winDistribution).length;
          dataPoints += Object.keys(sd.lossDistribution).length;
        }

        if (charts.includes("trade_sequence")) {
          const result = truncateArray(buildTradeSequence(trades));
          chartData.tradeSequence = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("rom_timeline")) {
          const result = truncateArray(buildRomTimeline(trades));
          chartData.romTimeline = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("rolling_metrics")) {
          chartData.rollingMetrics = buildRollingMetrics(trades, rollingWindowSize);
          dataPoints += (chartData.rollingMetrics as unknown[]).length;
        }

        if (charts.includes("exit_reason_breakdown")) {
          chartData.exitReasonBreakdown = buildExitReasonBreakdown(trades);
          dataPoints += (chartData.exitReasonBreakdown as unknown[]).length;
        }

        if (charts.includes("holding_periods")) {
          const result = truncateArray(buildHoldingPeriods(trades));
          chartData.holdingPeriods = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("premium_efficiency")) {
          const result = truncateArray(buildPremiumEfficiency(trades));
          chartData.premiumEfficiency = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("margin_utilization")) {
          // Pass equity curve to use rebuilt equity for fundsAtClose when filtering
          // Equity curve includes tradeNumber for accurate lookup by trade index
          const equityCurve =
            (chartData.equityCurve as Array<{
              date: string;
              equity: number;
              tradeNumber: number;
            }>) || buildEquityCurve(trades);
          const result = truncateArray(buildMarginUtilization(trades, equityCurve));
          chartData.marginUtilization = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("volatility_regimes")) {
          const result = truncateArray(buildVolatilityRegimes(trades));
          chartData.volatilityRegimes = result;
          dataPoints += outputLength(result);
        }

        if (charts.includes("mfe_mae")) {
          // Use the original (non-normalized) trades for MFE/MAE since it uses
          // internal trade fields (maxProfit, maxLoss) that aren't normalized
          const mfeData = calculateMFEMAEData(block.trades);
          const distribution = createExcursionDistribution(mfeData, mfeMaeBucketSize);

          // Calculate aggregate statistics
          const dataWithMfe = mfeData.filter((d) => d.mfe > 0);
          const dataWithMae = mfeData.filter((d) => d.mae > 0);

          const avgMfePercent =
            dataWithMfe.length > 0
              ? dataWithMfe.reduce((sum, d) => sum + (d.mfePercent || 0), 0) / dataWithMfe.length
              : 0;
          const avgMaePercent =
            dataWithMae.length > 0
              ? dataWithMae.reduce((sum, d) => sum + (d.maePercent || 0), 0) / dataWithMae.length
              : 0;
          const avgProfitCapture =
            mfeData.filter((d) => d.profitCapturePercent !== undefined).length > 0
              ? mfeData
                  .filter((d) => d.profitCapturePercent !== undefined)
                  .reduce((sum, d) => sum + d.profitCapturePercent!, 0) /
                mfeData.filter((d) => d.profitCapturePercent !== undefined).length
              : 0;
          const avgExcursionRatio =
            mfeData.filter((d) => d.excursionRatio !== undefined).length > 0
              ? mfeData
                  .filter((d) => d.excursionRatio !== undefined)
                  .reduce((sum, d) => sum + d.excursionRatio!, 0) /
                mfeData.filter((d) => d.excursionRatio !== undefined).length
              : 0;

          // Simplify data points for JSON output (exclude verbose trade details)
          const simplifiedData = mfeData.map((d) => ({
            tradeNumber: d.tradeNumber,
            date: formatDateKey(d.date),
            strategy: d.strategy,
            mfe: d.mfe,
            mae: d.mae,
            pl: d.pl,
            mfePercent: d.mfePercent,
            maePercent: d.maePercent,
            profitCapturePercent: d.profitCapturePercent,
            excursionRatio: d.excursionRatio,
            basis: d.basis,
            isWinner: d.isWinner,
          }));

          // Truncate dataPoints array if needed
          let mfeDataPointsOutput: unknown;
          let mfeOutputCount: number;
          if (simplifiedData.length > maxDataPoints) {
            anyTruncated = true;
            mfeDataPointsOutput = {
              data: simplifiedData.slice(0, maxDataPoints),
              truncated: true,
              totalPoints: simplifiedData.length,
            };
            mfeOutputCount = maxDataPoints;
          } else {
            mfeDataPointsOutput = simplifiedData;
            mfeOutputCount = simplifiedData.length;
          }

          chartData.mfeMae = {
            dataPoints: mfeDataPointsOutput,
            distribution,
            statistics: {
              totalTrades: mfeData.length,
              tradesWithMfe: dataWithMfe.length,
              tradesWithMae: dataWithMae.length,
              avgMfePercent,
              avgMaePercent,
              avgProfitCapture,
              avgExcursionRatio,
            },
          };
          dataPoints += mfeOutputCount + distribution.length;
        }

        if (charts.includes("daily_exposure")) {
          // Need equity curve for percentage calculations
          const equityCurve =
            (chartData.equityCurve as Array<{
              date: string;
              equity: number;
              highWaterMark: number;
            }>) || buildEquityCurve(trades);

          const exposureData = buildDailyExposure(trades, equityCurve);

          // When filtering by strategy, percentage values may be misleading because
          // margin values are absolute (sized for full portfolio) but divided by
          // the filtered equity curve
          const isStrategyFiltered = !!strategy;

          chartData.dailyExposure = {
            timeSeries: exposureData.dailyExposure,
            peakByDollars: exposureData.peakDailyExposure,
            peakByPercent: exposureData.peakDailyExposurePercent,
            statistics: {
              totalDays: exposureData.dailyExposure.length,
              avgExposure:
                exposureData.dailyExposure.length > 0
                  ? exposureData.dailyExposure.reduce((sum, d) => sum + d.exposure, 0) /
                    exposureData.dailyExposure.length
                  : 0,
              avgExposurePercent:
                exposureData.dailyExposure.length > 0
                  ? exposureData.dailyExposure.reduce((sum, d) => sum + d.exposurePercent, 0) /
                    exposureData.dailyExposure.length
                  : 0,
              avgOpenPositions:
                exposureData.dailyExposure.length > 0
                  ? exposureData.dailyExposure.reduce((sum, d) => sum + d.openPositions, 0) /
                    exposureData.dailyExposure.length
                  : 0,
            },
            ...(isStrategyFiltered && {
              warning:
                "Percentage values may be misleading when filtering by strategy. " +
                "Margin values are absolute (sized for the full portfolio), but the equity " +
                "curve is rebuilt for the filtered subset only. Use dollar exposure values " +
                "for accurate analysis when filtering.",
            }),
          };
          dataPoints += exposureData.dailyExposure.length;
        }

        // Brief summary for user display
        const filters: string[] = [];
        if (strategy) filters.push(`strategy=${strategy}`);
        if (dateRange?.from || dateRange?.to) {
          filters.push(`date=${dateRange.from ?? "start"} to ${dateRange.to ?? "end"}`);
        }
        if (normalizeTo1Lot) filters.push("normalized");

        const filterStr = filters.length > 0 ? ` (${filters.join(", ")})` : "";
        const summary = `Performance: ${blockId}${filterStr} | ${charts.length} charts | ${trades.length} trades | ${dataPoints} data points`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          dateRange: dateRange ?? null,
          normalizeTo1Lot,
          bucketCount,
          rollingWindowSize,
          mfeMaeBucketSize,
          maxDataPoints,
          tradesAnalyzed: trades.length,
          chartsIncluded: charts,
          truncationApplied: anyTruncated,
          ...chartData,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting performance charts: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 2: get_period_returns
  server.registerTool(
    "get_period_returns",
    {
      description:
        "Get P&L breakdown by period (monthly, weekly, or daily) with gross P/L, commissions, and net P/L",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z.string().optional().describe("Filter by strategy name (case-insensitive)"),
        period: z
          .enum(["monthly", "weekly", "daily"])
          .default("monthly")
          .describe("Time period for grouping (default: monthly)"),
        year: z
          .number()
          .optional()
          .describe("Filter to specific year (optional, alternative to dateRange)"),
        dateRange: z
          .object({
            from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
            to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
          })
          .optional()
          .describe("Filter trades to date range (takes precedence over year)"),
        normalizeTo1Lot: z
          .boolean()
          .default(false)
          .describe("Normalize all trades to 1 contract for fair comparison"),
      }),
    },
    async ({ blockId, strategy, period, year, dateRange, normalizeTo1Lot }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter
        trades = filterByStrategy(trades, strategy);

        // Apply date range filter (takes precedence over year)
        if (dateRange) {
          trades = filterByDateRange(trades, dateRange.from, dateRange.to);
        } else if (year !== undefined) {
          trades = trades.filter((t) => new Date(t.dateOpened).getFullYear() === year);
        }

        // Apply normalization if requested
        // Uses shared utility that properly rebuilds equity curve after normalizing P&L
        if (normalizeTo1Lot) {
          trades = normalizeToOneLot(trades);
        }

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  strategy || year || dateRange
                    ? `No trades found matching filters (strategy: ${strategy ?? "all"}, year: ${year ?? "all"}, dateRange: ${dateRange ? `${dateRange.from ?? "start"} to ${dateRange.to ?? "end"}` : "all"}).`
                    : "No trades found in this block.",
              },
            ],
            isError: true,
          };
        }

        // Group trades by period
        const periodData: Map<
          string,
          {
            grossPl: number;
            commissions: number;
            netPl: number;
            tradeCount: number;
          }
        > = new Map();

        trades.forEach((trade) => {
          const date = new Date(trade.dateOpened);
          let periodKey: string;

          if (period === "monthly") {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, "0");
            periodKey = `${y}-${m}`;
          } else if (period === "weekly") {
            const y = date.getFullYear();
            const w = String(getISOWeekNumber(date)).padStart(2, "0");
            periodKey = `${y}-W${w}`;
          } else {
            // daily
            periodKey = formatDateKey(date);
          }

          const existing = periodData.get(periodKey) || {
            grossPl: 0,
            commissions: 0,
            netPl: 0,
            tradeCount: 0,
          };

          const totalCommissions =
            (trade.openingCommissionsFees ?? 0) + (trade.closingCommissionsFees ?? 0);

          existing.grossPl += trade.pl;
          existing.commissions += totalCommissions;
          existing.netPl += trade.pl - totalCommissions;
          existing.tradeCount += 1;
          periodData.set(periodKey, existing);
        });

        // Convert to sorted array
        const periods = Array.from(periodData.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([periodKey, data]) => ({
            period: periodKey,
            ...data,
          }));

        // Calculate totals
        const totals = {
          grossPl: periods.reduce((sum, p) => sum + p.grossPl, 0),
          commissions: periods.reduce((sum, p) => sum + p.commissions, 0),
          netPl: periods.reduce((sum, p) => sum + p.netPl, 0),
          tradeCount: periods.reduce((sum, p) => sum + p.tradeCount, 0),
        };

        // Brief summary for user display
        const filters: string[] = [];
        if (strategy) filters.push(`strategy=${strategy}`);
        if (dateRange?.from || dateRange?.to) {
          filters.push(`date=${dateRange.from ?? "start"} to ${dateRange.to ?? "end"}`);
        } else if (year !== undefined) {
          filters.push(`year=${year}`);
        }
        if (normalizeTo1Lot) filters.push("normalized");

        const filterStr = filters.length > 0 ? ` (${filters.join(", ")})` : "";
        const summary = `Period Returns: ${blockId}${filterStr} | ${period} | ${periods.length} periods | Net P/L: ${formatCurrency(totals.netPl)}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          periodType: period,
          yearFilter: year ?? null,
          dateRange: dateRange ?? null,
          normalizeTo1Lot,
          tradesAnalyzed: trades.length,
          periodCount: periods.length,
          periods,
          totals,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting period returns: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 3: compare_backtest_to_actual
  server.registerTool(
    "compare_backtest_to_actual",
    {
      description:
        "Compare backtest (tradelog.csv) results to actual reported trades (reportinglog.csv) with scaling options for fair comparison. Matches trades by date and strategy. When no dateRange is specified, comparison is auto-limited to the reporting log's date range overlap. By default, output includes matched and unmatched comparisons; set matchedOnly=true to include only matched rows. Supports trade-level detail, outlier detection, and flexible grouping. Limitation: Trade-level matching uses minute precision; if multiple trades share the same date+strategy+minute, matching is order-dependent.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe(
            "Filter to specific strategy name (matches both backtest and actual by strategy)",
          ),
        scaling: z
          .enum(["raw", "perContract", "toReported"])
          .default("raw")
          .describe(
            "Scaling mode: 'raw' (no scaling), 'perContract' (divide by contracts for per-lot comparison), 'toReported' (scale backtest DOWN to match actual contract count)",
          ),
        dateRange: z
          .object({
            from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
            to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
          })
          .optional()
          .describe("Filter trades to date range"),
        matchedOnly: z
          .boolean()
          .default(false)
          .describe(
            "Only include trades where both backtest and actual exist on the same date (excludes unmatched rows from output and totals)",
          ),
        detailLevel: z
          .enum(["summary", "trades"])
          .default("summary")
          .describe(
            "'summary' (default): aggregate by date+strategy. 'trades': individual trade comparison with field-by-field differences",
          ),
        outliersOnly: z
          .boolean()
          .default(false)
          .describe("Only return high-slippage outliers (trades exceeding z-score threshold)"),
        outliersThreshold: z
          .number()
          .default(2)
          .describe("Z-score threshold for outlier detection (default: 2 = ~95% confidence)"),
        groupBy: z
          .enum(["none", "strategy", "date", "week", "month"])
          .default("none")
          .describe(
            "Group results: 'none' (flat list), 'strategy', 'date' (daily), 'week', 'month'",
          ),
      }),
    },
    async ({
      blockId,
      strategy,
      scaling,
      dateRange,
      matchedOnly,
      detailLevel,
      outliersOnly,
      outliersThreshold,
      groupBy,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let backtestTrades = block.trades;

        // Load reporting log (actual trades)
        let actualTrades: ReportingTrade[];
        try {
          actualTrades = await loadReportingLog(baseDir, blockId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `No reportinglog.csv found in block "${blockId}". This tool requires both tradelog.csv (backtest) and reportinglog.csv (actual) to compare.`,
              },
            ],
            isError: true,
          };
        }

        // Apply strategy filter to both
        backtestTrades = applyStrategyFilter(backtestTrades, strategy);
        actualTrades = applyStrategyFilter(actualTrades, strategy);

        // Apply date range filter to both
        backtestTrades = applyDateRangeFilter(backtestTrades, dateRange);
        actualTrades = applyDateRangeFilter(actualTrades, dateRange);

        if (backtestTrades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No backtest trades found in tradelog.csv matching filters.",
              },
            ],
            isError: true,
          };
        }

        if (actualTrades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No actual trades found in reportinglog.csv matching filters.",
              },
            ],
            isError: true,
          };
        }

        // Auto-filter backtest trades to reporting log date range overlap
        // when no explicit dateRange is provided
        let autoFilterApplied = false;
        if (!dateRange) {
          const actualDates = actualTrades.map((t) => formatDateKey(new Date(t.dateOpened)));
          if (actualDates.length > 0) {
            const minActualDate = actualDates.reduce((a, b) => (a < b ? a : b));
            const maxActualDate = actualDates.reduce((a, b) => (a > b ? a : b));
            const beforeCount = backtestTrades.length;
            backtestTrades = backtestTrades.filter((t) => {
              const d = formatDateKey(new Date(t.dateOpened));
              return d >= minActualDate && d <= maxActualDate;
            });
            autoFilterApplied = backtestTrades.length < beforeCount;
          }
        }

        // Helper to get group key based on groupBy parameter
        const getGroupKey = (
          dateStr: string,
          strategyName: string,
          groupByMode: typeof groupBy,
        ): string => {
          if (groupByMode === "strategy") {
            return strategyName;
          }
          if (groupByMode === "date") {
            return dateStr;
          }
          // Parse date for week/month grouping
          const date = new Date(dateStr + "T00:00:00");
          const year = date.getFullYear();
          if (groupByMode === "week") {
            const weekNum = getISOWeekNumber(date);
            return `${year}-W${weekNum.toString().padStart(2, "0")}`;
          }
          if (groupByMode === "month") {
            const month = date.getMonth() + 1;
            return `${year}-${month.toString().padStart(2, "0")}`;
          }
          return "all"; // groupBy === "none"
        };

        // Detailed comparison interface for trade-level matching
        interface DetailedComparison {
          date: string;
          strategy: string;
          timeOpened: string;
          matched: boolean;
          backtestPl: number;
          actualPl: number;
          scaledBacktestPl: number;
          slippage: number;
          slippagePercent: number | null;
          backtestContracts: number;
          actualContracts: number;
          scalingFactor: number;
          backtestLegs: string | null;
          actualLegs: string | null;
          differences: Array<{
            field: string;
            backtest: number | string | null;
            actual: number | string | null;
            delta?: number;
          }>;
          isOutlier: boolean;
          outlierSeverity?: "low" | "medium" | "high";
          zScore?: number;
          context?: {
            openingVix?: number;
            closingVix?: number;
            gap?: number;
            movement?: number;
            backtestReasonForClose?: string;
            actualReasonForClose?: string;
          };
        }

        // Grouped result interface
        interface GroupedResult {
          groupKey: string;
          count: number;
          matchedCount: number;
          totalSlippage: number;
          avgSlippage: number;
          outlierCount: number;
          comparisons: DetailedComparison[];
        }

        const comparisons: DetailedComparison[] = [];

        if (detailLevel === "trades") {
          // Trade-level matching by date|strategy|time (minute precision)
          // Build lookup for actual trades
          const actualByKey = new Map<string, ReportingTrade[]>();
          actualTrades.forEach((trade) => {
            const dateKey = formatDateKey(new Date(trade.dateOpened));
            const timeKey = truncateTimeToMinute(trade.timeOpened);
            const key = `${dateKey}\t${trade.strategy}\t${timeKey}`;
            const existing = actualByKey.get(key) || [];
            existing.push(trade);
            actualByKey.set(key, existing);
          });

          // Match backtest trades to actual trades
          for (const btTrade of backtestTrades) {
            const dateKey = formatDateKey(new Date(btTrade.dateOpened));
            const timeKey = truncateTimeToMinute(btTrade.timeOpened);
            const key = `${dateKey}\t${btTrade.strategy}\t${timeKey}`;

            const actualMatches = actualByKey.get(key);
            const actualTrade = actualMatches?.[0]; // Take first match

            if (actualTrade) {
              // Remove the matched trade from the list to avoid double-matching
              if (actualMatches && actualMatches.length > 1) {
                actualByKey.set(key, actualMatches.slice(1));
              } else {
                actualByKey.delete(key);
              }

              // Calculate scaling
              const btContracts = btTrade.numContracts;
              const actualContracts = actualTrade.numContracts;
              const { scaledBtPl, scaledActualPl: actualPl } = calculateScaledPl(
                btTrade.pl,
                actualTrade.pl,
                btContracts,
                actualContracts,
                scaling,
              );
              const scalingFactor =
                scaling === "toReported" && btContracts > 0 && actualContracts > 0
                  ? actualContracts / btContracts
                  : scaling === "toReported" && btContracts === 0
                    ? 0
                    : 1;

              const slippage = actualPl - scaledBtPl;
              const slippagePercent =
                scaledBtPl !== 0 ? (slippage / Math.abs(scaledBtPl)) * 100 : null;

              // Build field-by-field differences
              const differences: DetailedComparison["differences"] = [];

              // numContracts
              if (btContracts !== actualContracts) {
                differences.push({
                  field: "numContracts",
                  backtest: btContracts,
                  actual: actualContracts,
                  delta: actualContracts - btContracts,
                });
              }

              // openingPrice
              if (btTrade.openingPrice !== actualTrade.openingPrice) {
                differences.push({
                  field: "openingPrice",
                  backtest: btTrade.openingPrice,
                  actual: actualTrade.openingPrice,
                  delta: actualTrade.openingPrice - btTrade.openingPrice,
                });
              }

              // legs (strike differences)
              if (btTrade.legs !== actualTrade.legs) {
                differences.push({
                  field: "legs",
                  backtest: btTrade.legs,
                  actual: actualTrade.legs,
                });
              }

              // closingPrice (if both have it)
              if (
                btTrade.closingPrice !== undefined &&
                actualTrade.closingPrice !== undefined &&
                btTrade.closingPrice !== actualTrade.closingPrice
              ) {
                differences.push({
                  field: "closingPrice",
                  backtest: btTrade.closingPrice,
                  actual: actualTrade.closingPrice,
                  delta: actualTrade.closingPrice - btTrade.closingPrice,
                });
              }

              // reasonForClose (flag if different)
              const btReason = btTrade.reasonForClose ?? null;
              const actualReason = actualTrade.reasonForClose ?? null;
              if (btReason !== actualReason) {
                differences.push({
                  field: "reasonForClose",
                  backtest: btReason,
                  actual: actualReason,
                });
              }

              // P/L difference
              differences.push({
                field: "pl",
                backtest: btTrade.pl,
                actual: actualTrade.pl,
                delta: actualTrade.pl - btTrade.pl,
              });

              comparisons.push({
                date: dateKey,
                strategy: btTrade.strategy,
                timeOpened: timeKey,
                matched: true,
                backtestPl: btTrade.pl,
                actualPl: actualTrade.pl,
                scaledBacktestPl: scaledBtPl,
                slippage,
                slippagePercent,
                backtestContracts: btContracts,
                actualContracts: actualContracts,
                scalingFactor,
                backtestLegs: btTrade.legs,
                actualLegs: actualTrade.legs,
                differences,
                isOutlier: false, // Will be set later
                context: {
                  openingVix: btTrade.openingVix,
                  closingVix: btTrade.closingVix,
                  gap: btTrade.gap,
                  movement: btTrade.movement,
                  backtestReasonForClose: btTrade.reasonForClose,
                  actualReasonForClose: actualTrade.reasonForClose,
                },
              });
            } else {
              // Unmatched backtest trade
              const scaledBtPl =
                scaling === "perContract" && btTrade.numContracts > 0
                  ? btTrade.pl / btTrade.numContracts
                  : btTrade.pl;

              comparisons.push({
                date: dateKey,
                strategy: btTrade.strategy,
                timeOpened: timeKey,
                matched: false,
                backtestPl: btTrade.pl,
                actualPl: 0,
                scaledBacktestPl: scaledBtPl,
                slippage: 0,
                slippagePercent: null,
                backtestContracts: btTrade.numContracts,
                actualContracts: 0,
                scalingFactor: 0,
                backtestLegs: btTrade.legs,
                actualLegs: null,
                differences: [],
                isOutlier: false,
                context: {
                  openingVix: btTrade.openingVix,
                  closingVix: btTrade.closingVix,
                  gap: btTrade.gap,
                  movement: btTrade.movement,
                  backtestReasonForClose: btTrade.reasonForClose,
                },
              });
            }
          }

          // Add unmatched actual trades
          for (const [, remainingActuals] of actualByKey) {
            for (const actualTrade of remainingActuals) {
              const dateKey = formatDateKey(new Date(actualTrade.dateOpened));
              const timeKey = truncateTimeToMinute(actualTrade.timeOpened);

              comparisons.push({
                date: dateKey,
                strategy: actualTrade.strategy,
                timeOpened: timeKey,
                matched: false,
                backtestPl: 0,
                actualPl: actualTrade.pl,
                scaledBacktestPl: 0,
                slippage: 0,
                slippagePercent: null,
                backtestContracts: 0,
                actualContracts: actualTrade.numContracts,
                scalingFactor: 0,
                backtestLegs: null,
                actualLegs: actualTrade.legs,
                differences: [],
                isOutlier: false,
                context: {
                  actualReasonForClose: actualTrade.reasonForClose,
                },
              });
            }
          }
        } else {
          // Summary mode: aggregate by date+strategy (existing behavior)
          const backtestByDateStrategy = new Map<
            string,
            { trades: Trade[]; totalPl: number; contracts: number }
          >();
          const actualByDateStrategy = new Map<
            string,
            { trades: ReportingTrade[]; totalPl: number; contracts: number }
          >();

          backtestTrades.forEach((trade) => {
            const dateKey = formatDateKey(new Date(trade.dateOpened));
            const key = `${dateKey}\t${trade.strategy}`;
            const existing = backtestByDateStrategy.get(key) || {
              trades: [],
              totalPl: 0,
              contracts: 0,
            };
            existing.trades.push(trade);
            existing.totalPl += trade.pl;
            existing.contracts += trade.numContracts;
            backtestByDateStrategy.set(key, existing);
          });

          actualTrades.forEach((trade) => {
            const dateKey = formatDateKey(new Date(trade.dateOpened));
            const key = `${dateKey}\t${trade.strategy}`;
            const existing = actualByDateStrategy.get(key) || {
              trades: [],
              totalPl: 0,
              contracts: 0,
            };
            existing.trades.push(trade);
            existing.totalPl += trade.pl;
            existing.contracts += trade.numContracts;
            actualByDateStrategy.set(key, existing);
          });

          const processedActual = new Set<string>();

          for (const [key, btData] of backtestByDateStrategy) {
            const [dateKey, strategyName] = key.split("\t");
            const actualData = actualByDateStrategy.get(key);

            if (actualData) {
              processedActual.add(key);

              const { scaledBtPl, scaledActualPl } = calculateScaledPl(
                btData.totalPl,
                actualData.totalPl,
                btData.contracts,
                actualData.contracts,
                scaling,
              );
              const scalingFactor =
                scaling === "toReported" && btData.contracts > 0 && actualData.contracts > 0
                  ? actualData.contracts / btData.contracts
                  : 1;

              const slippage = scaledActualPl - scaledBtPl;
              const slippagePercent =
                scaledBtPl !== 0 ? (slippage / Math.abs(scaledBtPl)) * 100 : null;

              comparisons.push({
                date: dateKey,
                strategy: strategyName,
                timeOpened: "",
                matched: true,
                backtestPl: btData.totalPl,
                actualPl: actualData.totalPl,
                scaledBacktestPl: scaledBtPl,
                slippage,
                slippagePercent,
                backtestContracts: btData.contracts,
                actualContracts: actualData.contracts,
                scalingFactor,
                backtestLegs: null, // Not available in summary mode (aggregated trades)
                actualLegs: null,
                differences: [],
                isOutlier: false,
              });
            } else {
              comparisons.push({
                date: dateKey,
                strategy: strategyName,
                timeOpened: "",
                matched: false,
                backtestPl: btData.totalPl,
                actualPl: 0,
                scaledBacktestPl:
                  scaling === "perContract" && btData.contracts > 0
                    ? btData.totalPl / btData.contracts
                    : btData.totalPl,
                slippage: 0,
                slippagePercent: null,
                backtestContracts: btData.contracts,
                actualContracts: 0,
                scalingFactor: 0,
                backtestLegs: null, // Not available in summary mode
                actualLegs: null,
                differences: [],
                isOutlier: false,
              });
            }
          }

          // Add unmatched actual trades
          for (const [key, actualData] of actualByDateStrategy) {
            if (processedActual.has(key)) continue;

            const [dateKey, strategyName] = key.split("\t");
            comparisons.push({
              date: dateKey,
              strategy: strategyName,
              timeOpened: "",
              matched: false,
              backtestPl: 0,
              actualPl: actualData.totalPl,
              scaledBacktestPl: 0,
              slippage: 0,
              slippagePercent: null,
              backtestContracts: 0,
              actualContracts: actualData.contracts,
              scalingFactor: 0,
              backtestLegs: null, // Not available in summary mode
              actualLegs: null,
              differences: [],
              isOutlier: false,
            });
          }
        }

        // Sort by date, then strategy, then time
        comparisons.sort((a, b) => {
          const dateCompare = a.date.localeCompare(b.date);
          if (dateCompare !== 0) return dateCompare;
          const strategyCompare = a.strategy.localeCompare(b.strategy);
          if (strategyCompare !== 0) return strategyCompare;
          return a.timeOpened.localeCompare(b.timeOpened);
        });

        // Outlier detection using z-score
        let outlierStats: {
          meanSlippage: number;
          stdDevSlippage: number;
          threshold: number;
          outlierCount: number;
          outlierPercent: number;
          outlierTotalSlippage: number;
          outlierAvgSlippage: number;
        } | null = null;

        const matchedComparisons = comparisons.filter((c) => c.matched);
        const slippageValues = matchedComparisons.map((c) => c.slippage);

        if (slippageValues.length >= 3) {
          // Calculate mean and stdDev manually (avoid mathjs import complexity)
          const meanSlippage =
            slippageValues.reduce((sum, v) => sum + v, 0) / slippageValues.length;
          const variance =
            slippageValues.reduce((sum, v) => sum + Math.pow(v - meanSlippage, 2), 0) /
            slippageValues.length;
          const stdDevSlippage = Math.sqrt(variance);

          // Guard: skip if all values are essentially the same
          if (stdDevSlippage >= 1e-10) {
            // Calculate z-scores and flag outliers
            for (const comparison of comparisons) {
              if (comparison.matched) {
                const zScore = (comparison.slippage - meanSlippage) / stdDevSlippage;
                comparison.zScore = zScore;

                if (Math.abs(zScore) >= outliersThreshold) {
                  comparison.isOutlier = true;
                  if (Math.abs(zScore) >= 3) {
                    comparison.outlierSeverity = "high";
                  } else if (Math.abs(zScore) >= 2) {
                    comparison.outlierSeverity = "medium";
                  } else {
                    comparison.outlierSeverity = "low";
                  }
                }
              }
            }

            const outliers = comparisons.filter((c) => c.isOutlier);
            const outlierTotalSlippage = outliers.reduce((sum, c) => sum + c.slippage, 0);

            outlierStats = {
              meanSlippage,
              stdDevSlippage,
              threshold: outliersThreshold,
              outlierCount: outliers.length,
              outlierPercent:
                matchedComparisons.length > 0
                  ? (outliers.length / matchedComparisons.length) * 100
                  : 0,
              outlierTotalSlippage,
              outlierAvgSlippage: outliers.length > 0 ? outlierTotalSlippage / outliers.length : 0,
            };
          }
        }

        // Build unmatched summaries before filtering
        const unmatchedBacktestEntries = comparisons.filter(
          (c) => !c.matched && c.backtestPl !== 0,
        );
        const unmatchedActualEntries = comparisons.filter((c) => !c.matched && c.actualPl !== 0);

        const unmatchedBacktestSummary =
          unmatchedBacktestEntries.length > 0
            ? {
                count: unmatchedBacktestEntries.length,
                dateRange: {
                  from: unmatchedBacktestEntries.reduce((a, b) => (a.date < b.date ? a : b)).date,
                  to: unmatchedBacktestEntries.reduce((a, b) => (a.date > b.date ? a : b)).date,
                },
                totalPl: unmatchedBacktestEntries.reduce((sum, c) => sum + c.backtestPl, 0),
                strategies: Array.from(
                  new Set(unmatchedBacktestEntries.map((c) => c.strategy)),
                ).sort(),
              }
            : null;

        const unmatchedActualSummary =
          unmatchedActualEntries.length > 0
            ? {
                count: unmatchedActualEntries.length,
                dateRange: {
                  from: unmatchedActualEntries.reduce((a, b) => (a.date < b.date ? a : b)).date,
                  to: unmatchedActualEntries.reduce((a, b) => (a.date > b.date ? a : b)).date,
                },
                totalPl: unmatchedActualEntries.reduce((sum, c) => sum + c.actualPl, 0),
                strategies: Array.from(
                  new Set(unmatchedActualEntries.map((c) => c.strategy)),
                ).sort(),
              }
            : null;

        // Apply matchedOnly filter to the primary output set
        let outputComparisons = matchedOnly
          ? comparisons.filter((c) => c.matched)
          : [...comparisons];

        // Apply outliersOnly filter if requested
        if (outliersOnly) {
          outputComparisons = outputComparisons.filter((c) => c.isOutlier);
        }

        // Sort by absolute slippage (worst first) to surface problem areas
        outputComparisons.sort((a, b) => Math.abs(b.slippage) - Math.abs(a.slippage));

        // Apply grouping if requested
        let groups: GroupedResult[] | null = null;
        if (groupBy !== "none") {
          const groupMap = new Map<string, DetailedComparison[]>();
          for (const comparison of outputComparisons) {
            const gKey = getGroupKey(comparison.date, comparison.strategy, groupBy);
            const existing = groupMap.get(gKey) || [];
            existing.push(comparison);
            groupMap.set(gKey, existing);
          }

          groups = Array.from(groupMap.entries())
            .map(([groupKey, groupComparisons]) => {
              const matchedInGroup = groupComparisons.filter((c) => c.matched);
              const totalSlippage = groupComparisons.reduce((sum, c) => sum + c.slippage, 0);
              const outlierCount = groupComparisons.filter((c) => c.isOutlier).length;

              return {
                groupKey,
                count: groupComparisons.length,
                matchedCount: matchedInGroup.length,
                totalSlippage,
                avgSlippage: matchedInGroup.length > 0 ? totalSlippage / matchedInGroup.length : 0,
                outlierCount,
                comparisons: groupComparisons,
              };
            })
            .sort((a, b) => Math.abs(b.totalSlippage) - Math.abs(a.totalSlippage));
        }

        // Calculate summary statistics.
        // matchedOnly=false includes unmatched rows in totals for backward compatibility.
        const comparisonsForTotals = matchedOnly
          ? outputComparisons.filter((c) => c.matched)
          : outputComparisons;
        const matchedForSummary = outputComparisons.filter((c) => c.matched);
        const totalBacktestPl = comparisonsForTotals.reduce(
          (sum, c) => sum + c.scaledBacktestPl,
          0,
        );
        const totalActualPl = comparisonsForTotals.reduce(
          (sum, c) =>
            sum +
            (scaling === "perContract" && c.actualContracts > 0
              ? c.actualPl / c.actualContracts
              : c.actualPl),
          0,
        );
        const totalSlippage = totalActualPl - totalBacktestPl;
        const avgSlippage =
          matchedForSummary.length > 0
            ? matchedForSummary.reduce((sum, c) => sum + c.slippage, 0) / matchedForSummary.length
            : 0;
        const avgSlippagePercent =
          totalBacktestPl !== 0 ? (totalSlippage / Math.abs(totalBacktestPl)) * 100 : null;

        // Get unique strategies
        const backtestStrategies = Array.from(
          new Set(backtestTrades.map((t) => t.strategy)),
        ).sort();
        const actualStrategies = Array.from(new Set(actualTrades.map((t) => t.strategy))).sort();

        // Brief summary for user display
        const filters: string[] = [];
        if (strategy) filters.push(`strategy=${strategy}`);
        if (dateRange?.from || dateRange?.to) {
          filters.push(`date=${dateRange.from ?? "start"} to ${dateRange.to ?? "end"}`);
        }
        if (autoFilterApplied) filters.push("auto-date-overlap");
        if (matchedOnly) filters.push("matched-only");
        if (outliersOnly) filters.push("outliers-only");
        if (detailLevel === "trades") filters.push("trade-level");
        if (groupBy !== "none") filters.push(`grouped-by-${groupBy}`);

        const filterStr = filters.length > 0 ? ` (${filters.join(", ")})` : "";
        const slippageDisplay =
          avgSlippagePercent !== null
            ? `${formatPercent(avgSlippagePercent)} slippage`
            : "N/A slippage";
        const outlierDisplay =
          outlierStats !== null ? ` | ${outlierStats.outlierCount} outliers` : "";
        const summary = `Comparison: ${blockId}${filterStr} | ${scaling} scaling | ${matchedForSummary.length}/${outputComparisons.length} matched | ${slippageDisplay}${outlierDisplay}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          scalingMode: scaling,
          dateRange: dateRange ?? null,
          autoFilterApplied,
          filters: {
            matchedOnly,
            detailLevel,
            groupBy,
            outliersOnly,
            outliersThreshold,
          },
          backtestTradeCount: backtestTrades.length,
          actualTradeCount: actualTrades.length,
          backtestStrategies,
          actualStrategies,
          summary: {
            totalComparisons: outputComparisons.length,
            matchedComparisons: matchedForSummary.length,
            unmatchedBacktestCount: unmatchedBacktestEntries.length,
            unmatchedActualCount: unmatchedActualEntries.length,
            unmatchedBacktestPl: unmatchedBacktestSummary?.totalPl ?? 0,
            unmatchedActualPl: unmatchedActualSummary?.totalPl ?? 0,
            totalBacktestPl,
            totalActualPl,
            totalSlippage,
            avgSlippage,
            avgSlippagePercent,
            outlierStats,
            note: matchedOnly
              ? "Summary stats are computed from matched rows only."
              : "Summary stats include unmatched rows because matchedOnly=false. Unmatched trades are also reported in unmatchedSummary.",
          },
          unmatchedSummary: {
            backtest: unmatchedBacktestSummary,
            actual: unmatchedActualSummary,
          },
          ...(groupBy === "none" ? { comparisons: outputComparisons } : { groups }),
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error comparing backtest to actual: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
