"use client";

import { useMemo } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";

interface MarginUtilizationChartProps {
  className?: string;
}

export function MarginUtilizationChart({ className }: MarginUtilizationChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout } = useMemo(() => {
    if (!data?.marginUtilization || data.marginUtilization.length === 0) {
      return { plotData: [], layout: {} };
    }

    const entries = data.marginUtilization.filter((entry) => entry.marginReq > 0);

    if (entries.length === 0) {
      return { plotData: [], layout: {} };
    }

    const utilizationTrace: Partial<PlotData> = {
      x: entries.map((entry) => entry.marginReq),
      y: entries.map((entry) => entry.pl),
      customdata: entries.map((entry) => [entry.numContracts, entry.fundsAtClose]),
      mode: "markers",
      type: "scattergl",
      name: "Margin Usage",
      marker: {
        size: entries.map((entry) => Math.min(30, Math.max(8, entry.numContracts * 2 || 6))),
        color: entries.map((entry) => entry.fundsAtClose),
        colorscale: "Portland",
        showscale: true,
        colorbar: {
          title: {
            text: "Funds at Close ($)",
          },
        },
      },
      hovertemplate:
        "Margin Required: $%{x:.0f}<br>P/L: $%{y:.2f}<br>Contracts: %{customdata[0]}<br>Funds at Close: $%{customdata[1]:.2f}<extra></extra>",
    };

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Margin Requirement ($)" },
        type: "log",
        rangemode: "tozero",
      },
      yaxis: {
        title: { text: "Profit / Loss ($)" },
      },
      hovermode: "closest",
    };

    return { plotData: [utilizationTrace], layout: chartLayout };
  }, [data?.marginUtilization]);

  const tooltip = {
    flavor: "How hard are you leaning on buying power for each win or loss?",
    detailed:
      "Margin utilization highlights where capital efficiency breaks down. Bubble size shows contract count while color shades the resulting account value at close.",
  };

  return (
    <ChartWrapper
      title="🏗️ Margin Utilization"
      description="Profit/Loss versus required margin and sizing"
      className={className}
      data={plotData as PlotData[]}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
    />
  );
}
