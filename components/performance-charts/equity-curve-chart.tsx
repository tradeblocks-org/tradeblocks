"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { useMemo } from "react";
import { ChartWrapper, createLineChartLayout } from "./chart-wrapper";

interface EquityCurveChartProps {
  className?: string;
}

export function EquityCurveChart({ className }: EquityCurveChartProps) {
  const { data, chartSettings, updateChartSettings } = usePerformanceStore();

  const { plotData, layout } = useMemo(() => {
    if (!data?.equityCurve) {
      return { plotData: [], layout: {} };
    }

    const { equityCurve } = data;
    const { equityScale, showDrawdownAreas } = chartSettings;

    // Main equity line
    const equityTrace: Partial<PlotData> = {
      x: equityCurve.map((point) => point.date),
      y: equityCurve.map((point) => point.equity),
      type: "scatter",
      mode: "lines",
      name: "Portfolio Equity",
      line: {
        color: "#3b82f6",
        width: 3,
      },
      hovertemplate:
        "<b>Date:</b> %{x}<br>" +
        "<b>Equity:</b> $%{y:,.2f}<br>" +
        "<b>Trade #:</b> %{customdata}<br>" +
        "<extra></extra>",
      customdata: equityCurve.map((point) => point.tradeNumber),
    };

    // High water mark line
    const highWaterMarkTrace: Partial<PlotData> = {
      x: equityCurve.map((point) => point.date),
      y: equityCurve.map((point) => point.highWaterMark),
      type: "scatter",
      mode: "lines",
      name: "High Water Mark",
      line: {
        color: "#10b981",
        width: 2,
        dash: "dot",
      },
      hovertemplate:
        "<b>Date:</b> %{x}<br>" + "<b>High Water Mark:</b> $%{y:,.2f}<br>" + "<extra></extra>",
    };

    const traces = [equityTrace, highWaterMarkTrace];

    // Create base layout
    const baseLayout: Partial<Layout> = {
      ...createLineChartLayout("", "Date", "Portfolio Value ($)"),
      yaxis: {
        title: {
          text: "Portfolio Value ($)",
          standoff: 50,
        },
        showgrid: true,
        zeroline: false,
        type: equityScale,
        tickformat: "$,.0f",
      },
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
    };

    let chartLayout = baseLayout;

    // Add drawdown areas if enabled
    if (showDrawdownAreas) {
      // Find drawdown periods
      const drawdownPeriods: Array<{ start: number; end: number }> = [];
      let inDrawdown = false;
      let startIdx = 0;

      equityCurve.forEach((point, index) => {
        const isInDrawdown = point.equity < point.highWaterMark;

        if (isInDrawdown && !inDrawdown) {
          inDrawdown = true;
          startIdx = index;
        } else if (!isInDrawdown && inDrawdown) {
          inDrawdown = false;
          drawdownPeriods.push({ start: startIdx, end: index - 1 });
        }
      });

      // Handle case where drawdown continues to end
      if (inDrawdown) {
        drawdownPeriods.push({ start: startIdx, end: equityCurve.length - 1 });
      }

      // Add shapes for drawdown periods
      const shapes = drawdownPeriods.map((period) => ({
        type: "rect" as const,
        xref: "x" as const,
        yref: "paper" as const,
        x0: equityCurve[period.start].date,
        x1: equityCurve[period.end].date,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(239, 68, 68, 0.08)",
        line: { width: 0 },
        layer: "below" as const,
      }));

      // Add legend entry for drawdown periods
      if (drawdownPeriods.length > 0) {
        const legendTrace: Partial<PlotData> = {
          x: [],
          y: [],
          type: "scatter",
          mode: "markers",
          marker: {
            color: "rgba(239, 68, 68, 0.5)",
            size: 10,
            symbol: "square",
          },
          name: "Drawdown Periods",
          showlegend: true,
          hoverinfo: "skip",
        };
        traces.push(legendTrace);
      }

      // Add shapes to layout
      chartLayout = {
        ...baseLayout,
        shapes: shapes,
      };
    }

    return { plotData: traces, layout: chartLayout };
  }, [data, chartSettings]);

  const controls = (
    <div className="flex items-center gap-4">
      <ToggleGroup
        type="single"
        value={chartSettings.equityScale}
        onValueChange={(value: "linear" | "log") => {
          if (value) updateChartSettings({ equityScale: value });
        }}
        className="border rounded-md p-1"
      >
        <ToggleGroupItem value="linear" className="text-xs px-3 py-1">
          Linear
        </ToggleGroupItem>
        <ToggleGroupItem value="log" className="text-xs px-3 py-1">
          Log
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex items-center space-x-2">
        <Switch
          id="drawdown-areas"
          checked={chartSettings.showDrawdownAreas}
          onCheckedChange={(checked: boolean) =>
            updateChartSettings({ showDrawdownAreas: checked })
          }
        />
        <Label htmlFor="drawdown-areas" className="text-xs">
          Show Drawdown Areas
        </Label>
      </div>
    </div>
  );

  const tooltip = {
    flavor:
      "Your portfolio's building blocks stacked over time - every peak, valley, and milestone along the way.",
    detailed:
      "This shows your account value after each trade. Steady upward movement indicates consistent profitability, while volatility reveals periods of mixed results. The overall trend tells you if your trading approach is generating wealth over time or if adjustments might be needed.",
  };

  if (!data) {
    return (
      <ChartWrapper
        title="Equity Curve"
        description="Track your portfolio's value progression over time"
        tooltip={tooltip}
        className={className}
        data={[]}
        layout={{}}
      >
        {controls}
      </ChartWrapper>
    );
  }

  return (
    <ChartWrapper
      title="Equity Curve"
      description="Track your portfolio's value progression over time with drawdown highlighting"
      tooltip={tooltip}
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "400px" }}
    >
      {controls}
    </ChartWrapper>
  );
}
