"use client";

/**
 * Custom Chart
 *
 * Dynamic Plotly chart that renders based on user-selected axes and chart type.
 */

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { EnrichedTrade, getEnrichedTradeValue } from "@tradeblocks/lib";
import { ChartAxisConfig, ChartType, getFieldInfo } from "@tradeblocks/lib";
import {
  formatMinutesToTime,
  generateTimeAxisTicksFromData,
  getTimingLabel,
  isDiscreteTimingField,
} from "@tradeblocks/lib";
import type { Layout, PlotData } from "plotly.js";
import { useMemo } from "react";

interface CustomChartProps {
  trades: EnrichedTrade[];
  chartType: ChartType;
  xAxis: ChartAxisConfig;
  yAxis: ChartAxisConfig;
  yAxis2?: ChartAxisConfig; // Secondary Y-axis (right side)
  yAxis3?: ChartAxisConfig; // Tertiary Y-axis (far right)
  colorBy?: ChartAxisConfig;
  sizeBy?: ChartAxisConfig;
  boxBucketCount?: number; // Number of buckets for box plot (default: 4)
  className?: string;
}

/**
 * Colors for multi-axis traces
 */
const AXIS_COLORS = {
  y1: "rgb(59, 130, 246)", // Blue (primary)
  y2: "rgb(239, 68, 68)", // Red (secondary)
  y3: "rgb(34, 197, 94)", // Green (tertiary)
};

// Use shared getEnrichedTradeValue from enriched-trade model
const getTradeValue = getEnrichedTradeValue;

/**
 * Binary/categorical fields that should use discrete colors instead of continuous scale
 */
const BINARY_FIELDS = new Set(["isWinner"]);

/**
 * Check if a field should use categorical coloring
 */
function isBinaryField(field: string): boolean {
  return BINARY_FIELDS.has(field);
}

/**
 * Date/timestamp fields that should use date axis formatting
 */
const DATE_FIELDS = new Set(["dateOpenedTimestamp"]);

/**
 * Check if a field is a date/timestamp field
 */
function isDateField(field: string): boolean {
  return DATE_FIELDS.has(field);
}

/**
 * Format a value for hover display based on field type
 */
function formatValueForHover(value: number, field: string): string {
  if (isDateField(field)) {
    return new Date(value).toLocaleDateString();
  }
  if (field === "timeOfDayMinutes") {
    return formatMinutesToTime(value);
  }
  return value.toFixed(2);
}

/**
 * Convert a numeric value to a Plotly-compatible format
 * For date fields, converts timestamp to ISO string for proper axis handling
 */
function toPlotlyValue(value: number, field: string): number | string {
  if (isDateField(field)) {
    return new Date(value).toISOString();
  }
  return value;
}

/**
 * Build traces for a scatter plot with categorical coloring (winners/losers)
 */
function buildCategoricalScatterTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis: ChartAxisConfig,
  colorBy: ChartAxisConfig,
  sizeBy?: ChartAxisConfig,
): Partial<PlotData>[] {
  // Separate trades into winners and losers
  const winners: { x: number; y: number; size: number; hover: string }[] = [];
  const losers: { x: number; y: number; size: number; hover: string }[] = [];

  const xInfo = getFieldInfo(xAxis.field);
  const yInfo = getFieldInfo(yAxis.field);

  // Collect all size values first for scaling
  const allSizeValues: number[] = [];
  if (sizeBy && sizeBy.field !== "none") {
    for (const trade of trades) {
      const s = getTradeValue(trade, sizeBy.field);
      if (s !== null) allSizeValues.push(Math.abs(s));
    }
  }
  const maxSizeValue = allSizeValues.length > 0 ? Math.max(...allSizeValues) : 1;

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    const y = getTradeValue(trade, yAxis.field);
    const isWinner = getTradeValue(trade, colorBy.field);

    if (x === null || y === null) continue;

    // Calculate size for this trade
    let size = 8;
    if (sizeBy && sizeBy.field !== "none") {
      const s = getTradeValue(trade, sizeBy.field);
      size = Math.min(30, Math.max(6, (Math.abs(s ?? 0) / (maxSizeValue || 1)) * 25 + 5));
    }

    const hover =
      `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(x, xAxis.field)}<br>` +
      `${yInfo?.label ?? yAxis.field}: ${formatValueForHover(y, yAxis.field)}`;

    if (isWinner === 1) {
      winners.push({ x, y, size, hover });
    } else {
      losers.push({ x, y, size, hover });
    }
  }

  const traces: Partial<PlotData>[] = [];

  // Winners trace (green)
  if (winners.length > 0) {
    traces.push({
      x: winners.map((w) => w.x),
      y: winners.map((w) => w.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: "rgb(34, 197, 94)", // Green
        size: winners.map((w) => w.size),
      },
      hovertemplate: winners.map((w) => w.hover + "<extra></extra>"),
      name: "Winners",
    });
  }

  // Losers trace (red)
  if (losers.length > 0) {
    traces.push({
      x: losers.map((l) => l.x),
      y: losers.map((l) => l.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: "rgb(239, 68, 68)", // Red
        size: losers.map((l) => l.size),
      },
      hovertemplate: losers.map((l) => l.hover + "<extra></extra>"),
      name: "Losers",
    });
  }

  return traces;
}

/**
 * Build traces for a scatter plot
 */
function buildScatterTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis: ChartAxisConfig,
  colorBy?: ChartAxisConfig,
  sizeBy?: ChartAxisConfig,
): Partial<PlotData>[] {
  // Use categorical coloring for binary fields
  if (colorBy && colorBy.field !== "none" && isBinaryField(colorBy.field)) {
    return buildCategoricalScatterTraces(trades, xAxis, yAxis, colorBy, sizeBy);
  }

  const xValues: (number | string)[] = [];
  const yValues: number[] = [];
  const colorValues: number[] = [];
  const sizeValues: number[] = [];
  const hoverTexts: string[] = [];

  const xInfo = getFieldInfo(xAxis.field);
  const yInfo = getFieldInfo(yAxis.field);

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    const y = getTradeValue(trade, yAxis.field);

    if (x === null || y === null) continue;

    xValues.push(toPlotlyValue(x, xAxis.field));
    yValues.push(y);

    if (colorBy && colorBy.field !== "none") {
      const c = getTradeValue(trade, colorBy.field);
      colorValues.push(c ?? 0);
    }

    if (sizeBy && sizeBy.field !== "none") {
      const s = getTradeValue(trade, sizeBy.field);
      sizeValues.push(Math.abs(s ?? 0));
    }

    // Build hover text
    hoverTexts.push(
      `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(x, xAxis.field)}<br>` +
        `${yInfo?.label ?? yAxis.field}: ${formatValueForHover(y, yAxis.field)}`,
    );
  }

  // Calculate size scaling if using size encoding
  let markerSize: number | number[] = 8;
  if (sizeValues.length > 0) {
    const maxSize = Math.max(...sizeValues);
    markerSize = sizeValues.map((s) => Math.min(30, Math.max(6, (s / (maxSize || 1)) * 25 + 5)));
  }

  // Calculate color scale bounds for symmetry around zero
  let colorConfig: Partial<PlotData["marker"]> = {
    color: "rgb(59, 130, 246)", // Default blue
    size: markerSize,
  };

  if (colorValues.length > 0) {
    const maxAbs = Math.max(...colorValues.map(Math.abs)) || 1;
    colorConfig = {
      color: colorValues,
      colorscale: "RdYlBu",
      cmin: -maxAbs,
      cmax: maxAbs,
      showscale: true,
      colorbar: {
        title: { text: getFieldInfo(colorBy!.field)?.label ?? colorBy!.field },
      },
      size: markerSize,
    };
  }

  return [
    {
      x: xValues,
      y: yValues,
      mode: "markers",
      type: "scattergl",
      marker: colorConfig,
      hovertemplate: hoverTexts.map((t) => t + "<extra></extra>"),
      name: "",
    },
  ];
}

