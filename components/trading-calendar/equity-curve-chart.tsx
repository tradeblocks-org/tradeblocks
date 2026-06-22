"use client";

import { ChartWrapper, createLineChartLayout } from "@/components/performance-charts/chart-wrapper";
import { Badge } from "@/components/ui/badge";
import { Trade } from "@tradeblocks/lib";
import { ReportingTrade } from "@tradeblocks/lib";
import {
  useTradingCalendarStore,
  StrategyMatch,
  ScalingMode,
  CalendarViewMode,
} from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { useMemo } from "react";

/**
 * Get the date range for the current calendar view
 */
function getViewDateRange(
  viewDate: Date,
  viewMode: CalendarViewMode,
): { startDate: Date; endDate: Date } {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  if (viewMode === "month") {
    return {
      startDate: new Date(year, month, 1),
      endDate: new Date(year, month + 1, 0, 23, 59, 59, 999), // End of last day of month
    };
  } else {
    // Week view - get Sunday to Saturday
    const startDate = new Date(viewDate);
    startDate.setDate(viewDate.getDate() - viewDate.getDay()); // Go to Sunday
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6); // Saturday
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
  }
}

/**
 * Format a date range for display
 */
function formatDateRange(startDate: Date, endDate: Date, viewMode: CalendarViewMode): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const yearOptions: Intl.DateTimeFormatOptions = { ...options, year: "numeric" };

  if (viewMode === "month") {
    return startDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } else {
    // Week view: show range
    const start = startDate.toLocaleDateString("en-US", options);
    const end = endDate.toLocaleDateString("en-US", yearOptions);
    return `${start} - ${end}`;
  }
}

interface EquityCurvePoint {
  date: string;
  tradeNumber: number;
  equity: number;
}

/**
 * Build a map of strategy -> first trade's contract count for scaling
 * Uses first trade's numContracts as "unit size" (not sum of all trades)
 */
function buildStrategyContractMap<T extends { strategy: string; numContracts: number }>(
  trades: T[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const trade of trades) {
    // Only store the first trade's contract count per strategy (unit size)
    if (!map.has(trade.strategy)) {
      map.set(trade.strategy, trade.numContracts);
    }
  }
  return map;
}

/**
 * Build equity curve from trades with proper scaling
 * Sorts by close date and calculates cumulative P&L
 *
 * @param trades The trades to process
 * @param scalingMode Current scaling mode
 * @param tradeType Whether these are backtest or actual trades
 * @param strategyMatches Strategy mappings for toReported scaling
 * @param actualContractMap Map of actual strategy -> contract count (for toReported backtest scaling)
 */
function buildEquityCurve(
  trades: (Trade | ReportingTrade)[],
  scalingMode: ScalingMode,
  tradeType: "backtest" | "actual",
  strategyMatches: StrategyMatch[],
  actualContractMap: Map<string, number>,
): EquityCurvePoint[] {
  if (trades.length === 0) return [];

  // Build backtest -> actual strategy name mapping
  const backtestToActualStrategy = new Map<string, string>();
  for (const match of strategyMatches) {
    backtestToActualStrategy.set(match.backtestStrategy, match.actualStrategy);
  }

  // Sort trades by close date (or open date if no close date)
  const sortedTrades = [...trades].sort((a, b) => {
    const dateA = a.dateClosed || a.dateOpened;
    const dateB = b.dateClosed || b.dateOpened;
    return dateA.getTime() - dateB.getTime();
  });

  let cumulativeEquity = 0;
  const curve: EquityCurvePoint[] = [];

  sortedTrades.forEach((trade, index) => {
    let pl = trade.pl;

    if (scalingMode === "perContract") {
      // Normalize to per-contract
      if (trade.numContracts > 0) {
        pl = pl / trade.numContracts;
      }
    } else if (scalingMode === "toReported" && tradeType === "backtest") {
      // Scale backtest DOWN to match actual contract counts
      // Find the corresponding actual strategy
      const actualStrategy = backtestToActualStrategy.get(trade.strategy);
      if (actualStrategy && trade.numContracts > 0) {
        const actualContracts = actualContractMap.get(actualStrategy) ?? 0;
        if (actualContracts > 0) {
          // Scale factor = actualContracts / btContracts
          const scaleFactor = actualContracts / trade.numContracts;
          pl = pl * scaleFactor;
        }
      }
      // If no match found, show raw value (unmatched strategy)
    }
    // For 'actual' trades in toReported mode, no scaling needed - they stay as-is

    cumulativeEquity += pl;
    const date = trade.dateClosed || trade.dateOpened;

    curve.push({
      date: date.toISOString(),
      tradeNumber: index + 1,
      equity: cumulativeEquity,
    });
  });

  return curve;
}

