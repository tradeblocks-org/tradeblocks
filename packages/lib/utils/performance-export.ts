/**
 * Performance chart export utilities
 * Each export function generates CSV content for a specific chart's raw data
 */

import type { SnapshotChartData } from "../services/performance-snapshot.ts";
import { toCsvRow } from "./export-helpers.ts";

export const TAB_ORDER = [
  "Overview",
  "Returns Analysis",
  "Risk & Margin",
  "Trade Efficiency",
  "Excursion Analysis",
] as const;

export type ChartTab = (typeof TAB_ORDER)[number];

export interface ChartExportConfig {
  id: string;
  name: string;
  description: string;
  tab: ChartTab;
  exportFn: (data: SnapshotChartData) => string[];
}

/**
 * All available chart exports organized by tab
 */
export const CHART_EXPORTS: ChartExportConfig[] = [
  // Overview Tab
  {
    id: "equity-curve",
    name: "Cumulative P&L (Equity Curve)",
    description: "Daily equity values with high water mark",
    tab: "Overview",
    exportFn: (data) => {
      const lines = [
        "# Equity Curve",
        toCsvRow(["Date", "Equity", "High Water Mark", "Trade Number"]),
      ];
      for (const point of data.equityCurve) {
        lines.push(
          toCsvRow([
            point.date,
            point.equity.toFixed(2),
            point.highWaterMark.toFixed(2),
            point.tradeNumber,
          ]),
        );
      }
      return lines;
    },
  },
  {
    id: "drawdown",
    name: "Drawdown Chart",
    description: "Drawdown percentage over time",
    tab: "Overview",
    exportFn: (data) => {
      const lines = ["# Drawdown Data", toCsvRow(["Date", "Drawdown %"])];
      for (const point of data.drawdownData) {
        lines.push(toCsvRow([point.date, point.drawdownPct.toFixed(2)]));
      }
      return lines;
    },
  },
  {
    id: "win-loss-streaks",
    name: "Win/Loss Streaks",
    description: "Distribution of consecutive wins and losses",
    tab: "Overview",
    exportFn: (data) => {
      const lines = ["# Win/Loss Streak Distribution"];

      // Win streaks
      lines.push("");
      lines.push("# Win Streaks");
      lines.push(toCsvRow(["Streak Length", "Frequency"]));
      const winLengths = Object.keys(data.streakData.winDistribution)
        .map(Number)
        .sort((a, b) => a - b);
      for (const length of winLengths) {
        lines.push(toCsvRow([length, data.streakData.winDistribution[length]]));
      }

      // Loss streaks
      lines.push("");
      lines.push("# Loss Streaks");
      lines.push(toCsvRow(["Streak Length", "Frequency"]));
      const lossLengths = Object.keys(data.streakData.lossDistribution)
        .map(Number)
        .sort((a, b) => a - b);
      for (const length of lossLengths) {
        lines.push(toCsvRow([length, data.streakData.lossDistribution[length]]));
      }

      // Statistics
      lines.push("");
      lines.push("# Statistics");
      lines.push(toCsvRow(["Metric", "Value"]));
      lines.push(toCsvRow(["Max Win Streak", data.streakData.statistics.maxWinStreak]));
      lines.push(toCsvRow(["Max Loss Streak", data.streakData.statistics.maxLossStreak]));
      lines.push(toCsvRow(["Avg Win Streak", data.streakData.statistics.avgWinStreak.toFixed(2)]));
      lines.push(
        toCsvRow(["Avg Loss Streak", data.streakData.statistics.avgLossStreak.toFixed(2)]),
      );

      return lines;
    },
  },

  // Returns Analysis Tab
  {
    id: "monthly-returns",
    name: "Monthly Returns Heatmap",
    description: "P&L by month and year",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# Monthly Returns (P&L)"];
      lines.push(
        toCsvRow([
          "Year",
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
          "Total",
        ]),
      );

      const years = Object.keys(data.monthlyReturns).map(Number).sort();
      for (const year of years) {
        const months: (string | number)[] = [year];
        let yearTotal = 0;
        for (let m = 1; m <= 12; m++) {
          const val = data.monthlyReturns[year]?.[m];
          if (val !== undefined && val !== 0) {
            months.push(val.toFixed(2));
            yearTotal += val;
          } else {
            months.push("");
          }
        }
        months.push(yearTotal.toFixed(2));
        lines.push(toCsvRow(months));
      }

      // Monthly returns percent
      lines.push("");
      lines.push("# Monthly Returns (%)");
      lines.push(
        toCsvRow([
          "Year",
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ]),
      );

      for (const year of years) {
        const months: (string | number)[] = [year];
        for (let m = 1; m <= 12; m++) {
          const val = data.monthlyReturnsPercent[year]?.[m];
          if (val !== undefined && val !== 0) {
            months.push(`${val.toFixed(2)}%`);
          } else {
            months.push("");
          }
        }
        lines.push(toCsvRow(months));
      }

      return lines;
    },
  },
  {
    id: "return-distribution",
    name: "Return Distribution",
    description: "ROM values for histogram analysis",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# Return Distribution (ROM %)"];

      // Detailed inputs (includes margin) when available
      if (data.returnDistributionDetails && data.returnDistributionDetails.length > 0) {
        lines.push(
          toCsvRow(["Trade #", "Date", "P&L ($)", "Margin Req ($)", "ROM (%)", "Strategy"]),
        );
        data.returnDistributionDetails.forEach((t) => {
          lines.push(
            toCsvRow([
              t.tradeNumber,
              t.date,
              t.pl.toFixed(2),
              t.marginReq.toFixed(2),
              t.rom.toFixed(2),
              t.strategy ?? "",
            ]),
          );
        });
      } else {
        lines.push(toCsvRow(["Trade Index", "ROM %"]));
        data.returnDistribution.forEach((rom, index) => {
          lines.push(toCsvRow([index + 1, rom.toFixed(2)]));
        });
      }

      // Add summary statistics
      if (data.returnDistribution.length > 0) {
        const sorted = [...data.returnDistribution].sort((a, b) => a - b);
        const mean =
          data.returnDistribution.reduce((a, b) => a + b, 0) / data.returnDistribution.length;
        const median = sorted[Math.floor(sorted.length / 2)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        lines.push("");
        lines.push("# Statistics");
        lines.push(toCsvRow(["Metric", "Value"]));
        lines.push(toCsvRow(["Count", data.returnDistribution.length]));
        lines.push(toCsvRow(["Mean", `${mean.toFixed(2)}%`]));
        lines.push(toCsvRow(["Median", `${median.toFixed(2)}%`]));
        lines.push(toCsvRow(["Min", `${min.toFixed(2)}%`]));
        lines.push(toCsvRow(["Max", `${max.toFixed(2)}%`]));
      }

      return lines;
    },
  },
  {
    id: "day-of-week",
    name: "Day of Week Performance",
    description: "Performance breakdown by day of week",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# Day of Week Performance"];
      lines.push(toCsvRow(["Day", "Trade Count", "Avg P&L ($)", "Avg ROM (%)"]));
      for (const dow of data.dayOfWeekData) {
        lines.push(
          toCsvRow([dow.day, dow.count, dow.avgPl.toFixed(2), `${dow.avgPlPercent.toFixed(2)}%`]),
        );
      }
      return lines;
    },
  },
  {
    id: "trade-sequence",
    name: "Trade Sequence",
    description: "P&L and ROM for each trade in sequence",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# Trade Sequence"];
      const hasMargin = data.tradeSequence.some((t) => typeof t.marginReq === "number");
      lines.push(
        hasMargin
          ? toCsvRow(["Trade #", "Date", "P&L ($)", "Margin Req ($)", "ROM (%)"])
          : toCsvRow(["Trade #", "Date", "P&L ($)", "ROM (%)"]),
      );
      for (const trade of data.tradeSequence) {
        const base = [trade.tradeNumber, trade.date, trade.pl.toFixed(2)];
        if (hasMargin) {
          base.push((trade.marginReq ?? 0).toFixed(2));
        }
        base.push(trade.rom.toFixed(2));
        lines.push(toCsvRow(base));
      }
      return lines;
    },
  },
  {
    id: "rolling-metrics",
    name: "Rolling Metrics",
    description: "30-trade rolling win rate, Sharpe, and profit factor",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# Rolling Metrics (30-trade window)"];
      lines.push(toCsvRow(["Date", "Win Rate (%)", "Sharpe Ratio", "Profit Factor", "Volatility"]));
      for (const m of data.rollingMetrics) {
        lines.push(
          toCsvRow([
            m.date,
            m.winRate.toFixed(2),
            m.sharpeRatio.toFixed(2),
            m.profitFactor.toFixed(2),
            m.volatility.toFixed(2),
          ]),
        );
      }
      return lines;
    },
  },
  {
    id: "vix-regime",
    name: "VIX Regime Analysis",
    description: "Trade performance by VIX levels",
    tab: "Returns Analysis",
    exportFn: (data) => {
      const lines = ["# VIX Regime Analysis"];
      lines.push(toCsvRow(["Date", "Opening VIX", "Closing VIX", "P&L ($)", "ROM (%)"]));
      for (const v of data.volatilityRegimes) {
        lines.push(
          toCsvRow([
            v.date,
            v.openingVix?.toFixed(2) ?? "",
            v.closingVix?.toFixed(2) ?? "",
            v.pl.toFixed(2),
            v.rom !== undefined ? v.rom.toFixed(2) : "",
          ]),
        );
      }
      return lines;
    },
  },

  // Risk & Margin Tab
  {
    id: "rom-timeline",
    name: "ROM Timeline",
    description: "Return on Margin over time",
    tab: "Risk & Margin",
    exportFn: (data) => {
      const lines = ["# ROM Timeline"];
      lines.push(toCsvRow(["Date", "ROM (%)"]));
      for (const point of data.romTimeline) {
        lines.push(toCsvRow([point.date, point.rom.toFixed(2)]));
      }
      return lines;
    },
  },
  {
    id: "margin-utilization",
    name: "Margin Utilization",
    description: "Margin requirements and account funds over time",
    tab: "Risk & Margin",
    exportFn: (data) => {
      const lines = ["# Margin Utilization"];
      lines.push(
        toCsvRow(["Date", "Margin Required ($)", "Funds at Close ($)", "Contracts", "P&L ($)"]),
      );
      for (const m of data.marginUtilization) {
        lines.push(
          toCsvRow([
            m.date,
            m.marginReq.toFixed(2),
            m.fundsAtClose.toFixed(2),
            m.numContracts,
            m.pl.toFixed(2),
          ]),
        );
      }
      return lines;
    },
  },
  {
    id: "holding-duration",
    name: "Holding Duration",
    description: "Trade duration and P&L relationship",
    tab: "Risk & Margin",
    exportFn: (data) => {
      const lines = ["# Holding Duration"];
      lines.push(
        toCsvRow([
          "Trade #",
          "Date Opened",
          "Date Closed",
          "Duration (hours)",
          "P&L ($)",
          "Strategy",
        ]),
      );
      for (const h of data.holdingPeriods) {
        lines.push(
          toCsvRow([
            h.tradeNumber,
            h.dateOpened,
            h.dateClosed ?? "",
            h.durationHours.toFixed(1),
            h.pl.toFixed(2),
            h.strategy,
          ]),
        );
      }
      return lines;
    },
  },

  // Trade Efficiency Tab
  {
    id: "exit-reasons",
    name: "Exit Reason Breakdown",
    description: "Performance by exit reason",
    tab: "Trade Efficiency",
    exportFn: (data) => {
      const lines = ["# Exit Reason Breakdown"];
      lines.push(toCsvRow(["Exit Reason", "Count", "Total P&L ($)", "Avg P&L ($)"]));
      for (const e of data.exitReasonBreakdown) {
        lines.push(toCsvRow([e.reason, e.count, e.totalPl.toFixed(2), e.avgPl.toFixed(2)]));
      }
      return lines;
    },
  },
  {
    id: "premium-efficiency",
    name: "Premium Efficiency",
    description: "Premium capture efficiency per trade",
    tab: "Trade Efficiency",
    exportFn: (data) => {
      const lines = ["# Premium Efficiency"];
      lines.push(
        toCsvRow([
          "Trade #",
          "Date",
          "P&L ($)",
          "Premium ($)",
          "Total Premium ($)",
          "Efficiency (%)",
          "Efficiency Basis",
        ]),
      );
      for (const p of data.premiumEfficiency) {
        lines.push(
          toCsvRow([
            p.tradeNumber,
            p.date,
            p.pl.toFixed(2),
            p.premium !== undefined ? p.premium.toFixed(2) : "",
            p.totalPremium !== undefined ? p.totalPremium.toFixed(2) : "",
            p.efficiencyPct !== undefined ? `${p.efficiencyPct.toFixed(2)}%` : "",
            p.efficiencyBasis ?? "",
          ]),
        );
      }
      return lines;
    },
  },

  // Excursion Analysis Tab
  {
    id: "mfe-mae-scatter",
    name: "MFE/MAE Analysis",
    description: "Per-trade excursion data (MFE/MAE in $ and %) plus distribution buckets",
    tab: "Excursion Analysis",
    exportFn: (data) => {
      const lines = ["# MFE/MAE Analysis"];
      lines.push(
        toCsvRow([
          "Trade #",
          "Date",
          "P&L ($)",
          "MFE ($)",
          "MAE ($)",
          "MFE % (of margin)",
          "MAE % (of margin)",
          "Result",
        ]),
      );
      for (const point of data.mfeMaeData) {
        lines.push(
          toCsvRow([
            point.tradeNumber,
            point.date instanceof Date ? point.date.toISOString() : String(point.date),
            point.pl.toFixed(2),
            point.mfe.toFixed(2),
            point.mae.toFixed(2),
            point.mfePercent !== undefined ? point.mfePercent.toFixed(2) : "",
            point.maePercent !== undefined ? point.maePercent.toFixed(2) : "",
            point.isWinner ? "Win" : "Loss",
          ]),
        );
      }

      // Add distribution summary
      if (data.mfeMaeDistribution.length > 0) {
        lines.push("");
        lines.push("# Excursion Distribution");
        lines.push(toCsvRow(["Bucket", "MFE Count", "MAE Count"]));
        for (const bucket of data.mfeMaeDistribution) {
          lines.push(toCsvRow([bucket.bucket, bucket.mfeCount, bucket.maeCount]));
        }
      }

      return lines;
    },
  },
];

