"use client";

/**
 * Regime Breakdown Table
 *
 * Table showing statistics for each bucket within a regime.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RegimeBreakdownStats } from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

interface RegimeBreakdownTableProps {
  stats: RegimeBreakdownStats;
  className?: string;
}

export function RegimeBreakdownTable({ stats, className }: RegimeBreakdownTableProps) {
  const formatCurrency = (value: number) =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const formatPercent = (value: number) => `${value.toFixed(1)}%`;

  return (
    <div className={cn("overflow-x-auto", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bucket</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">% of Total</TableHead>
            <TableHead className="text-right">Win Rate</TableHead>
            <TableHead className="text-right">Avg ROM</TableHead>
            <TableHead className="text-right">Total P&L</TableHead>
            <TableHead className="text-right">% of P&L</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.bucketStats.map((bucket) => (
            <TableRow key={bucket.bucketId}>
              <TableCell>
                <div className="flex items-center gap-2">
                  {bucket.color && (
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: bucket.color }}
                    />
                  )}
                  <span className="font-medium">{bucket.bucketName}</span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{bucket.tradeCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(bucket.percentOfTrades)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span
                  className={cn(
                    bucket.winRate >= 50
                      ? "text-green-600 dark:text-green-500"
                      : "text-red-600 dark:text-red-500",
                  )}
                >
                  {formatPercent(bucket.winRate)}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span
                  className={cn(
                    bucket.avgRom >= 0
                      ? "text-green-600 dark:text-green-500"
                      : "text-red-600 dark:text-red-500",
                  )}
                >
                  {formatPercent(bucket.avgRom)}
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
              <TableCell className="text-right tabular-nums">
                {formatPercent(bucket.percentOfPl)}
              </TableCell>
            </TableRow>
          ))}

          {/* Unmatched row if any */}
          {stats.unmatchedCount > 0 && (
            <TableRow className="text-muted-foreground">
              <TableCell>
                <span className="italic">Unmatched</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{stats.unmatchedCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent((stats.unmatchedCount / stats.totalTrades) * 100)}
              </TableCell>
              <TableCell className="text-right">-</TableCell>
              <TableCell className="text-right">-</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(stats.unmatchedPl)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {stats.totalPl !== 0
                  ? formatPercent((stats.unmatchedPl / stats.totalPl) * 100)
                  : "-"}
              </TableCell>
            </TableRow>
          )}

          {/* Total row */}
          <TableRow className="font-medium bg-muted/50">
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">{stats.totalTrades}</TableCell>
            <TableCell className="text-right">100%</TableCell>
            <TableCell className="text-right">-</TableCell>
            <TableCell className="text-right">-</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCurrency(stats.totalPl)}
            </TableCell>
            <TableCell className="text-right">100%</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

export default RegimeBreakdownTable;
