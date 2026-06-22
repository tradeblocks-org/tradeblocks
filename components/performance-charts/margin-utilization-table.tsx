"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { cn } from "@tradeblocks/lib";
import { format } from "date-fns";
import type { Layout, PlotData } from "plotly.js";
import { useMemo, useState } from "react";
import { ChartWrapper } from "./chart-wrapper";

type CapitalMode = "fixed" | "compounding";

interface MarginUtilizationTableProps {
  className?: string;
}

// Color gradient from green (low utilization) to red (high utilization)
function getBucketColor(index: number, total: number): string {
  const colors = [
    "#10b981", // emerald-500
    "#34d399", // emerald-400
    "#6ee7b7", // emerald-300
    "#fcd34d", // amber-300
    "#fbbf24", // amber-400
    "#f59e0b", // amber-500
    "#f97316", // orange-500
    "#ef4444", // red-500
    "#dc2626", // red-600
    "#b91c1c", // red-700
  ];
  const colorIndex = Math.min(Math.floor((index / total) * colors.length), colors.length - 1);
  return colors[colorIndex];
}

function getBucketLabel(utilizationPct: number, bucketSize: number, maxThreshold: number): string {
  if (utilizationPct >= maxThreshold) {
    return `${maxThreshold}%+`;
  }
  const lowerBound = Math.floor(utilizationPct / bucketSize) * bucketSize;
  const upperBound = lowerBound + bucketSize;
  return `${lowerBound}-${upperBound}%`;
}

interface ChartData {
  months: string[];
  monthLabels: string[];
  bucketLabels: string[];
  // bucketCounts[bucketIndex][monthIndex] = count of trades
  bucketCounts: number[][];
  // The actual bucket size used (may differ from input if capped)
  effectiveBucketSize: number;
}

interface BucketStats {
  label: string;
  color: string;
  tradeCount: number;
  percentOfTrades: number;
  avgPl: number;
  totalPl: number;
}

function transformToChartData(
  marginUtilization: Array<{
    date: string;
    marginReq: number;
    fundsAtClose: number;
    numContracts: number;
    pl: number;
  }>,
  initialCapital: number,
  bucketSize: number,
  maxThreshold: number,
  capitalMode: CapitalMode,
): ChartData {
  if (!marginUtilization || marginUtilization.length === 0 || initialCapital <= 0) {
    return {
      months: [],
      monthLabels: [],
      bucketLabels: [],
      bucketCounts: [],
      effectiveBucketSize: bucketSize,
    };
  }

  // Group trades by month and bucket
  const monthBucketCounts = new Map<string, Map<string, number>>();
  const allMonths = new Set<string>();

  // Generate all bucket labels in order
  const bucketLabels: string[] = [];
  for (let i = 0; i < maxThreshold; i += bucketSize) {
    bucketLabels.push(`${i}-${i + bucketSize}%`);
  }
  bucketLabels.push(`${maxThreshold}%+`);

  for (const entry of marginUtilization) {
    if (entry.marginReq <= 0) continue;

    // Use fundsAtClose for compounding mode, initialCapital for fixed mode
    const denominator =
      capitalMode === "compounding" && entry.fundsAtClose > 0 ? entry.fundsAtClose : initialCapital;

    const utilizationPct = (entry.marginReq / denominator) * 100;
    const bucketLabel = getBucketLabel(utilizationPct, bucketSize, maxThreshold);

    const date = new Date(entry.date);
    // Use sortable key for ordering
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

    allMonths.add(monthKey);

    if (!monthBucketCounts.has(monthKey)) {
      monthBucketCounts.set(monthKey, new Map());
    }
    const bucketMap = monthBucketCounts.get(monthKey)!;
    bucketMap.set(bucketLabel, (bucketMap.get(bucketLabel) || 0) + 1);
  }

  const sortedMonths = Array.from(allMonths).sort();

  // Format month labels like "May '22"
  const monthLabels = sortedMonths.map((monthKey) => {
    const [year, month] = monthKey.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return format(date, "MMM ''yy");
  });

  // Build counts array: bucketCounts[bucketIndex][monthIndex]
  const bucketCounts: number[][] = bucketLabels.map((label) =>
    sortedMonths.map((monthKey) => {
      const bucketMap = monthBucketCounts.get(monthKey);
      return bucketMap?.get(label) || 0;
    }),
  );

  // Filter to only include buckets that have at least one trade
  const usedBucketIndices = bucketCounts
    .map((counts, index) => ({ index, hasData: counts.some((c) => c > 0) }))
    .filter((b) => b.hasData)
    .map((b) => b.index);

  const filteredBucketLabels = usedBucketIndices.map((i) => bucketLabels[i]);
  const filteredBucketCounts = usedBucketIndices.map((i) => bucketCounts[i]);

  return {
    months: sortedMonths,
    monthLabels,
    bucketLabels: filteredBucketLabels,
    bucketCounts: filteredBucketCounts,
    effectiveBucketSize: bucketSize,
  };
}

