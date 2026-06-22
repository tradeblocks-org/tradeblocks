"use client";

import React from "react";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Calendar, Target, AlertTriangle, Shield } from "lucide-react";
import { cn } from "@tradeblocks/lib";

interface PerformanceMetricsProps {
  className?: string;
}

interface MetricCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  trend?: "positive" | "negative" | "neutral";
  subtitle?: string;
  format?: "currency" | "percentage" | "number" | "ratio";
}

function MetricCard({
  title,
  value,
  icon,
  trend = "neutral",
  subtitle,
  format = "number",
}: MetricCardProps) {
  const formatValue = (val: string | number) => {
    const numValue = typeof val === "string" ? parseFloat(val) : val;

    switch (format) {
      case "currency":
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(numValue);
      case "percentage":
        return `${numValue.toFixed(1)}%`;
      case "ratio":
        return numValue.toFixed(2);
      default:
        return numValue.toString();
    }
  };

  const trendColors = {
    positive: "text-emerald-600 dark:text-emerald-400",
    negative: "text-red-600 dark:text-red-400",
    neutral: "text-foreground",
  };

  const bgColors = {
    positive: "bg-emerald-50 dark:bg-emerald-950/20",
    negative: "bg-red-50 dark:bg-red-950/20",
    neutral: "bg-muted/50",
  };

  return (
    <div className={cn("rounded-lg p-4 transition-colors", bgColors[trend])}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={cn("p-1.5 rounded-md bg-background/80", trendColors[trend])}>{icon}</div>
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
        </div>
      </div>
      <div className="space-y-1">
        <div className={cn("text-2xl font-bold", trendColors[trend])}>{formatValue(value)}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
    </div>
  );
}

export function PerformanceMetrics({ className }: PerformanceMetricsProps) {
  const { data } = usePerformanceStore();

  if (!data?.portfolioStats) {
    return (
      <Card className={className}>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-24">
            <div className="text-muted-foreground">Loading performance metrics...</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { portfolioStats, trades, peakDailyExposurePercent } = data;

  // Calculate additional metrics
  const dateRange =
    trades.length > 0
      ? {
          start: new Date(Math.min(...trades.map((t) => new Date(t.dateOpened).getTime()))),
          end: new Date(Math.max(...trades.map((t) => new Date(t.dateOpened).getTime()))),
        }
      : null;

  const activeDays = dateRange
    ? Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const bestMonth = portfolioStats.totalPl > 0 ? "+$520,782" : "N/A"; // Placeholder - would need monthly calculation
  const worstMonth = portfolioStats.totalPl < 0 ? "-$122,400" : "N/A"; // Placeholder

  const avgTradeDuration = trades.length > 0 ? "1.5 days" : "N/A"; // Placeholder

  return (
    <Card className={className}>
      <CardContent className="p-6">
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">📈 Performance Overview</h3>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <Calendar className="w-3 h-3 mr-1" />
                {activeDays} days
              </Badge>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <MetricCard
            title="Total P/L"
            value={portfolioStats.totalPl}
            format="currency"
            icon={
              portfolioStats.totalPl > 0 ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )
            }
            trend={portfolioStats.totalPl > 0 ? "positive" : "negative"}
            subtitle="Net profit/loss"
          />

          <MetricCard
            title="Win Rate"
            value={portfolioStats.winRate * 100}
            format="percentage"
            icon={<Target className="h-4 w-4" />}
            trend={portfolioStats.winRate > 0.5 ? "positive" : "negative"}
            subtitle="Successful trades"
          />

          <MetricCard
            title="Max Drawdown"
            value={Math.abs(portfolioStats.maxDrawdown)}
            format="percentage"
            icon={<AlertTriangle className="h-4 w-4" />}
            trend="negative"
            subtitle="Largest decline"
          />

          <MetricCard
            title="Sharpe Ratio"
            value={portfolioStats.sharpeRatio || 0}
            format="ratio"
            icon={<TrendingUp className="h-4 w-4" />}
            trend={
              (portfolioStats.sharpeRatio || 0) > 1
                ? "positive"
                : (portfolioStats.sharpeRatio || 0) > 0
                  ? "neutral"
                  : "negative"
            }
            subtitle="Risk-adjusted return"
          />

          <MetricCard
            title="Total Trades"
            value={portfolioStats.totalTrades}
            icon={<Calendar className="h-4 w-4" />}
            trend="neutral"
            subtitle="Completed positions"
          />
        </div>

        {/* Additional metrics row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-4 pt-4 border-t">
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">Best Month</div>
            <div className="font-semibold text-emerald-600 dark:text-emerald-400">{bestMonth}</div>
          </div>

          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">Worst Month</div>
            <div className="font-semibold text-red-600 dark:text-red-400">{worstMonth}</div>
          </div>

          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">Avg Duration</div>
            <div className="font-semibold">{avgTradeDuration}</div>
          </div>

          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">Win Streak</div>
            <div className="font-semibold text-emerald-600 dark:text-emerald-400">
              {portfolioStats.maxWinStreak} trades
            </div>
          </div>

          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground mb-1">
              <Shield className="h-3 w-3" />
              Peak Exposure
            </div>
            {peakDailyExposurePercent ? (
              <div className="font-semibold text-amber-600 dark:text-amber-400">
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                }).format(peakDailyExposurePercent.exposure)}
                <span className="text-xs ml-1">
                  ({peakDailyExposurePercent.exposurePercent.toFixed(1)}%)
                </span>
              </div>
            ) : (
              <div className="font-semibold text-muted-foreground">N/A</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
