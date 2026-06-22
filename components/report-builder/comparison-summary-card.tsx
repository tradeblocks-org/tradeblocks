"use client";

/**
 * Comparison Summary Card
 *
 * Shows side-by-side comparison of filtered vs full sample statistics.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RegimeComparisonStats, formatStatWithDelta } from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

interface ComparisonSummaryCardProps {
  stats: RegimeComparisonStats;
  className?: string;
}

export function ComparisonSummaryCard({ stats, className }: ComparisonSummaryCardProps) {
  const metrics = [
    {
      label: "Win Rate",
      filtered: stats.filteredWinRate,
      total: stats.totalWinRate,
      delta: stats.winRateDelta,
      format: "percent" as const,
      higherIsBetter: true,
    },
    {
      label: "Avg ROM",
      filtered: stats.filteredAvgRom,
      total: stats.totalAvgRom,
      delta: stats.avgRomDelta,
      format: "percent" as const,
      higherIsBetter: true,
    },
    {
      label: "Avg P&L",
      filtered: stats.filteredAvgPl,
      total: stats.totalAvgPl,
      delta: stats.avgPlDelta,
      format: "currency" as const,
      higherIsBetter: true,
    },
    {
      label: "Profit Factor",
      filtered: stats.filteredProfitFactor,
      total: stats.totalProfitFactor,
      delta: stats.profitFactorDelta,
      format: "decimal" as const,
      higherIsBetter: true,
    },
    {
      label: "Total P&L",
      filtered: stats.filteredTotalPl,
      total: stats.totalTotalPl,
      delta: stats.filteredTotalPl - stats.totalTotalPl,
      format: "currency" as const,
      higherIsBetter: true,
    },
  ];

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Filtered vs Full Sample</CardTitle>
        <p className="text-sm text-muted-foreground">
          {stats.filteredCount} of {stats.totalCount} trades ({stats.filteredPercent.toFixed(1)}%)
        </p>
      </CardHeader>
      <CardContent>
        {/* Header Row */}
        <div className="grid grid-cols-4 gap-2 pb-2 border-b text-xs font-medium text-muted-foreground">
          <div>Metric</div>
          <div className="text-right">Filtered</div>
          <div className="text-right">Full</div>
          <div className="text-right">Delta</div>
        </div>

        {/* Metric Rows */}
        {metrics.map((metric) => {
          const formatted = formatStatWithDelta(
            metric.filtered,
            metric.delta,
            metric.format,
            metric.higherIsBetter,
          );

          // Format the full sample value
          let fullFormatted: string;
          switch (metric.format) {
            case "percent":
              fullFormatted = `${metric.total.toFixed(1)}%`;
              break;
            case "currency":
              fullFormatted = `$${metric.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
              break;
            default:
              fullFormatted = isFinite(metric.total) ? metric.total.toFixed(2) : "∞";
          }

          return (
            <div
              key={metric.label}
              className="grid grid-cols-4 gap-2 py-2 border-b last:border-0 text-sm"
            >
              <div className="font-medium">{metric.label}</div>
              <div className="text-right">{formatted.value}</div>
              <div className="text-right text-muted-foreground">{fullFormatted}</div>
              <div
                className={cn(
                  "text-right font-medium",
                  formatted.isPositive
                    ? "text-green-600 dark:text-green-500"
                    : "text-red-600 dark:text-red-500",
                )}
              >
                {formatted.delta}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default ComparisonSummaryCard;
