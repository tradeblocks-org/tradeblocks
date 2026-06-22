"use client";

import { MetricCard } from "@/components/metric-card";
import { MetricSection } from "@/components/metric-section";
import { MultiSelect } from "@/components/multi-select";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  aggregateTradesByStrategy,
  calculateDayMetrics,
  formatPercent,
  scaleStrategyComparison,
} from "@tradeblocks/lib";
import { ScalingMode, TradeFilterMode, useTradingCalendarStore } from "@tradeblocks/lib/stores";
import { AlertTriangle, BarChart3, HelpCircle, TrendingUp } from "lucide-react";
import { useMemo } from "react";

interface StatsHeaderProps {
  onMatchStrategiesClick?: () => void;
}

export function StatsHeader({ onMatchStrategiesClick }: StatsHeaderProps) {
  const {
    performanceStats,
    comparisonStats,
    scalingMode,
    tradeFilterMode,
    navigationView,
    selectedDate,
    calendarDays,
    strategyMatches,
    unmatchedBacktestStrategies,
    unmatchedActualStrategies,
    actualTrades,
    combineLegGroups,
    allStrategies,
    selectedStrategies,
    setScalingMode,
    setTradeFilterMode,
    setSelectedStrategies,
    setCombineLegGroups,
  } = useTradingCalendarStore();

  const hasActualTrades = actualTrades.length > 0;
  const hasUnmatched =
    unmatchedBacktestStrategies.length > 0 || unmatchedActualStrategies.length > 0;

  // Check if viewing a specific day
  const isViewingDay = navigationView === "day" || navigationView === "trade";
  const dayData = selectedDate ? calendarDays.get(selectedDate) : undefined;

  // Calculate day-specific stats when viewing a day
  const dayStats = useMemo(() => {
    if (!isViewingDay || !dayData) return null;

    const comparisons = aggregateTradesByStrategy(dayData, strategyMatches);
    const scaledComparisons = comparisons.map((c) => scaleStrategyComparison(c, scalingMode));

    // Filter comparisons based on trade filter mode
    const filteredComparisons =
      tradeFilterMode === "matched"
        ? scaledComparisons.filter((c) => c.isMatched)
        : tradeFilterMode === "unmatched"
          ? scaledComparisons.filter((c) => !c.isMatched)
          : scaledComparisons;

    let scaledBacktestPl = 0;
    let scaledActualPl = 0;
    let matchedCount = 0;
    let winningStrategies = 0;

    for (const comparison of filteredComparisons) {
      if (comparison.scaled.backtestPl !== null) {
        scaledBacktestPl += comparison.scaled.backtestPl;
      }
      if (comparison.scaled.actualPl !== null) {
        scaledActualPl += comparison.scaled.actualPl;
      }
      if (comparison.isMatched) {
        matchedCount++;
      }
      // Count winning strategies based on which data is available
      const pl = comparison.scaled.actualPl ?? comparison.scaled.backtestPl;
      if (pl !== null && pl > 0) {
        winningStrategies++;
      }
    }

    // Calculate filtered trade counts
    const filteredBacktestCount =
      tradeFilterMode !== "all"
        ? filteredComparisons.reduce((sum, c) => sum + (c.backtest?.trades.length ?? 0), 0)
        : dayData.backtestTradeCount;
    const filteredActualCount =
      tradeFilterMode !== "all"
        ? filteredComparisons.reduce((sum, c) => sum + (c.actual?.trades.length ?? 0), 0)
        : dayData.actualTradeCount;

    // Determine if we have data after filtering
    const hasFilteredBacktest = filteredComparisons.some((c) => c.backtest !== null);
    const hasFilteredActual = filteredComparisons.some((c) => c.actual !== null);

    const variance =
      hasFilteredBacktest && hasFilteredActual ? scaledActualPl - scaledBacktestPl : null;
    const variancePercent =
      variance !== null && scaledBacktestPl !== 0
        ? (variance / Math.abs(scaledBacktestPl)) * 100
        : null;

    const winRate =
      filteredComparisons.length > 0 ? (winningStrategies / filteredComparisons.length) * 100 : 0;

    // Calculate day-specific performance metrics
    const dayMetrics = calculateDayMetrics(dayData);

    return {
      backtestPl: scaledBacktestPl,
      actualPl: scaledActualPl,
      backtestTradeCount: filteredBacktestCount,
      actualTradeCount: filteredActualCount,
      hasBacktest: hasFilteredBacktest,
      hasActual: hasFilteredActual,
      variance,
      variancePercent,
      strategyCount: filteredComparisons.length,
      matchedCount,
      winRate,
      // Day-specific metrics
      maxDrawdown: dayMetrics.maxDrawdown,
      avgRom: dayMetrics.avgRom,
      avgPremiumCapture: dayMetrics.avgPremiumCapture,
    };
  }, [isViewingDay, dayData, strategyMatches, scalingMode, tradeFilterMode]);

  // Get P/L positive flag
  const isPositive = (value: number) => value > 0;

  // Build strategy options for MultiSelect
  const strategyOptions = useMemo(
    () => allStrategies.map((s) => ({ label: s, value: s })),
    [allStrategies],
  );

  // Build actions for Performance section header
  const performanceActions = hasActualTrades ? (
    <>
      {/* Strategy Filter */}
      {allStrategies.length > 1 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label className="text-xs text-muted-foreground">Strategies</Label>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">Strategy Filter</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm text-foreground leading-relaxed">
                      Filter calendar data to specific strategies. All calculations, charts, and
                      stats update to reflect only the selected strategies.
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <MultiSelect
            options={strategyOptions}
            defaultValue={selectedStrategies}
            onValueChange={setSelectedStrategies}
            placeholder="All strategies"
            maxCount={1}
            className="w-[200px]"
            searchable={allStrategies.length > 5}
          />
        </div>
      )}

      {/* Scaling Mode Toggle */}
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">Scaling</Label>
          <HoverCard>
            <HoverCardTrigger asChild>
              <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
            </HoverCardTrigger>
            <HoverCardContent className="w-80 p-0 overflow-hidden">
              <div className="space-y-3">
                <div className="bg-primary/5 border-b px-4 py-3">
                  <h4 className="text-sm font-semibold text-primary">P&L Scaling</h4>
                </div>
                <div className="px-4 pb-4 space-y-3">
                  <p className="text-sm text-foreground leading-relaxed">
                    Normalize P&L values for fair comparison between backtest and actual.
                  </p>
                  <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                    <li>
                      <strong>Raw Values:</strong> Show original P&L without adjustment
                    </li>
                    <li>
                      <strong>Per Contract:</strong> Divide by contract count for per-lot comparison
                    </li>
                    <li>
                      <strong>Scale to Reported:</strong> Scale backtest down to match actual
                      contract counts
                    </li>
                  </ul>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
        <Select value={scalingMode} onValueChange={(value) => setScalingMode(value as ScalingMode)}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="raw">Raw Values</SelectItem>
            <SelectItem value="perContract">Per Contract</SelectItem>
            <SelectItem value="toReported">Scale to Reported</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Trade Filter Toggle */}
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">Trades</Label>
          <HoverCard>
            <HoverCardTrigger asChild>
              <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
            </HoverCardTrigger>
            <HoverCardContent className="w-80 p-0 overflow-hidden">
              <div className="space-y-3">
                <div className="bg-primary/5 border-b px-4 py-3">
                  <h4 className="text-sm font-semibold text-primary">Trade Filter</h4>
                </div>
                <div className="px-4 pb-4 space-y-3">
                  <p className="text-sm text-foreground leading-relaxed">
                    Filter which trades to include in all calculations and displays.
                  </p>
                  <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                    <li>
                      <strong>All Trades:</strong> Include all backtest and actual trades
                    </li>
                    <li>
                      <strong>Matched Only:</strong> Only include trades from strategies that have
                      both backtest and actual data
                    </li>
                    <li>
                      <strong>Unmatched Only:</strong> Only include trades from strategies missing a
                      counterpart
                    </li>
                  </ul>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
        <Select
          value={tradeFilterMode}
          onValueChange={(value) => setTradeFilterMode(value as TradeFilterMode)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Trades</SelectItem>
            <SelectItem value="matched">Matched Only</SelectItem>
            <SelectItem value="unmatched">Unmatched Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Unmatched strategies warning */}
      {hasUnmatched && (
        <Button
          variant="outline"
          size="sm"
          className="text-yellow-500 border-yellow-500/50 hover:bg-yellow-500/10"
          onClick={onMatchStrategiesClick}
        >
          <AlertTriangle className="h-4 w-4 mr-2" />
          {unmatchedBacktestStrategies.length + unmatchedActualStrategies.length} unmatched
        </Button>
      )}
    </>
  ) : null;

  // Helper to format ratio values
  const formatRatio = (value: number | null | undefined): string => {
    if (value === null || value === undefined) return "-";
    return value.toFixed(2);
  };

  // Helper to format percentage values
  const formatPct = (value: number | null | undefined): string => {
    if (value === null || value === undefined) return "-";
    return `${value.toFixed(1)}%`;
  };

  // Show the comparison section shell whenever the block has actual trades (unfiltered)
  // to avoid layout jumps. Content changes based on whether comparisonStats is available.
  const showComparisonSection = isViewingDay
    ? dayStats?.hasBacktest && dayStats?.hasActual
    : hasActualTrades;

  // Whether we have actual comparison data to display metrics
  const hasComparisonData = isViewingDay
    ? dayStats?.hasBacktest && dayStats?.hasActual
    : !!comparisonStats;

  return (
    <div className="space-y-6">
      {/* Comparison Stats - always present when block has actual trades, content varies */}
      {showComparisonSection && (
        <MetricSection
          title="Backtest vs Actual"
          icon={<BarChart3 className="h-4 w-4" />}
          gridCols={4}
          actions={performanceActions}
        >
          {hasComparisonData ? (
            <>
              <MetricCard
                title="Backtest P&L"
                value={
                  isViewingDay && dayStats
                    ? dayStats.backtestPl
                    : (comparisonStats?.backtestPl ?? 0)
                }
                format="currency"
                subtitle={
                  isViewingDay && dayStats ? `${dayStats.backtestTradeCount} trades` : undefined
                }
                isPositive={isPositive(
                  isViewingDay && dayStats
                    ? dayStats.backtestPl
                    : (comparisonStats?.backtestPl ?? 0),
                )}
                tooltip={{
                  flavor: "Total P&L from backtest trades",
                  detailed: "Sum of all backtest trade results (scaled if scaling mode is active)",
                }}
              />
              <MetricCard
                title="Actual P&L"
                value={
                  isViewingDay && dayStats ? dayStats.actualPl : (comparisonStats?.actualPl ?? 0)
                }
                format="currency"
                subtitle={
                  isViewingDay && dayStats ? `${dayStats.actualTradeCount} trades` : undefined
                }
                isPositive={isPositive(
                  isViewingDay && dayStats ? dayStats.actualPl : (comparisonStats?.actualPl ?? 0),
                )}
                tooltip={{
                  flavor: "Total P&L from actual trades",
                  detailed: "Sum of all actual executed trade results",
                }}
              />
              <MetricCard
                title="Variance"
                value={
                  isViewingDay && dayStats
                    ? (dayStats.variance ?? 0)
                    : (comparisonStats?.totalSlippage ?? 0)
                }
                format="currency"
                subtitle={
                  isViewingDay && dayStats
                    ? dayStats.variancePercent !== null
                      ? formatPercent(dayStats.variancePercent)
                      : undefined
                    : comparisonStats && comparisonStats.backtestPl !== 0
                      ? formatPercent(
                          (comparisonStats.totalSlippage / Math.abs(comparisonStats.backtestPl)) *
                            100,
                        )
                      : undefined
                }
                isPositive={isPositive(
                  isViewingDay && dayStats
                    ? (dayStats.variance ?? 0)
                    : (comparisonStats?.totalSlippage ?? 0),
                )}
                tooltip={{
                  flavor: "Performance difference between actual and backtest",
                  detailed:
                    "Includes slippage, commissions, timing differences, and market impact. Positive means actual outperformed backtest.",
                }}
              />
              <MetricCard
                title="Match Rate"
                value={
                  isViewingDay && dayStats
                    ? dayStats.strategyCount > 0
                      ? `${Math.round((dayStats.matchedCount / dayStats.strategyCount) * 100)}%`
                      : "-"
                    : comparisonStats
                      ? `${comparisonStats.matchRate.toFixed(0)}%`
                      : "-"
                }
                subtitle={
                  isViewingDay && dayStats
                    ? dayStats.strategyCount - dayStats.matchedCount > 0
                      ? `${dayStats.strategyCount - dayStats.matchedCount} unmatched`
                      : "All matched"
                    : comparisonStats &&
                        comparisonStats.unmatchedBacktestCount +
                          comparisonStats.unmatchedActualCount >
                          0
                      ? `${
                          comparisonStats.unmatchedBacktestCount +
                          comparisonStats.unmatchedActualCount
                        } unmatched`
                      : "All matched"
                }
                tooltip={{
                  flavor: "Percentage of strategies that were matched",
                  detailed: "How many backtest strategies have corresponding actual trades",
                }}
              />
            </>
          ) : (
            <div className="col-span-4 flex items-center justify-center py-4 text-sm text-muted-foreground">
              {selectedStrategies.length > 0
                ? "Selected strategies have no actual trades in this period — clear the filter or add a strategy with actual data to compare."
                : "No actual trades in this period to compare."}
            </div>
          )}
        </MetricSection>
      )}

      {/* Performance Stats - 8 metrics in 2 rows */}
      <MetricSection
        title="Performance"
        icon={<TrendingUp className="h-4 w-4" />}
        gridCols={4}
        actions={
          <div className="flex items-center gap-2">
            <Switch
              id="combine-legs"
              checked={combineLegGroups}
              onCheckedChange={setCombineLegGroups}
            />
            <Label htmlFor="combine-legs" className="text-xs text-muted-foreground cursor-pointer">
              Combine legs
            </Label>
          </div>
        }
      >
        {/* Row 1: CAGR, Win Rate, Sharpe, Sortino */}

        <MetricCard
          title="Win Rate"
          value={
            isViewingDay
              ? dayStats
                ? `${dayStats.winRate.toFixed(0)}%`
                : "-"
              : performanceStats
                ? `${performanceStats.winRate.toFixed(0)}%`
                : "-"
          }
          subtitle={
            isViewingDay
              ? dayStats
                ? `${dayStats.strategyCount} strategies`
                : "0 strategies"
              : performanceStats
                ? `${performanceStats.tradingDays} days · ${performanceStats.dataSource === "actual" ? "Actual" : "Backtest"}`
                : undefined
          }
          tooltip={{
            flavor: isViewingDay
              ? "Percentage of profitable strategies"
              : "Percentage of profitable trading days",
            detailed: isViewingDay
              ? "Strategies with positive P&L divided by total strategies"
              : "Days with positive P&L divided by total trading days",
          }}
        />
        <MetricCard
          title="CAGR"
          value={
            isViewingDay
              ? "-"
              : performanceStats?.cagr !== null
                ? formatPct(performanceStats?.cagr)
                : "-"
          }
          isPositive={
            !isViewingDay && performanceStats?.cagr !== null
              ? isPositive(performanceStats?.cagr ?? 0)
              : undefined
          }
          tooltip={{
            flavor: "Compound Annual Growth Rate",
            detailed:
              "Annualized return rate assuming compounding. Requires multiple days of data.",
          }}
        />
        <MetricCard
          title="Sharpe"
          value={isViewingDay ? "-" : formatRatio(performanceStats?.sharpe)}
          isPositive={
            !isViewingDay && performanceStats?.sharpe !== null
              ? isPositive(performanceStats?.sharpe ?? 0)
              : undefined
          }
          tooltip={{
            flavor: "Risk-adjusted return measure",
            detailed:
              "Excess return per unit of total volatility. Higher is better. Requires multiple days of data.",
          }}
        />
        <MetricCard
          title="Sortino"
          value={isViewingDay ? "-" : formatRatio(performanceStats?.sortino)}
          isPositive={
            !isViewingDay && performanceStats?.sortino !== null
              ? isPositive(performanceStats?.sortino ?? 0)
              : undefined
          }
          tooltip={{
            flavor: "Downside risk-adjusted return",
            detailed:
              "Like Sharpe but only considers downside volatility. Higher is better. Requires multiple days of data.",
          }}
        />

        {/* Row 2: Max Drawdown, Calmar, Avg RoM, Avg Premium Capture */}
        <MetricCard
          title="Max Drawdown"
          value={
            isViewingDay
              ? dayStats?.maxDrawdown != null
                ? formatPct(dayStats.maxDrawdown)
                : "-"
              : performanceStats?.maxDrawdown != null
                ? formatPct(performanceStats.maxDrawdown)
                : "-"
          }
          subtitle={!isViewingDay && performanceStats?.maxDrawdown != null ? "Backtest" : undefined}
          isPositive={false}
          tooltip={{
            flavor: isViewingDay
              ? "Intraday peak-to-trough decline"
              : "Largest peak-to-trough decline",
            detailed: isViewingDay
              ? "Maximum percentage drop from intraday equity peak. Based on trade close times."
              : "Maximum percentage drop from a peak to a trough. Lower is better.",
          }}
        />
        <MetricCard
          title="Calmar"
          value={isViewingDay ? "-" : formatRatio(performanceStats?.calmar)}
          isPositive={
            !isViewingDay && performanceStats?.calmar != null
              ? isPositive(performanceStats.calmar)
              : undefined
          }
          tooltip={{
            flavor: "Return vs drawdown ratio",
            detailed:
              "CAGR divided by Max Drawdown. Higher is better. Measures return per unit of drawdown risk.",
          }}
        />
        <MetricCard
          title="Avg RoM"
          value={
            isViewingDay
              ? dayStats?.avgRom != null
                ? formatPct(dayStats.avgRom)
                : "-"
              : performanceStats?.avgRom != null
                ? formatPct(performanceStats.avgRom)
                : "-"
          }
          subtitle={
            (isViewingDay ? dayStats?.avgRom : performanceStats?.avgRom) != null
              ? "Backtest"
              : undefined
          }
          isPositive={
            isViewingDay
              ? dayStats?.avgRom != null
                ? isPositive(dayStats.avgRom)
                : undefined
              : performanceStats?.avgRom != null
                ? isPositive(performanceStats.avgRom)
                : undefined
          }
          tooltip={{
            flavor: "Average Return on Margin",
            detailed:
              "Average P&L divided by margin requirement per trade. Only available for backtest trades with margin data.",
          }}
        />
        <MetricCard
          title="Premium Capture"
          value={
            isViewingDay
              ? dayStats?.avgPremiumCapture != null
                ? formatPct(dayStats.avgPremiumCapture)
                : "-"
              : performanceStats?.avgPremiumCapture != null
                ? formatPct(performanceStats.avgPremiumCapture)
                : "-"
          }
          subtitle={
            !isViewingDay && performanceStats?.avgPremiumCapture != null
              ? performanceStats.dataSource === "actual"
                ? "Actual"
                : "Backtest"
              : undefined
          }
          isPositive={
            isViewingDay
              ? dayStats?.avgPremiumCapture != null
                ? isPositive(dayStats.avgPremiumCapture)
                : undefined
              : performanceStats?.avgPremiumCapture != null
                ? isPositive(performanceStats.avgPremiumCapture)
                : undefined
          }
          tooltip={{
            flavor: "Average premium captured per trade",
            detailed:
              "Average P&L as a percentage of premium collected. Shows how much of the initial premium was captured as profit.",
          }}
        />
      </MetricSection>
    </div>
  );
}