/**
 * Get chart exports grouped by tab
 */
export function getChartExportsByTab(): Record<string, ChartExportConfig[]> {
  const byTab: Record<string, ChartExportConfig[]> = {};
  for (const chart of CHART_EXPORTS) {
    if (!byTab[chart.tab]) {
      byTab[chart.tab] = [];
    }
    byTab[chart.tab].push(chart);
  }
  return byTab;
}

/**
 * Export multiple charts as a combined CSV
 */
export function exportMultipleCharts(data: SnapshotChartData, chartIds: string[]): string[] {
  const lines: string[] = [];
  const selectedCharts = CHART_EXPORTS.filter((c) => chartIds.includes(c.id));

  for (let i = 0; i < selectedCharts.length; i++) {
    const chart = selectedCharts[i];
    if (i > 0) {
      lines.push(""); // Separator between charts
      lines.push(""); // Extra line for readability
    }
    lines.push(...chart.exportFn(data));
  }

  return lines;
}

/**
 * Export a single chart by ID as CSV
 */
export function exportSingleChart(data: SnapshotChartData, chartId: string): string[] | null {
  const chart = CHART_EXPORTS.find((c) => c.id === chartId);
  if (!chart) return null;
  return chart.exportFn(data);
}

/**
 * Get raw JSON data for a single chart
 */
