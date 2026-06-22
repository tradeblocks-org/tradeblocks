"use client";

import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { PlotData } from "plotly.js";
import { useMemo } from "react";
import { ChartWrapper, createHistogramLayout } from "./chart-wrapper";

interface ReturnDistributionChartProps {
  className?: string;
}

export function ReturnDistributionChart({ className }: ReturnDistributionChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout } = useMemo(() => {
    if (!data?.returnDistribution || data.returnDistribution.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { returnDistribution } = data;

    // Calculate statistics
    const mean = returnDistribution.reduce((sum, val) => sum + val, 0) / returnDistribution.length;
    const median = [...returnDistribution].sort((a, b) => a - b)[
      Math.floor(returnDistribution.length / 2)
    ];

    // Create histogram
    const histogramTrace = {
      x: returnDistribution,
      type: "histogram" as const,
      nbinsx: 30,
      name: "ROM Distribution",
      marker: {
        color: returnDistribution,
        colorscale: [
          [0, "#ef4444"], // Red for losses
          [0.5, "#f59e0b"], // Orange for small gains
          [1, "#10b981"], // Green for large gains
        ],
        showscale: false,
        line: { color: "white", width: 1 },
      },
      hovertemplate:
        "<b>ROM Range:</b> %{x:.1f}%<br>" + "<b>Trade Count:</b> %{y}<br>" + "<extra></extra>",
    };

    const traces: Partial<PlotData>[] = [histogramTrace];

    // Smart x-axis range
    const minRom = Math.min(...returnDistribution);
    const maxRom = Math.max(...returnDistribution);
    const rangePadding = (maxRom - minRom) * 0.1;
    const xMin = Math.max(-100, minRom - rangePadding);
    const xMax = Math.min(200, maxRom + rangePadding);

    // Add mean line as a trace (not a shape) so it can be toggled via legend
    traces.push({
      x: [mean, mean],
      y: [0, 1],
      type: "scatter",
      mode: "lines",
      line: { color: "#3b82f6", width: 2, dash: "dash" },
      name: `Mean: ${mean.toFixed(1)}%`,
      showlegend: true,
      yaxis: "y2",
      hovertemplate: `<b>Mean</b><br>${mean.toFixed(1)}%<extra></extra>`,
    });

    // Add median line as a trace (not a shape) so it can be toggled via legend
    traces.push({
      x: [median, median],
      y: [0, 1],
      type: "scatter",
      mode: "lines",
      line: { color: "#10b981", width: 2, dash: "dot" },
      name: `Median: ${median.toFixed(1)}%`,
      showlegend: true,
      yaxis: "y2",
      hovertemplate: `<b>Median</b><br>${median.toFixed(1)}%<extra></extra>`,
    });

    const chartLayout = {
      ...createHistogramLayout("", "Return on Margin (%)", "Number of Trades"),
      xaxis: {
        title: { text: "Return on Margin (%)" },
        showgrid: true,
        range: [xMin, xMax],
      },
      yaxis: {
        title: { text: "Number of Trades" },
        showgrid: true,
      },
      yaxis2: {
        overlaying: "y" as const,
        range: [0, 1],
        showgrid: false,
        showticklabels: false,
      },
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "right" as const,
        x: 1,
      },
      margin: {
        t: 100, // Increased top margin for legend
        r: 60,
        b: 60,
        l: 60,
      },
    };

    return { plotData: traces, layout: chartLayout };
  }, [data]);

  const tooltip = {
    flavor:
      "The building blocks of your trading style - are you stacking steady bricks or placing bold cornerstone moves?",
    detailed:
      "The distribution of your returns reveals important characteristics about your trading style. Are you consistently hitting small wins, occasionally landing big winners, or something in between? Understanding this helps you assess whether your risk/reward profile matches your goals and personality.",
  };

  if (!data) {
    return (
      <ChartWrapper
        title="📊 Return Distribution"
        description="Histogram of returns showing the frequency of different performance levels"
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
      />
    );
  }

  return (
    <ChartWrapper
      title="📊 Return Distribution"
      description="Distribution of return on margin values with statistical indicators"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "300px" }}
      tooltip={tooltip}
    />
  );
}