function calculateBucketStats(
  marginUtilization: Array<{
    date: string;
    marginReq: number;
    fundsAtClose: number;
    numContracts: number;
    pl: number;
  }>,
  initialCapital: number,
  bucketSize: number,
  maxThreshold: number,
  capitalMode: CapitalMode,
): BucketStats[] {
  if (!marginUtilization || marginUtilization.length === 0 || initialCapital <= 0) {
    return [];
  }

  // Generate all bucket labels in order
  const bucketLabels: string[] = [];
  for (let i = 0; i < maxThreshold; i += bucketSize) {
    bucketLabels.push(`${i}-${i + bucketSize}%`);
  }
  bucketLabels.push(`${maxThreshold}%+`);

  // Initialize bucket data
  const bucketData = new Map<string, { trades: number; totalPl: number }>();
  bucketLabels.forEach((label) => {
    bucketData.set(label, { trades: 0, totalPl: 0 });
  });

  let totalTrades = 0;

  for (const entry of marginUtilization) {
    if (entry.marginReq <= 0) continue;

    // Use fundsAtClose for compounding mode, initialCapital for fixed mode
    const denominator =
      capitalMode === "compounding" && entry.fundsAtClose > 0 ? entry.fundsAtClose : initialCapital;

    const utilizationPct = (entry.marginReq / denominator) * 100;
    const bucketLabel = getBucketLabel(utilizationPct, bucketSize, maxThreshold);

    const data = bucketData.get(bucketLabel);
    if (data) {
      data.trades += 1;
      data.totalPl += entry.pl;
      totalTrades += 1;
    }
  }

  // Build stats array
  return bucketLabels.map((label, index) => {
    const data = bucketData.get(label)!;
    return {
      label,
      color: getBucketColor(index, bucketLabels.length),
      tradeCount: data.trades,
      percentOfTrades: totalTrades > 0 ? (data.trades / totalTrades) * 100 : 0,
      avgPl: data.trades > 0 ? data.totalPl / data.trades : 0,
      totalPl: data.totalPl,
    };
  });
}

