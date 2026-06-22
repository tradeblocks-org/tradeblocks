"use client";

/**
 * Threshold Analysis Chart
 *
 * A specialized chart for evaluating filter thresholds.
 * Shows 4 series with dual Y-axes:
 * - Primary axis (left, 0-100%): Cumulative % of trades, Cumulative % of P/L
 * - Secondary axis (right, $): Avg P/L above threshold, Avg P/L below threshold
 *
 * Helps users identify optimal entry/exit filter levels by showing:
 * - What % of trades would be filtered at each threshold
 * - What % of profits come from trades at each threshold
 * - Expected average returns above vs below each threshold
 */

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { calculateThresholdAnalysis } from "@tradeblocks/lib";
import { EnrichedTrade } from "@tradeblocks/lib";
import { ChartAxisConfig, ThresholdMetric, getFieldInfo } from "@tradeblocks/lib";
import { generateTimeAxisTicksWithInterval } from "@tradeblocks/lib";
import type { Layout, PlotData } from "plotly.js";
import { useMemo } from "react";
import { WhatIfExplorer } from "./what-if-explorer";

interface ThresholdChartProps {
  trades: EnrichedTrade[];
  xAxis: ChartAxisConfig;
  metric?: ThresholdMetric; // 'pl', 'plPct', or 'rom' - defaults to 'plPct'
  className?: string;
}

// Threshold charts use wider tick intervals for cleaner display with many data points
const THRESHOLD_CHART_TICK_INTERVAL_HOURS = 2;