export function getChartJsonData(
  data: SnapshotChartData,
  chartId: string,
): Record<string, unknown> | null {
  const jsonExporters: Record<string, (data: SnapshotChartData) => Record<string, unknown>> = {
    "equity-curve": (d) => ({
      chartName: "Equity Curve",
      data: d.equityCurve,
    }),
    drawdown: (d) => ({
      chartName: "Drawdown",
      data: d.drawdownData,
    }),
    "win-loss-streaks": (d) => ({
      chartName: "Win/Loss Streaks",
      winDistribution: d.streakData.winDistribution,
      lossDistribution: d.streakData.lossDistribution,
      statistics: d.streakData.statistics,
    }),
    "monthly-returns": (d) => ({
      chartName: "Monthly Returns",
      monthlyReturnsPL: d.monthlyReturns,
      monthlyReturnsPercent: d.monthlyReturnsPercent,
    }),
    "return-distribution": (d) => {
      const sorted = [...d.returnDistribution].sort((a, b) => a - b);
      const mean =
        d.returnDistribution.length > 0
          ? d.returnDistribution.reduce((a, b) => a + b, 0) / d.returnDistribution.length
          : 0;
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      return {
        chartName: "Return Distribution",
        values: d.returnDistribution,
        inputs: d.returnDistributionDetails,
        statistics: {
          count: d.returnDistribution.length,
          mean,
          median,
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
        },
      };
    },
    "day-of-week": (d) => ({
      chartName: "Day of Week Performance",
      data: d.dayOfWeekData,
    }),
    "trade-sequence": (d) => ({
      chartName: "Trade Sequence",
      data: d.tradeSequence,
    }),
    "rolling-metrics": (d) => ({
      chartName: "Rolling Metrics",
      windowSize: 30,
      data: d.rollingMetrics,
    }),
    "vix-regime": (d) => ({
      chartName: "VIX Regime Analysis",
      data: d.volatilityRegimes,
    }),
    "rom-timeline": (d) => ({
      chartName: "ROM Timeline",
      data: d.romTimeline,
    }),
    "margin-utilization": (d) => ({
      chartName: "Margin Utilization",
      data: d.marginUtilization,
    }),
    "holding-duration": (d) => ({
      chartName: "Holding Duration",
      data: d.holdingPeriods,
    }),
    "exit-reasons": (d) => ({
      chartName: "Exit Reason Breakdown",
      data: d.exitReasonBreakdown,
    }),
    "premium-efficiency": (d) => ({
      chartName: "Premium Efficiency",
      data: d.premiumEfficiency,
    }),
    "mfe-mae-scatter": (d) => ({
      chartName: "MFE/MAE Analysis",
      data: d.mfeMaeData.map((point) => ({
        ...point,
        date: point.date instanceof Date ? point.date.toISOString() : point.date,
      })),
      stats: d.mfeMaeStats,
      distribution: d.mfeMaeDistribution,
    }),
  };

  const exporter = jsonExporters[chartId];
  if (!exporter) return null;
  return exporter(data);
}

/**
 * Get JSON data for multiple charts
 */
export function getMultipleChartsJson(
  data: SnapshotChartData,
  chartIds: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    charts: {} as Record<string, unknown>,
  };

  for (const chartId of chartIds) {
    const chartData = getChartJsonData(data, chartId);
    if (chartData) {
      (result.charts as Record<string, unknown>)[chartId] = chartData;
    }
  }

  return result;
}