export function EquityCurveChart() {
  const {
    backtestTrades,
    actualTrades,
    scalingMode,
    strategyMatches,
    viewDate,
    calendarViewMode,
    tradeFilterMode,
  } = useTradingCalendarStore();

  // Build equity curves filtered to current calendar view
  const {
    backtestCurve,
    actualCurve,
    matchedBacktestCurve,
    matchedActualCurve,
    unmatchedBacktestCurve,
    unmatchedActualCurve,
    dateRange,
  } = useMemo(() => {
    // Get the date range for the current calendar view
    const { startDate, endDate } = getViewDateRange(viewDate, calendarViewMode);

    // Filter trades to the current view period
    const filterByDateRange = <T extends { dateClosed?: Date | null; dateOpened: Date }>(
      trades: T[],
    ): T[] => {
      return trades.filter((t) => {
        const tradeDate = t.dateClosed || t.dateOpened;
        return tradeDate >= startDate && tradeDate <= endDate;
      });
    };

    const filteredBacktestTrades = filterByDateRange(backtestTrades);
    const filteredActualTrades = filterByDateRange(actualTrades);

    // Build contract count maps for scaling (from filtered trades)
    const actualContractMap = buildStrategyContractMap(filteredActualTrades);

    // All trades curves
    const btCurve = buildEquityCurve(
      filteredBacktestTrades,
      scalingMode,
      "backtest",
      strategyMatches,
      actualContractMap,
    );
    const actCurve = buildEquityCurve(
      filteredActualTrades,
      scalingMode,
      "actual",
      strategyMatches,
      actualContractMap,
    );

    // Build matched/unmatched strategy sets
    const matchedBacktestStrategies = new Set(strategyMatches.map((m) => m.backtestStrategy));
    const matchedActualStrategies = new Set(strategyMatches.map((m) => m.actualStrategy));

    // Matched trades only curves
    const matchedBtTrades = filteredBacktestTrades.filter((t) =>
      matchedBacktestStrategies.has(t.strategy),
    );
    const matchedActTrades = filteredActualTrades.filter((t) =>
      matchedActualStrategies.has(t.strategy),
    );

    const matchedActualContractMap = buildStrategyContractMap(matchedActTrades);

    const matchedBtCurve = buildEquityCurve(
      matchedBtTrades,
      scalingMode,
      "backtest",
      strategyMatches,
      matchedActualContractMap,
    );
    const matchedActCurve = buildEquityCurve(
      matchedActTrades,
      scalingMode,
      "actual",
      strategyMatches,
      matchedActualContractMap,
    );

    // Unmatched trades only curves
    const unmatchedBtTrades = filteredBacktestTrades.filter(
      (t) => !matchedBacktestStrategies.has(t.strategy),
    );
    const unmatchedActTrades = filteredActualTrades.filter(
      (t) => !matchedActualStrategies.has(t.strategy),
    );

    const unmatchedBtCurve = buildEquityCurve(
      unmatchedBtTrades,
      scalingMode,
      "backtest",
      strategyMatches,
      actualContractMap,
    );
    const unmatchedActCurve = buildEquityCurve(
      unmatchedActTrades,
      scalingMode,
      "actual",
      strategyMatches,
      actualContractMap,
    );

    return {
      backtestCurve: btCurve,
      actualCurve: actCurve,
      matchedBacktestCurve: matchedBtCurve,
      matchedActualCurve: matchedActCurve,
      unmatchedBacktestCurve: unmatchedBtCurve,
      unmatchedActualCurve: unmatchedActCurve,
      dateRange: { startDate, endDate },
    };
  }, [backtestTrades, actualTrades, scalingMode, strategyMatches, viewDate, calendarViewMode]);

  const hasBacktestData = backtestCurve.length > 0;
  const hasActualData = actualCurve.length > 0;

  // Don't show if no data at all
  if (!hasBacktestData && !hasActualData) {
    return null;
  }

  // Select curves based on trade filter mode from store
  const btCurve =
    tradeFilterMode === "matched"
      ? matchedBacktestCurve
      : tradeFilterMode === "unmatched"
        ? unmatchedBacktestCurve
        : backtestCurve;
  const actCurve =
    tradeFilterMode === "matched"
      ? matchedActualCurve
      : tradeFilterMode === "unmatched"
        ? unmatchedActualCurve
        : actualCurve;

  // Build traces
  const traces: Partial<PlotData>[] = [];

  if (btCurve.length > 0) {
    traces.push({
      x: btCurve.map((point) => point.date),
      y: btCurve.map((point) => point.equity),
      type: "scatter",
      mode: "lines",
      name: "Backtest P/L",
      line: {
        color: "#3b82f6", // blue
        width: 2,
        shape: "hv", // Step function
      },
      hovertemplate:
        "<b>Date:</b> %{x}<br>" +
        "<b>Backtest:</b> $%{y:,.2f}<br>" +
        "<b>Trade #:</b> %{customdata}<br>" +
        "<extra></extra>",
      customdata: btCurve.map((point) => point.tradeNumber),
    });
  }

  if (actCurve.length > 0) {
    traces.push({
      x: actCurve.map((point) => point.date),
      y: actCurve.map((point) => point.equity),
      type: "scatter",
      mode: "lines",
      name: "Actual P/L",
      line: {
        color: "#a855f7", // purple (to match actual trades badge color in calendar)
        width: 2,
        shape: "hv", // Step function
      },
      hovertemplate:
        "<b>Date:</b> %{x}<br>" +
        "<b>Actual:</b> $%{y:,.2f}<br>" +
        "<b>Trade #:</b> %{customdata}<br>" +
        "<extra></extra>",
      customdata: actCurve.map((point) => point.tradeNumber),
    });
  }

  // Calculate y-axis range
  const allEquityValues = [...btCurve.map((p) => p.equity), ...actCurve.map((p) => p.equity)];
  const minEquity = allEquityValues.length > 0 ? Math.min(...allEquityValues) : 0;
  const maxEquity = allEquityValues.length > 0 ? Math.max(...allEquityValues) : 0;
  const equityRange = maxEquity - minEquity;
  const padding = equityRange > 0 ? equityRange * 0.1 : Math.max(Math.abs(maxEquity) * 0.1, 100);

  const layout: Partial<Layout> = {
    ...createLineChartLayout("", "Date", "Cumulative P/L ($)"),
    xaxis: {
      title: { text: "Date" },
      showgrid: true,
    },
    yaxis: {
      title: {
        text: "Cumulative P/L ($)",
        standoff: 50,
      },
      showgrid: true,
      zeroline: true,
      zerolinewidth: 2,
      zerolinecolor: "#e5e7eb",
      tickformat: "$,.0f",
      range: [minEquity - padding, maxEquity + padding],
    },
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.02,
      xanchor: "right",
      x: 1,
    },
    hovermode: "x unified",
  };

  // Calculate final difference for matched mode
  let finalDifference: number | null = null;
  let finalPercentDiff: number | null = null;
  if (tradeFilterMode === "matched" && btCurve.length > 0 && actCurve.length > 0) {
    const finalBt = btCurve[btCurve.length - 1].equity;
    const finalAct = actCurve[actCurve.length - 1].equity;
    finalDifference = finalAct - finalBt;
    finalPercentDiff = finalBt !== 0 ? ((finalAct - finalBt) / Math.abs(finalBt)) * 100 : 0;
  }

  // Build scaling mode indicator
  const scalingLabel =
    scalingMode === "perContract"
      ? "Per Contract"
      : scalingMode === "toReported"
        ? "Scaled to Actual"
        : null;

  // Build trade filter mode indicator
  const filterLabel =
    tradeFilterMode === "matched"
      ? "Matched Only"
      : tradeFilterMode === "unmatched"
        ? "Unmatched Only"
        : null;

  const controls = (
    <div className="flex items-center gap-2">
      {scalingLabel && (
        <Badge variant="secondary" className="text-xs">
          {scalingLabel}
        </Badge>
      )}
      {filterLabel && (
        <Badge variant="outline" className="text-xs">
          {filterLabel}
        </Badge>
      )}
    </div>
  );

  // Build description
  const scalingNote =
    scalingMode === "perContract"
      ? " (per contract)"
      : scalingMode === "toReported"
        ? " (scaled to actual)"
        : "";

  // Format period for description
  const periodLabel = formatDateRange(dateRange.startDate, dateRange.endDate, calendarViewMode);

  let description = "";
  if (tradeFilterMode === "matched" && finalDifference !== null && finalPercentDiff !== null) {
    description = `${periodLabel}: ${btCurve.length} backtest vs ${actCurve.length} actual trades${scalingNote}. Diff: $${finalDifference.toFixed(2)} (${finalPercentDiff > 0 ? "+" : ""}${finalPercentDiff.toFixed(2)}%)`;
  } else {
    description = `${periodLabel}: ${btCurve.length} backtest, ${actCurve.length} actual trades${scalingNote}`;
  }

  return (
    <ChartWrapper
      title="Equity Curve Comparison"
      description={description}
      tooltip={{
        flavor: "Side-by-side comparison of backtest vs actual performance over time",
        detailed:
          tradeFilterMode === "matched"
            ? "This chart shows how your actual performance compares to your backtest expectations for matched strategies. Divergence between the lines reveals slippage, execution differences, or timing variations accumulating over time."
            : tradeFilterMode === "unmatched"
              ? "This chart shows only trades from strategies that are missing a counterpart. These are strategies present in only backtest or only actual data."
              : "This chart shows all trades from both backtest and actual data. This gives you the complete picture of what was planned vs what actually executed.",
      }}
      data={traces}
      layout={layout}
      style={{ height: "400px" }}
    >
      {controls}
    </ChartWrapper>
  );
}