/**
 * Build traces for a histogram
 */
function buildHistogramTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
): Partial<PlotData>[] {
  const values: number[] = [];

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    if (x !== null) {
      values.push(x);
    }
  }

  return [
    {
      x: values,
      type: "histogram",
      marker: {
        color: "rgb(59, 130, 246)",
      },
      name: getFieldInfo(xAxis.field)?.label ?? xAxis.field,
    },
  ];
}

/**
 * Build traces for a bar chart (aggregate Y by X buckets)
 */
function buildBarTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis: ChartAxisConfig,
): Partial<PlotData>[] {
  // Group trades by X value buckets
  const buckets = new Map<string, number[]>();
  const isTimeField = xAxis.field === "timeOfDayMinutes";

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    const y = getTradeValue(trade, yAxis.field);

    if (x === null || y === null) continue;

    // Create bucket key - for time, keep exact minute value
    let bucketKey: string;
    if (isTimeField) {
      // Keep exact minute value (no rounding)
      bucketKey = Math.round(x).toString();
    } else {
      bucketKey = x.toFixed(1);
    }

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey)!.push(y);
  }

  // Calculate average Y for each bucket
  const xLabels: string[] = [];
  const yAvgs: number[] = [];
  const xInfo = getFieldInfo(xAxis.field);
  const yInfo = getFieldInfo(yAxis.field);

  const sortedBuckets = Array.from(buckets.entries()).sort(
    (a, b) => parseFloat(a[0]) - parseFloat(b[0]),
  );

  for (const [bucket, values] of sortedBuckets) {
    // Format time values as readable time for bar labels
    if (isTimeField) {
      xLabels.push(formatMinutesToTime(parseFloat(bucket)));
    } else {
      xLabels.push(bucket);
    }
    yAvgs.push(values.reduce((sum, v) => sum + v, 0) / values.length);
  }

  return [
    {
      x: xLabels,
      y: yAvgs,
      type: "bar",
      marker: {
        color: yAvgs.map((v) => (v >= 0 ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)")),
      },
      hovertemplate: xLabels.map(
        (label, i) =>
          `${xInfo?.label ?? xAxis.field}: ${label}<br>` +
          `Avg ${yInfo?.label ?? yAxis.field}: ${yAvgs[i].toFixed(2)}<extra></extra>`,
      ),
      name: `Avg ${yInfo?.label ?? yAxis.field}`,
    },
  ];
}

/**
 * Build traces for a line chart (sorted by X, shows trend)
 */
function buildLineTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis: ChartAxisConfig,
): Partial<PlotData>[] {
  const points: { x: number; y: number }[] = [];

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    const y = getTradeValue(trade, yAxis.field);

    if (x !== null && y !== null) {
      points.push({ x, y });
    }
  }

  // Sort by X value for proper line rendering
  points.sort((a, b) => a.x - b.x);

  const xInfo = getFieldInfo(xAxis.field);
  const yInfo = getFieldInfo(yAxis.field);

  return [
    {
      x: points.map((p) => toPlotlyValue(p.x, xAxis.field)),
      y: points.map((p) => p.y),
      type: "scatter",
      mode: "lines+markers",
      line: {
        color: "rgb(59, 130, 246)",
        width: 2,
      },
      marker: {
        color: "rgb(59, 130, 246)",
        size: 6,
      },
      hovertemplate: points.map(
        (p) =>
          `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(p.x, xAxis.field)}<br>` +
          `${yInfo?.label ?? yAxis.field}: ${formatValueForHover(p.y, yAxis.field)}<extra></extra>`,
      ),
      name: yInfo?.label ?? yAxis.field,
    },
  ];
}

