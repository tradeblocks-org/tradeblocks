/**
 * Utilities for converting between time periods and trade counts
 */

/**
 * Units a simulation horizon can be expressed in.
 *
 * "trades" is an exact count and needs no frequency conversion, which matters
 * when the horizon is meant to match a specific history length: 83 trades is
 * 83 trades, whereas 2 years at 20 trades/year rounds to 40.
 */
export type TimeUnit = "years" | "months" | "days" | "trades";

/**
 * Convert a time period to number of trades based on trading frequency
 */
export function timeToTrades(value: number, unit: TimeUnit, tradesPerYear: number): number {
  const tradesPerDay = tradesPerYear / 365.25;
  const tradesPerMonth = tradesPerYear / 12;

  switch (unit) {
    case "trades":
      return Math.round(value);
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
 * Re-express a horizon in a different unit without changing how long it is.
 *
 * Switching the unit on its own is not a request for a different horizon, so the
 * number has to move with it: 83 trades at 20 trades/year is 4.15 years, not
 * 83 years. Reading the raw number under the new unit would silently turn an
 * 83-trade run into a 1,660-trade one.
 *
 * The trade count is preserved as closely as the target unit allows — exactly
 * for "trades", and to two decimals otherwise, which keeps the displayed value
 * readable while staying within a trade of the original.
 */
export function convertPeriodUnit(
  value: number,
  fromUnit: TimeUnit,
  toUnit: TimeUnit,
  tradesPerYear: number,
): number {
  if (fromUnit === toUnit) {
    return value;
  }

  const trades = timeToTrades(value, fromUnit, tradesPerYear);

  if (toUnit === "trades") {
    return Math.max(1, trades);
  }

  const converted = tradesToTime(trades, tradesPerYear, toUnit).value;
  return Math.max(0.01, Math.round(converted * 100) / 100);
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
      case "trades":
        return {
          value: trades,
          unit: "trades",
          displayText: `${trades.toLocaleString()} trade${trades !== 1 ? "s" : ""}`,
        };
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
 * Default simulation horizon: the length of the history being simulated.
 *
 * Simulating the block's own length is the comparable default — it is what the
 * user just looked at, and it is what other simulators project. Expressed in
 * "trades" so the horizon is the exact trade count rather than a frequency
 * round-trip that loses trades.
 *
 * @param historicalTradeCount - Trades in scope, after any strategy filter
 */
export function getDefaultSimulationPeriodFromHistory(historicalTradeCount: number): {
  value: number;
  unit: TimeUnit;
} {
  return { value: Math.max(1, Math.round(historicalTradeCount)), unit: "trades" };
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
