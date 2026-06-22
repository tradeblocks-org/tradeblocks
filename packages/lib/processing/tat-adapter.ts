/**
 * TAT (Trade Automation Toolbox) CSV Adapter
 *
 * Converts TAT CSV export rows into ReportingTrade objects.
 * TAT is used for live execution of options strategies (primarily double calendars).
 * This adapter allows comparing TAT execution results against Option Omega backtests
 * using the existing Trading Calendar comparison infrastructure.
 *
 * TAT CSV columns (key fields):
 *   Strategy, OpenDate, OpenTime, CloseDate, CloseTime, PriceOpen, PriceClose,
 *   TotalPremium, Qty, ContractCount, ProfitLoss, Commission, Status,
 *   ShortPut, LongPut, ShortCall, LongCall, UnderlyingSymbol, TradeType, TradeID
 *
 * Key mapping differences from OO:
 *   - strategy ← Template (not Strategy, which is a user-defined grouping in TAT)
 *   - openingPrice: TAT does not report underlying price level (always 0)
 *   - initialPremium ← TotalPremium / Qty (per-spread, matching OO semantics)
 *   - numContracts ← Qty (spreads), NOT ContractCount (total legs)
 */

import type { ReportingTrade } from "../models/reporting-trade.ts";

/**
 * TAT-specific required headers for format detection.
 * All three must be present (case-insensitive) to identify a TAT export.
 */
const TAT_SIGNATURE_HEADERS = ["tradeid", "profitloss", "buyingpower"];

/**
 * Detect whether CSV headers indicate a TAT export.
 */
export function isTatFormat(headers: string[]): boolean {
  const lower = headers.map((h) => h.toLowerCase().trim());
  return TAT_SIGNATURE_HEADERS.every((sig) => lower.includes(sig));
}

/**
 * Parse a date string preserving the calendar day.
 * Handles both YYYY-MM-DD (precise) and M/D/YYYY (display) formats.
 * Creates Date at local midnight to avoid timezone shifting.
 */
function parseTatDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.trim() === "") return null;

  // Try YYYY-MM-DD first (OpenDate/CloseDate format)
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  // Try M/D/YYYY (Date field format)
  const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  return null;
}

/**
 * Format a 24-hour time string (HH:MM:SS) to 12-hour format (H:MM AM/PM).
 * Also accepts already-formatted "H:MM AM/PM" strings and passes them through.
 */
function formatTatTime(timeStr: string): string | undefined {
  if (!timeStr || timeStr.trim() === "") return undefined;

  // Already in AM/PM format? Pass through.
  if (/[AP]M$/i.test(timeStr.trim())) return timeStr.trim();

  // Parse 24-hour format: HH:MM or HH:MM:SS
  const match = timeStr.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return undefined;

  const hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;

  return `${displayHours}:${minutes} ${period}`;
}

/**
 * Build a human-readable legs string from TAT strike columns.
 *
 * Format: "SPX 6905P/7125C | 6905P/7125C DC"
 *         (short legs)      (long legs)   (trade type)
 *
 * The " | " separator is required for compatibility with the LegsRow UI
 * component which splits on it.
 */
export function buildTatLegsString(row: Record<string, string>): string {
  const symbol = (row.UnderlyingSymbol || "").trim();
  const tradeType = (row.TradeType || "").trim();
  const shortPut = (row.ShortPut || "").trim();
  const shortCall = (row.ShortCall || "").trim();
  const longPut = (row.LongPut || "").trim();
  const longCall = (row.LongCall || "").trim();

  const isPresent = (v: string) => v !== "" && v !== "0";

  // Build short leg description
  const shortParts: string[] = [];
  if (isPresent(shortPut)) shortParts.push(`${shortPut}P`);
  if (isPresent(shortCall)) shortParts.push(`${shortCall}C`);
  const shortLeg = shortParts.join("/");

  // Build long leg description
  const longParts: string[] = [];
  if (isPresent(longPut)) longParts.push(`${longPut}P`);
  if (isPresent(longCall)) longParts.push(`${longCall}C`);
  const longLeg = longParts.join("/");

  // Combine with symbol prefix and trade type suffix
  const prefix = symbol ? `${symbol} ` : "";
  const suffix = tradeType ? ` ${tradeType}` : "";

  if (shortLeg && longLeg) {
    return `${prefix}${shortLeg} | ${longLeg}${suffix}`;
  }
  if (shortLeg) return `${prefix}${shortLeg}${suffix}`;
  if (longLeg) return `${prefix}${longLeg}${suffix}`;

  return tradeType || "Unknown";
}

