"use client";

/**
 * Histogram Chart
 *
 * Plotly histogram with What-If Filter Explorer for analyzing distributions
 * and exploring hypothetical filter thresholds.
 */

import { useMemo, useState, useCallback } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EnrichedTrade, getEnrichedTradeValue } from "@tradeblocks/lib";
import { ChartAxisConfig, getFieldInfo, ThresholdMetric } from "@tradeblocks/lib";
import { formatMinutesToTime, generateTimeAxisTicks } from "@tradeblocks/lib";
import { WhatIfExplorer } from "./what-if-explorer";

interface HistogramChartProps {
  trades: EnrichedTrade[];
  xAxis: ChartAxisConfig;
  metric?: ThresholdMetric;
  className?: string;
}

// Use shared getEnrichedTradeValue from enriched-trade model
const getTradeValue = getEnrichedTradeValue;

const DEFAULT_TIME_BIN_SIZE = 30;
const MIN_TIME_BIN_SIZE = 5;
const MAX_TIME_BIN_SIZE = 120;

/**
 * Bin time data into fixed-size intervals for histogram display.
 *
 * @param values - Array of time values in minutes since midnight
 * @param binSizeMinutes - Size of each bin in minutes (must be positive, defaults to 30)
 * @returns Object with x (bin midpoints), y (counts), and labels (formatted time ranges)
 *
 * Edge cases handled:
 * - Empty array: Returns empty arrays
 * - Identical min/max: Creates a single bin
 * - Invalid binSizeMinutes: Falls back to default
 */
function binTimeData(
  values: number[],
  binSizeMinutes: number = DEFAULT_TIME_BIN_SIZE,
): { x: number[]; y: number[]; labels: string[] } {
  if (values.length === 0) return { x: [], y: [], labels: [] };

  // Validate binSizeMinutes to prevent infinite loops or division by zero
  const safeBinSize = binSizeMinutes > 0 ? binSizeMinutes : DEFAULT_TIME_BIN_SIZE;

  const min = Math.min(...values);
  const max = Math.max(...values);

  // Round min down and max up to bin boundaries
  const binStart = Math.floor(min / safeBinSize) * safeBinSize;
  // Handle edge case where all values are identical (min === max)
  const binEnd = min === max ? binStart + safeBinSize : Math.ceil(max / safeBinSize) * safeBinSize;

  // Create bins at fixed intervals
  const bins = new Map<number, number>();
  for (let t = binStart; t < binEnd; t += safeBinSize) {
    bins.set(t, 0);
  }

  // Count values in each bin
  for (const val of values) {
    const binKey = Math.floor(val / safeBinSize) * safeBinSize;
    bins.set(binKey, (bins.get(binKey) || 0) + 1);
  }

  // Convert to arrays.
  // Use numeric X values (bin midpoints) so Plotly treats the X axis as a continuous
  // scale instead of categorical labels. This keeps bars aligned with the time-based
  // ticks generated elsewhere and avoids mis-positioned bars when using formatted
  // time strings. Human-readable time ranges are stored in `labels` for hover text.
  const x: number[] = [];
  const y: number[] = [];
  const labels: string[] = [];

  for (const [binKey, count] of Array.from(bins.entries()).sort((a, b) => a[0] - b[0])) {
    const binMid = binKey + safeBinSize / 2;
    x.push(binMid);
    y.push(count);
    // Format as time range for hover
    const startTime = formatMinutesToTime(binKey);
    const endTime = formatMinutesToTime(binKey + safeBinSize);
    labels.push(`${startTime} - ${endTime}`);
  }

  return { x, y, labels };
}