/**
 * Build traces for a box plot
 */
function buildBoxTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis: ChartAxisConfig,
  bucketCount: number = 4,
): Partial<PlotData>[] {
  // For box plots, we'll create N buckets of X and show Y distribution
  const xValues: number[] = [];
  const yValues: number[] = [];

  for (const trade of trades) {
    const x = getTradeValue(trade, xAxis.field);
    const y = getTradeValue(trade, yAxis.field);

    if (x !== null && y !== null) {
      xValues.push(x);
      yValues.push(y);
    }
  }

  if (xValues.length === 0) {
    return [];
  }

  // Check if this is a discrete timing field (day of week, month, hour)
  const isDiscrete = isDiscreteTimingField(xAxis.field);
  // Check if this is time of day (continuous but needs time formatting)
  const isTimeOfDay = xAxis.field === "timeOfDayMinutes";

  // For discrete timing fields, use the actual values as bucket keys
  // For continuous fields, create N equal-sized buckets
  let getBucketLabel: (x: number) => string;

  if (isDiscrete) {
    // Use human-readable labels for timing fields
    getBucketLabel = (x: number) => {
      const label = getTimingLabel(xAxis.field, Math.round(x));
      return label ?? String(Math.round(x));
    };
  } else {
    // Create N equal-sized buckets based on percentiles
    const sorted = [...xValues].sort((a, b) => a - b);
    const bucketEdges: number[] = [];

    for (let i = 1; i < bucketCount; i++) {
      const idx = Math.floor((sorted.length * i) / bucketCount);
      bucketEdges.push(sorted[idx]);
    }

    // Helper to format a value (time formatting for timeOfDayMinutes)
    const formatValue = (val: number): string => {
      if (isTimeOfDay) {
        return formatMinutesToTime(val, false); // No timezone suffix for compact display
      }
      return val.toFixed(1);
    };

    getBucketLabel = (x: number) => {
      for (let i = 0; i < bucketEdges.length; i++) {
        if (x <= bucketEdges[i]) {
          const low = i === 0 ? sorted[0] : bucketEdges[i - 1];
          const high = bucketEdges[i];
          return `${formatValue(low)} - ${formatValue(high)}`;
        }
      }
      const low = bucketEdges[bucketEdges.length - 1];
      const high = sorted[sorted.length - 1];
      return `${formatValue(low)} - ${formatValue(high)}`;
    };
  }

  const xLabels = xValues.map(getBucketLabel);

  // Sort the labels array to ensure consistent bucket ordering
  // Create pairs of [label, yValue] and sort by the bucket start value
  const pairs = xLabels.map((label, i) => ({
    label,
    y: yValues[i],
    x: xValues[i],
  }));
  pairs.sort((a, b) => a.x - b.x);

  return [
    {
      x: pairs.map((p) => p.label),
      y: pairs.map((p) => p.y),
      type: "box",
      marker: {
        color: "rgb(59, 130, 246)",
      },
      name: getFieldInfo(yAxis.field)?.label ?? yAxis.field,
    },
  ];
}

/**
 * Build traces for additional Y-axes (y2, y3)
 */
