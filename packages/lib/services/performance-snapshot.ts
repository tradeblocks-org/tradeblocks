import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type { PortfolioStats } from "../models/portfolio-stats.ts";
import { PortfolioStatsCalculator } from "../calculations/portfolio-stats.ts";
import {
  calculatePremiumEfficiencyPercent,
  computeTotalPremium,
  type EfficiencyBasis,
} from "../metrics/trade-efficiency.ts";
import {
  calculateMFEMAEDataAsync,
  calculateMFEMAEStats,
  createExcursionDistributionAsync,
  type MFEMAEDataPoint,
  type MFEMAEStats,
  type DistributionBucket,
  type NormalizationBasis,
} from "../calculations/mfe-mae.ts";
import { calculateDailyExposure as calculateDailyExposureShared } from "../calculations/daily-exposure.ts";
import { normalizeTradesToOneLot } from "../utils/trade-normalization.ts";
import { yieldToMain, checkCancelled } from "../utils/async-helpers.ts";
import { calculateRunsTest } from "../calculations/streak-analysis.ts";

export interface SnapshotDateRange {
  from?: Date;
  to?: Date;
}

export interface SnapshotFilters {
  dateRange?: SnapshotDateRange;
  strategies?: string[];
}

export interface SnapshotProgress {
  step: string;
  percent: number;
}

interface SnapshotOptions {
  trades: Trade[];
  dailyLogs?: DailyLogEntry[];
  filters?: SnapshotFilters;
  normalizeTo1Lot?: boolean;
  onProgress?: (progress: SnapshotProgress) => void;
  signal?: AbortSignal;
}

export interface SnapshotChartData {
  equityCurve: Array<{ date: string; equity: number; highWaterMark: number; tradeNumber: number }>;
  drawdownData: Array<{ date: string; drawdownPct: number }>;
  dayOfWeekData: Array<{ day: string; count: number; avgPl: number; avgPlPercent: number }>;
  returnDistribution: number[];
  /**
   * Per-trade inputs for ROM histogram; keeps margin context for exports/LLMs
   */
  returnDistributionDetails?: Array<{
    tradeNumber: number;
    date: string;
    pl: number;
    marginReq: number;
    strategy?: string;
    rom: number;
  }>;
  streakData: {
    winDistribution: Record<number, number>;
    lossDistribution: Record<number, number>;
    statistics: {
      maxWinStreak: number;
      maxLossStreak: number;
      avgWinStreak: number;
      avgLossStreak: number;
    };
    runsTest?: {
      numRuns: number;
      expectedRuns: number;
      zScore: number;
      pValue: number;
      isNonRandom: boolean;
      patternType: "random" | "clustered" | "alternating";
      interpretation: string;
      sampleSize: number;
      isSufficientSample: boolean;
    };
  };
  monthlyReturns: Record<number, Record<number, number>>;
  monthlyReturnsPercent: Record<number, Record<number, number>>;
  tradeSequence: Array<{
    tradeNumber: number;
    pl: number;
    rom: number;
    date: string;
    marginReq?: number;
  }>;
  romTimeline: Array<{ date: string; rom: number }>;
  rollingMetrics: Array<{
    date: string;
    winRate: number;
    sharpeRatio: number;
    profitFactor: number;
    volatility: number;
  }>;
  volatilityRegimes: Array<{
    date: string;
    openingVix?: number;
    closingVix?: number;
    pl: number;
    rom?: number;
  }>;
  premiumEfficiency: Array<{
    tradeNumber: number;
    date: string;
    pl: number;
    premium?: number;
    avgClosingCost?: number;
    maxProfit?: number;
    maxLoss?: number;
    totalCommissions?: number;
    efficiencyPct?: number;
    efficiencyDenominator?: number;
    efficiencyBasis?: EfficiencyBasis;
    totalPremium?: number;
  }>;
  marginUtilization: Array<{
    date: string;
    marginReq: number;
    fundsAtClose: number;
    numContracts: number;
    pl: number;
  }>;
  exitReasonBreakdown: Array<{
    reason: string;
    count: number;
    avgPl: number;
    avgPlPercent: number;
    totalPl: number;
  }>;
  holdingPeriods: Array<{
    tradeNumber: number;
    dateOpened: string;
    dateClosed?: string;
    durationHours: number;
    pl: number;
    strategy: string;
  }>;
  mfeMaeData: MFEMAEDataPoint[];
  mfeMaeStats: Partial<Record<NormalizationBasis, MFEMAEStats>>;
  mfeMaeDistribution: DistributionBucket[];
  dailyExposure: Array<{
    date: string;
    exposure: number;
    exposurePercent: number;
    openPositions: number;
  }>;
  peakDailyExposure: { date: string; exposure: number; exposurePercent: number } | null;
  peakDailyExposurePercent: { date: string; exposure: number; exposurePercent: number } | null;
}

