"use client";

import { useMemo } from "react";
import type { Layout, PlotData } from "plotly.js";
import { ChartWrapper } from "./chart-wrapper";
import { usePerformanceStore } from "@tradeblocks/lib/stores";

interface PremiumEfficiencyChartProps {
  className?: string;
}

export function PremiumEfficiencyChart({ className }: PremiumEfficiencyChartProps) {
  const { data } = usePerformanceStore();

  const { plotData, layout, stats } = useMemo(() => {
    if (!data?.premiumEfficiency || data.premiumEfficiency.length === 0) {
      return { plotData: [], layout: {}, stats: null };
    }

    const validEntries = data.premiumEfficiency.filter((entry) => typeof entry.pl === "number");

    if (validEntries.length === 0) {
      return { plotData: [], layout: {}, stats: null };
    }

    // Calculate gross P/L (before commissions) and net P/L (after commissions)
    const grossPL = validEntries.map((entry) => (entry.pl ?? 0) + (entry.totalCommissions ?? 0));
    const commissions = validEntries.map((entry) => entry.totalCommissions ?? 0);
    const netPL = validEntries.map((entry) => entry.pl ?? 0);
    const tradeNumbers = validEntries.map((entry) => entry.tradeNumber);

    // Calculate summary stats
    const totalGrossPL = grossPL.reduce((sum, val) => sum + val, 0);
    const totalCommissions = commissions.reduce((sum, val) => sum + val, 0);
    const totalNetPL = netPL.reduce((sum, val) => sum + val, 0);
    const commissionDragPct =
      totalGrossPL !== 0 ? (totalCommissions / Math.abs(totalGrossPL)) * 100 : 0;

    const currencyFormatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    });

    // Gross P/L bars (before commissions)
    const grossTrace: Partial<PlotData> = {
      x: tradeNumbers,
      y: grossPL,
      type: "bar",
      name: "Gross P/L",
      marker: {
        color: grossPL.map((val) => (val >= 0 ? "#22c55e" : "#ef4444")),
        opacity: 0.6,
      },
      customdata: grossPL.map((val, i) => [
        currencyFormatter.format(val),
        currencyFormatter.format(commissions[i]),
        currencyFormatter.format(netPL[i]),
      ]),
      hovertemplate:
        "Trade #%{x}<br>Gross P/L: %{customdata[0]}<br>Commissions: %{customdata[1]}<br>Net P/L: %{customdata[2]}<extra></extra>",
    };

    // Net P/L line (after commissions)
    const netTrace: Partial<PlotData> = {
      x: tradeNumbers,
      y: netPL,
      type: "scatter",
      mode: "lines+markers",
      name: "Net P/L",
      line: {
        color: "#2563eb",
        width: 2,
      },
      marker: {
        size: 6,
        color: "#2563eb",
      },
      customdata: netPL.map((val, i) => [
        currencyFormatter.format(grossPL[i]),
        currencyFormatter.format(commissions[i]),
        currencyFormatter.format(val),
      ]),
      hovertemplate:
        "Trade #%{x}<br>Gross P/L: %{customdata[0]}<br>Commissions: %{customdata[1]}<br>Net P/L: %{customdata[2]}<extra></extra>",
    };

    const minTrade = Math.min(...tradeNumbers);
    const maxTrade = Math.max(...tradeNumbers);

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "Trade Number" },
      },
      yaxis: {
        title: { text: "P/L ($)" },
        zeroline: true,
        zerolinecolor: "#94a3b8",
        zerolinewidth: 2,
      },
      hovermode: "x unified",
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1,
      },
      shapes: [
        {
          type: "line",
          xref: "x",
          yref: "y",
          x0: minTrade,
          x1: maxTrade,
          y0: 0,
          y1: 0,
          line: {
            color: "#94a3b8",
            width: 1,
            dash: "dot",
          },
        },
      ],
    };

    return {
      plotData: [grossTrace, netTrace],
      layout: chartLayout,
      stats: {
        totalGrossPL,
        totalCommissions,
        totalNetPL,
        commissionDragPct,
      },
    };
  }, [data?.premiumEfficiency]);

  const tooltip = {
    flavor: "How much are commissions eating into your profits?",
    detailed:
      "Bars show gross P/L before commissions, blue line shows net P/L after commissions. The gap between them reveals commission drag - smaller gaps mean better efficiency.",
  };

  const statsFooter = stats
    ? (() => {
        const currencyFormatter = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
          minimumFractionDigits: 0,
        });

        const formatCurrency = (value: number) => currencyFormatter.format(value);

        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Gross P/L</div>
              <div className="font-semibold">{formatCurrency(stats.totalGrossPL)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Total Commissions</div>
              <div className="font-semibold text-amber-600">
                {formatCurrency(-stats.totalCommissions)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Net P/L</div>
              <div className="font-semibold">{formatCurrency(stats.totalNetPL)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Commission Drag</div>
              <div className="font-semibold">{stats.commissionDragPct.toFixed(1)}%</div>
            </div>
          </div>
        );
      })()
    : null;

  return (
    <ChartWrapper
      title="💸 Commission Drag"
      description="Gross vs net P/L showing commission impact per trade"
      className={className}
      data={plotData as PlotData[]}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      footer={statsFooter}
    />
  );
}
