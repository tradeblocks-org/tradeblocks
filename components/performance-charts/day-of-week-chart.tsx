"use client";

import React, { useMemo, useState } from "react";
import { ChartWrapper, createBarChartLayout } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Layout, PlotData } from "plotly.js";

interface DayOfWeekChartProps {
  className?: string;
}

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type ViewMode = "dollars" | "percent";

export function DayOfWeekChart({ className }: DayOfWeekChartProps) {
  const { data } = usePerformanceStore();
  const [viewMode, setViewMode] = useState<ViewMode>("percent");

  const { plotData, layout } = useMemo(() => {
    if (!data?.dayOfWeekData) {
      return { plotData: [], layout: {} };
    }

    // Sort data by day order
    const sortedData = [...data.dayOfWeekData].sort(
      (a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day),
    );

    const days = sortedData.map((item) => item.day);
    const counts = sortedData.map((item) => item.count);
    const metricValues =
      viewMode === "dollars"
        ? sortedData.map((item) => item.avgPl)
        : sortedData.map((item) => item.avgPlPercent);

    // Color bars based on profitability
    const colors = metricValues.map((pl) => (pl > 0 ? "#22c55e" : "#ef4444"));

    // Create text labels showing average P/L
    const textLabels =
      viewMode === "dollars"
        ? metricValues.map((pl) => `$${pl >= 0 ? "+" : ""}${pl.toFixed(0)}`)
        : metricValues.map((pl) => `${pl >= 0 ? "+" : ""}${pl.toFixed(1)}%`);

    const hoverFormat =
      viewMode === "dollars"
        ? "<b>%{x}</b><br><b>Avg Return:</b> $%{y:.1f}<br><b>Trades:</b> %{customdata}<extra></extra>"
        : "<b>%{x}</b><br><b>Avg Return:</b> %{y:.1f}%<br><b>Trades:</b> %{customdata}<extra></extra>";

    const customdata = counts;

    const yAxisTitle = viewMode === "dollars" ? "Average Return ($)" : "Average Return (%)";

    const barTrace: Partial<PlotData> = {
      x: days,
      y: metricValues,
      type: "bar",
      marker: { color: colors },
      text: textLabels,
      textposition: "inside",
      textfont: {
        size: 12,
        color: "white",
        family: "Arial Black",
      },
      hovertemplate: hoverFormat,
      customdata,
    };

    const chartLayout: Partial<Layout> = {
      ...createBarChartLayout("", "Day of Week", yAxisTitle),
      yaxis: {
        title: { text: yAxisTitle },
        showgrid: true,
        zeroline: true,
        zerolinecolor: "#e5e7eb",
        zerolinewidth: 1,
      },
      xaxis: {
        title: { text: "Day of Week" },
        showgrid: false,
      },
    };

    return { plotData: [barTrace], layout: chartLayout };
  }, [data, viewMode]);

  const tooltip = {
    flavor:
      "Building blocks of your week - are you laying stronger foundations on Mondays or Fridays?",
    detailed:
      "Different weekdays often show distinct performance patterns due to market behavior, news cycles, and trader psychology. Identifying your strongest and weakest days can help you understand when your strategy works best and potentially adjust your trading schedule or position sizing.",
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

  if (!data) {
    return (
      <ChartWrapper
        title="📅 Day of Week Patterns"
        description="Trading activity and performance by day of the week"
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
        actions={toggleControls}
      />
    );
  }

  return (
    <ChartWrapper
      title="📅 Day of Week Patterns"
      description="Trading activity and performance patterns across weekdays"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "300px" }}
      tooltip={tooltip}
      actions={toggleControls}
    />
  );
}
