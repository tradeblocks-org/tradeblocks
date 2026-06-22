/**
 * Time and Date Formatting Utilities
 *
 * Utilities for formatting time-of-day values (minutes since midnight),
 * day-of-week, month, and hour values as readable labels for charts.
 */

// Day of week labels - index matches JavaScript getDay() (0 = Sunday)
export const DAY_OF_WEEK_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DAY_OF_WEEK_LABELS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Month labels - index 0-11 matches JavaScript getMonth()
export const MONTH_LABELS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export const MONTH_LABELS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Format day of week number (0-6) as readable label
 * @param dayOfWeek - Day of week (0 = Sunday, 6 = Saturday) from JavaScript getDay()
 * @param short - Use short form (Mon) vs full form (Monday)
 * @returns Day name or undefined if invalid
 */
export function formatDayOfWeek(dayOfWeek: number, short = true): string | undefined {
  if (dayOfWeek < 0 || dayOfWeek > 6) return undefined;
  return short ? DAY_OF_WEEK_LABELS_SHORT[dayOfWeek] : DAY_OF_WEEK_LABELS_FULL[dayOfWeek];
}

/**
 * Format month number (1-12) as readable label
 * Note: This uses 1-indexed months (1 = January) as used in EnrichedTrade.monthOfYear
 * @param monthOfYear - Month (1 = January, 12 = December)
 * @param short - Use short form (Jan) vs full form (January)
 * @returns Month name or undefined if invalid
 */
export function formatMonthOfYear(monthOfYear: number, short = true): string | undefined {
  if (monthOfYear < 1 || monthOfYear > 12) return undefined;
  return short ? MONTH_LABELS_SHORT[monthOfYear - 1] : MONTH_LABELS_FULL[monthOfYear - 1];
}

/**
 * Format hour of day (0-23) as readable label (e.g., "9am", "12pm", "3pm")
 * @param hourOfDay - Hour (0 = midnight, 23 = 11pm)
 * @returns Formatted hour string or undefined if invalid
 */
export function formatHourOfDay(hourOfDay: number): string | undefined {
  if (hourOfDay < 0 || hourOfDay > 23) return undefined;
  if (hourOfDay === 0) return "12am";
  if (hourOfDay === 12) return "12pm";
  if (hourOfDay < 12) return `${hourOfDay}am`;
  return `${hourOfDay - 12}pm`;
}

/**
 * Check if a field represents a discrete timing field with fixed buckets
 * (as opposed to continuous numeric values)
 */
export function isDiscreteTimingField(field: string): boolean {
  return field === "dayOfWeek" || field === "monthOfYear" || field === "hourOfDay";
}

/**
 * Get appropriate timing label for a field value
 * @param field - The field name (dayOfWeek, monthOfYear, hourOfDay)
 * @param value - The numeric value
 * @returns Human-readable label or null if not a timing field
 */
export function getTimingLabel(field: string, value: number): string | null {
  if (field === "dayOfWeek") {
    return formatDayOfWeek(value) ?? null;
  }
  if (field === "monthOfYear") {
    return formatMonthOfYear(value) ?? null;
  }
  if (field === "hourOfDay") {
    return formatHourOfDay(value) ?? null;
  }
  return null;
}

/**
 * Format minutes since midnight as readable time (e.g., "11:45 AM ET")
 *
 * @param minutes - Minutes since midnight (0-1439)
 * @param includeTimezone - Whether to include "ET" suffix (default: true)
 * @returns Formatted time string like "11:45 AM ET"
 */
export function formatMinutesToTime(minutes: number, includeTimezone = true): string {
  // Handle wrap-around: normalize to [0, 1440) for both negative and overflow values
  const normalizedMinutes = ((minutes % 1440) + 1440) % 1440;
  // Round first, then extract hours/mins to avoid "10:60" edge case
  const totalMinutesRounded = Math.round(normalizedMinutes);
  const hours = Math.floor(totalMinutesRounded / 60);
  const mins = totalMinutesRounded % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  const time = `${displayHours}:${mins.toString().padStart(2, "0")} ${period}`;
  return includeTimezone ? `${time} ET` : time;
}

/**
 * Generate tick values and labels for time of day axis (every hour)
 *
 * @param min - Minimum time in minutes
 * @param max - Maximum time in minutes
 * @param includeTimezone - Whether to include "ET" suffix in labels (default: true)
 * @returns Object with tickvals (numbers) and ticktext (formatted strings)
 */
export function generateTimeAxisTicks(
  min: number,
  max: number,
  includeTimezone = true,
): { tickvals: number[]; ticktext: string[] } {
  const tickvals: number[] = [];
  const ticktext: string[] = [];

  // Start at the first full hour at or after min
  const startHour = Math.ceil(min / 60);
  const endHour = Math.floor(max / 60);

  for (let hour = startHour; hour <= endHour; hour++) {
    const minutes = hour * 60;
    tickvals.push(minutes);
    ticktext.push(formatMinutesToTime(minutes, includeTimezone));
  }

  return { tickvals, ticktext };
}

/**
 * Generate time axis ticks from an array of time values.
 * Convenience wrapper that computes min/max from data and generates ticks.
 *
 * @param values - Array of time values in minutes since midnight
 * @param includeTimezone - Whether to include "ET" suffix in labels (default: true)
 * @returns Object with tickvals and ticktext, or null if values is empty
 */
export function generateTimeAxisTicksFromData(
  values: number[],
  includeTimezone = true,
): { tickvals: number[]; ticktext: string[] } | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return generateTimeAxisTicks(min, max, includeTimezone);
}

/**
 * Generate tick values for time axis at larger intervals (e.g., every 2 hours)
 * Useful for charts with limited horizontal space
 *
 * @param min - Minimum time in minutes
 * @param max - Maximum time in minutes
 * @param intervalHours - Hours between ticks (default: 2)
 * @param includeTimezone - Whether to include "ET" suffix in labels (default: false for compact display)
 * @returns Object with tickvals (numbers) and ticktext (formatted strings)
 */
export function generateTimeAxisTicksWithInterval(
  min: number,
  max: number,
  intervalHours = 2,
  includeTimezone = false,
): { tickvals: number[]; ticktext: string[] } {
  const tickvals: number[] = [];
  const ticktext: string[] = [];

  // Normalize min to handle negative values, then find the nearest interval mark
  const normalizedMin = Math.max(0, min);
  const intervalMinutes = intervalHours * 60;
  const startHour = Math.floor(normalizedMin / intervalMinutes) * intervalHours;
  const endHour = Math.floor(max / 60);

  for (let hour = startHour; hour <= endHour; hour += intervalHours) {
    const minutes = hour * 60;
    if (minutes >= min && minutes <= max) {
      tickvals.push(minutes);
      ticktext.push(formatMinutesToTime(minutes, includeTimezone));
    }
  }

  return { tickvals, ticktext };
}