export interface PerformanceSnapshot {
  filteredTrades: Trade[];
  filteredDailyLogs: DailyLogEntry[];
  portfolioStats: PortfolioStats;
  chartData: SnapshotChartData;
}

export async function buildPerformanceSnapshot(
  options: SnapshotOptions,
): Promise<PerformanceSnapshot> {
  const { onProgress, signal } = options;
  const normalizeTo1Lot = Boolean(options.normalizeTo1Lot);
  const strategies = options.filters?.strategies?.length ? options.filters?.strategies : undefined;
  const dateRange = options.filters?.dateRange;

  // Check for cancellation at start
  checkCancelled(signal);
  onProgress?.({ step: "Filtering trades", percent: 5 });
  await yieldToMain();

  // When filtering by strategy or normalizing, the `fundsAtClose` values from individual trades
  // represent the entire account balance and include performance from trades outside the current filter.
  // To avoid this data leakage, we rebuild the equity curve using cumulative P&L calculations instead of the absolute `fundsAtClose` values.
  const useFundsAtClose = !normalizeTo1Lot && !strategies;

  const sourceTrades = normalizeTo1Lot ? normalizeTradesToOneLot(options.trades) : options.trades;

  let filteredTrades = [...sourceTrades];
  let filteredDailyLogs = normalizeTo1Lot
    ? undefined
    : options.dailyLogs
      ? [...options.dailyLogs]
      : undefined;

  // Yield after copying large arrays
  checkCancelled(signal);
  await yieldToMain();

  if (dateRange?.from || dateRange?.to) {
    filteredTrades = filteredTrades.filter((trade) => {
      const tradeDate = new Date(trade.dateOpened);
      if (dateRange.from && tradeDate < dateRange.from) return false;
      if (dateRange.to && tradeDate > dateRange.to) return false;
      return true;
    });

    if (filteredDailyLogs) {
      filteredDailyLogs = filteredDailyLogs.filter((entry) => {
        const entryDate = new Date(entry.date);
        if (dateRange.from && entryDate < dateRange.from) return false;
        if (dateRange.to && entryDate > dateRange.to) return false;
        return true;
      });
    }
  }

  if (strategies) {
    filteredTrades = filteredTrades.filter((trade) =>
      strategies.includes(trade.strategy || "Unknown"),
    );

    // Note: We intentionally keep filteredDailyLogs available here (not setting to undefined).
    // While equity curve calculations use useFundsAtClose=false when strategies are filtered
    // (to avoid data leakage from other strategies' fundsAtClose values), we still need
    // daily logs for:
    // 1. Custom field joining during trade enrichment (e.g., daily.vixOpen)
    // 2. Monthly returns % calculations (which have appropriate fallbacks)
    // The useFundsAtClose flag (line 123) already handles the equity curve concern.
  }

  checkCancelled(signal);
  onProgress?.({ step: "Calculating portfolio stats", percent: 10 });
  await yieldToMain();

  const calculator = new PortfolioStatsCalculator();
  const portfolioStats = calculator.calculatePortfolioStats(
    filteredTrades,
    filteredDailyLogs,
    Boolean(strategies && strategies.length > 0),
  );

  // Yield after heavy portfolio stats calculation
  checkCancelled(signal);
  await yieldToMain();

  onProgress?.({ step: "Building charts", percent: 20 });

  const chartData = await processChartData(filteredTrades, filteredDailyLogs, {
    useFundsAtClose,
    onProgress,
    signal,
  });

  onProgress?.({ step: "Complete", percent: 100 });

  return {
    filteredTrades,
    filteredDailyLogs: filteredDailyLogs ?? [],
    portfolioStats,
    chartData,
  };
}