function buildAdditionalAxisTraces(
  trades: EnrichedTrade[],
  xAxis: ChartAxisConfig,
  yAxis2?: ChartAxisConfig,
  yAxis3?: ChartAxisConfig,
  chartType?: ChartType,
): Partial<PlotData>[] {
  const traces: Partial<PlotData>[] = [];
  const isLine = chartType === "line";
  const xInfo = getFieldInfo(xAxis.field);

  // Build Y2 trace
  if (yAxis2 && yAxis2.field !== "none") {
    const y2Info = getFieldInfo(yAxis2.field);
    const points: { x: number; y: number }[] = [];

    for (const trade of trades) {
      const x = getTradeValue(trade, xAxis.field);
      const y = getTradeValue(trade, yAxis2.field);
      if (x !== null && y !== null) {
        points.push({ x, y });
      }
    }

    // Sort by X for line charts
    if (isLine) {
      points.sort((a, b) => a.x - b.x);
    }

    if (points.length > 0) {
      traces.push({
        x: points.map((p) => toPlotlyValue(p.x, xAxis.field)),
        y: points.map((p) => p.y),
        type: "scattergl",
        mode: isLine ? "lines+markers" : "markers",
        marker: {
          color: AXIS_COLORS.y2,
          size: 6,
        },
        line: isLine
          ? {
              color: AXIS_COLORS.y2,
              width: 2,
            }
          : undefined,
        yaxis: "y2",
        name: y2Info?.label ?? yAxis2.field,
        hovertemplate: points.map(
          (p) =>
            `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(p.x, xAxis.field)}<br>` +
            `${y2Info?.label ?? yAxis2.field}: ${formatValueForHover(
              p.y,
              yAxis2.field,
            )}<extra></extra>`,
        ),
      });
    }
  }

  // Build Y3 trace
  if (yAxis3 && yAxis3.field !== "none") {
    const y3Info = getFieldInfo(yAxis3.field);
    const points: { x: number; y: number }[] = [];

    for (const trade of trades) {
      const x = getTradeValue(trade, xAxis.field);
      const y = getTradeValue(trade, yAxis3.field);
      if (x !== null && y !== null) {
        points.push({ x, y });
      }
    }

    // Sort by X for line charts
    if (isLine) {
      points.sort((a, b) => a.x - b.x);
    }

    if (points.length > 0) {
      traces.push({
        x: points.map((p) => toPlotlyValue(p.x, xAxis.field)),
        y: points.map((p) => p.y),
        type: "scattergl",
        mode: isLine ? "lines+markers" : "markers",
        marker: {
          color: AXIS_COLORS.y3,
          size: 6,
        },
        line: isLine
          ? {
              color: AXIS_COLORS.y3,
              width: 2,
            }
          : undefined,
        yaxis: "y3",
        name: y3Info?.label ?? yAxis3.field,
        hovertemplate: points.map(
          (p) =>
            `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(p.x, xAxis.field)}<br>` +
            `${y3Info?.label ?? yAxis3.field}: ${formatValueForHover(
              p.y,
              yAxis3.field,
            )}<extra></extra>`,
        ),
      });
    }
  }

  return traces;
}

/**
 * Calculate Y-axis range with padding
 */
function calculateAxisRange(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min) * 0.1 || 1;
  return [min - padding, max + padding];
}

