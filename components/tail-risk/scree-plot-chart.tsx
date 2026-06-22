"use client";

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { TailRiskAnalysisResult } from "@tradeblocks/lib";
import { useTheme } from "next-themes";
import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";

interface ScreePlotChartProps {
  result: TailRiskAnalysisResult;
}

export function ScreePlotChart({ result }: ScreePlotChartProps) {
  const { theme } = useTheme();

  const { plotData, layout } = useMemo(() => {
    const { eigenvalues, explainedVariance, effectiveFactors, varianceThreshold } = result;
    const isDark = theme === "dark";
    const thresholdPct = varianceThreshold * 100;

    const n = eigenvalues.length;
    const factorLabels = eigenvalues.map((_, i) => `Factor ${i + 1}`);

    // Bar chart for eigenvalues
    const eigenvalueTrace: Partial<Data> = {
      x: factorLabels,
      y: eigenvalues,
      type: "bar",
      name: "Eigenvalue",
      marker: {
        color: eigenvalues.map((_, i) =>
          i < effectiveFactors ? (isDark ? "#3b82f6" : "#2563eb") : isDark ? "#475569" : "#94a3b8",
        ),
      },
      hovertemplate: "<b>%{x}</b><br>Eigenvalue: %{y:.3f}<extra></extra>",
    };

    // Line chart for cumulative explained variance
    const cumulativeTrace: Partial<Data> = {
      x: factorLabels,
      y: explainedVariance.map((v) => v * 100),
      type: "scatter",
      mode: "lines+markers",
      name: "Cumulative Variance %",
      yaxis: "y2",
      line: {
        color: isDark ? "#f97316" : "#ea580c",
        width: 2,
      },
      marker: {
        size: 8,
        color: isDark ? "#f97316" : "#ea580c",
      },
      hovertemplate: "<b>%{x}</b><br>Cumulative: %{y:.1f}%<extra></extra>",
    };

    // Threshold line (configurable)
    const thresholdTrace: Partial<Data> = {
      x: factorLabels,
      y: new Array(n).fill(thresholdPct),
      type: "scatter",
      mode: "lines",
      name: `${thresholdPct.toFixed(0)}% Threshold`,
      yaxis: "y2",
      line: {
        color: isDark ? "#22c55e" : "#16a34a",
        width: 2,
        dash: "dash",
      },
      hoverinfo: "skip",
    };

    const plotLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Risk Factor" },
        tickangle: -45,
      },
      yaxis: {
        title: { text: "Eigenvalue" },
        side: "left",
      },
      yaxis2: {
        title: { text: "Cumulative Variance (%)" },
        side: "right",
        overlaying: "y",
        range: [0, 105],
        showgrid: false,
      },
      legend: {
        x: 0.5,
        y: 1.15,
        xanchor: "center",
        orientation: "h",
      },
      margin: {
        l: 60,
        r: 60,
        t: 60,
        b: 100,
      },
      annotations: [
        {
          x: factorLabels[effectiveFactors - 1] || factorLabels[0],
          y: explainedVariance[effectiveFactors - 1]
            ? explainedVariance[effectiveFactors - 1] * 100
            : 0,
          xref: "x",
          yref: "y2",
          text: `${effectiveFactors} factors explain ${
            explainedVariance[effectiveFactors - 1]
              ? (explainedVariance[effectiveFactors - 1] * 100).toFixed(0)
              : 0
          }%`,
          showarrow: true,
          arrowhead: 2,
          arrowsize: 1,
          arrowwidth: 2,
          arrowcolor: isDark ? "#22c55e" : "#16a34a",
          ax: 40,
          ay: -40,
          font: {
            size: 12,
            color: isDark ? "#22c55e" : "#16a34a",
          },
          bgcolor: isDark ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.9)",
          borderpad: 4,
        },
      ],
    };

    return {
      plotData: [eigenvalueTrace, cumulativeTrace, thresholdTrace] as Data[],
      layout: plotLayout,
    };
  }, [result, theme]);

  const { effectiveFactors, strategies, varianceThreshold } = result;
  const thresholdPct = (varianceThreshold * 100).toFixed(0);

  return (
    <ChartWrapper
      title="Factor Analysis (Scree Plot)"
      description={`${strategies.length} strategies decompose into ${effectiveFactors} effective risk factors`}
      tooltip={{
        flavor: "Shows how many independent sources of tail risk exist in your portfolio.",
        detailed: `Your portfolio has ${strategies.length} strategy labels, but they share underlying risk factors. The blue bars show eigenvalues (variance captured by each factor). The orange line shows cumulative variance explained. The annotation shows how many factors are needed to explain ${thresholdPct}% of tail risk. Fewer effective factors = more concentrated tail risk.`,
      }}
      data={plotData}
      layout={layout}
      style={{ height: "450px" }}
    />
  );
}