export async function processChartData(
  trades: Trade[],
  dailyLogs?: DailyLogEntry[],
  options?: {
    useFundsAtClose?: boolean;
    onProgress?: (progress: SnapshotProgress) => void;
    signal?: AbortSignal;
  },
): Promise<SnapshotChartData> {
  const { onProgress, signal } = options ?? {};

  checkCancelled(signal);
  onProgress?.({ step: "Building equity curve", percent: 25 });
  await yieldToMain();

  const { equityCurve, drawdownData } = buildEquityAndDrawdown(
    trades,
    dailyLogs,
    options?.useFundsAtClose,
  );

  // Yield after equity curve (can be heavy with many trades/logs)
  checkCancelled(signal);
  await yieldToMain();

  onProgress?.({ step: "Calculating day of week stats", percent: 30 });

  const dayOfWeekData = calculateDayOfWeekData(trades);

  // Yield after day of week
  checkCancelled(signal);
  await yieldToMain();

  const romTrades = trades
    .map((trade, index) => {
      const marginReq = getFiniteNumber(trade.marginReq) ?? 0;
      const rom = marginReq > 0 ? (trade.pl / marginReq) * 100 : undefined;

      return {
        tradeNumber: index + 1,
        date: new Date(trade.dateOpened).toISOString(),
        pl: trade.pl,
        marginReq,
        strategy: trade.strategy,
        rom,
      };
    })
    .filter((trade) => trade.rom !== undefined) as Array<{
    tradeNumber: number;
    date: string;
    pl: number;
    marginReq: number;
    strategy?: string;
    rom: number;
  }>;

  const returnDistribution = romTrades.map((trade) => trade.rom);

  const streakData = calculateStreakData(trades);

  // Yield after streak data
  checkCancelled(signal);
  await yieldToMain();

  onProgress?.({ step: "Computing monthly returns", percent: 40 });

  const monthlyReturns = calculateMonthlyReturns(trades);

  // Yield after monthly returns
  checkCancelled(signal);
  await yieldToMain();

  const monthlyReturnsPercent = calculateMonthlyReturnsPercent(trades, dailyLogs);

  // Yield after monthly returns percent
  checkCancelled(signal);
  await yieldToMain();

  const tradeSequence = trades.map((trade, index) => {
    const marginReq = getFiniteNumber(trade.marginReq) ?? 0;
    return {
      tradeNumber: index + 1,
      pl: trade.pl,
      rom: marginReq > 0 ? (trade.pl / marginReq) * 100 : 0,
      marginReq,
      date: new Date(trade.dateOpened).toISOString(),
    };
  });

  // Yield after trade sequence
  checkCancelled(signal);
  onProgress?.({ step: "Calculating rolling metrics", percent: 50 });
  await yieldToMain();

  const romTimeline = trades
    .filter((trade) => trade.marginReq && trade.marginReq > 0)
    .map((trade) => ({
      date: new Date(trade.dateOpened).toISOString(),
      rom: (trade.pl / trade.marginReq!) * 100,
    }));

  // Rolling metrics is O(n * windowSize) - most expensive calculation
  const rollingMetrics = await calculateRollingMetrics(trades, signal);

  checkCancelled(signal);
  onProgress?.({ step: "Analyzing volatility regimes", percent: 70 });
  await yieldToMain();

  const volatilityRegimes = calculateVolatilityRegimes(trades);

  // Yield after volatility regimes
  checkCancelled(signal);
  await yieldToMain();

  const premiumEfficiency = calculatePremiumEfficiency(trades);

  // Yield after premium efficiency
  checkCancelled(signal);
  onProgress?.({ step: "Computing margin utilization", percent: 80 });
  await yieldToMain();

  const marginUtilization = calculateMarginUtilization(trades, equityCurve);

  // Yield after margin utilization
  checkCancelled(signal);
  await yieldToMain();

  const exitReasonBreakdown = calculateExitReasonBreakdown(trades);

  // Yield after exit reason breakdown
  checkCancelled(signal);
  await yieldToMain();

  const holdingPeriods = calculateHoldingPeriods(trades);

  // Yield after holding periods
  checkCancelled(signal);
  onProgress?.({ step: "Calculating daily exposure", percent: 85 });
  await yieldToMain();

  const { dailyExposure, peakDailyExposure, peakDailyExposurePercent } = calculateDailyExposure(
    trades,
    equityCurve,
  );

  // Yield after daily exposure
  checkCancelled(signal);
  onProgress?.({ step: "Calculating MFE/MAE analysis", percent: 90 });
  await yieldToMain();

  // MFE/MAE excursion analysis (async to yield during processing)
  const mfeMaeData = await calculateMFEMAEDataAsync(trades, signal);

  checkCancelled(signal);

  const mfeMaeStats = await calculateMFEMAEStats(mfeMaeData, signal);

  // Yield after MFE/MAE stats
  checkCancelled(signal);
  onProgress?.({ step: "Finalizing (distributions)", percent: 95 });
  await yieldToMain();

  const mfeMaeDistribution = await createExcursionDistributionAsync(mfeMaeData, 10, signal);

  // Yield after distributions to let UI paint before returning large object
  checkCancelled(signal);
  onProgress?.({ step: "Finalizing (packaging)", percent: 98 });
  await yieldToMain();

  return {
    equityCurve,
    drawdownData,
    dayOfWeekData,
    returnDistribution,
    returnDistributionDetails: romTrades,
    streakData,
    monthlyReturns,
    monthlyReturnsPercent,
    tradeSequence,
    romTimeline,
    rollingMetrics,
    volatilityRegimes,
    premiumEfficiency,
    marginUtilization,
    exitReasonBreakdown,
    holdingPeriods,
    mfeMaeData,
    mfeMaeStats,
    mfeMaeDistribution,
    dailyExposure,
    peakDailyExposure,
    peakDailyExposurePercent,
  };
}

