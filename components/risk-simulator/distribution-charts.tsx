"use client";

import { useMemo } from "react";
import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import type { MonteCarloResult } from "@tradeblocks/lib";
import type { Data } from "plotly.js";
import { useTheme } from "next-themes";

interface ReturnDistributionChartProps {
  result: MonteCarloResult;
}

export function ReturnDistributionChart({ result }: ReturnDistributionChartProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const { data, layout } = useMemo(() => {
    const { simulations } = result;

    // Get final returns from all simulations
    const finalReturns = simulations.map((sim) => sim.totalReturn * 100);

    // Calculate percentiles manually
    const sortedReturns = [...finalReturns].sort((a, b) => a - b);
    const p5 = sortedReturns[Math.floor(sortedReturns.length * 0.05)];
    const p50 = sortedReturns[Math.floor(sortedReturns.length * 0.5)];
    const p95 = sortedReturns[Math.floor(sortedReturns.length * 0.95)];

    const traces: Data[] = [];

    // Histogram
    traces.push({
      x: finalReturns,
      type: "histogram",
      nbinsx: 50,
      marker: {
        color: isDark ? "rgba(59, 130, 246, 0.7)" : "rgba(37, 99, 235, 0.7)",
        line: {
          color: isDark ? "rgba(59, 130, 246, 1)" : "rgba(37, 99, 235, 1)",
          width: 1,
        },
      },
      showlegend: false,
      hovertemplate: "<b>Return:</b> %{x:.1f}%<br><b>Count:</b> %{y}<extra></extra>",
    } as Data);

    // Get histogram max for vertical line height
    const yMax = 120;

    // Add percentile lines
    traces.push(
      {
        x: [p5, p5],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#ef4444", dash: "dash", width: 2 },
        name: `P5: ${p5.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
      {
        x: [p50, p50],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#3b82f6", dash: "dash", width: 2 },
        name: `P50: ${p50.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
      {
        x: [p95, p95],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#22c55e", dash: "dash", width: 2 },
        name: `P95: ${p95.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
    );

    const plotLayout = {
      xaxis: {
        title: { text: "Cumulative Return" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      },
      yaxis: {
        title: { text: "Frequency" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      },
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "right" as const,
        x: 1,
      },
      autosize: true,
      height: 400,
    };

    return { data: traces, layout: plotLayout };
  }, [result, isDark]);

  return (
    <ChartWrapper
      title="Return Distribution"
      tooltip={{
        flavor:
          "Histogram showing the frequency distribution of final returns across all Monte Carlo simulations.",
        detailed:
          "The shape reveals your strategy's risk profile. A narrow, tall distribution indicates consistent performance, while a wide, flat distribution suggests high variability. The P5, P50, and P95 lines mark the 5th percentile (pessimistic), median (most likely), and 95th percentile (optimistic) outcomes. Use this to visualize the full range of possible results and understand the probability of different return levels.",
      }}
      data={data}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: "400px" }}
    />
  );
}

interface DrawdownDistributionChartProps {
  result: MonteCarloResult;
}

export function DrawdownDistributionChart({ result }: DrawdownDistributionChartProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const { data, layout } = useMemo(() => {
    const { simulations } = result;

    // Get max drawdowns from all simulations (as percentages)
    const maxDrawdowns = simulations.map((sim) => sim.maxDrawdown * 100);

    // Calculate percentiles
    const sortedDrawdowns = [...maxDrawdowns].sort((a, b) => a - b);
    const p5 = sortedDrawdowns[Math.floor(sortedDrawdowns.length * 0.05)];
    const p50 = sortedDrawdowns[Math.floor(sortedDrawdowns.length * 0.5)];
    const p95 = sortedDrawdowns[Math.floor(sortedDrawdowns.length * 0.95)];

    const traces: Data[] = [];

    // Histogram
    traces.push({
      x: maxDrawdowns,
      type: "histogram",
      nbinsx: 30,
      marker: {
        color: isDark ? "rgba(249, 115, 22, 0.7)" : "rgba(234, 88, 12, 0.7)",
        line: {
          color: isDark ? "rgba(249, 115, 22, 1)" : "rgba(234, 88, 12, 1)",
          width: 1,
        },
      },
      showlegend: false,
      hovertemplate: "<b>Drawdown:</b> %{x:.1f}%<br><b>Count:</b> %{y}<extra></extra>",
    } as Data);

    // Get histogram max for vertical line height
    const yMax = 200;

    // Add percentile lines
    traces.push(
      {
        x: [p5, p5],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#ef4444", dash: "dash", width: 2 },
        name: `P5: ${p5.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
      {
        x: [p50, p50],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#3b82f6", dash: "dash", width: 2 },
        name: `P50: ${p50.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
      {
        x: [p95, p95],
        y: [0, yMax],
        type: "scatter",
        mode: "lines",
        line: { color: "#22c55e", dash: "dash", width: 2 },
        name: `P95: ${p95.toFixed(1)}%`,
        showlegend: true,
        hoverinfo: "skip",
      } as Data,
    );

    const plotLayout = {
      xaxis: {
        title: { text: "Drawdown (%)" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      },
      yaxis: {
        title: { text: "Frequency" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      },
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "right" as const,
        x: 1,
      },
      autosize: true,
      height: 400,
    };

    return { data: traces, layout: plotLayout };
  }, [result, isDark]);

  return (
    <ChartWrapper
      title="Drawdown Analysis"
      tooltip={{
        flavor:
          "Histogram showing the distribution of maximum peak-to-trough declines across all simulations.",
        detailed:
          "Each bar represents how many simulations experienced a particular level of worst drawdown. The P50 (median) line shows the typical worst drawdown you might expect, while P95 represents severe but plausible downturns. Use this to determine if you have sufficient capital to withstand losing streaks without forced liquidation. Drawdowns are measured as the largest percentage decline from any peak to the subsequent trough within each simulation.",
      }}
      data={data}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: "400px" }}
    />
  );
}