export function CustomChart({
  trades,
  chartType,
  xAxis,
  yAxis,
  yAxis2,
  yAxis3,
  colorBy,
  sizeBy,
  boxBucketCount = 4,
  className,
}: CustomChartProps) {
  const { traces, layout } = useMemo(() => {
    if (trades.length === 0) {
      return { traces: [], layout: {} };
    }

    let chartTraces: Partial<PlotData>[] = [];

    // Check if we're using multi-axis (only for scatter/line)
    const hasMultiAxis =
      (chartType === "scatter" || chartType === "line") &&
      ((yAxis2 && yAxis2.field !== "none") || (yAxis3 && yAxis3.field !== "none"));

    switch (chartType) {
      case "scatter":
        // When using multi-axis, don't use colorBy (it conflicts with axis coloring)
        if (hasMultiAxis) {
          // Build simple scatter for primary axis with axis color
          const xInfo = getFieldInfo(xAxis.field);
          const yInfo = getFieldInfo(yAxis.field);
          const points: { x: number; y: number }[] = [];
          for (const trade of trades) {
            const x = getTradeValue(trade, xAxis.field);
            const y = getTradeValue(trade, yAxis.field);
            if (x !== null && y !== null) {
              points.push({ x, y });
            }
          }
          chartTraces = [
            {
              x: points.map((p) => toPlotlyValue(p.x, xAxis.field)),
              y: points.map((p) => p.y),
              type: "scattergl",
              mode: "markers",
              marker: {
                color: AXIS_COLORS.y1,
                size: 8,
              },
              name: yInfo?.label ?? yAxis.field,
              hovertemplate: points.map(
                (p) =>
                  `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(p.x, xAxis.field)}<br>` +
                  `${yInfo?.label ?? yAxis.field}: ${formatValueForHover(
                    p.y,
                    yAxis.field,
                  )}<extra></extra>`,
              ),
            },
          ];
        } else {
          chartTraces = buildScatterTraces(trades, xAxis, yAxis, colorBy, sizeBy);
        }
        break;
      case "line":
        // For line charts with multi-axis, use axis colors
        if (hasMultiAxis) {
          const xInfo = getFieldInfo(xAxis.field);
          const yInfo = getFieldInfo(yAxis.field);
          const points: { x: number; y: number }[] = [];
          for (const trade of trades) {
            const x = getTradeValue(trade, xAxis.field);
            const y = getTradeValue(trade, yAxis.field);
            if (x !== null && y !== null) {
              points.push({ x, y });
            }
          }
          points.sort((a, b) => a.x - b.x);
          chartTraces = [
            {
              x: points.map((p) => toPlotlyValue(p.x, xAxis.field)),
              y: points.map((p) => p.y),
              type: "scattergl",
              mode: "lines+markers",
              line: { color: AXIS_COLORS.y1, width: 2 },
              marker: { color: AXIS_COLORS.y1, size: 6 },
              name: yInfo?.label ?? yAxis.field,
              hovertemplate: points.map(
                (p) =>
                  `${xInfo?.label ?? xAxis.field}: ${formatValueForHover(p.x, xAxis.field)}<br>` +
                  `${yInfo?.label ?? yAxis.field}: ${formatValueForHover(
                    p.y,
                    yAxis.field,
                  )}<extra></extra>`,
              ),
            },
          ];
        } else {
          chartTraces = buildLineTraces(trades, xAxis, yAxis);
        }
        break;
      case "histogram":
        chartTraces = buildHistogramTraces(trades, xAxis);
        break;
      case "bar":
        chartTraces = buildBarTraces(trades, xAxis, yAxis);
        break;
      case "box":
        chartTraces = buildBoxTraces(trades, xAxis, yAxis, boxBucketCount);
        break;
    }

    // Add additional Y-axis traces for scatter/line
    if (hasMultiAxis) {
      const additionalTraces = buildAdditionalAxisTraces(trades, xAxis, yAxis2, yAxis3, chartType);
      chartTraces = [...chartTraces, ...additionalTraces];
    }

    const xInfo = getFieldInfo(xAxis.field);
    const yInfo = getFieldInfo(yAxis.field);

    // Show legend for categorical color fields OR when using multi-axis
    const useCategoricalColor = colorBy && colorBy.field !== "none" && isBinaryField(colorBy.field);
    const showLegend = useCategoricalColor || hasMultiAxis;

    // Use date axis type for date fields
    const isXAxisDate = isDateField(xAxis.field);

    // Box plots use categorical string labels on X-axis (bucket ranges like "9:30 AM - 10:30 AM")
    // so we need to explicitly set category type for proper rendering
    const isBoxPlot = chartType === "box";

    // Check for time fields to generate custom tick labels.
    // For bar charts, the X-axis is already converted to string category labels
    // in buildBarTraces (e.g., "09:30", "10:00"), while the time tick helpers
    // generate numeric tickvals. Mixing numeric tickvals with string category
    // labels would cause a mismatch, so we only apply time tick formatting to
    // non-bar/non-box charts.
    const isXTimeField = xAxis.field === "timeOfDayMinutes" && chartType !== "bar" && !isBoxPlot;
    const isYTimeField = yAxis.field === "timeOfDayMinutes" && chartType !== "bar";

    // Generate time axis ticks using shared helper
    const xTimeTicks = isXTimeField
      ? generateTimeAxisTicksFromData(
          trades.map((t) => getTradeValue(t, xAxis.field)).filter((v): v is number => v !== null),
        )
      : null;
    const yTimeTicks = isYTimeField
      ? generateTimeAxisTicksFromData(
          trades.map((t) => getTradeValue(t, yAxis.field)).filter((v): v is number => v !== null),
        )
      : null;

    // Calculate dynamic right margin based on number of axes
    let rightMargin = 40;
    if (colorBy && colorBy.field !== "none" && !hasMultiAxis) {
      rightMargin = 100; // Space for color bar
    } else if (hasMultiAxis) {
      const hasY3 = yAxis3 && yAxis3.field !== "none";
      // Y2 uses the default right side, Y3 shifts outward by 60px
      rightMargin = hasY3 ? 110 : 50;
    }

    // Increase left margin for time axis labels on Y-axis
    const leftMargin = isYTimeField ? 95 : 70;

    // Determine X-axis type: date for timestamps, category for box plots, undefined otherwise
    const xAxisType = isXAxisDate ? "date" : isBoxPlot ? "category" : undefined;

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: xInfo?.label ?? xAxis.field },
        zeroline: chartType !== "histogram",
        type: xAxisType,
        ...(xTimeTicks && {
          tickvals: xTimeTicks.tickvals,
          ticktext: xTimeTicks.ticktext,
        }),
      },
      yaxis: {
        title: {
          text: chartType === "histogram" ? "Count" : (yInfo?.label ?? yAxis.field),
        },
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
        ...(yTimeTicks && {
          tickvals: yTimeTicks.tickvals,
          ticktext: yTimeTicks.ticktext,
        }),
      },
      showlegend: showLegend,
      legend: showLegend
        ? {
            x: 0,
            y: 1.1,
            xanchor: "left",
            yanchor: "bottom",
            orientation: "h",
            bgcolor: "rgba(0,0,0,0)",
          }
        : undefined,
      hovermode: "closest",
      margin: {
        t: showLegend ? 40 : 20,
        r: rightMargin,
        b: 60,
        l: leftMargin,
      },
    };

    // Add Y2 axis config
    if (yAxis2 && yAxis2.field !== "none") {
      const y2Info = getFieldInfo(yAxis2.field);
      const y2Values: number[] = [];
      for (const trade of trades) {
        const v = getTradeValue(trade, yAxis2.field);
        if (v !== null) y2Values.push(v);
      }
      (chartLayout as Record<string, unknown>).yaxis2 = {
        title: { text: y2Info?.label ?? yAxis2.field },
        overlaying: "y",
        side: "right",
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
        range: calculateAxisRange(y2Values),
      };
    }

    // Add Y3 axis config
    if (yAxis3 && yAxis3.field !== "none") {
      const y3Info = getFieldInfo(yAxis3.field);
      const y3Values: number[] = [];
      for (const trade of trades) {
        const v = getTradeValue(trade, yAxis3.field);
        if (v !== null) y3Values.push(v);
      }
      (chartLayout as Record<string, unknown>).yaxis3 = {
        title: { text: y3Info?.label ?? yAxis3.field },
        overlaying: "y",
        side: "right",
        anchor: "free",
        position: 1,
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: "#94a3b8",
        range: calculateAxisRange(y3Values),
        shift: 60,
      };
    }

    return { traces: chartTraces, layout: chartLayout };
  }, [trades, chartType, xAxis, yAxis, yAxis2, yAxis3, colorBy, sizeBy, boxBucketCount]);

  if (trades.length === 0) {
    return (
      <div className="h-[400px] flex items-center justify-center text-muted-foreground">
        No data available for chart
      </div>
    );
  }

  return (
    <ChartWrapper
      title=""
      className={className}
      data={traces as PlotData[]}
      layout={layout}
      style={{ height: "400px" }}
    />
  );
}

export default CustomChart;
