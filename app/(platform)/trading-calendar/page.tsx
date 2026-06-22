"use client";

import { NoActiveBlock } from "@/components/no-active-block";
import { CalendarNavigation } from "@/components/trading-calendar/calendar-navigation";
import { CalendarView } from "@/components/trading-calendar/calendar-view";
import { DayView } from "@/components/trading-calendar/day-view";
import { EquityCurveChart } from "@/components/trading-calendar/equity-curve-chart";
import { MatchStrategiesDialog } from "@/components/trading-calendar/match-strategies-dialog";
import { StatsHeader } from "@/components/trading-calendar/stats-header";
import { TradeDetailView } from "@/components/trading-calendar/trade-detail-view";
import { Card, CardContent } from "@/components/ui/card";
import {
  useBlockStore,
  useTradingCalendarStore,
  type NavigationView,
} from "@tradeblocks/lib/stores";
import { Loader2 } from "lucide-react";
import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Wrapper component to handle Suspense boundary for useSearchParams
export default function TradingCalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TradingCalendarContent />
    </Suspense>
  );
}

function TradingCalendarContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeBlockId, blocks } = useBlockStore();
  const {
    isLoading,
    error,
    navigationView,
    selectedDate,
    selectedStrategy,
    loadCalendarData,
    reset,
    setNavigationFromUrl,
  } = useTradingCalendarStore();

  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [initialUrlApplied, setInitialUrlApplied] = useState(false);

  // Track whether we're updating from URL (to prevent sync loop)
  const isUpdatingFromUrl = useRef(false);

  const activeBlock = blocks.find((b) => b.id === activeBlockId);

  // Sync URL to store on initial load and URL changes
  useEffect(() => {
    const view = searchParams.get("view") as NavigationView | null;
    const date = searchParams.get("date");
    const strategy = searchParams.get("strategy");

    // Set flag to prevent store->URL sync from firing
    isUpdatingFromUrl.current = true;

    if (view && setNavigationFromUrl) {
      setNavigationFromUrl(view, date, strategy);
    } else if (setNavigationFromUrl) {
      // No view param means calendar view
      setNavigationFromUrl("calendar", null, null);
    }

    // Mark initial URL as applied after first render
    if (!initialUrlApplied) {
      setInitialUrlApplied(true);
    }

    // Reset flag after a tick to allow future store changes to sync to URL
    setTimeout(() => {
      isUpdatingFromUrl.current = false;
    }, 0);
  }, [searchParams, setNavigationFromUrl, initialUrlApplied]);

  // Sync store state to URL when navigation changes
  const syncUrlToState = useCallback(() => {
    // Don't sync if we're currently updating from URL (prevents loop)
    if (isUpdatingFromUrl.current) {
      return;
    }

    const params = new URLSearchParams();

    if (navigationView !== "calendar") {
      params.set("view", navigationView);
      if (selectedDate) {
        params.set("date", selectedDate);
      }
      if (navigationView === "trade" && selectedStrategy) {
        params.set("strategy", selectedStrategy);
      }
    }

    const newUrl = params.toString()
      ? `/trading-calendar?${params.toString()}`
      : "/trading-calendar";

    // Only update if URL actually changed
    const currentParams = searchParams.toString();
    if (params.toString() !== currentParams) {
      router.push(newUrl, { scroll: false });
    }
  }, [navigationView, selectedDate, selectedStrategy, router, searchParams]);

  // Update URL when store state changes (but not on initial load)
  useEffect(() => {
    if (initialUrlApplied) {
      syncUrlToState();
    }
  }, [navigationView, selectedDate, selectedStrategy, syncUrlToState, initialUrlApplied]);

  // Load calendar data when active block changes
  useEffect(() => {
    if (activeBlockId) {
      loadCalendarData(activeBlockId);
    } else {
      reset();
    }
  }, [activeBlockId, loadCalendarData, reset]);

  // No active block state
  if (!activeBlockId || !activeBlock) {
    return (
      <div className="p-6">
        <NoActiveBlock />
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="text-center text-destructive">
          <p>Failed to load calendar data</p>
          <p className="text-sm text-muted-foreground mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats header with metrics */}
      <StatsHeader onMatchStrategiesClick={() => setMatchDialogOpen(true)} />

      {/* Calendar card with navigation and content */}
      <Card>
        <CardContent className="space-y-6">
          {/* Navigation controls - date range, back button, view options */}
          <CalendarNavigation />

          {/* Main content area - switches based on navigation state */}
          <div className="min-h-[500px]">
            {navigationView === "calendar" && <CalendarView />}
            {navigationView === "day" && <DayView />}
            {navigationView === "trade" && <TradeDetailView />}
          </div>
        </CardContent>
      </Card>

      {/* Equity curve comparison chart - only show in calendar view when both data types exist */}
      {navigationView === "calendar" && <EquityCurveChart />}

      {/* Strategy matching dialog */}
      <MatchStrategiesDialog open={matchDialogOpen} onOpenChange={setMatchDialogOpen} />
    </div>
  );
}
