"use client";

import type { Data } from "plotly.js";
import { useEffect, useMemo, useState } from "react";

import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import type { WalkForwardPeriodResult } from "@tradeblocks/lib";

interface WalkForwardAnalysisChartProps {
  periods: WalkForwardPeriodResult[];
  targetMetricLabel: string;
}

export function WalkForwardAnalysisChart({
  periods,
  targetMetricLabel,
}: WalkForwardAnalysisChartProps) {
  const [timelineRange, setTimelineRange] = useState<[number, number]>([1, periods.length || 1]);
  const [paramRange, setParamRange] = useState<[number, number]>([1, periods.length || 1]);

  useEffect(() => {
    const count = periods.length || 1;
    setTimelineRange([1, count]);
    setParamRange([1, count]);
  }, [periods]);

  const slicePeriods = (range: [number, number]) =>
    periods.slice(Math.max(0, range[0] - 1), Math.min(periods.length, range[1]));

  const timelinePeriods = slicePeriods(timelineRange);
  const paramPeriods = slicePeriods(paramRange);

  const periodSignature = useMemo(() => {
    if (!periods.length) return "empty";
    return periods
      .map((period) => {
        const inSampleStart = new Date(period.inSampleStart).toISOString();
        const outOfSampleEnd = new Date(period.outOfSampleEnd).toISOString();
        const oosMetric = period.targetMetricOutOfSample.toFixed(4);
        return `${inSampleStart}-${outOfSampleEnd}-${oosMetric}`;
      })
      .join("|");
  }, [periods]);

  const timeline = useMemo(() => {
    if (!timelinePeriods.length) {
      return null;
    }
    const midpoint = (start: Date, end: Date) =>
      new Date((new Date(start).getTime() + new Date(end).getTime()) / 2).toISOString();

    const inSampleTrace: Data = {
      type: "scatter",
      mode: "lines+markers",
      name: "In-Sample",
      x: timelinePeriods.map((period) => midpoint(period.inSampleStart, period.inSampleEnd)),
      y: timelinePeriods.map((period) => Number(period.targetMetricInSample.toFixed(3))),
      marker: { color: "#2563eb", size: 8 },
      line: { width: 2, color: "#2563eb" },
      hovertemplate:
        `<b>In-Sample</b><br>${targetMetricLabel}: %{y:.3f}<br>` + `Window: %{x}<extra></extra>`,
    };

    const outSampleTrace: Data = {
      type: "scatter",
      mode: "lines+markers",
      name: "Out-of-Sample",
      x: timelinePeriods.map((period) => midpoint(period.outOfSampleStart, period.outOfSampleEnd)),
      y: timelinePeriods.map((period) => Number(period.targetMetricOutOfSample.toFixed(3))),
      marker: { color: "#f97316", size: 8 },
      line: { width: 2, dash: "dot", color: "#f97316" },
      hovertemplate:
        `<b>Out-of-Sample</b><br>${targetMetricLabel}: %{y:.3f}<br>` +
        `Window: %{x}<extra></extra>`,
    };

    const shapes = timelinePeriods.flatMap((period) => [
      {
        type: "rect" as const,
        xref: "x" as const,
        yref: "paper" as const,
        x0: period.inSampleStart.toISOString(),
        x1: period.inSampleEnd.toISOString(),
        y0: 0,
        y1: 0.45,
        fillcolor: "rgba(37,99,235,0.08)",
        line: { width: 0 },
      },
      {
        type: "rect" as const,
        xref: "x" as const,
        yref: "paper" as const,
        x0: period.outOfSampleStart.toISOString(),
        x1: period.outOfSampleEnd.toISOString(),
        y0: 0.55,
        y1: 1,
        fillcolor: "rgba(249,115,22,0.08)",
        line: { width: 0 },
      },
    ]);

    // Reduce tick clutter similar to parameter chart: limit to ~12 ticks
    const tickStep = Math.max(1, Math.ceil(timelinePeriods.length / 12));
    const tickVals: string[] = [];
    const tickText: string[] = [];
    timelinePeriods.forEach((period, index) => {
      if (index % tickStep === 0 || index === timelinePeriods.length - 1) {
        const label = midpoint(period.inSampleStart, period.inSampleEnd);
        tickVals.push(label);
        tickText.push(new Date(label).toLocaleDateString());
      }
    });

    return {
      data: [inSampleTrace, outSampleTrace],
      layout: {
        title: undefined,
        xaxis: {
          title: { text: "Timeline" },
          type: "date" as const,
          tickmode: "array" as const,
          tickvals: tickVals,
          ticktext: tickText,
          tickangle: -45,
          automargin: true,
          tickfont: { size: 10 },
        },
        yaxis: {
          title: { text: targetMetricLabel },
          zeroline: true,
        },
        shapes,
        legend: {
          orientation: "h" as const,
          y: 1.15,
          yanchor: "bottom" as const,
          x: 0,
          xanchor: "left" as const,
        },
        margin: { t: 60, b: 90, l: 70, r: 20 },
      },
    };
  }, [timelinePeriods, targetMetricLabel]);

  const parameterEvolution = useMemo(() => {
    const parameterKeys = Array.from(
      new Set(paramPeriods.flatMap((period) => Object.keys(period.optimalParameters))),
    );

    if (parameterKeys.length === 0) {
      return null;
    }

    const toLabel = (key: string) => {
      if (key.startsWith("strategy:")) return `Weight: ${key.replace("strategy:", "")}`;
      switch (key) {
        case "kellyMultiplier":
          return "Kelly Multiplier";
        case "fixedFractionPct":
          return "Fixed Fraction %";
        case "maxDrawdownPct":
          return "Max Drawdown %";
        case "maxDailyLossPct":
          return "Max Daily Loss %";
        case "consecutiveLossLimit":
          return "Consecutive Loss Limit";
        default:
          return key;
      }
    };

    // Separate strategy weights from other parameters for distinct styling
    const strategyWeightKeys = parameterKeys.filter((k) => k.startsWith("strategy:"));
    const otherParamKeys = parameterKeys.filter((k) => !k.startsWith("strategy:"));

    // Color palette for strategy weights (distinct from default Plotly colors)
    const strategyColors = [
      "#8b5cf6", // violet
      "#06b6d4", // cyan
      "#84cc16", // lime
      "#f97316", // orange
      "#ec4899", // pink
    ];

    const traces: Data[] = [
      // Other parameters - solid lines
      ...otherParamKeys.map((key) => {
        const friendlyName = toLabel(key);
        return {
          type: "scatter" as const,
          mode: "lines+markers" as const,
          name: friendlyName,
          x: paramPeriods.map((_, index) => `Period ${index + 1}`),
          y: paramPeriods.map((period) => period.optimalParameters[key] ?? null),
          connectgaps: true,
        };
      }),
      // Strategy weights - dashed lines with distinct colors
      ...strategyWeightKeys.map((key, idx) => {
        const friendlyName = toLabel(key);
        return {
          type: "scatter" as const,
          mode: "lines+markers" as const,
          name: friendlyName,
          x: paramPeriods.map((_, index) => `Period ${index + 1}`),
          y: paramPeriods.map((period) => period.optimalParameters[key] ?? null),
          connectgaps: true,
          line: {
            dash: "dash" as const,
            color: strategyColors[idx % strategyColors.length],
          },
          marker: {
            symbol: "diamond" as const,
            color: strategyColors[idx % strategyColors.length],
          },
        };
      }),
    ];

    // Reduce tick clutter: show at most ~12 ticks across the window
    const tickStep = Math.max(1, Math.ceil(paramPeriods.length / 12));
    const tickVals: string[] = [];
    const tickText: string[] = [];
    paramPeriods.forEach((_, index) => {
      if (index % tickStep === 0 || index === paramPeriods.length - 1) {
        const label = `Period ${index + 1}`;
        tickVals.push(label);
        tickText.push(label);
      }
    });

    return {
      data: traces,
      layout: {
        title: undefined,
        xaxis: {
          title: { text: "Optimization Window" },
          tickangle: -45,
          tickmode: "array" as const,
          tickvals: tickVals,
          ticktext: tickText,
          automargin: true,
          tickfont: { size: 10 },
        },
        yaxis: { title: { text: "Parameter Value" } },
        legend: {
          orientation: "h" as const,
          y: 1.15,
          yanchor: "bottom" as const,
          x: 0,
          xanchor: "left" as const,
        },
        margin: { t: 60, b: 80, l: 70, r: 20 },
      },
    };
  }, [paramPeriods]);

  if (!timeline) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Run an analysis to unlock timeline insights.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ChartWrapper
        key={`timeline-${periodSignature}-${targetMetricLabel}`}
        title="Performance Timeline"
        description="Compare in-sample versus out-of-sample performance along the rolling windows."
        headerAddon={
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500/80" />
              <span>In-Sample</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-orange-500/80" />
              <span>Out-of-Sample</span>
            </div>
            {periods.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Range</span>
                <div className="w-32 sm:w-40">
                  <Slider
                    min={1}
                    max={periods.length}
                    step={1}
                    value={[timelineRange[0], timelineRange[1]]}
                    onValueChange={(v) => {
                      if (!v || v.length < 2) return;
                      const [a, b] = v as [number, number];
                      setTimelineRange([Math.min(a, b), Math.max(a, b)]);
                    }}
                  />
                </div>
                <Badge variant="secondary" className="text-[11px]">
                  {timelineRange[0]}–{timelineRange[1]}
                </Badge>
              </div>
            )}
          </div>
        }
        data={timeline.data}
        layout={{ ...timeline.layout, height: 380 }}
      />
      {parameterEvolution ? (
        <ChartWrapper
          key={`parameters-${periodSignature}`}
          title="Parameter Evolution"
          description="Track how optimal sizing or risk parameters changed across walk-forward runs."
          headerAddon={
            periods.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="text-muted-foreground">Range</span>
                <div className="w-32 sm:w-40">
                  <Slider
                    min={1}
                    max={periods.length}
                    step={1}
                    value={[paramRange[0], paramRange[1]]}
                    onValueChange={(v) => {
                      if (!v || v.length < 2) return;
                      const [a, b] = v as [number, number];
                      setParamRange([Math.min(a, b), Math.max(a, b)]);
                    }}
                  />
                </div>
                <Badge variant="secondary" className="text-[11px]">
                  {paramRange[0]}–{paramRange[1]}
                </Badge>
              </div>
            ) : null
          }
          data={parameterEvolution.data}
          layout={{ ...parameterEvolution.layout, height: 380 }}
        />
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No optimizable parameters were recorded for these periods.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
