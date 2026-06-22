"use client";

import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight } from "lucide-react";
import { useTradingCalendarStore } from "@tradeblocks/lib/stores";
import {
  formatCurrency,
  aggregateTradesByStrategy,
  scaleStrategyComparison,
} from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

interface TradeCardProps {
  strategy: string;
  backtestPl: number | null;
  actualPl: number | null;
  slippage: number | null;
  slippagePercent: number | null;
  isMatched: boolean;
  reasonForClose?: string;
  time?: string;
  onClick: () => void;
}

function TradeCard({
  strategy,
  backtestPl,
  actualPl,
  slippage,
  slippagePercent,
  isMatched,
  reasonForClose,
  time,
  onClick,
}: TradeCardProps) {
  const hasBacktest = backtestPl !== null;
  const hasActual = actualPl !== null;

  return (
    <Card className="cursor-pointer hover:bg-accent transition-colors" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            {/* Strategy name row */}
            <div className="flex items-center gap-2 mb-3">
              <span className="font-semibold truncate">{strategy}</span>
              {time && <span className="text-xs text-muted-foreground flex-shrink-0">{time}</span>}
              {isMatched && (
                <Badge variant="outline" className="text-xs flex-shrink-0">
                  Matched
                </Badge>
              )}
            </div>

            {/* P&L row - horizontal layout */}
            <div className="flex items-center gap-6">
              {hasBacktest && (
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Backtest</span>
                  <span
                    className={cn(
                      "text-lg font-semibold",
                      backtestPl > 0 && "text-green-500",
                      backtestPl < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(backtestPl)}
                  </span>
                </div>
              )}

              {hasActual && (
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Actual</span>
                  <span
                    className={cn(
                      "text-lg font-semibold",
                      actualPl > 0 && "text-green-500",
                      actualPl < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(actualPl)}
                  </span>
                </div>
              )}

              {slippage !== null && (
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Variance</span>
                  <span
                    className={cn(
                      "text-lg font-semibold",
                      slippage > 0 && "text-green-500",
                      slippage < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(slippage)}
                    {slippagePercent !== null && (
                      <span className="text-sm ml-1">
                        ({slippagePercent > 0 ? "+" : ""}
                        {slippagePercent.toFixed(1)}%)
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* Reason for close */}
            {reasonForClose && (
              <div className="text-xs text-muted-foreground mt-2">{reasonForClose}</div>
            )}
          </div>

          {/* Click indicator */}
          <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0 ml-2" />
        </div>
      </CardContent>
    </Card>
  );
}

export function DayView() {
  const {
    selectedDate,
    calendarDays,
    strategyMatches,
    scalingMode,
    tradeFilterMode,
    navigateToTrade,
  } = useTradingCalendarStore();

  const dayData = selectedDate ? calendarDays.get(selectedDate) : undefined;

  // Aggregate trades by strategy
  const strategyComparisons = useMemo(() => {
    if (!dayData) return [];
    const comparisons = aggregateTradesByStrategy(dayData, strategyMatches);
    return comparisons.map((c) => scaleStrategyComparison(c, scalingMode));
  }, [dayData, strategyMatches, scalingMode]);

  if (!selectedDate) return null;

  // Separate matched and unmatched
  const matchedComparisons = strategyComparisons.filter((c) => c.isMatched);
  const unmatchedComparisons = strategyComparisons.filter((c) => !c.isMatched);

  return (
    <div className="space-y-6">
      {/* Matched strategies - hidden when filter mode is 'unmatched' */}
      {tradeFilterMode !== "unmatched" && matchedComparisons.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Matched Strategies ({matchedComparisons.length})
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {matchedComparisons.map((comparison) => {
              const firstActualTrade = comparison.actual?.trades[0];
              const firstBtTrade = comparison.backtest?.trades[0];

              return (
                <TradeCard
                  key={comparison.strategy}
                  strategy={comparison.strategy}
                  backtestPl={comparison.scaled.backtestPl}
                  actualPl={comparison.scaled.actualPl}
                  slippage={comparison.scaled.slippage}
                  slippagePercent={comparison.scaled.slippagePercent}
                  isMatched={true}
                  reasonForClose={firstActualTrade?.reasonForClose ?? firstBtTrade?.reasonForClose}
                  time={firstBtTrade?.timeOpened ?? undefined}
                  onClick={() => navigateToTrade(comparison.strategy, selectedDate)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Unmatched strategies - hidden when filter mode is 'matched' */}
      {tradeFilterMode !== "matched" && unmatchedComparisons.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Unmatched ({unmatchedComparisons.length})
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {unmatchedComparisons.map((comparison) => {
              const firstActualTrade = comparison.actual?.trades[0];
              const firstBtTrade = comparison.backtest?.trades[0];

              return (
                <TradeCard
                  key={comparison.strategy}
                  strategy={comparison.strategy}
                  backtestPl={comparison.scaled.backtestPl}
                  actualPl={comparison.scaled.actualPl}
                  slippage={null}
                  slippagePercent={null}
                  isMatched={false}
                  reasonForClose={firstActualTrade?.reasonForClose ?? firstBtTrade?.reasonForClose}
                  time={firstBtTrade?.timeOpened ?? undefined}
                  onClick={() => navigateToTrade(comparison.strategy, selectedDate)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state - accounts for filter mode */}
      {(tradeFilterMode === "all"
        ? strategyComparisons.length === 0
        : tradeFilterMode === "matched"
          ? matchedComparisons.length === 0
          : unmatchedComparisons.length === 0) && (
        <Card className="py-8">
          <CardContent className="text-center text-muted-foreground">
            {tradeFilterMode === "matched"
              ? "No matched trades on this day"
              : tradeFilterMode === "unmatched"
                ? "No unmatched trades on this day"
                : "No trades on this day"}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
