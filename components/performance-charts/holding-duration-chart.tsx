"use client";

import { useMemo } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";

interface HoldingDurationChartProps {
  className?: string;
}

export function HoldingDurationChart({ className }: HoldingDurationChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout } = useMemo(() => {
    if (!data?.holdingPeriods || data.holdingPeriods.length === 0) {
      return { plotData: [], layout: {} };
    }

    const durations = data.holdingPeriods
      .map((entry) => entry.durationHours)
      .filter((duration) => typeof duration === "number" && isFinite(duration));

    if (durations.length === 0) {
      return { plotData: [], layout: {} };
    }

    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const binCount = Math.min(30, Math.max(10, Math.floor(Math.sqrt(durations.length))));
    const range = maxDuration - minDuration;
    const binSize = range > 0 ? range / binCount : 1;

    const histogramTrace: Partial<PlotData> = {
      x: durations,
      type: "histogram",
      name: "Holding Duration",
      marker: {
        color: "#0ea5e9",
        opacity: 0.75,
      },
      xbins: {
        size: binSize,
        start: minDuration,
        end: maxDuration,
      },
      hovertemplate: "Duration: %{x:.1f} hours<extra></extra>",
    };

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Holding Period (hours)" },
      },
      yaxis: {
        title: { text: "Trade Count" },
      },
      bargap: 0.05,
    };

    return { plotData: [histogramTrace], layout: chartLayout };
  }, [data?.holdingPeriods]);

  const tooltip = {
    flavor: "How long do positions usually stay open?",
    detailed:
      "Holding period distribution shows whether the strategy thrives on quick scalps or longer swings. Use it to align review cadences and capital lock-up expectations.",
  };

  return (
    <ChartWrapper
      title="⏱️ Holding Periods"
      description="Distribution of time-in-trade"
      className={className}
      data={plotData as PlotData[]}
      layout={layout}
      style={{ height: "320px" }}
      tooltip={tooltip}
    />
  );
}
