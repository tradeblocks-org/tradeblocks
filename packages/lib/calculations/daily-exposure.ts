/**
 * Daily exposure calculation using a time-aware sweep-line algorithm.
 *
 * Calculates the peak concurrent margin exposure for each day by tracking
 * when trades actually open and close (using timeOpened/timeClosed), not
 * just which calendar day they were active.
 *
 * This correctly handles intraday trading where trades open and close
 * sequentially - 7 sequential trades = 1× margin, not 7×.
 */

import type { Trade } from "../models/trade.ts";

/**
 * Daily exposure data point
 */
export interface DailyExposurePoint {
  date: string;
  exposure: number;
  exposurePercent: number;
  openPositions: number;
  /** Time of day when peak exposure occurred (HH:mm:ss) */
  peakTime?: string;
}

/**
 * Peak exposure data
 */
export interface PeakExposure {
  date: string;
  exposure: number;
  exposurePercent: number;
}

/**
 * Equity curve point for percentage calculations
 */
export interface EquityCurvePoint {
  date: string;
  equity: number;
}

/**
 * Result of daily exposure calculation
 */
export interface DailyExposureResult {
  dailyExposure: DailyExposurePoint[];
  peakDailyExposure: PeakExposure | null;
  peakDailyExposurePercent: PeakExposure | null;
}

/**
 * Get a finite number from a value, or undefined if not a finite number
 */
function getFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && isFinite(value)) {
    return value;
  }
  return undefined;
}

/**
 * Format a date to YYYY-MM-DD string using local time
 *
 * Trade dates in TradeBlocks are Eastern Time and parsed at local midnight.
 * Using local time methods (not toISOString/UTC) ensures dates match correctly.
 */
function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parse a time string (HH:mm:ss or HH:mm) to minutes since midnight
 * Returns 0 (midnight) for missing or malformed time strings
 */
function parseTimeToMinutes(timeStr: string | undefined): number {
  // Default to midnight when time is missing
  if (!timeStr) return 0;

  const parts = timeStr.split(":");
  // Require at least HH:mm format
  if (parts.length < 2) return 0;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);

  // Validate parsed values; fall back to midnight on malformed input
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  // Clamp to valid time range
  const safeHours = Math.max(0, Math.min(23, hours));
  const safeMinutes = Math.max(0, Math.min(59, minutes));

  return safeHours * 60 + safeMinutes;
}

/**
 * Format minutes since midnight to HH:mm:ss
 */
function formatMinutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:00`;
}

/** Internal event for tracking margin changes at specific times */
interface TimedEvent {
  dateKey: string;
  timeMinutes: number; // minutes since midnight
  type: "open" | "close";
  margin: number;
}

/**
 * Calculate daily exposure using a time-aware sweep-line algorithm.
 *
 * For each day, we track when trades open and close to find the peak
 * concurrent margin exposure at any moment during that day.
 *
 * @param trades - Array of trades to analyze
 * @param equityCurve - Array of equity curve points for percentage calculations
 * @returns Daily exposure time series and peak exposure points
 */
export function calculateDailyExposure(
  trades: Trade[],
  equityCurve: EquityCurvePoint[],
): DailyExposureResult {
  if (trades.length === 0) {
    return { dailyExposure: [], peakDailyExposure: null, peakDailyExposurePercent: null };
  }

  // Build a map of equity by date for percentage calculations
  const equityByDate = new Map<string, number>();
  for (const point of equityCurve) {
    const dateKey = point.date.slice(0, 10);
    equityByDate.set(dateKey, point.equity);
  }

  // Build timed events for each trade
  const events: TimedEvent[] = [];

  for (const trade of trades) {
    const margin = getFiniteNumber(trade.marginReq) ?? 0;
    if (margin <= 0) continue;

    const openDate = new Date(trade.dateOpened);
    if (isNaN(openDate.getTime())) continue;
    const openDateKey = formatDateKey(openDate);
    const openTimeMinutes = parseTimeToMinutes(trade.timeOpened);

    // Add open event
    events.push({
      dateKey: openDateKey,
      timeMinutes: openTimeMinutes,
      type: "open",
      margin,
    });

    // Add close event if trade is closed
    if (trade.dateClosed) {
      const closeDate = new Date(trade.dateClosed);
      if (!isNaN(closeDate.getTime())) {
        const closeDateKey = formatDateKey(closeDate);
        // Use timeClosed, default to end of day if not provided
        const closeTimeMinutes = trade.timeClosed
          ? parseTimeToMinutes(trade.timeClosed)
          : 23 * 60 + 59; // 23:59

        events.push({
          dateKey: closeDateKey,
          timeMinutes: closeTimeMinutes,
          type: "close",
          margin,
        });
      }
    }
    // If no close date, position stays open indefinitely (no close event)
  }

  if (events.length === 0) {
    return { dailyExposure: [], peakDailyExposure: null, peakDailyExposurePercent: null };
  }

  // Group events by date
  const eventsByDate = new Map<string, TimedEvent[]>();
  for (const event of events) {
    const existing = eventsByDate.get(event.dateKey) ?? [];
    existing.push(event);
    eventsByDate.set(event.dateKey, existing);
  }

  // Track running exposure across days (for multi-day positions)
  // We need to process days in order to carry forward open positions
  const allDates = Array.from(eventsByDate.keys()).sort();

  // Find the full date range including days between events
  const minDateKey = allDates[0];
  const maxDateKey = allDates[allDates.length - 1];

  const dailyExposure: DailyExposurePoint[] = [];
  let peakDailyExposure: PeakExposure | null = null;
  let peakDailyExposurePercent: PeakExposure | null = null;
  let lastKnownEquity = 0;

  // Track total exposure and position count carried over from previous days
  let carryOverExposure = 0;
  let carryOverPositions = 0;

  // Parse date keys at local midnight (matching how trade dates are parsed)
  const currentDate = new Date(minDateKey + "T00:00:00");
  const endDate = new Date(maxDateKey + "T00:00:00");

  while (currentDate <= endDate) {
    const dateKey = formatDateKey(currentDate);
    const dayEvents = eventsByDate.get(dateKey) ?? [];

    // Sort events by time, with opens before closes at same time
    // This ensures if a trade opens and closes at the exact same time,
    // we see the exposure momentarily
    dayEvents.sort((a, b) => {
      if (a.timeMinutes !== b.timeMinutes) {
        return a.timeMinutes - b.timeMinutes;
      }
      // At same time: opens before closes
      return a.type === "open" ? -1 : 1;
    });

    // Sweep through the day to find peak exposure
    let runningExposure = carryOverExposure;
    let runningPositions = carryOverPositions;
    let dayPeakExposure = runningExposure;
    let dayPeakPositions = runningPositions;
    // Default to midnight (00:00) for days with only carry-over exposure and no events
    let dayPeakTimeMinutes = 0;

    for (const event of dayEvents) {
      if (event.type === "open") {
        runningExposure += event.margin;
        runningPositions += 1;
      } else {
        runningExposure -= event.margin;
        runningPositions -= 1;
      }

      // Track peak
      if (runningExposure > dayPeakExposure) {
        dayPeakExposure = runningExposure;
        dayPeakPositions = runningPositions;
        dayPeakTimeMinutes = event.timeMinutes;
      }
    }

    // Update carry-over for next day
    carryOverExposure = runningExposure;
    carryOverPositions = runningPositions;

    // Get equity for percentage calculation
    const equity = equityByDate.get(dateKey) ?? lastKnownEquity;
    if (equity > 0) lastKnownEquity = equity;

    const exposurePercent = equity > 0 ? (dayPeakExposure / equity) * 100 : 0;

    // Only include days with exposure
    if (dayPeakExposure > 0) {
      const point: DailyExposurePoint = {
        date: currentDate.toISOString(),
        exposure: dayPeakExposure,
        exposurePercent,
        openPositions: dayPeakPositions,
        peakTime: formatMinutesToTime(dayPeakTimeMinutes),
      };
      dailyExposure.push(point);

      // Track overall peak exposure (by dollar amount)
      if (!peakDailyExposure || dayPeakExposure > peakDailyExposure.exposure) {
        peakDailyExposure = {
          date: currentDate.toISOString(),
          exposure: dayPeakExposure,
          exposurePercent,
        };
      }

      // Track overall peak exposure (by percentage)
      if (!peakDailyExposurePercent || exposurePercent > peakDailyExposurePercent.exposurePercent) {
        peakDailyExposurePercent = {
          date: currentDate.toISOString(),
          exposure: dayPeakExposure,
          exposurePercent,
        };
      }
    }

    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return { dailyExposure, peakDailyExposure, peakDailyExposurePercent };
}

/**
 * Exposure at the moment a trade opens
 */
export interface ExposureAtOpen {
  /** Trade index in the original array */
  tradeIndex: number;
  /** Exposure in dollars at the moment this trade opened (before adding this trade's margin) */
  exposureBefore: number;
  /** Exposure in dollars at the moment this trade opened (after adding this trade's margin) */
  exposureAfter: number;
  /** Exposure as % of equity at the moment this trade opened (before adding this trade's margin) */
  exposurePercentBefore: number;
  /** Exposure as % of equity at the moment this trade opened (after adding this trade's margin) */
  exposurePercentAfter: number;
}

/**
 * Calculate the portfolio exposure at the exact moment each trade opens.
 *
 * This uses a sweep-line algorithm to track running exposure through time,
 * then queries the exposure state at each trade's specific open timestamp.
 *
 * @param trades - Array of trades to analyze
 * @param equityCurve - Array of equity curve points for percentage calculations
 * @returns Map from trade index to exposure data at that trade's open time
 */
export function calculateExposureAtTradeOpen(
  trades: Trade[],
  equityCurve: EquityCurvePoint[],
): Map<number, ExposureAtOpen> {
  const result = new Map<number, ExposureAtOpen>();

  if (trades.length === 0) {
    return result;
  }

  // Build equity lookup by date
  const equityByDate = new Map<string, number>();
  for (const point of equityCurve) {
    const dateKey = point.date.slice(0, 10);
    equityByDate.set(dateKey, point.equity);
  }

  // Create timestamped events for all trades
  // Each event has: timestamp (ms), type, margin, and optionally tradeIndex for opens
  interface TimestampedEvent {
    timestamp: number;
    dateKey: string;
    timeMinutes: number;
    type: "open" | "close";
    margin: number;
    tradeIndex?: number; // Only set for 'open' events
  }

  const events: TimestampedEvent[] = [];

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const margin = getFiniteNumber(trade.marginReq) ?? 0;
    if (margin <= 0) continue;

    const openDate = new Date(trade.dateOpened);
    if (isNaN(openDate.getTime())) continue;

    const openDateKey = formatDateKey(openDate);
    const openTimeMinutes = parseTimeToMinutes(trade.timeOpened);

    // Create full timestamp for sorting
    const openTimestamp = openDate.getTime() + openTimeMinutes * 60 * 1000;

    // Add open event with trade index
    events.push({
      timestamp: openTimestamp,
      dateKey: openDateKey,
      timeMinutes: openTimeMinutes,
      type: "open",
      margin,
      tradeIndex: i,
    });

    // Add close event if trade is closed
    if (trade.dateClosed) {
      const closeDate = new Date(trade.dateClosed);
      if (!isNaN(closeDate.getTime())) {
        const closeDateKey = formatDateKey(closeDate);
        const closeTimeMinutes = trade.timeClosed
          ? parseTimeToMinutes(trade.timeClosed)
          : 23 * 60 + 59;

        const closeTimestamp = closeDate.getTime() + closeTimeMinutes * 60 * 1000;

        events.push({
          timestamp: closeTimestamp,
          dateKey: closeDateKey,
          timeMinutes: closeTimeMinutes,
          type: "close",
          margin,
        });
      }
    }
  }

  if (events.length === 0) {
    return result;
  }

  // Sort events by timestamp, with closes before opens at same time
  // This ensures when we process an open, all prior closes have been applied
  events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    // At same timestamp: closes before opens
    // This way when we process an open, all prior closes have been applied
    if (a.type !== b.type) {
      return a.type === "close" ? -1 : 1;
    }
    return 0;
  });

  // Sweep through events tracking running exposure
  let runningExposure = 0;
  let lastKnownEquity = 0;

  for (const event of events) {
    // Get equity for this date
    const equity = equityByDate.get(event.dateKey) ?? lastKnownEquity;
    if (equity > 0) lastKnownEquity = equity;

    if (event.type === "open" && event.tradeIndex !== undefined) {
      // Record exposure BEFORE and AFTER adding this trade
      const exposureBefore = runningExposure;
      const exposureAfter = runningExposure + event.margin;

      const exposurePercentBefore = equity > 0 ? (exposureBefore / equity) * 100 : 0;
      const exposurePercentAfter = equity > 0 ? (exposureAfter / equity) * 100 : 0;

      result.set(event.tradeIndex, {
        tradeIndex: event.tradeIndex,
        exposureBefore,
        exposureAfter,
        exposurePercentBefore,
        exposurePercentAfter,
      });

      // Update running exposure
      runningExposure = exposureAfter;
    } else if (event.type === "close") {
      runningExposure -= event.margin;
    } else if (event.type === "open") {
      // Open event without tradeIndex (shouldn't happen, but handle gracefully)
      runningExposure += event.margin;
    }
  }

  return result;
}
