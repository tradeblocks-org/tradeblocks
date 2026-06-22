"use client";

import React, { useMemo } from "react";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";

interface ExcursionDistributionChartProps {
  className?: string;
}

export function ExcursionDistributionChart({ className }: ExcursionDistributionChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout } = useMemo(() => {
    if (!data?.mfeMaeDistribution || data.mfeMaeDistribution.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { mfeMaeDistribution } = data;

    const bucketLabels = mfeMaeDistribution.map((d) => d.bucket);
    const mfeCounts = mfeMaeDistribution.map((d) => d.mfeCount);
    const maeCounts = mfeMaeDistribution.map((d) => d.maeCount);

    const traces: Partial<PlotData>[] = [];

    // MFE histogram
    traces.push({
      x: bucketLabels,
      y: mfeCounts,
      type: "bar",
      name: "MFE (Favorable)",
      marker: {
        color: "#22c55e",
        opacity: 0.7,
      },
      hovertemplate: "<b>MFE Range: %{x}</b><br>" + "Count: %{y} trades<br>" + "<extra></extra>",
    });

    // MAE histogram
    traces.push({
      x: bucketLabels,
      y: maeCounts,
      type: "bar",
      name: "MAE (Adverse)",
      marker: {
        color: "#ef4444",
        opacity: 0.7,
      },
      hovertemplate: "<b>MAE Range: %{x}</b><br>" + "Count: %{y} trades<br>" + "<extra></extra>",
    });

    const chartLayout: Partial<Layout> = {
      barmode: "group",
      xaxis: {
        title: { text: "Excursion Range (%)" },
        showgrid: true,
        tickangle: -45,
      },
      yaxis: {
        title: { text: "Number of Trades" },
        showgrid: true,
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
      margin: {
        b: 80,
      },
    };

    return { plotData: traces, layout: chartLayout };
  }, [data]);

  const tooltip = {
    flavor:
      "Where do most of your trades peak and trough? This distribution reveals your typical risk and reward magnitudes.",
    detailed:
      "This histogram groups trades into buckets based on their excursion percentages. Green bars show Maximum Favorable Excursion (MFE) - how high profits typically go before exit. Red bars show Maximum Adverse Excursion (MAE) - how much drawdown you typically experience during trades. If MFE bars cluster at higher percentages than MAE bars, your trades generally offer more upside than downside. Concentrated distributions indicate consistent patterns, while spread-out distributions suggest varying trade behaviors. Use this to understand if you're sizing positions appropriately for the typical excursion magnitudes you encounter.",
  };

  if (!data || !data.mfeMaeDistribution || data.mfeMaeDistribution.length === 0) {
    return (
      <ChartWrapper
        title="📊 Excursion Distribution"
        description="Distribution of MFE and MAE percentages across trades"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "400px" }}
        tooltip={tooltip}
      />
    );
  }

  return (
    <ChartWrapper
      title="📊 Excursion Distribution"
      description="Frequency distribution of Maximum Favorable and Adverse Excursions"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "450px" }}
      tooltip={tooltip}
    />
  );
}
