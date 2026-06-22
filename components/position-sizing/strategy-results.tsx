/**
 * Strategy results grid showing per-strategy Kelly metrics and allocation guidance
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Separator } from "@/components/ui/separator";
import { KellyMetrics } from "@tradeblocks/lib";
import { AlertTriangle, HelpCircle, Info } from "lucide-react";

export interface StrategyAnalysis {
  name: string;
  tradeCount: number;
  kellyMetrics: KellyMetrics;
  inputPct: number; // User's Kelly multiplier
  appliedPct: number; // Kelly % * (input % / 100)
  maxMarginPct: number;
  allocationPct: number; // Max margin * (input % / 100)
  allocationDollars: number;
}

interface StrategyResultsProps {
  strategies: StrategyAnalysis[];
  startingCapital: number;
}

export function StrategyResults({ strategies, startingCapital }: StrategyResultsProps) {
  if (strategies.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-muted-foreground">No strategies available for analysis.</p>
      </Card>
    );
  }

  // Check if any strategy has unrealistic values
  const hasAnyUnrealisticValues = strategies.some((s) => s.kellyMetrics.hasUnrealisticValues);

  return (
    <div className="space-y-4">
      {/* Warning banner for unrealistic backtest data */}
      {hasAnyUnrealisticValues && (
        <Alert
          variant="default"
          className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20"
        >
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
          <AlertTitle className="text-amber-900 dark:text-amber-100">
            Unrealistic Backtest Values Detected
          </AlertTitle>
          <AlertDescription className="text-amber-800 dark:text-amber-200 [&>span]:block [&>span]:mt-2">
            <span>
              Your backtest data shows extremely large P&L values (likely from unlimited compounding
              backtests). We automatically use <strong>Normalized Kelly</strong> calculations for
              more realistic position sizing.
            </span>
            <span className="font-medium">
              ✓ <strong>Normalized Kelly</strong> uses percentage returns on margin (ROI %) instead
              of absolute dollars.
            </span>
            <span className="text-sm">
              Focus on the <strong>Normalized Kelly %</strong> and{" "}
              <strong>Recommended Allocation %</strong> metrics shown below.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {strategies.map((strategy) => {
          const hasValidKelly = strategy.kellyMetrics.hasValidKelly;
          const hasOnlyWins =
            strategy.kellyMetrics.avgWin > 0 && strategy.kellyMetrics.avgLoss === 0;
          const hasOnlyLosses =
            strategy.kellyMetrics.avgWin === 0 && strategy.kellyMetrics.avgLoss > 0;
          const hasNormalizedKelly = strategy.kellyMetrics.normalizedKellyPct !== undefined;
          const isUnrealistic = strategy.kellyMetrics.hasUnrealisticValues;

          // Always use normalized metrics when available (more reliable for position sizing)
          const displayKellyPct = hasNormalizedKelly
            ? strategy.kellyMetrics.normalizedKellyPct!
            : strategy.kellyMetrics.percent;

          const useNormalizedDisplay = hasNormalizedKelly;

          const payoffDisplay =
            isFinite(strategy.kellyMetrics.payoffRatio) && strategy.kellyMetrics.payoffRatio > 0
              ? `${strategy.kellyMetrics.payoffRatio.toFixed(2)}x`
              : "--";

          // Always show percentage returns when normalized Kelly is available
          const avgWinDisplay =
            useNormalizedDisplay && strategy.kellyMetrics.avgWinPct !== undefined
              ? `${strategy.kellyMetrics.avgWinPct.toFixed(1)}% ROI`
              : strategy.kellyMetrics.avgWin > 0
                ? `$${strategy.kellyMetrics.avgWin.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}`
                : "--";

          const avgLossDisplay =
            useNormalizedDisplay && strategy.kellyMetrics.avgLossPct !== undefined
              ? `${strategy.kellyMetrics.avgLossPct.toFixed(1)}% ROI`
              : strategy.kellyMetrics.avgLoss > 0
                ? `-$${strategy.kellyMetrics.avgLoss.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}`
                : "--";

          // Calculate applied capital based on display mode
          const appliedCapitalDollars = useNormalizedDisplay
            ? (startingCapital * strategy.appliedPct) / 100
            : strategy.allocationDollars;

          // Calculate recommended allocation dollars based on display mode
          const recommendedAllocationDollars = useNormalizedDisplay
            ? (startingCapital * strategy.appliedPct) / 100
            : strategy.allocationDollars;

          return (
            <Card key={strategy.name} className="p-4">
              <div className="space-y-4">
                {/* Strategy name and badges */}
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <h3
                    className="font-semibold leading-snug min-h-[3rem] flex items-center truncate"
                    title={strategy.name}
                  >
                    {strategy.name}
                  </h3>
                  <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
                    <Badge variant="secondary">
                      {strategy.tradeCount} {strategy.tradeCount === 1 ? "trade" : "trades"}
                    </Badge>
                    {!hasValidKelly && hasOnlyWins && (
                      <Badge variant="outline">Kelly N/A - Only wins</Badge>
                    )}
                    {!hasValidKelly && hasOnlyLosses && (
                      <Badge variant="outline">Kelly N/A - Only losses</Badge>
                    )}
                    {!hasValidKelly &&
                      !hasOnlyWins &&
                      !hasOnlyLosses &&
                      strategy.tradeCount > 0 && (
                        <Badge variant="outline">Kelly N/A - No P/L data</Badge>
                      )}
                    {hasValidKelly && strategy.kellyMetrics.percent <= 0 && (
                      <Badge variant="destructive">Negative expectancy</Badge>
                    )}
                  </div>
                </div>

                <Separator />

                {/* Kelly percentages */}
                <div className="space-y-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        {hasValidKelly
                          ? hasNormalizedKelly
                            ? `Normalized Kelly ${displayKellyPct.toFixed(1)}%`
                            : `Full Kelly ${displayKellyPct.toFixed(1)}%`
                          : "Kelly calculation unavailable"}
                      </p>
                      {hasNormalizedKelly && (
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <Info
                              className={`h-3.5 w-3.5 cursor-help ${
                                isUnrealistic
                                  ? "text-amber-600 dark:text-amber-500"
                                  : "text-blue-600 dark:text-blue-500"
                              }`}
                            />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-80 p-0 overflow-hidden">
                            <div className="space-y-3">
                              <div
                                className={`border-b px-4 py-3 ${
                                  isUnrealistic
                                    ? "bg-amber-500/10 border-amber-500/20"
                                    : "bg-blue-500/10 border-blue-500/20"
                                }`}
                              >
                                <h4
                                  className={`text-sm font-semibold ${
                                    isUnrealistic
                                      ? "text-amber-900 dark:text-amber-100"
                                      : "text-blue-900 dark:text-blue-100"
                                  }`}
                                >
                                  Normalized Kelly
                                </h4>
                              </div>
                              <div className="px-4 pb-4 space-y-3">
                                <p className="text-sm text-foreground leading-relaxed">
                                  {isUnrealistic
                                    ? "This strategy has unrealistic P&L values from compounding."
                                    : "Calculated using percentage returns on margin requirement."}
                                </p>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                  Normalized Kelly uses ROI % (P&L / Margin) instead of absolute
                                  dollars, making it more appropriate for position sizing with
                                  varying position sizes.
                                </p>
                              </div>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                      )}
                    </div>
                    {hasValidKelly &&
                      hasNormalizedKelly &&
                      Math.abs(strategy.kellyMetrics.percent - displayKellyPct) > 0.1 && (
                        <div className="flex items-center gap-1">
                          <p className="text-xs text-muted-foreground">
                            Full Kelly (absolute): {strategy.kellyMetrics.percent.toFixed(1)}%
                          </p>
                          {Math.abs(strategy.kellyMetrics.percent - displayKellyPct) >
                            displayKellyPct * 0.2 && (
                            <HoverCard>
                              <HoverCardTrigger asChild>
                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                              </HoverCardTrigger>
                              <HoverCardContent className="w-80 p-0 overflow-hidden">
                                <div className="space-y-3">
                                  <div className="bg-primary/5 border-b px-4 py-3">
                                    <h4 className="text-sm font-semibold text-primary">
                                      Why These Differ
                                    </h4>
                                  </div>
                                  <div className="px-4 pb-4 space-y-3">
                                    <p className="text-sm text-foreground leading-relaxed">
                                      Normalized Kelly may use a different sample of trades (only
                                      those with margin data).
                                    </p>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      For compounding backtests, use the{" "}
                                      <strong>Normalized Kelly</strong> value as it&apos;s
                                      calculated from percentage returns rather than absolute P&L.
                                    </p>
                                  </div>
                                </div>
                              </HoverCardContent>
                            </HoverCard>
                          )}
                        </div>
                      )}
                    {hasValidKelly && (
                      <p className="text-xs text-muted-foreground">
                        Kelly multiplier: {strategy.inputPct.toFixed(0)}%
                      </p>
                    )}
                  </div>
                </div>

                {/* Win rate and payoff ratio */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Win Rate</p>
                    <p className="text-sm font-semibold">
                      {(strategy.kellyMetrics.winRate * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="space-y-1 text-right">
                    <p className="text-xs text-muted-foreground">Win/Loss Ratio</p>
                    <p className="text-sm font-semibold">{payoffDisplay}</p>
                  </div>
                </div>

                {/* Average win/loss */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {useNormalizedDisplay && strategy.kellyMetrics.avgWinPct !== undefined
                        ? "Avg Win (on margin)"
                        : "Average Win"}
                    </p>
                    <p className="text-sm font-semibold text-green-600">{avgWinDisplay}</p>
                  </div>
                  <div className="space-y-1 text-right">
                    <p className="text-xs text-muted-foreground">
                      {useNormalizedDisplay && strategy.kellyMetrics.avgLossPct !== undefined
                        ? "Avg Loss (on margin)"
                        : "Average Loss"}
                    </p>
                    <p className="text-sm font-semibold text-red-600">{avgLossDisplay}</p>
                  </div>
                </div>

                <Separator />

                {/* Allocation guidance */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <p className="text-xs text-muted-foreground">Max margin used</p>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">
                                Max Margin Used
                              </h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              <p className="text-sm font-medium text-foreground leading-relaxed">
                                Peak margin requirement observed historically for this strategy.
                              </p>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                Higher values indicate more capital-intensive strategies. This
                                represents the maximum percentage of your starting capital that was
                                needed at any point to support all open positions in this strategy.
                              </p>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <p className="text-sm font-semibold">{strategy.maxMarginPct.toFixed(1)}%</p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <p className="text-xs text-muted-foreground">Applied capital</p>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">
                                Applied Capital
                              </h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              <p className="text-sm font-medium text-foreground leading-relaxed">
                                Starting capital × this strategy&apos;s applied % after Kelly.
                              </p>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {useNormalizedDisplay
                                  ? "This represents the total dollar amount you should allocate to this strategy based on normalized Kelly calculations and your risk tolerance."
                                  : "Use this as the maximum capital you intend to commit to the strategy when configuring backtest sizing rules."}
                              </p>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <p className="text-sm font-semibold">
                      $
                      {appliedCapitalDollars.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <p className="text-xs text-muted-foreground">
                        {useNormalizedDisplay
                          ? "Recommended allocation %"
                          : "Reference allocation %"}
                      </p>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">
                                {useNormalizedDisplay
                                  ? "Recommended Allocation %"
                                  : "Reference Allocation %"}
                              </h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              {useNormalizedDisplay ? (
                                <>
                                  <p className="text-sm font-medium text-foreground leading-relaxed">
                                    Applied Kelly % (your Normalized Kelly with risk multipliers).
                                  </p>
                                  <p className="text-xs text-muted-foreground leading-relaxed">
                                    <strong>
                                      Use this value in Option Omega&apos;s allocation % field
                                    </strong>{" "}
                                    when re-running your backtest. This is your Kelly-optimal
                                    position size adjusted for your risk tolerance.
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-sm font-medium text-foreground leading-relaxed">
                                    Historical max margin × your Kelly %.
                                  </p>
                                  <p className="text-xs text-muted-foreground leading-relaxed">
                                    Use this percentage as the per-trade margin allocation guideline
                                    when setting up your backtest.
                                  </p>
                                </>
                              )}
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <p className="text-sm font-semibold">
                      {useNormalizedDisplay
                        ? strategy.appliedPct.toFixed(1)
                        : strategy.allocationPct.toFixed(1)}
                      %
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <p className="text-xs text-muted-foreground">
                        {useNormalizedDisplay
                          ? "Recommended allocation $"
                          : "Reference allocation $"}
                      </p>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">
                                {useNormalizedDisplay
                                  ? "Recommended Allocation $"
                                  : "Reference Allocation $"}
                              </h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              {useNormalizedDisplay ? (
                                <>
                                  <p className="text-sm font-medium text-foreground leading-relaxed">
                                    Starting capital × recommended allocation %.
                                  </p>
                                  <p className="text-xs text-muted-foreground leading-relaxed">
                                    The total dollar amount allocated to this strategy based on
                                    Kelly-optimal sizing and your risk tolerance settings.
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-sm font-medium text-foreground leading-relaxed">
                                    Starting capital × reference allocation %.
                                  </p>
                                  <p className="text-xs text-muted-foreground leading-relaxed">
                                    Map this dollar amount to your backtest&apos;s per-trade
                                    allocation limit so it mirrors the Kelly-based guidance above.
                                  </p>
                                </>
                              )}
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <p className="text-sm font-semibold">
                      $
                      {recommendedAllocationDollars.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
