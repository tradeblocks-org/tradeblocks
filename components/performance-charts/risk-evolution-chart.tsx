"use client";

import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { useMemo, useState } from "react";
import { ChartWrapper } from "./chart-wrapper";

interface RiskEvolutionChartProps {
  className?: string;
}

type ViewMode = "dollars" | "percent-margin" | "percent-portfolio";

interface TradeData {
  tradeNumber: number;
  pl: number;
  rom: number;
  date: string;
  marginReq?: number;
}

interface EquityCurvePoint {
  date: string;
  equity: number;
  highWaterMark: number;
  tradeNumber: number;
}

function calculateRollingVolatility(
  trades: TradeData[],
  windowSize: number,
  viewMode: ViewMode,
  equityCurve?: EquityCurvePoint[],
): Array<{ date: string; volatility: number }> {
  if (trades.length < windowSize) {
    return [];
  }

  const results: Array<{ date: string; volatility: number }> = [];

  // For percent-portfolio mode, use the actual equity curve (initial capital + cumulative P&L)
  // The equity curve is indexed by tradeNumber (0 = initial, 1 = after trade 1, etc.)
  // Build a lookup by trade number for quick access
  const equityByTradeNumber = new Map<number, number>();
  if (viewMode === "percent-portfolio" && equityCurve) {
    for (const point of equityCurve) {
      equityByTradeNumber.set(point.tradeNumber, point.equity);
    }
  }

  // Calculate rolling volatility for each window
  for (let i = windowSize - 1; i < trades.length; i++) {
    const windowTrades = trades.slice(i - windowSize + 1, i + 1);

    // Get values based on view mode
    let values: number[];

    if (viewMode === "dollars") {
      values = windowTrades.map((t) => t.pl);
    } else if (viewMode === "percent-margin") {
      // P&L as percentage of margin requirement
      values = windowTrades.map((t) => {
        const margin = t.marginReq ?? 0;
        if (margin <= 0) return 0;
        return (t.pl / margin) * 100;
      });
    } else {
      // percent-portfolio: P&L as percentage of portfolio value BEFORE the trade
      // Use equity curve which includes initial capital, not just cumulative P&L
      values = windowTrades.map((t) => {
        // Equity BEFORE this trade = equity after the previous trade
        const prevTradeNumber = t.tradeNumber - 1;
        const prevEquity = equityByTradeNumber.get(prevTradeNumber) ?? 0;
        if (prevEquity <= 0) return 0;
        return (t.pl / prevEquity) * 100;
      });
    }

    // Calculate mean
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

    // Calculate variance and standard deviation
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const volatility = Math.sqrt(variance);

    results.push({
      date: windowTrades[windowTrades.length - 1].date,
      volatility,
    });
  }

  return results;
}

export function RiskEvolutionChart({ className }: RiskEvolutionChartProps) {
  const { data } = usePerformanceStore();

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>("dollars");

  // Window size with two-state pattern for number input
  const [windowSize, setWindowSize] = useState<number>(30);
  const [windowInput, setWindowInput] = useState<string>("30");

  const handleWindowBlur = () => {
    const val = parseInt(windowInput, 10);
    if (!isNaN(val) && val >= 5 && val <= 100) {
      setWindowSize(val);
      setWindowInput(String(val));
    } else {
      setWindowInput(String(windowSize));
    }
  };

  const { plotData, layout } = useMemo(() => {
    if (!data?.tradeSequence || data.tradeSequence.length === 0) {
      return { plotData: [], layout: {} };
    }

    const volatilityData = calculateRollingVolatility(
      data.tradeSequence,
      windowSize,
      viewMode,
      data.equityCurve,
    );

    if (volatilityData.length === 0) {
      return { plotData: [], layout: {} };
    }

    const dates = volatilityData.map((m) => m.date);
    const volatility = volatilityData.map((m) => m.volatility);

    // Format based on view mode
    const isPercent = viewMode !== "dollars";
    const hoverFormat = isPercent
      ? "<b>%{x}</b><br>Volatility: %{y:.2f}%<extra></extra>"
      : "<b>%{x}</b><br>Volatility: $%{y:.2f}<extra></extra>";

    const yAxisTitle =
      viewMode === "dollars"
        ? "Volatility ($)"
        : viewMode === "percent-margin"
          ? "Volatility (% of Margin)"
          : "Volatility (% of Portfolio)";

    const trace: Partial<PlotData> = {
      x: dates,
      y: volatility,
      type: "scatter",
      mode: "lines+markers",
      name: "Volatility",
      line: {
        color: "#3b82f6",
        width: 2,
      },
      marker: {
        size: 4,
      },
      hovertemplate: hoverFormat,
    };

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Date" },
        showgrid: true,
      },
      yaxis: {
        title: { text: yAxisTitle },
        showgrid: true,
      },
      showlegend: false,
      hovermode: "closest",
    };

    return { plotData: [trace], layout: chartLayout };
  }, [data, windowSize, viewMode]);

  const tooltip = {
    flavor:
      "Your construction style evolution - are you building bolder structures or laying more careful foundations over time?",
    detailed:
      "Risk evolution tracks how your exposure to volatility and drawdowns changes over time. Increasing risk might indicate growing confidence, larger position sizes, or changing market conditions. Decreasing risk could show improved discipline or more conservative positioning. Both trends provide insights into your trading development.",
  };

  const headerControls = (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Window:</span>
        <Input
          type="number"
          min={5}
          max={100}
          value={windowInput}
          onChange={(e) => setWindowInput(e.target.value)}
          onBlur={handleWindowBlur}
          onKeyDown={(e) => e.key === "Enter" && handleWindowBlur()}
          className="w-16 h-8 text-center"
        />
        <span className="text-sm text-muted-foreground">trades</span>
      </div>
      <ToggleGroup
        type="single"
        value={viewMode}
        onValueChange={(value) => {
          if (value) setViewMode(value as ViewMode);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="dollars" aria-label="View in dollars" className="px-3">
          Dollars
        </ToggleGroupItem>
        <ToggleGroupItem
          value="percent-margin"
          aria-label="View as percent of margin"
          className="px-3"
        >
          % Margin
        </ToggleGroupItem>
        <ToggleGroupItem
          value="percent-portfolio"
          aria-label="View as percent of portfolio"
          className="px-5"
        >
          % Portfolio
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );

  const description = `Rolling volatility as a risk indicator (${windowSize}-trade window)`;

  // Check if we have enough trades for the window
  const hasEnoughTrades = data?.tradeSequence && data.tradeSequence.length >= windowSize;

  if (!data || !data.tradeSequence || data.tradeSequence.length === 0 || !hasEnoughTrades) {
    const emptyDescription =
      !data?.tradeSequence || data.tradeSequence.length === 0
        ? "Rolling volatility as a risk indicator"
        : `Need at least ${windowSize} trades (have ${data.tradeSequence.length})`;

    return (
      <ChartWrapper
        title="⚠️ Risk Evolution"
        description={emptyDescription}
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
      title="⚠️ Risk Evolution"
      description={description}
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      actions={headerControls}
    />
  );
}