function buildEquityAndDrawdown(
  trades: Trade[],
  dailyLogs?: DailyLogEntry[],
  useFundsAtClose = true,
) {
  // When we shouldn't trust account-level equity (e.g., strategy filters or normalization),
  // skip daily logs and rebuild from trade P&L instead of leaking other strategies.
  if (useFundsAtClose && dailyLogs && dailyLogs.length > 0) {
    return buildEquityAndDrawdownFromDailyLogs(trades, dailyLogs);
  }

  const equityCurve = calculateEquityCurveFromTrades(trades, useFundsAtClose);
  const drawdownData = calculateDailyDrawdownFromEquityCurve(equityCurve);

  return { equityCurve, drawdownData };
}

function calculateDailyDrawdownFromEquityCurve(
  equityCurve: SnapshotChartData["equityCurve"],
): SnapshotChartData["drawdownData"] {
  if (!equityCurve || equityCurve.length === 0) {
    return [];
  }

  // Collapse multiple trades on the same calendar day into a single end-of-day point
  const dailyPoints: Array<{ date: string; equity: number }> = [];

  // Seed the high water mark from the initial curve point so day-one drops are preserved
  let highWaterMark = Number.isFinite(equityCurve[0].highWaterMark)
    ? equityCurve[0].highWaterMark
    : equityCurve[0].equity;

  equityCurve.forEach((point) => {
    const dayKey = point.date.slice(0, 10); // YYYY-MM-DD
    const lastPoint = dailyPoints[dailyPoints.length - 1];

    if (lastPoint && lastPoint.date.slice(0, 10) === dayKey) {
      // Overwrite with the latest equity for that day (end-of-day)
      dailyPoints[dailyPoints.length - 1] = { date: point.date, equity: point.equity };
    } else {
      dailyPoints.push({ date: point.date, equity: point.equity });
    }
  });

  return dailyPoints.map((point) => {
    if (!isFinite(highWaterMark) || point.equity > highWaterMark) {
      highWaterMark = point.equity;
    }

    const drawdownPct =
      highWaterMark > 0 ? ((point.equity - highWaterMark) / highWaterMark) * 100 : 0;

    return {
      date: point.date,
      drawdownPct,
    };
  });
}