export function MarginUtilizationTable({ className }: MarginUtilizationTableProps) {
  const { data } = usePerformanceStore();

  const [bucketSize, setBucketSize] = useState<number>(1);
  const [maxThreshold, setMaxThreshold] = useState<number>(5);
  const [bucketInput, setBucketInput] = useState<string>("1");
  const [maxInput, setMaxInput] = useState<string>("5");
  const [capitalMode, setCapitalMode] = useState<CapitalMode>("fixed");

  const initialCapital = data?.portfolioStats?.initialCapital ?? 0;

  const { plotData, layout } = useMemo(() => {
    if (!data?.marginUtilization || data.marginUtilization.length === 0 || initialCapital <= 0) {
      return { plotData: [], layout: {} };
    }

    const chartData = transformToChartData(
      data.marginUtilization,
      initialCapital,
      bucketSize,
      maxThreshold,
      capitalMode,
    );

    if (chartData.months.length === 0) {
      return { plotData: [], layout: {} };
    }

    // Create stacked area traces - one per bucket
    const traces: Partial<PlotData>[] = chartData.bucketLabels.map((label, index) => ({
      x: chartData.monthLabels,
      y: chartData.bucketCounts[index],
      type: "scatter" as const,
      mode: "lines" as const,
      name: label,
      stackgroup: "one",
      groupnorm: "percent" as const,
      fillcolor: getBucketColor(index, chartData.bucketLabels.length),
      line: {
        width: 0.5,
        color: getBucketColor(index, chartData.bucketLabels.length),
      },
      hovertemplate: `<b>${label}</b><br>%{y:.1f}% of trades<extra></extra>`,
    }));

    const chartLayout: Partial<Layout> = {
      xaxis: {
        title: { text: "" },
        showgrid: false,
        tickangle: -45,
      },
      yaxis: {
        title: { text: "% of Trades" },
        showgrid: true,
        range: [0, 100],
        ticksuffix: "%",
      },
      hovermode: "closest" as const,
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "center" as const,
        x: 0.5,
        traceorder: "normal" as const,
      },
      margin: {
        t: 80,
        r: 30,
        b: 80,
        l: 60,
      },
    };

    return { plotData: traces, layout: chartLayout };
  }, [data?.marginUtilization, initialCapital, bucketSize, maxThreshold, capitalMode]);

  // Calculate bucket statistics for the summary table
  const bucketStats = useMemo(() => {
    if (!data?.marginUtilization || data.marginUtilization.length === 0 || initialCapital <= 0) {
      return [];
    }
    return calculateBucketStats(
      data.marginUtilization,
      initialCapital,
      bucketSize,
      maxThreshold,
      capitalMode,
    );
  }, [data?.marginUtilization, initialCapital, bucketSize, maxThreshold, capitalMode]);

  // Calculate totals for the summary table
  const totals = useMemo(() => {
    const totalTrades = bucketStats.reduce((sum, b) => sum + b.tradeCount, 0);
    const totalPl = bucketStats.reduce((sum, b) => sum + b.totalPl, 0);
    return {
      tradeCount: totalTrades,
      avgPl: totalTrades > 0 ? totalPl / totalTrades : 0,
      totalPl,
    };
  }, [bucketStats]);

  const tooltip = {
    flavor: "How is your margin utilization distributed over time?",
    detailed:
      capitalMode === "fixed"
        ? "This chart shows how your margin utilization changes month over month. Each colored band represents a percentage range of your starting capital used as margin. Watch for trends - are you taking on more margin over time?"
        : "This chart shows how your margin utilization changes month over month relative to your current capital at each trade. Each colored band represents a percentage range of your account value used as margin. This mode adjusts for account growth/decline over time.",
  };

  const description =
    capitalMode === "fixed"
      ? "Distribution of margin usage as % of starting capital over time"
      : "Distribution of margin usage as % of current capital over time";

  const handleBucketBlur = () => {
    const val = parseInt(bucketInput, 10);
    if (!isNaN(val) && val >= 1 && val <= 50) {
      setBucketSize(val);
      setBucketInput(String(val));
    } else {
      setBucketInput(String(bucketSize));
    }
  };

  const handleMaxBlur = () => {
    const val = parseInt(maxInput, 10);
    if (!isNaN(val) && val >= 1 && val <= 100) {
      setMaxThreshold(val);
      setMaxInput(String(val));
    } else {
      setMaxInput(String(maxThreshold));
    }
  };

  const headerControls = (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Bucket:</span>
        <Input
          type="number"
          min={1}
          max={50}
          value={bucketInput}
          onChange={(e) => setBucketInput(e.target.value)}
          onBlur={handleBucketBlur}
          onKeyDown={(e) => e.key === "Enter" && handleBucketBlur()}
          className="w-16 h-8 text-center"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Max:</span>
        <Input
          type="number"
          min={1}
          max={100}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={handleMaxBlur}
          onKeyDown={(e) => e.key === "Enter" && handleMaxBlur()}
          className="w-16 h-8 text-center"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>

      <RadioGroup
        value={capitalMode}
        onValueChange={(value) => setCapitalMode(value as CapitalMode)}
        className="flex items-center gap-3"
      >
        <div className="flex items-center space-x-1.5">
          <RadioGroupItem value="fixed" id="margin-cap-fixed" />
          <Label htmlFor="margin-cap-fixed" className="text-sm font-normal cursor-pointer">
            Fixed
          </Label>
        </div>
        <div className="flex items-center space-x-1.5">
          <RadioGroupItem value="compounding" id="margin-cap-compounding" />
          <Label htmlFor="margin-cap-compounding" className="text-sm font-normal cursor-pointer">
            Compounding
          </Label>
        </div>
      </RadioGroup>
    </div>
  );

  const formatCurrency = (value: number) =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const formatPercent = (value: number) => `${value.toFixed(1)}%`;

  // Handle empty states
  if (!data?.marginUtilization || data.marginUtilization.length === 0) {
    return (
      <ChartWrapper
        title="Margin Utilization Distribution"
        description={description}
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
        actions={headerControls}
      />
    );
  }

  if (initialCapital <= 0) {
    return (
      <ChartWrapper
        title="Margin Utilization Distribution"
        description="Unable to calculate: starting capital is not set"
        className={className}
        data={[]}
        layout={{}}
        tooltip={tooltip}
        actions={headerControls}
      />
    );
  }

  const summaryTable =
    bucketStats.length > 0 ? (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">% of Total</TableHead>
              <TableHead className="text-right">Avg P&L</TableHead>
              <TableHead className="text-right">Total P&L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bucketStats
              .filter((bucket) => bucket.tradeCount > 0)
              .map((bucket) => (
                <TableRow key={bucket.label}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: bucket.color }}
                      />
                      <span className="font-medium">{bucket.label}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{bucket.tradeCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(bucket.percentOfTrades)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span
                      className={cn(
                        bucket.avgPl >= 0
                          ? "text-green-600 dark:text-green-500"
                          : "text-red-600 dark:text-red-500",
                      )}
                    >
                      {formatCurrency(bucket.avgPl)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span
                      className={cn(
                        bucket.totalPl >= 0
                          ? "text-green-600 dark:text-green-500"
                          : "text-red-600 dark:text-red-500",
                      )}
                    >
                      {formatCurrency(bucket.totalPl)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}

            {/* Total row */}
            <TableRow className="font-medium bg-muted/50">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{totals.tradeCount}</TableCell>
              <TableCell className="text-right">100%</TableCell>
              <TableCell className="text-right tabular-nums">
                <span
                  className={cn(
                    totals.avgPl >= 0
                      ? "text-green-600 dark:text-green-500"
                      : "text-red-600 dark:text-red-500",
                  )}
                >
                  {formatCurrency(totals.avgPl)}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span
                  className={cn(
                    totals.totalPl >= 0
                      ? "text-green-600 dark:text-green-500"
                      : "text-red-600 dark:text-red-500",
                  )}
                >
                  {formatCurrency(totals.totalPl)}
                </span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    ) : undefined;

  return (
    <ChartWrapper
      title="Margin Utilization Distribution"
      description={description}
      className={className}
      data={plotData as PlotData[]}
      layout={layout}
      style={{ height: "350px" }}
      tooltip={tooltip}
      actions={headerControls}
      footer={summaryTable}
    />
  );
}
