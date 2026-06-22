"use client";

import { useMemo } from "react";
import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import type { MonteCarloResult } from "@tradeblocks/lib";
import type { Data } from "plotly.js";
import { useTheme } from "next-themes";

interface EquityCurveChartProps {
  result: MonteCarloResult;
  scaleType?: "linear" | "log";
  showIndividualPaths?: boolean;
  maxPathsToShow?: number;
}

export function EquityCurveChart({
  result,
  scaleType = "linear",
  showIndividualPaths = false,
  maxPathsToShow = 20,
}: EquityCurveChartProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const { data, layout } = useMemo(() => {
    const { percentiles, simulations } = result;

    // Convert percentiles to percentage for display
    const toPercent = (arr: number[]) => arr.map((v) => v * 100);

    const traces: Data[] = [];

    // Show individual simulation paths if requested
    if (showIndividualPaths) {
      const pathsToShow = Math.min(maxPathsToShow, simulations.length);
      for (let i = 0; i < pathsToShow; i++) {
        traces.push({
          x: percentiles.steps,
          y: toPercent(simulations[i].equityCurve),
          type: "scatter",
          mode: "lines",
          line: {
            color: isDark ? "rgba(100, 116, 139, 0.2)" : "rgba(148, 163, 184, 0.2)",
            width: 1,
          },
          showlegend: false,
          hoverinfo: "skip",
        } as Data);
      }
    }

    // P5-P25 filled area (light red/orange)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPercent(percentiles.p5), ...toPercent(percentiles.p25).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.1)",
      line: { width: 0 },
      showlegend: true,
      name: "P5-P25",
      hoverinfo: "skip",
    } as Data);

    // P25-P50 filled area (light yellow/amber)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPercent(percentiles.p25), ...toPercent(percentiles.p50).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(251, 191, 36, 0.2)" : "rgba(251, 191, 36, 0.15)",
      line: { width: 0 },
      showlegend: true,
      name: "P25-P50",
      hoverinfo: "skip",
    } as Data);

    // P50-P75 filled area (light green)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPercent(percentiles.p50), ...toPercent(percentiles.p75).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(34, 197, 94, 0.2)" : "rgba(34, 197, 94, 0.15)",
      line: { width: 0 },
      showlegend: true,
      name: "P50-P75",
      hoverinfo: "skip",
    } as Data);

    // P75-P95 filled area (light blue/cyan)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPercent(percentiles.p75), ...toPercent(percentiles.p95).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(59, 130, 246, 0.15)" : "rgba(59, 130, 246, 0.1)",
      line: { width: 0 },
      showlegend: true,
      name: "P75-P95",
      hoverinfo: "skip",
    } as Data);

    // Percentile lines
    traces.push(
      {
        x: percentiles.steps,
        y: toPercent(percentiles.p5),
        type: "scatter",
        mode: "lines",
        line: { color: "#ef4444", width: 1.5, dash: "dot" },
        name: "P5 (Worst 5%)",
      } as Data,
      {
        x: percentiles.steps,
        y: toPercent(percentiles.p25),
        type: "scatter",
        mode: "lines",
        line: { color: "#f59e0b", width: 1.5, dash: "dash" },
        name: "P25",
      } as Data,
      {
        x: percentiles.steps,
        y: toPercent(percentiles.p50),
        type: "scatter",
        mode: "lines",
        line: { color: isDark ? "#10b981" : "#22c55e", width: 2.5 },
        name: "P50 (Median)",
      } as Data,
      {
        x: percentiles.steps,
        y: toPercent(percentiles.p75),
        type: "scatter",
        mode: "lines",
        line: { color: "#3b82f6", width: 1.5, dash: "dash" },
        name: "P75",
      } as Data,
      {
        x: percentiles.steps,
        y: toPercent(percentiles.p95),
        type: "scatter",
        mode: "lines",
        line: { color: "#8b5cf6", width: 1.5, dash: "dot" },
        name: "P95 (Best 5%)",
      } as Data,
    );

    // Zero line
    traces.push({
      x: percentiles.steps,
      y: new Array(percentiles.steps.length).fill(0),
      type: "scatter",
      mode: "lines",
      line: {
        color: isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.2)",
        width: 1,
        dash: "dash",
      },
      showlegend: false,
      hoverinfo: "skip",
    } as Data);

    const plotLayout = {
      xaxis: {
        title: { text: "Trade Number" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      },
      yaxis: {
        title: { text: "Cumulative Return (%)" },
        showgrid: true,
        gridcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
        type: scaleType,
      },
      hovermode: "x unified" as const,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "right" as const,
        x: 1,
      },
    };

    return { data: traces, layout: plotLayout };
  }, [result, isDark, scaleType, showIndividualPaths, maxPathsToShow]);

  return (
    <ChartWrapper
      title="Portfolio Growth Projections"
      description={`${result.parameters.numSimulations} simulations projecting ${result.parameters.simulationLength} trades forward`}
      tooltip={{
        flavor:
          "Percentile bands show the range of possible outcomes based on resampling your actual trade history.",
        detailed:
          "The median line (P50) represents the most likely path. Wider bands indicate higher uncertainty. The shaded regions show where most simulations fall.",
      }}
      data={data}
      layout={layout}
      config={{ displayModeBar: true, displaylogo: false, responsive: true }}
      style={{ width: "100%", height: "500px" }}
    />
  );
}