function buildEquityAndDrawdownFromDailyLogs(trades: Trade[], dailyLogs: DailyLogEntry[]) {
  const sortedLogs = [...dailyLogs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (sortedLogs.length === 0) {
    return { equityCurve: [], drawdownData: [] };
  }

  const tradesSortedByClose = trades
    .filter((trade) => trade.dateClosed)
    .sort(
      (a, b) =>
        new Date(a.dateClosed ?? a.dateOpened).getTime() -
        new Date(b.dateClosed ?? b.dateOpened).getTime(),
    );

  let closedTradeCount = 0;
  let highWaterMark = Number.NEGATIVE_INFINITY;

  const equityCurve: SnapshotChartData["equityCurve"] = [];
  const drawdownData: SnapshotChartData["drawdownData"] = [];

  sortedLogs.forEach((entry) => {
    const entryDate = new Date(entry.date);

    while (
      closedTradeCount < tradesSortedByClose.length &&
      new Date(
        tradesSortedByClose[closedTradeCount].dateClosed ??
          tradesSortedByClose[closedTradeCount].dateOpened,
      ).getTime() <= entryDate.getTime()
    ) {
      closedTradeCount += 1;
    }

    const equity = getEquityValueFromDailyLog(entry);
    if (!isFinite(equity)) {
      return;
    }

    if (!isFinite(highWaterMark) || equity > highWaterMark) {
      highWaterMark = equity;
    }

    const drawdownPct =
      typeof entry.drawdownPct === "number" && !Number.isNaN(entry.drawdownPct)
        ? entry.drawdownPct
        : highWaterMark > 0
          ? ((equity - highWaterMark) / highWaterMark) * 100
          : 0;

    const isoDate = entryDate.toISOString();

    equityCurve.push({
      date: isoDate,
      equity,
      highWaterMark,
      tradeNumber: closedTradeCount,
    });

    drawdownData.push({
      date: isoDate,
      drawdownPct,
    });
  });

  return { equityCurve, drawdownData };
}

function getEquityValueFromDailyLog(entry: DailyLogEntry): number {
  const candidates = [entry.netLiquidity, entry.currentFunds, entry.tradingFunds];
  for (const value of candidates) {
    if (typeof value === "number" && isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function calculateEquityCurveFromTrades(trades: Trade[], useFundsAtClose: boolean) {
  const closedTrades = trades
    .filter((trade) => trade.dateClosed)
    .sort((a, b) => {
      const dateA = new Date(a.dateClosed ?? a.dateOpened).getTime();
      const dateB = new Date(b.dateClosed ?? b.dateOpened).getTime();
      if (dateA === dateB) {
        return (a.timeClosed || "").localeCompare(b.timeClosed || "");
      }
      return dateA - dateB;
    });

  if (closedTrades.length === 0) {
    const fallbackTrades = [...trades].sort(
      (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
    );

    if (fallbackTrades.length === 0) {
      const now = new Date().toISOString();
      return [
        {
          date: now,
          equity: 0,
          highWaterMark: 0,
          tradeNumber: 0,
        },
      ];
    }

    let initialCapital = PortfolioStatsCalculator.calculateInitialCapital(fallbackTrades);
    if (!isFinite(initialCapital) || initialCapital <= 0) {
      initialCapital = 100000;
    }

    let runningEquity = initialCapital;
    let highWaterMark = runningEquity;

    const initialDate = new Date(fallbackTrades[0].dateOpened);

    const curve: SnapshotChartData["equityCurve"] = [
      {
        date: initialDate.toISOString(),
        equity: runningEquity,
        highWaterMark,
        tradeNumber: 0,
      },
    ];

    fallbackTrades.forEach((trade, index) => {
      runningEquity += trade.pl;
      highWaterMark = Math.max(highWaterMark, runningEquity);

      const baseDate = new Date(trade.dateOpened);
      const uniqueDate = new Date(baseDate.getTime() + (index + 1) * 1000);

      curve.push({
        date: uniqueDate.toISOString(),
        equity: runningEquity,
        highWaterMark,
        tradeNumber: index + 1,
      });
    });

    return curve;
  }

  let initialCapital = PortfolioStatsCalculator.calculateInitialCapital(closedTrades);
  if (!isFinite(initialCapital) || initialCapital <= 0) {
    initialCapital = 100000;
  }

  let runningEquity = initialCapital;
  let highWaterMark = runningEquity;

  const firstCloseDate = new Date(closedTrades[0].dateClosed ?? closedTrades[0].dateOpened);
  const initialDate = new Date(firstCloseDate.getTime() - 1000);

  const curve: SnapshotChartData["equityCurve"] = [
    {
      date: initialDate.toISOString(),
      equity: runningEquity,
      highWaterMark,
      tradeNumber: 0,
    },
  ];

  closedTrades.forEach((trade, index) => {
    const equity =
      useFundsAtClose && typeof trade.fundsAtClose === "number" && isFinite(trade.fundsAtClose)
        ? trade.fundsAtClose
        : runningEquity + trade.pl;

    runningEquity = equity;
    highWaterMark = Math.max(highWaterMark, runningEquity);

    const closeDate = new Date(trade.dateClosed ?? trade.dateOpened);
    const uniqueDate = new Date(closeDate.getTime() + (index + 1) * 1000);

    curve.push({
      date: uniqueDate.toISOString(),
      equity: runningEquity,
      highWaterMark,
      tradeNumber: index + 1,
    });
  });

  return curve;
}

function calculateDayOfWeekData(trades: Trade[]) {
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dayData: Record<
    string,
    {
      count: number;
      totalPl: number;
      totalPlPercent: number;
      percentSampleCount: number;
    }
  > = {};

  trades.forEach((trade) => {
    const tradeDate =
      trade.dateOpened instanceof Date ? trade.dateOpened : new Date(trade.dateOpened);
    // Use getDay() (local timezone) not getUTCDay() because dates are parsed at local midnight
    // via parseDatePreservingCalendarDay() in trade-processor.ts
    const jsDay = tradeDate.getDay();

    const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
    const day = dayNames[pythonWeekday];

    if (!dayData[day]) {
      dayData[day] = { count: 0, totalPl: 0, totalPlPercent: 0, percentSampleCount: 0 };
    }
    dayData[day].count++;
    dayData[day].totalPl += trade.pl;

    // Calculate percentage return (ROM) if margin is available
    if (trade.marginReq && trade.marginReq > 0) {
      dayData[day].totalPlPercent += (trade.pl / trade.marginReq) * 100;
      dayData[day].percentSampleCount++;
    }
  });

  return Object.entries(dayData).map(([day, data]) => ({
    day,
    count: data.count,
    avgPl: data.count > 0 ? data.totalPl / data.count : 0,
    avgPlPercent: data.percentSampleCount > 0 ? data.totalPlPercent / data.percentSampleCount : 0,
  }));
}

function calculateStreakData(trades: Trade[]) {
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

  // Calculate runs test for streakiness detection
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

function calculateMonthlyReturns(trades: Trade[]) {
  const monthlyData: Record<string, number> = {};

  trades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    // Use local methods since dates are parsed at local midnight
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

function calculateMonthlyReturnsPercent(
  trades: Trade[],
  dailyLogs?: DailyLogEntry[],
): Record<number, Record<number, number>> {
  // If daily logs are available, use them for accurate balance tracking
  if (dailyLogs && dailyLogs.length > 0) {
    return calculateMonthlyReturnsPercentFromDailyLogs(trades, dailyLogs);
  }

  // Fallback to trade-based calculation
  return calculateMonthlyReturnsPercentFromTrades(trades);
}

function calculateMonthlyReturnsPercentFromDailyLogs(
  trades: Trade[],
  dailyLogs: DailyLogEntry[],
): Record<number, Record<number, number>> {
  const sortedLogs = [...dailyLogs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (sortedLogs.length === 0) {
    return {};
  }

  // Pre-compute trade-based percents for fallback months without balance data
  const tradeBasedPercents = calculateMonthlyReturnsPercentFromTrades(trades);

  // Group trades by month to get P&L per month
  const monthlyPL: Record<string, number> = {};
  trades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    // Use local methods since dates are parsed at local midnight
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    monthlyPL[monthKey] = (monthlyPL[monthKey] || 0) + trade.pl;
  });

  // Get starting balance for each month from daily logs
  const monthlyBalances: Record<string, { startBalance: number; endBalance: number }> = {};

  sortedLogs.forEach((log) => {
    const date = new Date(log.date);
    // Use local methods since dates are parsed at local midnight
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;

    const balance = getEquityValueFromDailyLog(log);

    if (!monthlyBalances[monthKey]) {
      monthlyBalances[monthKey] = { startBalance: balance, endBalance: balance };
    } else {
      monthlyBalances[monthKey].endBalance = balance;
    }
  });

  // Calculate percentage returns
  const monthlyReturnsPercent: Record<number, Record<number, number>> = {};
  const years = new Set<number>();

  Object.keys(monthlyPL).forEach((monthKey) => {
    const [yearStr, monthStr] = monthKey.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    years.add(year);

    if (!monthlyReturnsPercent[year]) {
      monthlyReturnsPercent[year] = {};
    }

    const pl = monthlyPL[monthKey] || 0;
    const balanceData = monthlyBalances[monthKey];

    if (balanceData && balanceData.startBalance > 0) {
      // Calculate percentage: (monthPL / startingBalance) * 100
      monthlyReturnsPercent[year][month] = (pl / balanceData.startBalance) * 100;
    } else {
      const fallbackPercent = tradeBasedPercents[year]?.[month];
      monthlyReturnsPercent[year][month] =
        typeof fallbackPercent === "number" ? fallbackPercent : 0;
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

function calculateMonthlyReturnsPercentFromTrades(
  trades: Trade[],
): Record<number, Record<number, number>> {
  if (trades.length === 0) {
    return {};
  }

  // Sort trades by date
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
  );

  // Calculate initial capital
  let runningCapital = PortfolioStatsCalculator.calculateInitialCapital(sortedTrades);
  if (!isFinite(runningCapital) || runningCapital <= 0) {
    runningCapital = 100000;
  }

  // Group trades by month
  const monthlyData: Record<string, { pl: number; startingCapital: number }> = {};
  const years = new Set<number>();

  sortedTrades.forEach((trade) => {
    const date = new Date(trade.dateOpened);
    // Use local methods since dates are parsed at local midnight
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

  // Calculate percentage returns and update running capital
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

    // Update startingCapital for any remaining trades in future months
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

async function calculateRollingMetrics(trades: Trade[], signal?: AbortSignal) {
  const windowSize = 30;
  const metrics: SnapshotChartData["rollingMetrics"] = [];

  if (trades.length < windowSize) {
    return metrics;
  }

  // Use sliding window approach to avoid repeated array operations
  // Pre-extract P&L values for faster access
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
    // Yield every 100 iterations to keep UI responsive
    if (i % 100 === 0) {
      checkCancelled(signal);
      await yieldToMain();
    }

    // Calculate metrics for current window
    const winRate = windowWins / windowSize;
    const avgReturn = windowSum / windowSize;

    // Calculate variance (need to iterate for this, but only over window)
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

    const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

    metrics.push({
      date: new Date(trades[i].dateOpened).toISOString(),
      winRate: winRate * 100,
      sharpeRatio,
      profitFactor,
      volatility,
    });

    // Slide window to the next position (skip on final iteration—there is no next window to build)
    if (i < trades.length - 1) {
      const oldPl = plValues[i - windowSize + 1];
      const newPl = plValues[i + 1];

      // Remove old value
      windowSum -= oldPl;
      if (oldPl > 0) {
        windowWins--;
        windowPositiveSum -= oldPl;
      } else if (oldPl < 0) {
        windowNegativeSum -= Math.abs(oldPl);
      }

      // Add new value
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

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && isFinite(value) ? value : undefined;
}

function calculateVolatilityRegimes(trades: Trade[]) {
  const regimes: SnapshotChartData["volatilityRegimes"] = [];

  trades.forEach((trade) => {
    const openingVix = getFiniteNumber(trade.openingVix);
    const closingVix = getFiniteNumber(trade.closingVix);

    if (openingVix === undefined && closingVix === undefined) {
      return;
    }

    const rom =
      trade.marginReq && trade.marginReq !== 0 ? (trade.pl / trade.marginReq) * 100 : undefined;

    regimes.push({
      date: new Date(trade.dateOpened).toISOString(),
      openingVix,
      closingVix,
      pl: trade.pl,
      rom,
    });
  });

  return regimes;
}

function calculatePremiumEfficiency(trades: Trade[]) {
  const efficiency: SnapshotChartData["premiumEfficiency"] = [];

  trades.forEach((trade, index) => {
    const premium = getFiniteNumber(trade.premium);
    const avgClosingCost = getFiniteNumber(trade.avgClosingCost);
    const maxProfit = getFiniteNumber(trade.maxProfit);
    const maxLoss = getFiniteNumber(trade.maxLoss);

    const totalCommissions =
      getFiniteNumber(trade.openingCommissionsFees) !== undefined &&
      getFiniteNumber(trade.closingCommissionsFees) !== undefined
        ? (trade.openingCommissionsFees ?? 0) + (trade.closingCommissionsFees ?? 0)
        : undefined;

    const efficiencyResult = calculatePremiumEfficiencyPercent(trade);
    const totalPremium = computeTotalPremium(trade);

    efficiency.push({
      tradeNumber: index + 1,
      date: new Date(trade.dateOpened).toISOString(),
      pl: trade.pl,
      premium,
      avgClosingCost,
      maxProfit,
      maxLoss,
      totalCommissions,
      efficiencyPct: efficiencyResult.percentage,
      efficiencyDenominator: efficiencyResult.denominator,
      efficiencyBasis: efficiencyResult.basis,
      totalPremium,
    });
  });

  return efficiency;
}

/**
 * Calculate margin utilization data for each trade.
 * When an equity curve is provided, uses it to look up equity values instead of
 * the raw fundsAtClose (which may include P&L from other strategies when filtering).
 *
 * Note: The equity curve is indexed by tradeNumber (0 = initial, 1 = after trade 1, etc.)
 * We use the equity AFTER the trade (i.e., at trade's close) for the fundsAtClose value.
 */
function calculateMarginUtilization(
  trades: Trade[],
  equityCurve?: SnapshotChartData["equityCurve"],
) {
  const utilization: SnapshotChartData["marginUtilization"] = [];

  // Build equity lookup by trade number if curve provided
  // This is more reliable than date-based lookup since equity curve points are
  // keyed by close date and may have offset timestamps for uniqueness
  const equityByTradeNumber = new Map<number, number>();
  if (equityCurve) {
    for (const point of equityCurve) {
      equityByTradeNumber.set(point.tradeNumber, point.equity);
    }
  }

  trades.forEach((trade, index) => {
    const marginReq = getFiniteNumber(trade.marginReq) ?? 0;
    const numContracts = getFiniteNumber(trade.numContracts) ?? 0;

    // Use equity curve value if available, otherwise fall back to trade's fundsAtClose
    // The equity after this trade = equityCurve[tradeNumber] where tradeNumber = index + 1
    let fundsAtClose: number;
    if (equityCurve && equityCurve.length > 0) {
      const tradeNumber = index + 1;
      fundsAtClose =
        equityByTradeNumber.get(tradeNumber) ?? getFiniteNumber(trade.fundsAtClose) ?? 0;
    } else {
      fundsAtClose = getFiniteNumber(trade.fundsAtClose) ?? 0;
    }

    if (marginReq === 0 && fundsAtClose === 0 && numContracts === 0) {
      return;
    }

    utilization.push({
      date: new Date(trade.dateOpened).toISOString(),
      marginReq,
      fundsAtClose,
      numContracts,
      pl: trade.pl,
    });
  });

  return utilization;
}

function calculateExitReasonBreakdown(trades: Trade[]) {
  const summaryMap = new Map<
    string,
    { count: number; totalPl: number; totalPlPercent: number; percentSampleCount: number }
  >();

  trades.forEach((trade) => {
    const reason = (trade.reasonForClose && trade.reasonForClose.trim()) || "Unknown";
    const current = summaryMap.get(reason) || {
      count: 0,
      totalPl: 0,
      totalPlPercent: 0,
      percentSampleCount: 0,
    };
    current.count += 1;
    current.totalPl += trade.pl;

    // Calculate percentage return (ROM) if margin is available
    if (trade.marginReq && trade.marginReq > 0) {
      current.totalPlPercent += (trade.pl / trade.marginReq) * 100;
      current.percentSampleCount++;
    }

    summaryMap.set(reason, current);
  });

  return Array.from(summaryMap.entries()).map(
    ([reason, { count, totalPl, totalPlPercent, percentSampleCount }]) => ({
      reason,
      count,
      totalPl,
      avgPl: count > 0 ? totalPl / count : 0,
      avgPlPercent: percentSampleCount > 0 ? totalPlPercent / percentSampleCount : 0,
    }),
  );
}

function calculateHoldingPeriods(trades: Trade[]) {
  const periods: SnapshotChartData["holdingPeriods"] = [];

  trades.forEach((trade, index) => {
    if (!trade.dateOpened) {
      return;
    }

    const openDate = new Date(trade.dateOpened);
    const closeDate = trade.dateClosed ? new Date(trade.dateClosed) : undefined;

    if (isNaN(openDate.getTime())) {
      return;
    }

    let durationHours = 0;
    if (closeDate && !isNaN(closeDate.getTime())) {
      durationHours = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60);
    }

    periods.push({
      tradeNumber: index + 1,
      dateOpened: openDate.toISOString(),
      dateClosed: closeDate ? closeDate.toISOString() : undefined,
      durationHours,
      pl: trade.pl,
      strategy: trade.strategy || "Unknown",
    });
  });

  return periods;
}

/**
 * Wrapper around the shared daily exposure calculation.
 * Maps between local types and the shared function.
 */
function calculateDailyExposure(
  trades: Trade[],
  equityCurve: SnapshotChartData["equityCurve"],
): {
  dailyExposure: SnapshotChartData["dailyExposure"];
  peakDailyExposure: SnapshotChartData["peakDailyExposure"];
  peakDailyExposurePercent: SnapshotChartData["peakDailyExposurePercent"];
} {
  // Use the shared calculation from lib/calculations/daily-exposure.ts
  return calculateDailyExposureShared(trades, equityCurve);
}
