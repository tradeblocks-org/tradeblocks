"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { useMemo, useState } from "react";
import { ChartWrapper, createBarChartLayout } from "./chart-wrapper";

interface MonthlyReturnsChartProps {
  className?: string;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type ViewMode = "dollars" | "percent";
type DisplayMode = "chronological" | "combined";

interface BarTraceConfig {
  x: string[];
  y: number[];
  labels: string[];
  hoverFormat: string;
  customdata?: number[];
}

function getBarColors(values: number[]): string[] {
  return values.map((v) => (v >= 0 ? "#16a34a" : "#dc2626"));
}

function formatValueLabel(value: number, viewMode: ViewMode): string {
  if (viewMode === "dollars") {
    return `$${value >= 0 ? "+" : ""}${value.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    })}`;
  } else {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
  }
}

function createBarTrace(config: BarTraceConfig): Partial<PlotData> {
  return {
    x: config.x,
    y: config.y,
    type: "bar",
    marker: { color: getBarColors(config.y) },
    text: config.labels,
    textposition: "inside",
    textfont: {
      size: 10,
      color: "white",
    },
    hovertemplate: config.hoverFormat,
    customdata: config.customdata,
  };
}

function createChartLayout(yAxisTitle: string, hasAngledLabels: boolean): Partial<Layout> {
  return {
    ...createBarChartLayout("", "Month", yAxisTitle),
    xaxis: {
      title: { text: "Month" },
      showgrid: false,
      ...(hasAngledLabels && { tickangle: 45 }),
    },
    yaxis: {
      title: { text: yAxisTitle },
      showgrid: true,
      zeroline: true,
      zerolinecolor: "#e5e7eb",
      zerolinewidth: 1,
    },
    showlegend: false,
    margin: {
      t: 60,
      r: 40,
      b: 80,
      l: 80,
    },
  };
}

export function MonthlyReturnsChart({ className }: MonthlyReturnsChartProps) {
  const { data } = usePerformanceStore();
  const [viewMode, setViewMode] = useState<ViewMode>("percent");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("chronological");

  const { plotData, layout } = useMemo(() => {
    if (!data?.monthlyReturns) {
      return { plotData: [], layout: {} };
    }

    const { monthlyReturns, monthlyReturnsPercent } = data;
    const sourceData = viewMode === "dollars" ? monthlyReturns : monthlyReturnsPercent;

    if (!sourceData) {
      return { plotData: [], layout: {} };
    }

    if (displayMode === "combined") {
      // Combined mode: aggregate all years for each month
      const monthlyAggregates: {
        [month: number]: { sum: number; count: number };
      } = {};

      const years = Object.keys(sourceData).map(Number).sort();

      for (const year of years) {
        const yearData = sourceData[year];
        for (let monthIdx = 1; monthIdx <= 12; monthIdx++) {
          if (monthIdx in yearData && yearData[monthIdx] !== 0) {
            if (!monthlyAggregates[monthIdx]) {
              monthlyAggregates[monthIdx] = { sum: 0, count: 0 };
            }
            monthlyAggregates[monthIdx].sum += yearData[monthIdx];
            monthlyAggregates[monthIdx].count += 1;
          }
        }
      }

      const months: string[] = [];
      const avgValues: number[] = [];
      const counts: number[] = [];
      const labels: string[] = [];

      for (let monthIdx = 1; monthIdx <= 12; monthIdx++) {
        if (monthlyAggregates[monthIdx]) {
          const avg = monthlyAggregates[monthIdx].sum / monthlyAggregates[monthIdx].count;
          months.push(MONTH_NAMES[monthIdx - 1]);
          avgValues.push(avg);
          counts.push(monthlyAggregates[monthIdx].count);
          labels.push(formatValueLabel(avg, viewMode));
        }
      }

      if (avgValues.length === 0) {
        return { plotData: [], layout: {} };
      }

      const hoverFormat =
        viewMode === "dollars"
          ? "<b>%{x}</b><br><b>Avg Return:</b> $%{y:.1f}<br><b>Months:</b> %{customdata}<extra></extra>"
          : "<b>%{x}</b><br><b>Avg Return:</b> %{y:.1f}%<br><b>Months:</b> %{customdata}<extra></extra>";

      const barTrace = createBarTrace({
        x: months,
        y: avgValues,
        labels,
        hoverFormat,
        customdata: counts,
      });

      const yAxisTitle =
        viewMode === "dollars" ? "Average Monthly Return ($)" : "Average Monthly Return (%)";
      const chartLayout = createChartLayout(yAxisTitle, false);

      return { plotData: [barTrace], layout: chartLayout };
    } else {
      // Chronological mode: flatten the data for chronological bar chart
      const allMonths: string[] = [];
      const allValues: number[] = [];
      const allLabels: string[] = [];

      const years = Object.keys(sourceData).map(Number).sort();

      for (const year of years) {
        const yearData = sourceData[year];
        for (let monthIdx = 1; monthIdx <= 12; monthIdx++) {
          // Only include months with non-zero values (matching legacy line 670)
          if (monthIdx in yearData && yearData[monthIdx] !== 0) {
            const value = yearData[monthIdx];
            allMonths.push(`${MONTH_NAMES[monthIdx - 1]} ${year}`);
            allValues.push(value);
            allLabels.push(formatValueLabel(value, viewMode));
          }
        }
      }

      if (allValues.length === 0) {
        return { plotData: [], layout: {} };
      }

      const barTrace = createBarTrace({
        x: allMonths,
        y: allValues,
        labels: allLabels,
        hoverFormat: "<b>%{x}</b><br>Return: %{text}<extra></extra>",
      });

      const yAxisTitle = viewMode === "dollars" ? "Monthly Return ($)" : "Monthly Return (%)";
      const chartLayout = createChartLayout(yAxisTitle, true);

      return { plotData: [barTrace], layout: chartLayout };
    }
  }, [data, viewMode, displayMode]);

  const tooltip = {
    flavor:
      "Your trading foundation year by year - which months added strong blocks and which needed rebuilding.",
    detailed:
      "Monthly performance patterns can reveal seasonal effects, consistency issues, and how your strategy performs across different market environments. Some strategies work better in certain market conditions that tend to cluster around calendar periods. This helps identify when to be more or less aggressive.",
  };

  const toggleControls = (
    <div className="flex gap-3">
      <ToggleGroup
        type="single"
        value={displayMode}
        onValueChange={(value) => {
          if (value) setDisplayMode(value as DisplayMode);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="chronological" aria-label="Chronological view" className="px-3">
          Chronological
        </ToggleGroupItem>
        <ToggleGroupItem value="combined" aria-label="Combined view">
          Combined
        </ToggleGroupItem>
      </ToggleGroup>
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
    </div>
  );

  if (!data || !data.monthlyReturns || Object.keys(data.monthlyReturns).length === 0) {
    return (
      <ChartWrapper
        title="📅 Monthly Returns"
        description="Monthly profit and loss over time"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "300px" }}
        tooltip={tooltip}
        actions={toggleControls}
      />
    );
  }

  return (
    <ChartWrapper
      title="📅 Monthly Returns"
      description="Monthly profit and loss performance across trading periods"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      actions={toggleControls}
    />
  );
}
