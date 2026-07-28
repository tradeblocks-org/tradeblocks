"use client";

import React, { useMemo, useState } from "react";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import type { Layout, PlotData } from "plotly.js";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RollingMetricsChartProps {
  className?: string;
}

type MetricType = "win_rate" | "profit_factor" | "pl_signal_to_noise";

const METRIC_CONFIG = {
  win_rate: {
    key: "winRate" as const,
    label: "Win Rate",
    yAxisLabel: "Win Rate (%)",
    format: (val: number) => `${val.toFixed(1)}%`,
  },
  profit_factor: {
    key: "profitFactor" as const,
    label: "Profit Factor",
    yAxisLabel: "Profit Factor",
    format: (val: number) => val.toFixed(2),
  },
  pl_signal_to_noise: {
    key: "plSignalToNoise" as const,
    label: "P/L Signal-to-Noise",
    yAxisLabel: "Mean Trade P/L / P/L Volatility (Nonannualized)",
    format: (val: number) => val.toFixed(2),
  },
};

export function RollingMetricsChart({ className }: RollingMetricsChartProps) {
  const { data } = usePerformanceStore();
  const [metricType, setMetricType] = useState<MetricType>("win_rate");

  const { plotData, layout } = useMemo(() => {
    if (!data?.rollingMetrics || data.rollingMetrics.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { rollingMetrics } = data;
    const config = METRIC_CONFIG[metricType];

    const dates = rollingMetrics.map((m) => m.date);
    const values = rollingMetrics.map((m) => m[config.key]);

    const trace: Partial<PlotData> = {
      x: dates,
      y: values,
      type: "scatter",
      mode: "lines",
      name: config.label,
      line: {
        color: "#3b82f6",
        width: 2,
      },
      hovertemplate: `<b>%{x}</b><br>${config.label}: %{y:.2f}<extra></extra>`,
    };

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Date" },
        showgrid: true,
      },
      yaxis: {
        title: { text: config.yAxisLabel },
        showgrid: true,
      },
      showlegend: false,
      hovermode: "closest",
    };

    return { plotData: [trace], layout: chartLayout };
  }, [data, metricType]);

  const tooltip = {
    flavor:
      "Your building progress through a moving window - examining your last 30 blocks at each construction milestone.",
    detailed:
      "Rolling calculations show how your performance metrics evolve using moving time windows. P/L Signal-to-Noise is the nonannualized mean trade P/L divided by population P/L volatility; it is not the portfolio Sharpe ratio.",
  };

  if (!data || !data.rollingMetrics || data.rollingMetrics.length === 0) {
    return (
      <ChartWrapper
        title="📈 Rolling Metrics"
        description="Rolling performance metrics over time (30-trade window)"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "300px" }}
        tooltip={tooltip}
      />
    );
  }

  return (
    <ChartWrapper
      title="📈 Rolling Metrics"
      description="30-trade window"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
    >
      <div className="flex items-center gap-1.5">
        <Label htmlFor="metric-type" className="text-xs text-muted-foreground">
          Metric:
        </Label>
        <Select value={metricType} onValueChange={(val) => setMetricType(val as MetricType)}>
          <SelectTrigger id="metric-type" className="w-[115px] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="win_rate">Win Rate</SelectItem>
            <SelectItem value="profit_factor">Profit Factor</SelectItem>
            <SelectItem value="pl_signal_to_noise">P/L Signal-to-Noise</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </ChartWrapper>
  );
}