export function HistogramChart({
  trades,
  xAxis,
  metric = "plPct",
  className,
}: HistogramChartProps) {
  // Track the selected range from What-If Explorer for visual highlighting
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  // Bin size for time histograms (in minutes)
  const [timeBinSize, setTimeBinSize] = useState(DEFAULT_TIME_BIN_SIZE);

  const handleRangeChange = useCallback((min: number, max: number) => {
    setSelectedRange([min, max]);
  }, []);

  const isTimeField = xAxis.field === "timeOfDayMinutes";

  const { traces, layout } = useMemo(() => {
    if (trades.length === 0) {
      return { traces: [], layout: {} };
    }

    // Extract values for histogram
    const allValues: number[] = [];
    for (const trade of trades) {
      const x = getTradeValue(trade, xAxis.field);
      if (x !== null) {
        allValues.push(x);
      }
    }

    if (allValues.length === 0) {
      return { traces: [], layout: {} };
    }

    const xInfo = getFieldInfo(xAxis.field);
    const chartTraces: Partial<PlotData>[] = [];
    const isTime = xAxis.field === "timeOfDayMinutes";
    const fieldLabel = xInfo?.label ?? xAxis.field;

    // Compute data range once for consistent binning and axis formatting
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);
    const binCount = Math.min(50, Math.ceil(Math.sqrt(allValues.length)));

    // For time fields, use pre-binned bar chart with configurable intervals
    if (isTime) {
      if (selectedRange) {
        const [rangeMin, rangeMax] = selectedRange;
        const inRangeValues = allValues.filter((v) => v >= rangeMin && v <= rangeMax);
        const outOfRangeValues = allValues.filter((v) => v < rangeMin || v > rangeMax);

        // Pre-bin both datasets with same bin size
        const inBinned = binTimeData(inRangeValues, timeBinSize);
        const outBinned = binTimeData(outOfRangeValues, timeBinSize);

        if (outBinned.y.length > 0) {
          chartTraces.push({
            x: outBinned.x,
            y: outBinned.y,
            type: "bar",
            marker: { color: "rgba(148, 163, 184, 0.5)" },
            name: "Outside Range",
            hovertemplate: outBinned.labels.map(
              (label, i) =>
                `${fieldLabel}: ${label}<br>Count: ${outBinned.y[i]}<extra>Outside Range</extra>`,
            ),
          });
        }

        if (inBinned.y.length > 0) {
          chartTraces.push({
            x: inBinned.x,
            y: inBinned.y,
            type: "bar",
            marker: { color: "rgb(59, 130, 246)" },
            name: "In Range",
            hovertemplate: inBinned.labels.map(
              (label, i) =>
                `${fieldLabel}: ${label}<br>Count: ${inBinned.y[i]}<extra>In Range</extra>`,
            ),
          });
        }
      } else {
        // No range selection - single bar chart
        const binned = binTimeData(allValues, timeBinSize);
        chartTraces.push({
          x: binned.x,
          y: binned.y,
          type: "bar",
          marker: { color: "rgb(59, 130, 246)" },
          name: fieldLabel,
          hovertemplate: binned.labels.map(
            (label, i) => `${fieldLabel}: ${label}<br>Count: ${binned.y[i]}<extra></extra>`,
          ),
        });
      }
    } else {
      // Non-time fields use standard Plotly histogram
      if (selectedRange) {
        const [rangeMin, rangeMax] = selectedRange;
        const inRangeValues = allValues.filter((v) => v >= rangeMin && v <= rangeMax);
        const outOfRangeValues = allValues.filter((v) => v < rangeMin || v > rangeMax);

        const binSize = (dataMax - dataMin) / binCount || 1;

        // Out-of-range bars (gray/faded)
        if (outOfRangeValues.length > 0) {
          chartTraces.push({
            x: outOfRangeValues,
            type: "histogram",
            marker: { color: "rgba(148, 163, 184, 0.5)" },
            xbins: { start: dataMin, end: dataMax, size: binSize },
            name: "Outside Range",
            hovertemplate: `${fieldLabel}: %{x}<br>Count: %{y}<extra>Outside Range</extra>`,
          });
        }

        // In-range bars (blue/highlighted)
        if (inRangeValues.length > 0) {
          chartTraces.push({
            x: inRangeValues,
            type: "histogram",
            marker: { color: "rgb(59, 130, 246)" },
            xbins: { start: dataMin, end: dataMax, size: binSize },
            name: "In Range",
            hovertemplate: `${fieldLabel}: %{x}<br>Count: %{y}<extra>In Range</extra>`,
          });
        }
      } else {
        // No range selection - single blue histogram
        chartTraces.push({
          x: allValues,
          type: "histogram",
          marker: { color: "rgb(59, 130, 246)" },
          name: fieldLabel,
          hovertemplate: `${fieldLabel}: %{x}<br>Count: %{y}<extra></extra>`,
        });
      }
    }

    // Generate time axis ticks for time fields
    const timeTicks = isTime ? generateTimeAxisTicks(dataMin, dataMax) : null;

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: xInfo?.label ?? xAxis.field },
        zeroline: false,
        ...(timeTicks && {
          tickvals: timeTicks.tickvals,
          ticktext: timeTicks.ticktext,
        }),
      },
      yaxis: {
        title: { text: "Count" },
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
      },
      barmode: "overlay", // Overlay the two histograms
      showlegend: selectedRange !== null,
      legend: selectedRange
        ? {
            x: 0,
            y: 1.1,
            xanchor: "left",
            yanchor: "bottom",
            orientation: "h" as const,
            bgcolor: "rgba(0,0,0,0)",
          }
        : undefined,
      hovermode: "closest",
      margin: {
        t: selectedRange ? 40 : 20,
        r: 40,
        b: isTime ? 80 : 60, // More space for time labels
        l: 70,
      },
    };

    return { traces: chartTraces, layout: chartLayout };
  }, [trades, xAxis, selectedRange, timeBinSize]);

  if (trades.length === 0) {
    return (
      <div className="h-[400px] flex items-center justify-center text-muted-foreground">
        No data available for chart
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Bin size selector for time fields */}
      {isTimeField && (
        <div className="flex items-center gap-2 mb-2">
          <Label className="text-xs text-muted-foreground">Bin size:</Label>
          <Input
            type="number"
            min={MIN_TIME_BIN_SIZE}
            max={MAX_TIME_BIN_SIZE}
            value={timeBinSize}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= MIN_TIME_BIN_SIZE && val <= MAX_TIME_BIN_SIZE) {
                setTimeBinSize(val);
              }
            }}
            onBlur={(e) => {
              const val = parseInt(e.target.value, 10);
              if (isNaN(val) || val < MIN_TIME_BIN_SIZE || val > MAX_TIME_BIN_SIZE) {
                setTimeBinSize(DEFAULT_TIME_BIN_SIZE);
              }
            }}
            className="h-7 w-16 text-xs"
          />
          <span className="text-xs text-muted-foreground">min</span>
        </div>
      )}

      <ChartWrapper
        title=""
        data={traces as PlotData[]}
        layout={layout}
        style={{ height: "400px" }}
      />

      {/* What-If Filter Explorer */}
      <WhatIfExplorer
        trades={trades}
        xAxisField={xAxis.field}
        metric={metric}
        onRangeChange={handleRangeChange}
      />
    </div>
  );
}

export default HistogramChart;
