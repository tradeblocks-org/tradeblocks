"use client";

import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { format } from "date-fns";
import type { Layout, PlotData } from "plotly.js";
import { useMemo } from "react";
import { ChartWrapper } from "./chart-wrapper";

interface GroupedLegOutcomesChartProps {
  className?: string;
}

// Increased max points since scatter plots can handle more density
const MAX_POINTS = 200;

const OUTCOME_LABELS: Record<string, string> = {
  all_losses: "All Legs Lost",
  all_wins: "All Legs Won",
  mixed: "Mixed Outcome",
  neutral: "Partial / Neutral",
};

const OUTCOME_COLORS: Record<string, string> = {
  all_losses: "#f87171",
  all_wins: "#4ade80",
  mixed: "#facc15",
  neutral: "#93c5fd",
};

export function GroupedLegOutcomesChart({ className }: GroupedLegOutcomesChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout, hasData, summary } = useMemo(() => {
    if (!data?.groupedLegOutcomes) {
      return { plotData: [], layout: {}, hasData: false, summary: null };
    }

    const entries = data.groupedLegOutcomes.entries;
    // Sort chronologically for the scatter plot line (if we wanted lines, but markers are better here)
    // The store already sorts them, but let's be safe for the axis.
    const sortedEntries = [...entries].sort(
      (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
    );

    const recentEntries =
      sortedEntries.length > MAX_POINTS ? sortedEntries.slice(-MAX_POINTS) : sortedEntries;

    // X-Axis: Actual Date/Time
    const xValues = recentEntries.map((entry) => {
      // Combine date and time if available for precise plotting
      if (entry.timeOpened) {
        return `${entry.dateOpened.split("T")[0]}T${entry.timeOpened}`;
      }
      return entry.dateOpened;
    });

    const yValues = recentEntries.map((entry) => entry.combinedPl);
    const colors = recentEntries.map((entry) => OUTCOME_COLORS[entry.outcome] ?? "#cbd5f5");

    // Prepare detailed custom data for tooltip
    const custom = recentEntries.map((entry) => {
      const dateLabel = format(new Date(entry.dateOpened), "MMM d, yyyy");
      const timeLabel = entry.timeOpened ? ` at ${entry.timeOpened}` : "";
      return [
        OUTCOME_LABELS[entry.outcome] ?? entry.outcome, // 0: Outcome Label
        entry.legCount, // 1: Leg Count
        entry.positiveLegs, // 2: Positive Legs
        entry.negativeLegs, // 3: Negative Legs
        `${dateLabel}${timeLabel}`, // 4: Full Date/Time
        entry.strategy, // 5: Strategy
      ];
    });

    const scatterTrace: Partial<PlotData> = {
      x: xValues,
      y: yValues,
      type: "scatter",
      mode: "markers",
      name: "Combined P/L",
      marker: {
        color: colors,
        size: 10,
        line: {
          color: "white",
          width: 1,
        },
        opacity: 0.8,
      },
      customdata: custom,
      hovertemplate:
        "<b>%{customdata[4]}</b><br>" +
        "Strategy: %{customdata[5]}<br>" +
        "Outcome: <b>%{customdata[0]}</b><br>" +
        "Combined P/L: <b>$%{y:.2f}</b><br>" +
        "Legs: %{customdata[1]} (Win: %{customdata[2]}, Loss: %{customdata[3]})<extra></extra>",
    };

    const layout: Partial<Layout> = {
      xaxis: {
        title: { text: "Date" },
        type: "date",
        tickformat: "%b %d", // e.g. "Jan 01"
        gridcolor: "#f1f5f9",
        zeroline: false,
      },
      yaxis: {
        title: { text: "P/L ($)" },
        zeroline: true,
        zerolinecolor: "#94a3b8",
        gridcolor: "#f1f5f9",
      },
      showlegend: false, // Legend is redundant with color coding and tooltip
      hovermode: "closest",
      margin: { t: 20, r: 20, b: 40, l: 60 },
    };

    return {
      plotData: [scatterTrace],
      layout,
      hasData: xValues.length > 0,
      summary: data.groupedLegOutcomes.summary,
    };
  }, [data]);

  const tooltip = {
    flavor: "Scatter plot of grouped entry outcomes over time.",
    detailed:
      "Each dot represents a grouped entry. The position shows the P/L and the date/time. Colors indicate the outcome type (Win/Loss/Mixed). This view helps identify clusters of activity and performance trends over time.",
  };

  const summaryFooter = summary ? (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
      <SummaryCell label="Tracked Entries" value={summary.totalEntries} />
      <SummaryCell label="All Legs Lost" value={summary.allLosses} accent="text-red-500" />
      <SummaryCell label="All Legs Won" value={summary.allWins} accent="text-emerald-500" />
      <SummaryCell label="Mixed Outcomes" value={summary.mixedOutcomes} accent="text-amber-500" />
      <SummaryCell
        label="All-Loss Damage ($)"
        value={currencyFormatter.format(summary.totalAllLossMagnitude)}
      />
    </div>
  ) : undefined;

  if (!hasData) {
    return (
      <ChartWrapper
        title="🧲 Grouped Leg Outcomes"
        description="Timeline of grouped trade performance"
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
        style={{ height: "360px" }}
        contentOverlay={
          <EmptyState message="No grouped entries yet. Enable combine leg groups to unlock this view." />
        }
      />
    );
  }

  return (
    <ChartWrapper
      title="🧲 Grouped Leg Outcomes"
      description="Timeline of grouped trade performance"
      className={className}
      data={hasData ? plotData : []}
      layout={layout}
      tooltip={tooltip}
      footer={summaryFooter}
      style={{ height: "360px" }}
    />
  );
}

function SummaryCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold ${accent ?? ""}`}>{value}</p>
    </div>
  );
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function EmptyState({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
