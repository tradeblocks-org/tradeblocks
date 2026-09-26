import type { Trade } from "../models/trade.ts";
import { formatDateKey } from "./trade-matching.ts";
import { getGrossPl, getNetPl } from "../utils/equity-curve.ts";
import { PortfolioStatsCalculator } from "./portfolio-stats.ts";

function getRealizationDate(trade: Trade): Date {
  return new Date(trade.dateClosed ?? trade.dateOpened);
}

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
    (a, b) => getRealizationDate(a).getTime() - getRealizationDate(b).getTime(),
  );

  // Calculate initial capital from first trade
  let initialCapital = PortfolioStatsCalculator.calculateInitialCapital(sortedTrades);
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
      date: formatDateKey(getRealizationDate(sortedTrades[0])),
      equity: runningEquity,
      highWaterMark,
      tradeNumber: 0,
    },
  ];

  sortedTrades.forEach((trade, index) => {
    runningEquity += getNetPl(trade);
    highWaterMark = Math.max(highWaterMark, runningEquity);

    curve.push({
      date: formatDateKey(getRealizationDate(trade)),
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
    const date = getRealizationDate(trade);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    monthlyData[monthKey] = (monthlyData[monthKey] || 0) + getNetPl(trade);
  });

  const monthlyReturns: Record<number, Record<number, number>> = {};
  const years = new Set<number>();

  trades.forEach((trade) => {
    years.add(getRealizationDate(trade).getFullYear());
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

  const returns = trades.map(getNetPl);
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
    const date = getRealizationDate(trade);
    const jsDay = date.getDay();
    const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
    const day = dayNames[pythonWeekday];

    if (!dayData[day]) {
      dayData[day] = { count: 0, totalPl: 0, totalPlPercent: 0, percentCount: 0 };
    }
    dayData[day].count++;
    dayData[day].totalPl += getNetPl(trade);

    // Calculate ROM if margin available
    if (trade.marginReq && trade.marginReq > 0) {
      dayData[day].totalPlPercent += (getNetPl(trade) / trade.marginReq) * 100;
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
      pl: getNetPl(trade),
      rom: marginReq && marginReq > 0 ? (getNetPl(trade) / marginReq) * 100 : null,
      date: formatDateKey(getRealizationDate(trade)),
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
        date: formatDateKey(getRealizationDate(trade)),
        rom: (getNetPl(trade) / trade.marginReq) * 100,
        tradeNumber: index + 1,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}
/**
 * Build rolling metrics (30-trade rolling window).
 *
 * `sharpeRatio` is retained for response compatibility but is a nonannualized
 * trade-P/L signal-to-noise visualization, not portfolio daily-return Sharpe.
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

  const plValues = trades.map(getNetPl);

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

    const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

    metrics.push({
      date: formatDateKey(getRealizationDate(trades[i])),
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
    current.totalPl += getNetPl(trade);

    if (trade.marginReq && trade.marginReq > 0) {
      current.totalRom += (getNetPl(trade) / trade.marginReq) * 100;
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
      pl: getNetPl(trade),
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
      efficiencyPct = (getNetPl(trade) / Math.abs(premium)) * 100;
    }

    return {
      tradeNumber: index + 1,
      date: formatDateKey(getRealizationDate(trade)),
      pl: getNetPl(trade),
      premium,
      efficiencyPct,
      strategy: trade.strategy || "Unknown",
    };
  });
}
/**
 * Build monthly returns percent (percentage-based)
 * Note: Uses trade-based calculation (initial capital derived from first trade)
 */
function buildMonthlyReturnsPercent(trades: Trade[]): Record<number, Record<number, number>> {
  if (trades.length === 0) return {};

  // Sort trades by date
  const sortedTrades = [...trades].sort(
    (a, b) => getRealizationDate(a).getTime() - getRealizationDate(b).getTime(),
  );

  // Calculate initial capital from first trade
  let runningCapital = PortfolioStatsCalculator.calculateInitialCapital(sortedTrades);
  if (!isFinite(runningCapital) || runningCapital <= 0) {
    runningCapital = 100000;
  }

  // Group trades by month
  const monthlyData: Record<string, { pl: number; startingCapital: number }> = {};
  const years = new Set<number>();

  sortedTrades.forEach((trade) => {
    const date = getRealizationDate(trade);
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

    monthlyData[monthKey].pl += getNetPl(trade);
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

export {
  buildEquityCurve as buildRealizedEquityCurveByCloseDate,
  buildDrawdownSeries as buildRealizedDrawdownSeries,
  buildMonthlyReturns as buildRealizedMonthlyReturnsByCloseDate,
  buildMonthlyReturnsPercent as buildRealizedMonthlyReturnPercentByCloseDate,
  buildReturnDistribution as buildRealizedTradePlDistribution,
  buildDayOfWeekData as buildRealizedWeekdayDataByCloseDate,
  buildTradeSequence as buildRealizedTradeSequenceByCloseDate,
  buildRomTimeline as buildRealizedRomTimelineByCloseDate,
  buildRollingMetrics as buildRealizedRollingMetricsByCloseDate,
  buildExitReasonBreakdown as buildRealizedExitReasonBreakdown,
  buildHoldingPeriods as buildRealizedHoldingPeriods,
  buildPremiumEfficiency as buildRealizedPremiumEfficiencyByCloseDate,
};

/** Aggregate reported, gross and net P/L by the trade's close date (opening date if unclosed). */
export function buildRealizedPeriodReturnsByCloseDate(
  trades: Trade[],
  period: "daily" | "weekly" | "monthly",
): {
  periods: Array<{
    period: string;
    reportedPl: number;
    grossPl: number;
    commissions: number;
    netPl: number;
    tradeCount: number;
  }>;
  totals: {
    reportedPl: number;
    grossPl: number;
    commissions: number;
    netPl: number;
    tradeCount: number;
  };
} {
  const periodData = new Map<
    string,
    { reportedPl: number; grossPl: number; commissions: number; netPl: number; tradeCount: number }
  >();
  trades.forEach((trade) => {
    const date = getRealizationDate(trade);
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
      periodKey = formatDateKey(date);
    }
    const existing = periodData.get(periodKey) || {
      reportedPl: 0,
      grossPl: 0,
      commissions: 0,
      netPl: 0,
      tradeCount: 0,
    };
    const totalCommissions =
      (trade.openingCommissionsFees ?? 0) + (trade.closingCommissionsFees ?? 0);
    existing.reportedPl += trade.pl;
    existing.grossPl += getGrossPl(trade);
    existing.commissions += totalCommissions;
    existing.netPl += getNetPl(trade);
    existing.tradeCount += 1;
    periodData.set(periodKey, existing);
  });
  const periods = Array.from(periodData.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([periodKey, data]) => ({ period: periodKey, ...data }));
  const totals = {
    reportedPl: periods.reduce((sum, p) => sum + p.reportedPl, 0),
    grossPl: periods.reduce((sum, p) => sum + p.grossPl, 0),
    commissions: periods.reduce((sum, p) => sum + p.commissions, 0),
    netPl: periods.reduce((sum, p) => sum + p.netPl, 0),
    tradeCount: periods.reduce((sum, p) => sum + p.tradeCount, 0),
  };
  return { periods, totals };
}

/** Close-window attribution uses reported trade P/L, matching the realized-only MCP view. */
export function buildRealizedDrawdownAttributionByCloseDate(trades: Trade[], topN: number) {
  const sortedTrades = [...trades].sort((a, b) => {
    const dateA = new Date(a.dateClosed ?? a.dateOpened);
    const dateB = new Date(b.dateClosed ?? b.dateOpened);
    if (dateA.getTime() !== dateB.getTime()) return dateA.getTime() - dateB.getTime();
    const timeA = a.timeClosed ?? a.timeOpened ?? "";
    const timeB = b.timeClosed ?? b.timeOpened ?? "";
    return timeA.localeCompare(timeB);
  });
  if (sortedTrades.length === 0) return null;
  const firstTrade = sortedTrades[0];
  const initialCapital = (firstTrade.fundsAtClose ?? 10000) - firstTrade.pl;
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let peakDate: Date = new Date(firstTrade.dateClosed ?? firstTrade.dateOpened);
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let troughDate: Date | null = null;
  let drawdownPeakDate: Date | null = null;
  for (const trade of sortedTrades) {
    equity += trade.pl;
    const closeDate = new Date(trade.dateClosed ?? trade.dateOpened);
    if (equity > peakEquity) {
      peakEquity = equity;
      peakDate = closeDate;
    }
    const drawdown = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
      troughDate = closeDate;
      drawdownPeakDate = peakDate;
    }
  }
  if (maxDrawdown <= 0 || !troughDate || !drawdownPeakDate) return null;
  const drawdownTrades = sortedTrades.filter((trade) => {
    const closeDate = new Date(trade.dateClosed ?? trade.dateOpened);
    return closeDate >= drawdownPeakDate && closeDate <= troughDate;
  });
  const strategyPl = new Map<
    string,
    { pl: number; trades: number; wins: number; losses: number }
  >();
  let totalLossDuringDrawdown = 0;
  for (const trade of drawdownTrades) {
    const existing = strategyPl.get(trade.strategy) ?? { pl: 0, trades: 0, wins: 0, losses: 0 };
    existing.pl += trade.pl;
    existing.trades += 1;
    if (trade.pl > 0) existing.wins += 1;
    else if (trade.pl < 0) existing.losses += 1;
    strategyPl.set(trade.strategy, existing);
    totalLossDuringDrawdown += trade.pl;
  }
  const attribution = Array.from(strategyPl.entries())
    .map(([strategyName, data]) => ({
      strategy: strategyName,
      pl: data.pl,
      trades: data.trades,
      wins: data.wins,
      losses: data.losses,
      contributionPct:
        totalLossDuringDrawdown !== 0 ? Math.abs((data.pl / totalLossDuringDrawdown) * 100) : 0,
    }))
    .sort((a, b) => a.pl - b.pl)
    .slice(0, topN);
  const durationMs = troughDate.getTime() - drawdownPeakDate.getTime();
  const durationDays = Math.ceil(durationMs / (1000 * 60 * 60 * 24));
  const peakDateStr = formatDateKey(drawdownPeakDate);
  const troughDateStr = formatDateKey(troughDate);
  return {
    maxDrawdownPct,
    peakDateStr,
    troughDateStr,
    drawdownPeriod: {
      peakDate: peakDateStr,
      troughDate: troughDateStr,
      peakEquity,
      troughEquity: peakEquity - maxDrawdown,
      maxDrawdown,
      maxDrawdownPct,
      durationDays,
    },
    periodStats: { totalTrades: drawdownTrades.length, totalPl: totalLossDuringDrawdown },
    attribution,
  };
}