/**
 * Parse a numeric value from a TAT CSV field.
 * Handles empty strings, whitespace, NaN.
 */
function parseNumber(value: string | undefined, defaultValue?: number): number {
  if (!value || value.trim() === "" || value.toLowerCase() === "nan") {
    return defaultValue ?? 0;
  }
  const cleaned = value.replace(/[$,%]/g, "").trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? (defaultValue ?? 0) : parsed;
}

/**
 * Convert a single TAT CSV row to a ReportingTrade object.
 * Returns null if the row is missing required data (date or P/L).
 */
/**
 * Normalize row keys to canonical PascalCase used by TAT exports.
 * This allows conversion to work even if CSV headers have different casing.
 */
function normalizeRowKeys(row: Record<string, string>): Record<string, string> {
  const keyMap: Record<string, string> = {};
  for (const key of Object.keys(row)) {
    keyMap[key.toLowerCase()] = key;
  }

  const canonicalKeys = [
    "OpenDate",
    "Date",
    "CloseDate",
    "OpenTime",
    "CloseTime",
    "TimeOpened",
    "TimeClosed",
    "ProfitLoss",
    "PriceOpen",
    "PriceClose",
    "TotalPremium",
    "Qty",
    "Strategy",
    "Template",
    "Status",
    "UnderlyingSymbol",
    "TradeType",
    "ShortPut",
    "ShortCall",
    "LongPut",
    "LongCall",
  ];

  const normalized: Record<string, string> = { ...row };
  for (const canonical of canonicalKeys) {
    if (!(canonical in normalized)) {
      const actual = keyMap[canonical.toLowerCase()];
      if (actual) normalized[canonical] = row[actual];
    }
  }
  return normalized;
}

export function convertTatRowToReportingTrade(row: Record<string, string>): ReportingTrade | null {
  // Normalize keys so conversion works regardless of CSV header casing
  row = normalizeRowKeys(row);

  // Parse date: prefer OpenDate, fall back to Date
  const dateOpened = parseTatDate(row.OpenDate) ?? parseTatDate(row.Date);
  if (!dateOpened || isNaN(dateOpened.getTime())) return null;

  // P/L is required
  const plStr = (row.ProfitLoss || "").trim();
  if (!plStr) return null;

  // Parse closing date: prefer CloseDate, fall back to parsing TimeClosed date
  const dateClosed = parseTatDate(row.CloseDate) ?? undefined;

  // Parse times: prefer precise OpenTime/CloseTime, fall back to TimeOpened/TimeClosed
  const timeOpened = formatTatTime(row.OpenTime) ?? formatTatTime(row.TimeOpened);
  const timeClosed = formatTatTime(row.CloseTime) ?? formatTatTime(row.TimeClosed);

  const legs = buildTatLegsString(row);

  const qty = parseNumber(row.Qty, 1);

  return {
    // Template = strategy name (matches OO's Strategy); Strategy = user-defined grouping
    strategy: (row.Template || row.Strategy || "").trim() || "Unknown",
    dateOpened,
    timeOpened,
    openingPrice: 0, // OO reports underlying price level; TAT does not provide this
    legs,
    initialPremium: qty !== 0 ? parseNumber(row.TotalPremium) / qty : parseNumber(row.TotalPremium), // Per-spread premium (matches OO semantics)
    numContracts: qty, // Qty = spreads (matches OO semantics)
    pl: parseNumber(row.ProfitLoss),
    closingPrice: row.PriceClose ? parseNumber(row.PriceClose) : undefined,
    dateClosed,
    timeClosed,
    reasonForClose: (row.Status || "").trim() || undefined,
  };
}
