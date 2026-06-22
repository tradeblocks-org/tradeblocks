/**
 * Margin utilization chart showing portfolio and per-strategy margin over time
 */

"use client";

import { Card } from "@/components/ui/card";
import { MarginTimeline } from "@tradeblocks/lib";
import { truncateStrategyName } from "@tradeblocks/lib";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import type { Data } from "plotly.js";
import { useMemo } from "react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface MarginChartProps {
  marginTimeline: MarginTimeline;
  strategyNames: string[];
}

export function MarginChart({ marginTimeline, strategyNames }: MarginChartProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const { data, layout } = useMemo(() => {
    const traces: Data[] = [];

    const hoverTemplate =
      "<b>Date:</b> %{x|%b %d, %Y}<br>" + "<b>%{fullData.name}:</b> %{y:.2f}%<extra></extra>";

    // Portfolio line (bold)
    if (marginTimeline.dates.length > 0) {
      traces.push({
        x: marginTimeline.dates,
        y: marginTimeline.portfolioPct,
        mode: "lines+markers",
        name: "Portfolio",
        line: { width: 3 },
        marker: { size: 6 },
        hovertemplate: hoverTemplate,
      });

      // Per-strategy lines (dotted)
      for (const strategyName of strategyNames) {
        const series = marginTimeline.strategyPct.get(strategyName) || [];
        if (!series.some((v) => v > 0)) continue; // Skip if no margin used

        traces.push({
          x: marginTimeline.dates,
          y: series,
          mode: "lines",
          name: truncateStrategyName(strategyName, 40),
          line: { dash: "dot" },
          hovertemplate: hoverTemplate.replace("%{fullData.name}", strategyName),
        });
      }
    }

    const plotLayout = {
      paper_bgcolor: isDark ? "#020817" : "#ffffff",
      plot_bgcolor: isDark ? "#020817" : "#ffffff",
      font: {
        family:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        size: 12,
        color: isDark ? "#f8fafc" : "#0f172a",
      },
      xaxis: {
        title: { text: "Date" },
        showgrid: true,
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        automargin: true,
      },
      yaxis: {
        title: { text: "% of Starting Capital", standoff: 20 },
        showgrid: true,
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        ticksuffix: "%",
        automargin: true,
      },
      hovermode: "closest" as const,
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "left" as const,
        x: 0,
        font: {
          color: isDark ? "#f8fafc" : "#0f172a",
        },
      },
      autosize: true,
      height: 400,
      margin: {
        l: 60,
        r: 30,
        t: 40,
        b: 60,
      },
    };

    return { data: traces, layout: plotLayout };
  }, [marginTimeline, strategyNames, isDark]);

  if (marginTimeline.dates.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-muted-foreground">
          No margin data available. Upload trades with margin requirements to see utilization over
          time.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Margin Utilization Over Time</h3>
      <div className="w-full">
        <Plot
          data={data}
          layout={layout}
          config={{ displayModeBar: true, displaylogo: false, responsive: true }}
          style={{ width: "100%", height: "400px" }}
          useResizeHandler
        />
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        Mode: {marginTimeline.mode === "fixed" ? "Fixed Capital" : "Compounding"}
        {marginTimeline.mode === "compounding" &&
          " (margin calculated as % of running net liquidation)"}
      </p>
    </Card>
  );
}
