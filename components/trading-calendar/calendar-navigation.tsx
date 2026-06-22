"use client";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CalendarViewMode,
  DataDisplayMode,
  DateDisplayMode,
  useTradingCalendarStore,
} from "@tradeblocks/lib/stores";
import { cn } from "@tradeblocks/lib";
import { format } from "date-fns";
import { CalendarIcon, ChevronLeft, ChevronRight, HelpCircle } from "lucide-react";

export function CalendarNavigation() {
  const {
    calendarViewMode,
    dateDisplayMode,
    dataDisplayMode,
    showMargin,
    viewDate,
    navigationView,
    selectedDate,
    actualTrades,
    backtestTrades,
    setCalendarViewMode,
    setDateDisplayMode,
    setDataDisplayMode,
    setShowMargin,
    setViewDate,
    navigateBack,
    navigateToDay,
  } = useTradingCalendarStore();

  const hasActualTrades = actualTrades.length > 0;
  const hasBacktestTrades = backtestTrades.length > 0;
  const hasBothDataSources = hasActualTrades && hasBacktestTrades;

  // Check if viewing a specific day
  const isViewingDay = navigationView === "day" || navigationView === "trade";

  // Navigation handlers
  const navigatePrev = () => {
    const newDate = new Date(viewDate);
    if (calendarViewMode === "month") {
      newDate.setMonth(newDate.getMonth() - 1);
    } else {
      newDate.setDate(newDate.getDate() - 7);
    }
    setViewDate(newDate);
  };

  const navigateNext = () => {
    const newDate = new Date(viewDate);
    if (calendarViewMode === "month") {
      newDate.setMonth(newDate.getMonth() + 1);
    } else {
      newDate.setDate(newDate.getDate() + 7);
    }
    setViewDate(newDate);
  };

  const goToToday = () => {
    setViewDate(new Date());
  };

  // Format view date label
  const viewDateLabel =
    calendarViewMode === "month"
      ? format(viewDate, "MMMM yyyy")
      : `Week of ${format(viewDate, "MMM d, yyyy")}`;

  // Parse YYYY-MM-DD to local Date (avoids UTC timezone shift)
  const parseDateKey = (dateKey: string): Date => {
    const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, year, month, day] = match;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    return new Date(dateKey);
  };

  // Format Date to YYYY-MM-DD in local timezone
  const formatDateKey = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  // Parse selected date for day navigation (local timezone)
  const selectedDateObj = selectedDate ? parseDateKey(selectedDate) : null;

  // Format selected date for day view display
  const selectedDateLabel = selectedDateObj
    ? selectedDateObj.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";

  // Day navigation handlers
  const navigatePrevDay = () => {
    if (selectedDateObj) {
      const prevDay = new Date(selectedDateObj);
      prevDay.setDate(prevDay.getDate() - 1);
      navigateToDay(formatDateKey(prevDay));
    }
  };

  const navigateNextDay = () => {
    if (selectedDateObj) {
      const nextDay = new Date(selectedDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      navigateToDay(formatDateKey(nextDay));
    }
  };

  // Handle date selection from calendar picker in day view
  const handleDaySelect = (date: Date | undefined) => {
    if (date) {
      navigateToDay(formatDateKey(date));
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-6">
      {/* Date Navigation - takes up ~2 columns worth of space */}
      <div className="space-y-2 flex-shrink-0">
        <Label>Date Range</Label>
        {isViewingDay ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={navigatePrevDay}>
              <ChevronLeft className="h-4 w-4" />
            </Button>

            {/* Day Picker Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="min-w-[280px] justify-start text-left font-semibold"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedDateLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={selectedDateObj ?? undefined}
                  onSelect={handleDaySelect}
                  defaultMonth={selectedDateObj ?? undefined}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Button variant="outline" size="icon" onClick={navigateNextDay}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={navigatePrev}>
              <ChevronLeft className="h-4 w-4" />
            </Button>

            {/* Month Picker Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn("min-w-[180px] justify-start text-left font-semibold")}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {viewDateLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={viewDate}
                  onSelect={(date) => date && setViewDate(date)}
                  defaultMonth={viewDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Button variant="outline" size="icon" onClick={navigateNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={goToToday}>
              Today
            </Button>
          </div>
        )}
      </div>

      {/* Back button when viewing day or trade - placed after date for layout stability */}
      {isViewingDay && (
        <div className="space-y-2">
          <Label className="invisible">Back</Label>
          <Button variant="ghost" size="sm" onClick={navigateBack}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            {navigationView === "trade" ? "Back to Day" : "Back to Calendar"}
          </Button>
        </div>
      )}

      {/* Spacer to push controls to the right */}
      <div className="flex-1" />

      {/* View Mode Toggle - hide when viewing day */}
      {!isViewingDay && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label>View Mode</Label>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-64 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">View Mode</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm text-foreground leading-relaxed">
                      Choose between week or month view.
                    </p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>
                        <strong>Week:</strong> 7-day view for detailed daily analysis
                      </li>
                      <li>
                        <strong>Month:</strong> Full month view with weekly summaries
                      </li>
                    </ul>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <Select
            value={calendarViewMode}
            onValueChange={(value) => setCalendarViewMode(value as CalendarViewMode)}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {/* Show Margin Toggle (only when backtest trades exist since margin only comes from backtest) */}
      {hasBacktestTrades && !isViewingDay && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label>Show Margin</Label>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-64 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">Margin Display</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm text-foreground leading-relaxed">
                      Show total margin requirement for trades on each day.
                    </p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>Daily cells show sum of margin for all trades</li>
                      <li>Weekly column shows maximum daily margin</li>
                      <li>Only available from backtest data</li>
                    </ul>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <div className="flex items-center h-9">
            <Switch checked={showMargin} onCheckedChange={setShowMargin} />
          </div>
        </div>
      )}

      {/* Date Display Mode - hide when viewing trade detail */}
      {navigationView !== "trade" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label>Show By</Label>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-64 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">Date Display</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm text-foreground leading-relaxed">
                      Choose which date to use for placing trades on the calendar.
                    </p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>
                        <strong>Entry Date:</strong> Show trades by when they were opened
                      </li>
                      <li>
                        <strong>Close Date:</strong> Show trades by when they were closed
                      </li>
                    </ul>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <Select
            value={dateDisplayMode}
            onValueChange={(value) => setDateDisplayMode(value as DateDisplayMode)}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="entry">Entry Date</SelectItem>
              <SelectItem value="exit">Close Date</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Data Display Mode Toggle (only shown when both data sources exist) - hide when viewing trade detail */}
      {hasBothDataSources && navigationView !== "trade" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label>Show Data</Label>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-64 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">Data Display</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm text-foreground leading-relaxed">
                      Choose which data to display in calendar cells.
                    </p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                      <li>
                        <strong>Backtest:</strong> Show only backtest/reported data
                      </li>
                      <li>
                        <strong>Actual:</strong> Show only actual/live trade data
                      </li>
                      <li>
                        <strong>Both:</strong> Show both data sources side by side
                      </li>
                    </ul>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <Select
            value={dataDisplayMode}
            onValueChange={(value) => setDataDisplayMode(value as DataDisplayMode)}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="backtest">Backtest</SelectItem>
              <SelectItem value="actual">Actual</SelectItem>
              <SelectItem value="both">Both</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
