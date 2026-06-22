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

interface ROMTimelineChartProps {
  className?: string;
}

export function ROMTimelineChart({ className }: ROMTimelineChartProps) {
  const { data } = usePerformanceStore();
  const [maPeriod, setMaPeriod] = useState<string>("30");

  const { plotData, layout } = useMemo(() => {
    if (!data?.romTimeline || data.romTimeline.length === 0) {
      return { plotData: [], layout: {} };
    }

    const { romTimeline } = data;

    const dates = romTimeline.map((r) => r.date);
    const romValues = romTimeline.map((r) => r.rom);

    const traces: Partial<PlotData>[] = [];

    // ROM scatter plot
    traces.push({
      x: dates,
      y: romValues,
      type: "scattergl",
      mode: "markers",
      name: "ROM Values",
      marker: {
        color: "#3b82f6",
        size: 6,
        opacity: 0.7,
      },
      hovertemplate: "<b>%{x}</b><br>ROM: %{y:.1f}%<extra></extra>",
    });

    // Moving average overlay
    if (maPeriod !== "none" && romValues.length >= 2) {
      const period = parseInt(maPeriod);

      // Only display MA if we have enough data points for a full window
      if (romValues.length >= period) {
        const ma: number[] = [];
        const maDates: string[] = [];

        // Start from the first point where we have a full window
        for (let i = period - 1; i < romValues.length; i++) {
          const window = romValues.slice(i - period + 1, i + 1);
          const avg = window.reduce((sum, val) => sum + val, 0) / window.length;
          ma.push(avg);
          maDates.push(dates[i]);
        }

        traces.push({
          x: maDates,
          y: ma,
          type: "scatter",
          mode: "lines",
          name: `${period}-point MA`,
          line: {
            color: "#dc2626",
            width: 2,
          },
          hovertemplate: `<b>%{x}</b><br>MA: %{y:.1f}%<extra></extra>`,
        });
      }
    }

    // Calculate mean ROM
    const meanROM = romValues.reduce((sum, val) => sum + val, 0) / romValues.length;

    // Add mean line as a trace (not a shape) so it can be toggled via legend
    traces.push({
      x: [dates[0], dates[dates.length - 1]],
      y: [meanROM, meanROM],
      type: "scatter",
      mode: "lines",
      line: {
        color: "#16a34a",
        width: 2,
        dash: "dash",
      },
      name: `Mean: ${meanROM.toFixed(1)}%`,
      showlegend: true,
      hovertemplate: `<b>Mean ROM</b><br>${meanROM.toFixed(1)}%<extra></extra>`,
    });

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Date" },
        showgrid: true,
      },
      yaxis: {
        title: { text: "Return on Margin (%)" },
        showgrid: true,
      },
      showlegend: true,
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
      hovermode: "closest",
    };

    return { plotData: traces, layout: chartLayout };
  }, [data, maPeriod]);

  const tooltip = {
    flavor:
      "Building efficiency - how much structure you're creating with each block of borrowed capital.",
    detailed:
      "Return on Margin shows how efficiently you're using borrowed capital by comparing profits/losses to the margin required. This is especially important for options trading where margin requirements vary significantly. Higher RoM indicates better capital efficiency, while trends show if your effectiveness is improving over time.",
  };

  if (!data || !data.romTimeline || data.romTimeline.length === 0) {
    return (
      <ChartWrapper
        title="📈 Return on Margin Timeline"
        description="ROM% for each trade over time with moving average"
        className={className}
        data={[]}
        layout={{}}
        style={{ height: "400px" }}
        tooltip={tooltip}
      />
    );
  }

  return (
    <ChartWrapper
      title="📈 Return on Margin Timeline"
      description="ROM% for each trade over time with optional moving average overlay"
      className={className}
      data={plotData}
      layout={layout}
      style={{ height: "450px" }}
      tooltip={tooltip}
    >
      <div className="flex items-center gap-2">
        <Label htmlFor="ma-period" className="text-xs text-muted-foreground">
          MA Period:
        </Label>
        <Select value={maPeriod} onValueChange={setMaPeriod}>
          <SelectTrigger id="ma-period" className="w-[100px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="20">20</SelectItem>
            <SelectItem value="30">30</SelectItem>
            <SelectItem value="50">50</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </ChartWrapper>
  );
}
