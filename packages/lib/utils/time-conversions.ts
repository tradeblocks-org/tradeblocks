/**
 * Utilities for converting between time periods and trade counts
 */

export type TimeUnit = "years" | "months" | "days";

/**
 * Convert a time period to number of trades based on trading frequency
 */
export function timeToTrades(value: number, unit: TimeUnit, tradesPerYear: number): number {
  const tradesPerDay = tradesPerYear / 365.25;
  const tradesPerMonth = tradesPerYear / 12;

  switch (unit) {
    case "years":
      return Math.round(value * tradesPerYear);
    case "months":
      return Math.round(value * tradesPerMonth);
    case "days":
      return Math.round(value * tradesPerDay);
    default:
      return Math.round(value * tradesPerYear);
  }
}

/**
 * Convert number of trades to time period based on trading frequency
 */
export function tradesToTime(
  trades: number,
  tradesPerYear: number,
  targetUnit?: TimeUnit,
): { value: number; unit: TimeUnit; displayText: string } {
  const years = trades / tradesPerYear;
  const months = (trades / tradesPerYear) * 12;
  const days = (trades / tradesPerYear) * 365.25;

  // If target unit is specified, use it
  if (targetUnit) {
    switch (targetUnit) {
      case "years":
        return {
          value: years,
          unit: "years",
          displayText: `${years.toFixed(1)} year${years !== 1 ? "s" : ""}`,
        };
      case "months":
        return {
          value: months,
          unit: "months",
          displayText: `${Math.round(months)} month${months !== 1 ? "s" : ""}`,
        };
      case "days":
        return {
          value: days,
          unit: "days",
          displayText: `${Math.round(days)} day${days !== 1 ? "s" : ""}`,
        };
    }
  }

  // Auto-select the most appropriate unit
  if (years >= 1) {
    return {
      value: years,
      unit: "years",
      displayText: `${years.toFixed(1)} year${years !== 1 ? "s" : ""}`,
    };
  } else if (months >= 1) {
    return {
      value: months,
      unit: "months",
      displayText: `${Math.round(months)} month${Math.round(months) !== 1 ? "s" : ""}`,
    };
  } else {
    return {
      value: days,
      unit: "days",
      displayText: `${Math.round(days)} day${Math.round(days) !== 1 ? "s" : ""}`,
    };
  }
}

/**
 * Convert a percentage of total trades to a trade count
 */
export function percentageToTrades(percentage: number, totalTrades: number): number {
  return Math.max(1, Math.round((percentage / 100) * totalTrades));
}

/**
 * Convert a trade count to percentage of total
 */
export function tradesToPercentage(trades: number, totalTrades: number): number {
  if (totalTrades === 0) return 0;
  return Math.min(100, Math.max(0, (trades / totalTrades) * 100));
}

/**
 * Format a trade count with time context
 */
export function formatTradesWithTime(trades: number, tradesPerYear: number): string {
  const time = tradesToTime(trades, tradesPerYear);
  return `${trades.toLocaleString()} trades (≈ ${time.displayText})`;
}

/**
 * Get sensible default values based on trading frequency
 */
export function getDefaultSimulationPeriod(tradesPerYear: number): {
  value: number;
  unit: TimeUnit;
} {
  if (tradesPerYear >= 10000) {
    return { value: 3, unit: "months" };
  }

  if (tradesPerYear >= 1000) {
    return { value: 6, unit: "months" };
  }

  if (tradesPerYear >= 100) {
    return { value: 1, unit: "years" };
  }

  return { value: 2, unit: "years" };
}

/**
 * Get sensible resample window based on total trades
 */
export function getDefaultResamplePercentage(totalTrades: number): number {
  if (totalTrades >= 1000) {
    return 25; // Use last 25% for large datasets
  } else if (totalTrades >= 500) {
    return 50; // Use last 50% for medium datasets
  } else if (totalTrades >= 100) {
    return 75; // Use last 75% for smaller datasets
  } else {
    return 100; // Use all trades for very small datasets
  }
}
