"use client";

import { getEffectiveRateDate, loadBrowserPublishedRates } from "@tradeblocks/lib";
import { usePerformanceStore, useTradingCalendarStore } from "@tradeblocks/lib/stores";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

const SETTING = "tradeblocks:published-rates-enabled";
interface PublishedRatesState {
  through: string;
  revision: number;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}
const RatesContext = createContext<PublishedRatesState | null>(null);

export function PublishedRatesProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [through, setThrough] = useState(() => getEffectiveRateDate("DTB3"));
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setEnabledState(window.localStorage.getItem(SETTING) !== "false");
  }, []);

  useEffect(() => {
    if (enabled === null) return;
    const controller = new AbortController();
    loadBrowserPublishedRates(enabled, controller.signal)
      .then(async () => {
        if (controller.signal.aborted) return;
        setThrough(getEffectiveRateDate("DTB3"));
        setRevision((value) => value + 1);
        const performance = usePerformanceStore.getState();
        if (performance.data) await performance.applyFilters();
        const calendar = useTradingCalendarStore.getState();
        if (calendar.performanceStats) calendar.setScalingMode(calendar.scalingMode);
      })
      .catch((error) =>
        console.error("Could not recalculate metrics with current risk-free rates:", error),
      );
    return () => controller.abort();
  }, [enabled]);

  const setEnabled = useCallback((value: boolean) => {
    window.localStorage.setItem(SETTING, String(value));
    setEnabledState(value);
  }, []);

  return (
    <RatesContext.Provider value={{ through, revision, enabled: enabled ?? true, setEnabled }}>
      {children}
    </RatesContext.Provider>
  );
}

export function usePublishedRates(): PublishedRatesState {
  const state = useContext(RatesContext);
  if (!state) throw new Error("usePublishedRates requires PublishedRatesProvider");
  return state;
}
