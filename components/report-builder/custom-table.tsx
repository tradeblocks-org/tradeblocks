"use client";

/**
 * Custom Table
 *
 * Displays aggregated trade statistics in a table format,
 * bucketed by the X-axis field with user-defined thresholds.
 * Columns are dynamically rendered based on selection.
 */

import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EnrichedTrade } from "@tradeblocks/lib";
import {
  ChartAxisConfig,
  getFieldInfo,
  getColumnLabel,
  getColumnUnit,
  DEFAULT_TABLE_COLUMNS,
} from "@tradeblocks/lib";
import { buildTableRows, computeAggregation } from "@tradeblocks/lib";

interface CustomTableProps {
  trades: EnrichedTrade[];
  xAxis: ChartAxisConfig;
  bucketEdges: number[];
  selectedColumns?: string[];
  className?: string;
}

/**
 * Format a number as currency
 */
function formatCurrency(value: number): string {
  const absValue = Math.abs(value);
  const formatted = absValue.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return value < 0 ? `-${formatted}` : formatted;
}

/**
 * Format a number as percentage
 */
function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Format a number with appropriate precision
 */
function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 1) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

/**
 * Format a value based on its unit
 */
function formatValue(value: number, unit?: string): string {
  if (unit === "$") return formatCurrency(value);
  if (unit === "%") return formatPercent(value);
  if (unit === "hrs") return `${value.toFixed(1)}`;
  return formatNumber(value);
}

/**
 * Get CSS class for P&L value coloring (only for $ and % units)
 */
function getValueColorClass(value: number, unit?: string): string {
  // Only color P&L and percentage values
  if (unit === "$" || unit === "%") {
    if (value > 0) return "text-green-600 dark:text-green-400";
    if (value < 0) return "text-red-600 dark:text-red-400";
  }
  return "";
}

export function CustomTable({
  trades,
  xAxis,
  bucketEdges,
  selectedColumns = DEFAULT_TABLE_COLUMNS,
  className,
}: CustomTableProps) {
  // Build table rows with selected columns
  const rows = useMemo(() => {
    if (!bucketEdges || bucketEdges.length === 0) {
      return [];
    }
    return buildTableRows(trades, xAxis.field, bucketEdges, selectedColumns);
  }, [trades, xAxis.field, bucketEdges, selectedColumns]);

  // Get field info for header
  const fieldInfo = getFieldInfo(xAxis.field);
  const fieldLabel = fieldInfo?.label ?? xAxis.field;

  // Get column metadata
  const columns = useMemo(() => {
    return selectedColumns.map((key) => ({
      key,
      label: getColumnLabel(key),
      unit: getColumnUnit(key),
    }));
  }, [selectedColumns]);

  // Calculate totals for each column
  const totals = useMemo(() => {
    if (rows.length === 0 || trades.length === 0) return null;

    const result: Record<string, number> = {};

    for (const col of columns) {
      // For count, sum up the bucket counts
      if (col.key === "count") {
        result[col.key] = rows.reduce((sum, r) => sum + (r.values[col.key] ?? 0), 0);
      }
      // For winRate, calculate from all trades
      else if (col.key === "winRate") {
        const winners = trades.filter((t) => (t.pl ?? 0) > 0).length;
        result[col.key] = trades.length > 0 ? (winners / trades.length) * 100 : 0;
      }
      // For averages, calculate from all trades
      else if (col.key.includes(":avg")) {
        const field = col.key.split(":")[0];
        result[col.key] = computeAggregation(trades, field, "avg");
      }
      // For sums, sum up the bucket sums
      else if (col.key.includes(":sum")) {
        result[col.key] = rows.reduce((sum, r) => sum + (r.values[col.key] ?? 0), 0);
      }
      // For min/max, skip in totals
      else {
        result[col.key] = NaN; // Will display as '—'
      }
    }

    return result;
  }, [rows, trades, columns]);

  if (rows.length === 0) {
    return (
      <div className={`text-center text-muted-foreground py-8 ${className ?? ""}`}>
        {bucketEdges.length === 0
          ? "Enter bucket thresholds to generate table"
          : "No trades match the current filters"}
      </div>
    );
  }

  return (
    <div className={`rounded-lg border bg-muted/20 overflow-hidden ${className ?? ""}`}>
      <div className="overflow-x-auto">
        <Table className="w-max min-w-full">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-[100px] whitespace-nowrap bg-muted border-r">
                {fieldLabel}
              </TableHead>
              {columns.map((col) => (
                <TableHead key={col.key} className="text-right whitespace-nowrap px-4">
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="sticky left-0 z-10 font-medium whitespace-nowrap bg-background border-r">
                  {row.label}
                </TableCell>
                {columns.map((col) => {
                  const value = row.values[col.key] ?? 0;
                  return (
                    <TableCell
                      key={col.key}
                      className={`text-right whitespace-nowrap px-4 ${getValueColorClass(value, col.unit)}`}
                    >
                      {formatValue(value, col.unit)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}

            {/* Totals row */}
            {totals && (
              <TableRow className="border-t-2 font-medium bg-muted/30">
                <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-muted border-r">
                  Total
                </TableCell>
                {columns.map((col) => {
                  const value = totals[col.key];
                  const isValid = !isNaN(value);
                  return (
                    <TableCell
                      key={col.key}
                      className={`text-right whitespace-nowrap px-4 ${isValid ? getValueColorClass(value, col.unit) : ""}`}
                    >
                      {isValid ? formatValue(value, col.unit) : "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default CustomTable;
