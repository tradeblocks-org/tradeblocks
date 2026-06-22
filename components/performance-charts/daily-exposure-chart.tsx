"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { useEffect, useMemo, useState } from "react";
import { ChartWrapper } from "./chart-wrapper";

interface DailyExposureChartProps {
  className?: string;
}

type ViewMode = "dollars" | "percent";

export function DailyExposureChart({ className }: DailyExposureChartProps) {
  const { data, selectedStrategies } = usePerformanceStore();

  // Check if strategy filter is active - % view is invalid when filtering
  // because margin values are sized for the full portfolio, not the filtered subset
  const isStrategyFiltered = selectedStrategies.length > 0;

  // View mode state - force to dollars when strategy filtered
  const [viewMode, setViewMode] = useState<ViewMode>("percent");

  // Reset to dollars view when strategy filter becomes active
  useEffect(() => {
    if (isStrategyFiltered && viewMode === "percent") {
      setViewMode("dollars");
    }
  }, [isStrategyFiltered, viewMode]);

  // Effective view mode (forced to dollars when filtered)
  const effectiveViewMode = isStrategyFiltered ? "dollars" : viewMode;

  const { plotData, layout } = useMemo(() => {
    if (!data?.dailyExposure || data.dailyExposure.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { dailyExposure, peakDailyExposure, peakDailyExposurePercent } = data;

    // Use the appropriate peak based on view mode
    const activePeak =
      effectiveViewMode === "dollars" ? peakDailyExposure : peakDailyExposurePercent;

    const dates = dailyExposure.map((d) => d.date);
    const values = dailyExposure.map((d) =>
      effectiveViewMode === "dollars" ? d.exposure : d.exposurePercent,
    );

    // Format based on view mode
    const hoverFormat =
      effectiveViewMode === "dollars"
        ? "<b>%{x|%Y-%m-%d}</b><br>Exposure: $%{y:,.0f}<br>Positions: %{customdata}<extra></extra>"
        : "<b>%{x|%Y-%m-%d}</b><br>Exposure: %{y:.1f}%<br>Positions: %{customdata}<extra></extra>";

    const yAxisTitle =
      effectiveViewMode === "dollars" ? "Daily Exposure ($)" : "Daily Exposure (% of Portfolio)";

    const trace: Partial<PlotData> = {
      x: dates,
      y: values,
      customdata: dailyExposure.map((d) => d.openPositions),
      type: "scatter",
      mode: "lines",
      name: "Exposure",
      fill: "tozeroy",
      fillcolor: "rgba(251, 191, 36, 0.2)",
      line: {
        color: "#f59e0b",
        width: 2,
      },
      hovertemplate: hoverFormat,
    };

    // Add a marker for the peak day
    const traces: Partial<PlotData>[] = [trace];

    if (activePeak) {
      const peakValue =
        effectiveViewMode === "dollars" ? activePeak.exposure : activePeak.exposurePercent;

      const peakTrace: Partial<PlotData> = {
        x: [activePeak.date],
        y: [peakValue],
        type: "scatter",
        mode: "markers",
        name: "Peak",
        marker: {
          color: "#dc2626",
          size: 10,
          symbol: "diamond",
        },
        hovertemplate:
          effectiveViewMode === "dollars"
            ? "<b>Peak Exposure</b><br>%{x|%Y-%m-%d}<br>$%{y:,.0f}<extra></extra>"
            : "<b>Peak Exposure</b><br>%{x|%Y-%m-%d}<br>%{y:.1f}%<extra></extra>",
      };
      traces.push(peakTrace);
    }

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Date" },
        showgrid: true,
      },
      yaxis: {
        title: { text: yAxisTitle },
        showgrid: true,
        rangemode: "tozero",
      },
      showlegend: false,
      hovermode: "closest",
    };

    return {
      plotData: traces,
      layout: chartLayout,
    };
  }, [data, effectiveViewMode]);

  const tooltip = {
    flavor:
      "How much of your capital is at risk each day? This shows your total margin exposure over time.",
    detailed:
      "Daily exposure tracks the sum of margin requirements for all open positions on each trading day. Higher exposure means more capital at risk if positions move against you. The peak exposure (marked with a diamond) shows your riskiest day. Use this to understand your position sizing habits and identify periods of elevated risk.",
  };

  const headerControls = (
    <ToggleGroup
      type="single"
      value={effectiveViewMode}
      onValueChange={(value) => {
        if (value && !isStrategyFiltered) setViewMode(value as ViewMode);
      }}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="dollars" aria-label="View in dollars" className="px-3">
        Dollars
      </ToggleGroupItem>
      {isStrategyFiltered ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ToggleGroupItem
                value="percent"
                aria-label="View as percent (disabled when filtering by strategy)"
                className="px-3 opacity-50 cursor-not-allowed"
                disabled
              >
                % Portfolio
              </ToggleGroupItem>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p>
              % view unavailable when filtering by strategy. Margin values are sized for the full
              portfolio, not individual strategies.
            </p>
          </TooltipContent>
        </Tooltip>
      ) : (
        <ToggleGroupItem value="percent" aria-label="View as percent" className="px-3">
          % Portfolio
        </ToggleGroupItem>
      )}
    </ToggleGroup>
  );

  if (!data?.dailyExposure || data.dailyExposure.length === 0) {
    return (
      <ChartWrapper
        title="🛡️ Daily Exposure"
        description="Total margin exposure over time"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "300px" }}
        tooltip={tooltip}
        actions={headerControls}
      />
    );
  }

  return (
    <ChartWrapper
      title="🛡️ Daily Exposure"
      description="Total margin exposure over time (peak day marked)"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      actions={headerControls}
    />
  );
}
