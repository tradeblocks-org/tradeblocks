"use client";

import React, { useMemo, useState } from "react";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Layout, PlotData } from "plotly.js";

interface TradeSequenceChartProps {
  className?: string;
  showTrend?: boolean;
}

type ViewMode = "dollars" | "percent";

export function TradeSequenceChart({ className, showTrend = true }: TradeSequenceChartProps) {
  const { data } = usePerformanceStore();
  const [viewMode, setViewMode] = useState<ViewMode>("percent");

  const { plotData, layout } = useMemo(() => {
    if (!data?.tradeSequence || data.tradeSequence.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { tradeSequence } = data;

    const tradeNumbers = tradeSequence.map((t) => t.tradeNumber);
    const returns =
      viewMode === "dollars" ? tradeSequence.map((t) => t.pl) : tradeSequence.map((t) => t.rom);
    const colors = returns.map((ret) => (ret > 0 ? "#22c55e" : "#ef4444"));

    const traces: Partial<PlotData>[] = [];

    const hoverTemplate =
      viewMode === "dollars"
        ? "<b>Trade #%{x}</b><br>Return: $%{y:.1f}<extra></extra>"
        : "<b>Trade #%{x}</b><br>Return: %{y:.1f}%<extra></extra>";

    const trendHoverTemplate =
      viewMode === "dollars"
        ? "<b>Trend Line</b><br>Trade: %{x}<br>Trend: $%{y:.1f}<extra></extra>"
        : "<b>Trend Line</b><br>Trade: %{x}<br>Trend: %{y:.1f}%<extra></extra>";

    const yAxisTitle = viewMode === "dollars" ? "Return ($)" : "Return (%)";

    // Scatter plot for trade returns
    traces.push({
      x: tradeNumbers,
      y: returns,
      type: "scattergl",
      mode: "markers",
      name: "Trade Returns",
      marker: {
        color: colors,
        size: 6,
        opacity: 0.8,
      },
      hovertemplate: hoverTemplate,
    });

    // Add trend line if enabled and we have enough data
    if (showTrend && tradeNumbers.length > 2) {
      // Calculate linear regression (y = mx + b)
      const n = tradeNumbers.length;
      const sumX = tradeNumbers.reduce((a, b) => a + b, 0);
      const sumY = returns.reduce((a, b) => a + b, 0);
      const sumXY = tradeNumbers.reduce((sum, x, i) => sum + x * returns[i], 0);
      const sumX2 = tradeNumbers.reduce((sum, x) => sum + x * x, 0);

      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;

      const trendLine = tradeNumbers.map((x) => slope * x + intercept);

      traces.push({
        x: tradeNumbers,
        y: trendLine,
        type: "scatter",
        mode: "lines",
        name: "Trend",
        line: {
          color: "#6b7280",
          width: 2,
          dash: "dash",
        },
        hovertemplate: trendHoverTemplate,
      });
    }

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Trade Number" },
        showgrid: true,
      },
      yaxis: {
        title: { text: yAxisTitle },
        showgrid: true,
        zeroline: true,
        zerolinewidth: 1,
      },
      showlegend: true,
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
      hovermode: "closest",
      shapes: [
        {
          type: "line",
          x0: Math.min(...tradeNumbers),
          x1: Math.max(...tradeNumbers),
          y0: 0,
          y1: 0,
          line: {
            color: "rgba(148, 163, 184, 0.5)",
            width: 1,
          },
        },
      ],
    };

    return { plotData: traces, layout: chartLayout };
  }, [data, showTrend, viewMode]);

  const tooltip = {
    flavor:
      "Every building block placed in order - your complete construction timeline with all the additions and reconstructions.",
    detailed:
      "This chronological view shows every trade outcome and helps identify improvement trends, clustering of similar results, and overall progression. You can spot if your wins are getting bigger, losses smaller, or if certain periods produced notably different results due to market conditions or strategy evolution.",
  };

  const toggleControls = (
    <ToggleGroup
      type="single"
      value={viewMode}
      onValueChange={(value) => {
        if (value) setViewMode(value as ViewMode);
      }}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="dollars" aria-label="View in dollars">
        Dollars
      </ToggleGroupItem>
      <ToggleGroupItem value="percent" aria-label="View in percent">
        Percent
      </ToggleGroupItem>
    </ToggleGroup>
  );

  if (!data || !data.tradeSequence || data.tradeSequence.length === 0) {
    return (
      <ChartWrapper
        title="📊 Trade Sequence"
        description="Individual trade returns over time"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "300px" }}
        tooltip={tooltip}
        actions={toggleControls}
      />
    );
  }

  return (
    <ChartWrapper
      title="📊 Trade Sequence"
      description="Individual trade returns plotted chronologically with trend analysis"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      actions={toggleControls}
    />
  );
}