export function ThresholdChart({
  trades,
  xAxis,
  metric = "plPct",
  className,
}: ThresholdChartProps) {
  // Calculate analysis
  const analysis = useMemo(() => {
    if (trades.length === 0) return null;
    return calculateThresholdAnalysis(trades, xAxis.field);
  }, [trades, xAxis.field]);

  const { traces, layout } = useMemo(() => {
    if (!analysis || analysis.dataPoints.length === 0) {
      return { traces: [], layout: {} };
    }

    const xValues = analysis.dataPoints.map((d) => d.xValue);
    const xInfo = getFieldInfo(xAxis.field);
    const fieldLabel = xInfo?.label ?? xAxis.field;

    // Trace 1: Cumulative % of trades (primary Y-axis)
    const cumulativeTradesTrace: Partial<PlotData> = {
      x: xValues,
      y: analysis.dataPoints.map((d) => d.cumulativeTradesPct),
      type: "scatter",
      mode: "lines",
      name: "Cumulative Trades %",
      line: {
        color: "rgb(59, 130, 246)", // Blue
        width: 2,
      },
      hovertemplate: analysis.dataPoints.map(
        (d) =>
          `${fieldLabel}: ${d.xValue.toFixed(2)}<br>` +
          `Trades ≤ threshold: ${d.cumulativeTradesPct.toFixed(1)}%<br>` +
          `(${d.tradesBelow} of ${analysis.totalTrades} trades)<extra></extra>`,
      ),
      yaxis: "y",
    };

    // Trace 2: Cumulative % of P/L (primary Y-axis)
    const cumulativePlTrace: Partial<PlotData> = {
      x: xValues,
      y: analysis.dataPoints.map((d) => d.cumulativePlPct),
      type: "scatter",
      mode: "lines",
      name: "Cumulative P/L %",
      line: {
        color: "rgb(16, 185, 129)", // Teal
        width: 2,
      },
      hovertemplate: analysis.dataPoints.map(
        (d) =>
          `${fieldLabel}: ${d.xValue.toFixed(2)}<br>` +
          `P/L ≤ threshold: ${d.cumulativePlPct.toFixed(1)}%<extra></extra>`,
      ),
      yaxis: "y",
    };

    // Determine metric labels and formatting
    const metricLabel = metric === "rom" ? "ROM" : "P/L";
    const metricUnit = metric === "pl" ? "$" : "%";
    const formatValue = (v: number | null) => {
      if (v === null) return "N/A";
      if (metric === "pl") return `$${v.toFixed(0)}`;
      return `${v.toFixed(1)}%`;
    };

    // Get the correct values based on metric
    const getAboveValue = (d: (typeof analysis.dataPoints)[0]) => {
      switch (metric) {
        case "rom":
          return d.avgRomAbove;
        case "plPct":
          return d.avgPlPctAbove;
        default:
          return d.avgPlAbove;
      }
    };
    const getBelowValue = (d: (typeof analysis.dataPoints)[0]) => {
      switch (metric) {
        case "rom":
          return d.avgRomBelow;
        case "plPct":
          return d.avgPlPctBelow;
        default:
          return d.avgPlBelow;
      }
    };

    // Create a short field name for legend (e.g., "VIX" from "Opening VIX")
    const shortFieldName = fieldLabel.replace(/^(Opening|Closing|Avg)\s+/i, "");

    // Trace 3: Avg metric above threshold (secondary Y-axis)
    const avgAboveTrace: Partial<PlotData> = {
      x: xValues,
      y: analysis.dataPoints.map(getAboveValue),
      type: "scatter",
      mode: "markers",
      name: `Avg ${metricLabel} (High ${shortFieldName})`,
      marker: {
        color: "rgb(249, 115, 22)", // Orange - neutral color for "above"
        size: 6,
      },
      hovertemplate: analysis.dataPoints.map(
        (d) =>
          `${fieldLabel}: ${d.xValue.toFixed(2)}<br>` +
          `Avg ${metricLabel} (>${d.xValue.toFixed(2)}): ${formatValue(getAboveValue(d))}<br>` +
          `Trades: ${d.tradesAbove}<extra></extra>`,
      ),
      yaxis: "y2",
    };

    // Trace 4: Avg metric below threshold (secondary Y-axis)
    const avgBelowTrace: Partial<PlotData> = {
      x: xValues,
      y: analysis.dataPoints.map(getBelowValue),
      type: "scatter",
      mode: "markers",
      name: `Avg ${metricLabel} (Low ${shortFieldName})`,
      marker: {
        color: "rgb(139, 92, 246)", // Violet - neutral color for "below"
        size: 6,
      },
      hovertemplate: analysis.dataPoints.map(
        (d) =>
          `${fieldLabel}: ${d.xValue.toFixed(2)}<br>` +
          `Avg ${metricLabel} (≤${d.xValue.toFixed(2)}): ${formatValue(getBelowValue(d))}<br>` +
          `Trades: ${d.tradesBelow}<extra></extra>`,
      ),
      yaxis: "y2",
    };

    const chartTraces = [cumulativeTradesTrace, cumulativePlTrace, avgAboveTrace, avgBelowTrace];

    // Calculate range for secondary axis (with padding)
    const allMetricValues = analysis.dataPoints
      .flatMap((d) => [getAboveValue(d), getBelowValue(d)])
      .filter((v): v is number => v !== null);
    const minMetric = allMetricValues.length > 0 ? Math.min(...allMetricValues) : 0;
    const maxMetric = allMetricValues.length > 0 ? Math.max(...allMetricValues) : 100;
    const metricPadding = (maxMetric - minMetric) * 0.1;

    // Calculate range for primary axis (cumulative %)
    // Cumulative P/L % can go outside 0-100 when early trades have different P/L signs
    const allCumulativeValues = analysis.dataPoints.flatMap((d) => [
      d.cumulativeTradesPct,
      d.cumulativePlPct,
    ]);
    const minCumulative = Math.min(0, ...allCumulativeValues); // Always include 0
    const maxCumulative = Math.max(100, ...allCumulativeValues); // Always include 100
    const cumulativePadding = (maxCumulative - minCumulative) * 0.05;

    // Generate custom tick labels for time of day field
    const isTimeField = xAxis.field === "timeOfDayMinutes";
    const timeTicks = isTimeField
      ? generateTimeAxisTicksWithInterval(
          Math.min(...xValues),
          Math.max(...xValues),
          THRESHOLD_CHART_TICK_INTERVAL_HOURS,
          false, // No timezone suffix for compact display
        )
      : null;

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: fieldLabel },
        zeroline: false,
        ...(timeTicks && {
          tickvals: timeTicks.tickvals,
          ticktext: timeTicks.ticktext,
        }),
      },
      yaxis: {
        title: { text: "Cumulative %" },
        range: [minCumulative - cumulativePadding, maxCumulative + cumulativePadding],
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
        ticksuffix: "%",
      },
      yaxis2: {
        title: { text: `Avg ${metricLabel} (${metricUnit})` },
        overlaying: "y",
        side: "right",
        range: [minMetric - metricPadding, maxMetric + metricPadding],
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
        tickprefix: metric === "pl" ? "$" : "",
        ticksuffix: metric === "pl" ? "" : "%",
      },
      showlegend: true,
      legend: {
        x: 0.5,
        y: 1.0,
        xanchor: "center",
        yanchor: "bottom",
        orientation: "h",
        bgcolor: "rgba(0,0,0,0)",
      },
      hovermode: "closest",
      margin: {
        t: 50,
        r: 80,
        b: 60,
        l: 70,
      },
    };

    return { traces: chartTraces, layout: chartLayout };
  }, [analysis, xAxis, metric]);

  if (trades.length === 0) {
    return (
      <div className="h-[400px] flex items-center justify-center text-muted-foreground">
        No data available for threshold analysis
      </div>
    );
  }

  return (
    <div>
      <ChartWrapper
        title=""
        className={className}
        data={traces as PlotData[]}
        layout={layout}
        style={{ height: "400px" }}
      />

      {/* What-If Explorer - uses shared component */}
      <WhatIfExplorer trades={trades} xAxisField={xAxis.field} metric={metric} />
    </div>
  );
}

export default ThresholdChart;
