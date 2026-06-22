"use client";

import { useMemo } from "react";
import { useTradingCalendarStore } from "@tradeblocks/lib/stores";
import {
  formatCurrency,
  getDayBackgroundStyle,
  getMonthGridDates,
  getWeekGridDates,
  getFilteredScaledDayBacktestPl,
  getFilteredScaledDayActualPl,
  getScaledDayBacktestPl,
  getScaledDayActualPl,
  getFilteredTradeCounts,
  getScaledDayMargin,
} from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format date to YYYY-MM-DD in local timezone
 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface CalendarDayCellProps {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  onClick: () => void;
}

function CalendarDayCell({ date, isCurrentMonth, isToday, onClick }: CalendarDayCellProps) {
  const {
    calendarDays,
    scalingMode,
    dataDisplayMode,
    showMargin,
    tradeFilterMode,
    strategyMatches,
  } = useTradingCalendarStore();

  const dateKey = formatDateKey(date);
  const dayData = calendarDays.get(dateKey);

  // Build matched strategy sets when filtering by matched/unmatched
  const matchedBacktestStrategies = useMemo(() => {
    if (tradeFilterMode === "all") return null;
    return new Set(strategyMatches.map((m) => m.backtestStrategy));
  }, [tradeFilterMode, strategyMatches]);

  const matchedActualStrategies = useMemo(() => {
    if (tradeFilterMode === "all") return null;
    return new Set(strategyMatches.map((m) => m.actualStrategy));
  }, [tradeFilterMode, strategyMatches]);

  // Get filtered trade counts
  const { backtestCount, actualCount } = useMemo(() => {
    if (!dayData) return { backtestCount: 0, actualCount: 0 };
    if (tradeFilterMode === "unmatched") {
      const matched = getFilteredTradeCounts(
        dayData,
        matchedBacktestStrategies,
        matchedActualStrategies,
        strategyMatches,
      );
      return {
        backtestCount: dayData.backtestTradeCount - matched.backtestCount,
        actualCount: dayData.actualTradeCount - matched.actualCount,
      };
    }
    return getFilteredTradeCounts(
      dayData,
      matchedBacktestStrategies,
      matchedActualStrategies,
      strategyMatches,
    );
  }, [
    dayData,
    matchedBacktestStrategies,
    matchedActualStrategies,
    strategyMatches,
    tradeFilterMode,
  ]);

  // In matched mode, only show days that have BOTH backtest AND actual trades from matched strategies
  // This enables actual comparison. In all/unmatched mode, show if either exists.
  // IMPORTANT: Only show trade data for dates within the current month view
  const hasTrades =
    isCurrentMonth &&
    (tradeFilterMode === "matched"
      ? backtestCount > 0 && actualCount > 0
      : backtestCount > 0 || actualCount > 0);
  const hasBacktestData = backtestCount > 0;
  const hasActualData = actualCount > 0;

  // Determine what to show based on display mode
  const showBacktest =
    (dataDisplayMode === "backtest" || dataDisplayMode === "both") && hasBacktestData;
  const showActual = (dataDisplayMode === "actual" || dataDisplayMode === "both") && hasActualData;

  // Get both P/L values (filtered)
  const backtestPl = useMemo(() => {
    if (!dayData) return 0;
    if (tradeFilterMode === "unmatched") {
      const total = getScaledDayBacktestPl(dayData, scalingMode, strategyMatches);
      const matched = getFilteredScaledDayBacktestPl(
        dayData,
        scalingMode,
        matchedBacktestStrategies,
        strategyMatches,
      );
      return total - matched;
    }
    return getFilteredScaledDayBacktestPl(
      dayData,
      scalingMode,
      matchedBacktestStrategies,
      strategyMatches,
    );
  }, [dayData, scalingMode, matchedBacktestStrategies, strategyMatches, tradeFilterMode]);
  const actualPl = useMemo(() => {
    if (!dayData) return 0;
    if (tradeFilterMode === "unmatched") {
      const total = getScaledDayActualPl(dayData, scalingMode);
      const matched = getFilteredScaledDayActualPl(
        dayData,
        scalingMode,
        matchedActualStrategies,
        strategyMatches,
      );
      return total - matched;
    }
    return getFilteredScaledDayActualPl(
      dayData,
      scalingMode,
      matchedActualStrategies,
      strategyMatches,
    );
  }, [dayData, scalingMode, matchedActualStrategies, strategyMatches, tradeFilterMode]);

  // Get background style - handles mismatch cases with stripes when showing both
  const bgStyle = useMemo(() => {
    if (!hasTrades) return {};
    // Only check for mismatch when in 'both' mode and both data sources exist
    if (dataDisplayMode === "both" && hasBacktestData && hasActualData) {
      return getDayBackgroundStyle(backtestPl, actualPl);
    }
    // Single mode - just use the displayed value
    const displayedPl =
      dataDisplayMode === "backtest"
        ? backtestPl
        : dataDisplayMode === "actual"
          ? actualPl
          : hasActualData
            ? actualPl
            : backtestPl;
    return getDayBackgroundStyle(null, displayedPl);
  }, [hasTrades, dataDisplayMode, hasBacktestData, hasActualData, backtestPl, actualPl]);

  return (
    <button
      onClick={onClick}
      disabled={!hasTrades}
      className={cn(
        "relative flex flex-col items-start p-2 min-h-[100px] border-b border-r border-border/50 transition-colors",
        isCurrentMonth ? "bg-background" : "bg-muted/30",
        hasTrades && "hover:bg-accent cursor-pointer",
        !hasTrades && "cursor-default",
        bgStyle.className,
        isToday && "ring-2 ring-primary ring-inset",
      )}
    >
      {/* Top section: Date and P&L */}
      <div className="w-full flex-1 flex flex-col items-start">
        {/* Date number */}
        <span
          className={cn(
            "text-sm font-medium",
            !isCurrentMonth && "text-muted-foreground",
            isToday && "text-primary font-bold",
          )}
        >
          {date.getDate()}
        </span>

        {/* Trade data */}
        {hasTrades && (
          <div className="flex flex-col items-start mt-1 w-full gap-0.5">
            {/* Single data source mode - larger, simpler display */}
            {dataDisplayMode !== "both" ? (
              <>
                {showBacktest && (
                  <div className="flex flex-col">
                    <span className="text-lg font-semibold text-foreground">
                      {formatCurrency(backtestPl, true)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {backtestCount} {backtestCount === 1 ? "trade" : "trades"}
                    </span>
                  </div>
                )}
                {showActual && (
                  <div className="flex flex-col">
                    <span className="text-lg font-semibold text-foreground">
                      {formatCurrency(actualPl, true)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {actualCount} {actualCount === 1 ? "trade" : "trades"}
                    </span>
                  </div>
                )}
              </>
            ) : (
              /* Both mode - compact with dots */
              <>
                {showBacktest && (
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-foreground">
                      {formatCurrency(backtestPl, true)}
                    </span>
                    <span className="text-xs text-muted-foreground">({backtestCount})</span>
                  </div>
                )}
                {showActual && (
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-foreground">
                      {formatCurrency(actualPl, true)}
                    </span>
                    <span className="text-xs text-muted-foreground">({actualCount})</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom section: Margin - pinned to bottom */}
      {showMargin && dayData && dayData.totalMargin > 0 && (
        <div className="flex items-center gap-1 pt-1 border-t border-border/30 w-full mt-auto">
          <span className="text-xs text-muted-foreground">Margin:</span>
          <span className="text-xs font-medium text-foreground">
            {formatCurrency(getScaledDayMargin(dayData, scalingMode))}
          </span>
        </div>
      )}
    </button>
  );
}

interface WeeklySummaryProps {
  dates: Date[];
  currentMonth: number;
}

function WeeklySummary({ dates, currentMonth }: WeeklySummaryProps) {
  const {
    calendarDays,
    scalingMode,
    dataDisplayMode,
    showMargin,
    tradeFilterMode,
    strategyMatches,
  } = useTradingCalendarStore();

  // Build matched strategy sets when filtering by matched/unmatched
  const matchedBacktestStrategies = useMemo(() => {
    if (tradeFilterMode === "all") return null;
    return new Set(strategyMatches.map((m) => m.backtestStrategy));
  }, [tradeFilterMode, strategyMatches]);

  const matchedActualStrategies = useMemo(() => {
    if (tradeFilterMode === "all") return null;
    return new Set(strategyMatches.map((m) => m.actualStrategy));
  }, [tradeFilterMode, strategyMatches]);

  // Calculate week totals for both backtest and actual (using scaled and filtered values)
  // Only include dates from the current month in the weekly totals
  const weekStats = useMemo(() => {
    let backtestPl = 0;
    let actualPl = 0;
    let backtestDays = 0;
    let actualDays = 0;
    let maxMargin = 0;

    for (const date of dates) {
      // Skip dates that are not in the current month
      if (date.getMonth() !== currentMonth) continue;

      const dateKey = formatDateKey(date);
      const dayData = calendarDays.get(dateKey);

      if (dayData) {
        let btCount: number, actCount: number;
        if (tradeFilterMode === "unmatched") {
          const matched = getFilteredTradeCounts(
            dayData,
            matchedBacktestStrategies,
            matchedActualStrategies,
            strategyMatches,
          );
          btCount = dayData.backtestTradeCount - matched.backtestCount;
          actCount = dayData.actualTradeCount - matched.actualCount;
        } else {
          const counts = getFilteredTradeCounts(
            dayData,
            matchedBacktestStrategies,
            matchedActualStrategies,
            strategyMatches,
          );
          btCount = counts.backtestCount;
          actCount = counts.actualCount;
        }

        // In matched mode, only count days that have BOTH backtest AND actual
        const includeDay = tradeFilterMode === "matched" ? btCount > 0 && actCount > 0 : true;

        if (includeDay && btCount > 0) {
          if (tradeFilterMode === "unmatched") {
            // Unmatched P&L = total - matched
            const totalPl = getScaledDayBacktestPl(dayData, scalingMode, strategyMatches);
            const matchedPl = getFilteredScaledDayBacktestPl(
              dayData,
              scalingMode,
              matchedBacktestStrategies,
              strategyMatches,
            );
            backtestPl += totalPl - matchedPl;
          } else {
            backtestPl += getFilteredScaledDayBacktestPl(
              dayData,
              scalingMode,
              matchedBacktestStrategies,
              strategyMatches,
            );
          }
          backtestDays++;
        }
        if (includeDay && actCount > 0) {
          if (tradeFilterMode === "unmatched") {
            const totalPl = getScaledDayActualPl(dayData, scalingMode);
            const matchedPl = getFilteredScaledDayActualPl(
              dayData,
              scalingMode,
              matchedActualStrategies,
              strategyMatches,
            );
            actualPl += totalPl - matchedPl;
          } else {
            actualPl += getFilteredScaledDayActualPl(
              dayData,
              scalingMode,
              matchedActualStrategies,
              strategyMatches,
            );
          }
          actualDays++;
        }
        // Track max scaled margin for the week (only for included days)
        if (includeDay) {
          const scaledMargin = getScaledDayMargin(dayData, scalingMode);
          if (scaledMargin > maxMargin) {
            maxMargin = scaledMargin;
          }
        }
      }
    }

    return { backtestPl, actualPl, backtestDays, actualDays, maxMargin };
  }, [
    dates,
    calendarDays,
    scalingMode,
    matchedBacktestStrategies,
    matchedActualStrategies,
    tradeFilterMode,
    strategyMatches,
    currentMonth,
  ]);

  // Determine what to show based on display mode
  const showBacktest =
    (dataDisplayMode === "backtest" || dataDisplayMode === "both") && weekStats.backtestDays > 0;
  const showActual =
    (dataDisplayMode === "actual" || dataDisplayMode === "both") && weekStats.actualDays > 0;

  const hasTrades = showBacktest || showActual;

  if (!hasTrades) {
    return (
      <div className="flex flex-col items-end justify-center p-2 min-h-[100px] border-b border-border/50 bg-muted/20">
        <span className="text-xs text-muted-foreground">-</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start justify-center p-2 min-h-[100px] border-b border-border/50 bg-muted/20 gap-0.5">
      {/* Single data source mode - larger, simpler display */}
      {dataDisplayMode !== "both" ? (
        <>
          {showBacktest && (
            <div className="flex flex-col">
              <span
                className={cn(
                  "text-lg font-bold",
                  weekStats.backtestPl > 0 && "text-green-600 dark:text-green-400",
                  weekStats.backtestPl < 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {formatCurrency(weekStats.backtestPl, true)}
              </span>
              <span className="text-xs text-muted-foreground">
                {weekStats.backtestDays} {weekStats.backtestDays === 1 ? "day" : "days"}
              </span>
            </div>
          )}
          {showActual && (
            <div className="flex flex-col">
              <span
                className={cn(
                  "text-lg font-bold",
                  weekStats.actualPl > 0 && "text-green-600 dark:text-green-400",
                  weekStats.actualPl < 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {formatCurrency(weekStats.actualPl, true)}
              </span>
              <span className="text-xs text-muted-foreground">
                {weekStats.actualDays} {weekStats.actualDays === 1 ? "day" : "days"}
              </span>
            </div>
          )}
        </>
      ) : (
        /* Both mode - compact with dots */
        <>
          {showBacktest && (
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
              <span
                className={cn(
                  "text-sm font-bold",
                  weekStats.backtestPl > 0 && "text-green-600 dark:text-green-400",
                  weekStats.backtestPl < 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {formatCurrency(weekStats.backtestPl, true)}
              </span>
              <span className="text-xs text-muted-foreground">({weekStats.backtestDays}d)</span>
            </div>
          )}
          {showActual && (
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 flex-shrink-0" />
              <span
                className={cn(
                  "text-sm font-bold",
                  weekStats.actualPl > 0 && "text-green-600 dark:text-green-400",
                  weekStats.actualPl < 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {formatCurrency(weekStats.actualPl, true)}
              </span>
              <span className="text-xs text-muted-foreground">({weekStats.actualDays}d)</span>
            </div>
          )}
        </>
      )}

      {/* Max margin for the week - only show when toggle is on and we have margin data */}
      {showMargin && weekStats.maxMargin > 0 && (
        <div className="flex items-center gap-1 mt-1 pt-1 border-t border-border/30 w-full">
          <span className="text-xs text-muted-foreground">Max Margin:</span>
          <span className="text-xs font-medium text-foreground">
            {formatCurrency(weekStats.maxMargin)}
          </span>
        </div>
      )}
    </div>
  );
}

export function CalendarView() {
  const { viewDate, calendarViewMode, dataDisplayMode, navigateToDay } = useTradingCalendarStore();

  const today = new Date();
  const todayKey = formatDateKey(today);

  // Get dates to display based on view mode
  const gridDates = useMemo(() => {
    if (calendarViewMode === "month") {
      return getMonthGridDates(viewDate.getFullYear(), viewDate.getMonth());
    }
    return getWeekGridDates(viewDate);
  }, [viewDate, calendarViewMode]);

  // Group dates by week for weekly summaries
  const weeks = useMemo(() => {
    const result: Date[][] = [];
    for (let i = 0; i < gridDates.length; i += 7) {
      result.push(gridDates.slice(i, i + 7));
    }
    return result;
  }, [gridDates]);

  const currentMonth = viewDate.getMonth();

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Weekday headers */}
      <div className="grid grid-cols-[repeat(7,1fr)_140px] bg-muted/50">
        {WEEKDAY_LABELS.map((day) => (
          <div
            key={day}
            className="p-2 text-center text-sm font-medium text-muted-foreground border-b border-r border-border/50"
          >
            {day}
          </div>
        ))}
        <div className="p-2 text-center text-sm font-medium text-muted-foreground border-b border-border/50">
          Weekly
        </div>
      </div>

      {/* Calendar grid */}
      <div>
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="grid grid-cols-[repeat(7,1fr)_140px]">
            {week.map((date) => {
              const dateKey = formatDateKey(date);
              const isCurrentMonth = date.getMonth() === currentMonth;
              const isToday = dateKey === todayKey;

              return (
                <CalendarDayCell
                  key={dateKey}
                  date={date}
                  isCurrentMonth={isCurrentMonth}
                  isToday={isToday}
                  onClick={() => navigateToDay(dateKey)}
                />
              );
            })}
            <WeeklySummary dates={week} currentMonth={currentMonth} />
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 p-3 bg-muted/30 border-t text-xs text-muted-foreground">
        {/* Data source legend - only show when in "both" mode */}
        {dataDisplayMode === "both" && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <span>Backtest</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              <span>Actual</span>
            </div>
          </div>
        )}
        {/* Background color legend */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-3 rounded-sm bg-green-900/25" />
            <span>Profit</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-3 rounded-sm bg-red-900/25" />
            <span>Loss</span>
          </div>
          {dataDisplayMode === "both" && (
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-3 rounded-sm bg-violet-900/25" />
              <span>Mixed</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
