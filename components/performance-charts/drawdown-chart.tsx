"use client";

import React, { useMemo } from "react";
import { ChartWrapper, createLineChartLayout } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { useTheme } from "next-themes";
import type { PlotData, Layout } from "plotly.js";

interface DrawdownChartProps {
  className?: string;
}

export function DrawdownChart({ className }: DrawdownChartProps) {
  const { data } = usePerformanceStore();
  const { theme } = useTheme();

  const { plotData, layout } = useMemo(() => {
    if (!data?.drawdownData) {
      return { plotData: [], layout: {} };
    }

    const { drawdownData } = data;

    // Find maximum drawdown point (most negative value)
    // Use explicit initial value to avoid potential reduce edge cases
    const maxDrawdownPoint =
      drawdownData.length > 0
        ? drawdownData.reduce((max, current) =>
            current.drawdownPct < max.drawdownPct ? current : max,
          )
        : { date: "", drawdownPct: 0 };

    // Main drawdown area
    const drawdownTrace: Partial<PlotData> = {
      x: drawdownData.map((point) => point.date),
      y: drawdownData.map((point) => point.drawdownPct),
      type: "scatter" as const,
      mode: "lines+markers", // Add markers to ensure all points are visible
      name: "Drawdown %",
      line: {
        color: "#ef4444",
        width: 1, // Make line visible
        shape: "linear", // Preserve sharp changes, no smoothing
      },
      marker: {
        color: "#ef4444",
        size: 2, // Small markers
        opacity: 0.6,
      },
      fill: "tozeroy", // Fill to y=0 directly instead of tonexty
      fillcolor: "rgba(239, 68, 68, 0.3)",
      hovertemplate: "<b>Date:</b> %{x}<br>" + "<b>Drawdown:</b> %{y:.2f}%<br>" + "<extra></extra>",
    };

    // Zero line (baseline)
    const zeroLineTrace: Partial<PlotData> = {
      x: drawdownData.map((point) => point.date),
      y: Array(drawdownData.length).fill(0),
      type: "scatter" as const,
      mode: "lines",
      name: "No Drawdown",
      line: { color: "rgba(0,0,0,0.3)", width: 1 },
      showlegend: false,
      hoverinfo: "skip",
    };

    // Maximum drawdown point
    const maxDrawdownTrace: Partial<PlotData> = {
      x: [maxDrawdownPoint.date],
      y: [maxDrawdownPoint.drawdownPct],
      type: "scatter" as const,
      mode: "markers",
      name: `Max Drawdown: ${maxDrawdownPoint.drawdownPct.toFixed(1)}%`,
      marker: {
        color: "#dc2626",
        size: 12,
        symbol: "x",
        line: { width: 2, color: "#991b1b" },
      },
      hovertemplate:
        "<b>Maximum Drawdown</b><br>" +
        "<b>Date:</b> %{x}<br>" +
        "<b>Drawdown:</b> %{y:.2f}%<br>" +
        "<extra></extra>",
    };

    const traces: Partial<PlotData>[] = [zeroLineTrace, drawdownTrace, maxDrawdownTrace];

    // Use the same max drawdown point for consistency
    const minDrawdown = maxDrawdownPoint.drawdownPct;

    const yAxisRange = [minDrawdown * 1.1, 5];

    const chartLayout: Partial<Layout> = {
      ...createLineChartLayout("", "Date", "Drawdown (%)"),
      yaxis: {
        title: {
          text: "Drawdown (%)",
          standoff: 50, // Match equity curve chart spacing
        },
        showgrid: true,
        zeroline: true,
        zerolinecolor: "#000",
        zerolinewidth: 1,
        tickformat: ".1f",
        range: yAxisRange, // Show from deepest drawdown to above zero
        fixedrange: false, // Allow zoom but start with our range
        type: "linear", // Ensure linear scaling
      },
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
      annotations: [
        {
          x: maxDrawdownPoint.date,
          y: maxDrawdownPoint.drawdownPct,
          text: "Max DD",
          showarrow: true,
          arrowhead: 2,
          arrowsize: 1,
          arrowwidth: 2,
          arrowcolor: theme === "dark" ? "#f8fafc" : "#0f172a", // White in dark mode, black in light mode
          ax: 0,
          ay: -30,
          font: { size: 10, color: theme === "dark" ? "#f8fafc" : "#0f172a" }, // White in dark mode, black in light mode
        },
      ],
      margin: {
        l: 60, // Reduce left margin since percentage labels are shorter than dollar amounts
        r: 30,
        t: 60,
        b: 50,
      },
    };

    return { plotData: traces, layout: chartLayout };
  }, [data, theme]);

  const tooltip = {
    flavor:
      "When your trading blocks tumbled - measuring how far you fell from your highest tower.",
    detailed:
      "Drawdowns show the worst-case scenarios you've experienced - how much your account declined from peak values. This is crucial for understanding your risk tolerance and whether your strategy's downside matches what you can psychologically and financially handle. Recovery time shows resilience.",
  };

  if (!data) {
    return (
      <ChartWrapper
        title="Drawdown"
        description="Visualize portfolio drawdown periods and recovery"
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
      />
    );
  }

  return (
    <ChartWrapper
      title="Drawdown"
      description="Visualize portfolio drawdown periods and recovery patterns"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "400px" }}
      tooltip={tooltip}
    />
  );
}
