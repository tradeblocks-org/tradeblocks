"use client";

import { useMemo, useState } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface ExitReasonChartProps {
  className?: string;
}

type ViewMode = "dollars" | "percent";

export function ExitReasonChart({ className }: ExitReasonChartProps) {
  const { data } = usePerformanceStore();
  const [viewMode, setViewMode] = useState<ViewMode>("percent");

  const { plotData, layout } = useMemo(() => {
    if (!data?.exitReasonBreakdown || data.exitReasonBreakdown.length === 0) {
      return { plotData: [], layout: {} };
    }

    const sorted = [...data.exitReasonBreakdown].sort((a, b) => b.count - a.count);
    const reasons = sorted.map((item) => item.reason);

    const countTrace: Partial<PlotData> = {
      x: reasons,
      y: sorted.map((item) => item.count),
      type: "bar",
      name: "Trade Count",
      marker: {
        color: "#6366f1",
      },
      hovertemplate: "%{x}<br>Trades: %{y}<extra></extra>",
    };

    const metricValues =
      viewMode === "dollars"
        ? sorted.map((item) => item.avgPl)
        : sorted.map((item) => item.avgPlPercent);

    const yAxisTitle = viewMode === "dollars" ? "Average P/L ($)" : "Average P/L (%)";
    const hoverFormat =
      viewMode === "dollars"
        ? "%{x}<br>Avg P/L: $%{y:.2f}<extra></extra>"
        : "%{x}<br>Avg P/L: %{y:.2f}%<extra></extra>";

    const avgPlTrace: Partial<PlotData> = {
      x: reasons,
      y: metricValues,
      type: "scatter",
      mode: "lines+markers",
      name: yAxisTitle,
      yaxis: "y2",
      marker: {
        size: 8,
        color: metricValues.map((val) => (val >= 0 ? "#22c55e" : "#ef4444")),
      },
      hovertemplate: hoverFormat,
    };

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Exit Reason", standoff: 20 },
        tickangle: -45,
      },
      yaxis: {
        title: { text: "Trade Count" },
      },
      yaxis2: {
        title: { text: yAxisTitle },
        overlaying: "y",
        side: "right",
      },
      barmode: "group",
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
      margin: {
        r: 80,
        b: 120,
      },
    };

    return { plotData: [countTrace, avgPlTrace], layout: chartLayout };
  }, [data?.exitReasonBreakdown, viewMode]);

  const tooltip = {
    flavor: "Which exits add value and which ones leak capital?",
    detailed:
      "Tally exit reasons to see where discretionary overrides, stops, or assignment drive the best and worst outcomes. Consider codifying playbooks around the top performers.",
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

  return (
    <ChartWrapper
      title="🚪 Exit Diagnostics"
      description="Counts and average P/L by closing reason"
      className={className}
      data={plotData as PlotData[]}
      layout={layout}
      style={{ height: "320px" }}
      tooltip={tooltip}
      actions={toggleControls}
    />
  );
}
