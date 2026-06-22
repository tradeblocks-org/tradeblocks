"use client";

/**
 * Cumulative Distribution Chart
 *
 * Plotly chart showing cumulative distribution of trades by a field.
 */

import { useMemo } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { CumulativeDistributionAnalysis } from "@tradeblocks/lib";

interface CumulativeDistributionChartProps {
  analysis: CumulativeDistributionAnalysis;
  showPl?: boolean;
  className?: string;
}

export function CumulativeDistributionChart({
  analysis,
  showPl = false,
  className,
}: CumulativeDistributionChartProps) {
  const { traces, layout } = useMemo(() => {
    const { fieldLabel, points, stats } = analysis;

    if (points.length === 0) {
      return { traces: [], layout: {} };
    }

    // Trade count trace (primary y-axis)
    const tradeTrace: Partial<PlotData> = {
      x: points.map((p) => p.threshold),
      y: points.map((p) => p.tradesAtOrAbovePercent),
      type: "scatter",
      mode: "lines",
      name: "% Trades (≥)",
      line: { color: "#3b82f6", width: 2 },
      hovertemplate: `${fieldLabel}: %{x:.2f}<br>Trades ≥: %{y:.1f}%<extra></extra>`,
    };

    // Win rate trace (secondary y-axis)
    const winRateTrace: Partial<PlotData> = {
      x: points.map((p) => p.threshold),
      y: points.map((p) => p.winRateAtOrAbove),
      type: "scatter",
      mode: "lines",
      name: "Win Rate (≥)",
      line: { color: "#22c55e", width: 2, dash: "dash" },
      yaxis: "y2",
      hovertemplate: `${fieldLabel}: %{x:.2f}<br>Win Rate: %{y:.1f}%<extra></extra>`,
    };

    // Avg ROM trace
    const romTrace: Partial<PlotData> = {
      x: points.map((p) => p.threshold),
      y: points.map((p) => p.avgRomAtOrAbove),
      type: "scatter",
      mode: "lines",
      name: "Avg ROM (≥)",
      line: { color: "#8b5cf6", width: 2, dash: "dot" },
      yaxis: "y2",
      hovertemplate: `${fieldLabel}: %{x:.2f}<br>Avg ROM: %{y:.1f}%<extra></extra>`,
    };

    const chartTraces: Partial<PlotData>[] = [tradeTrace, winRateTrace, romTrace];

    // Optional P&L trace
    if (showPl) {
      const plTrace: Partial<PlotData> = {
        x: points.map((p) => p.threshold),
        y: points.map((p) => p.plAtOrAbovePercent),
        type: "scatter",
        mode: "lines",
        name: "% P&L (≥)",
        line: { color: "#f59e0b", width: 2 },
        hovertemplate: `${fieldLabel}: %{x:.2f}<br>P&L ≥: %{y:.1f}%<extra></extra>`,
      };
      chartTraces.push(plTrace);
    }

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: fieldLabel },
        zeroline: false,
      },
      yaxis: {
        title: { text: "% of Trades / P&L" },
        range: [0, 105],
        zeroline: false,
      },
      yaxis2: {
        title: { text: "Win Rate / ROM %" },
        overlaying: "y",
        side: "right",
        range: [-10, 105],
        zeroline: false,
      },
      showlegend: true,
      legend: {
        orientation: "h",
        y: -0.2,
      },
      hovermode: "x unified",
      margin: { t: 30, b: 80 },
      // Reference lines for statistics
      shapes: [
        {
          type: "line",
          x0: stats.mean,
          x1: stats.mean,
          y0: 0,
          y1: 100,
          line: { color: "#94a3b8", width: 1, dash: "dot" },
        },
        {
          type: "line",
          x0: stats.median,
          x1: stats.median,
          y0: 0,
          y1: 100,
          line: { color: "#64748b", width: 1, dash: "dash" },
        },
      ],
      annotations: [
        {
          x: stats.mean,
          y: 95,
          text: `Mean: ${stats.mean.toFixed(2)}`,
          showarrow: false,
          font: { size: 10, color: "#94a3b8" },
          xanchor: "left",
          xshift: 5,
        },
        {
          x: stats.median,
          y: 90,
          text: `Median: ${stats.median.toFixed(2)}`,
          showarrow: false,
          font: { size: 10, color: "#64748b" },
          xanchor: "left",
          xshift: 5,
        },
      ],
    };

    return { traces: chartTraces, layout: chartLayout };
  }, [analysis, showPl]);

  if (analysis.points.length === 0) {
    return (
      <div className="h-[400px] flex items-center justify-center text-muted-foreground">
        No data available. Field may not have values for these trades.
      </div>
    );
  }

  const tooltip = {
    flavor: `Distribution of trades across ${analysis.fieldLabel} thresholds`,
    detailed:
      "Shows what percentage of trades (and optionally P&L) occur at or above each threshold level. The dashed lines show win rate and ROM at each threshold. Vertical lines mark mean and median values.",
  };

  return (
    <ChartWrapper
      title=""
      description=""
      data={traces as PlotData[]}
      layout={layout}
      className={className}
      tooltip={tooltip}
      style={{ height: "400px" }}
    />
  );
}

export default CumulativeDistributionChart;
