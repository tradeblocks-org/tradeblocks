/**
 * Regime definitions for the Custom Report Builder
 *
 * Regimes allow users to define custom thresholds for filtering trades
 * by market conditions (VIX levels, SLR bands, time of day, etc.)
 */

/**
 * Supported field types for regime filtering
 * Each type determines the UI component and validation logic
 */
export type RegimeFieldType =
  | "numeric_threshold" // For VIX, SLR, gap, excursion metrics
  | "time_of_day" // For timeOpened buckets
  | "day_of_week"; // For day of week filtering

/**
 * Available trade fields that can be used for regime filtering
 */
export type RegimeSourceField =
  // Direct trade fields
  | "openingVix"
  | "closingVix"
  | "openingShortLongRatio"
  | "closingShortLongRatio"
  | "gap"
  | "movement"
  // Time-based fields
  | "timeOpened"
  | "dayOfWeek"
  // Derived fields (computed at analysis time)
  | "durationHours"
  | "mfePercent"
  | "maePercent"
  | "profitCapturePercent"
  | "excursionRatio";

/**
 * Human-readable labels for source fields
 */
export const REGIME_FIELD_LABELS: Record<RegimeSourceField, string> = {
  openingVix: "Opening VIX",
  closingVix: "Closing VIX",
  openingShortLongRatio: "Opening S/L Ratio",
  closingShortLongRatio: "Closing S/L Ratio",
  gap: "Gap %",
  movement: "Movement",
  timeOpened: "Time of Day",
  dayOfWeek: "Day of Week",
  durationHours: "Duration (Hours)",
  mfePercent: "MFE %",
  maePercent: "MAE %",
  profitCapturePercent: "Profit Capture %",
  excursionRatio: "Excursion Ratio",
};

/**
 * Field type mapping for each source field
 */
export const REGIME_FIELD_TYPES: Record<RegimeSourceField, RegimeFieldType> = {
  openingVix: "numeric_threshold",
  closingVix: "numeric_threshold",
  openingShortLongRatio: "numeric_threshold",
  closingShortLongRatio: "numeric_threshold",
  gap: "numeric_threshold",
  movement: "numeric_threshold",
  timeOpened: "time_of_day",
  dayOfWeek: "day_of_week",
  durationHours: "numeric_threshold",
  mfePercent: "numeric_threshold",
  maePercent: "numeric_threshold",
  profitCapturePercent: "numeric_threshold",
  excursionRatio: "numeric_threshold",
};

/**
 * Base interface for all regime bucket definitions
 */
export interface RegimeBucketBase {
  id: string; // UUID for unique identification
  name: string; // Display label (e.g., "Low VIX", "Morning Session")
  color?: string; // Optional color for charts (hex code)
}

/**
 * Numeric threshold bucket (for VIX, SLR, gap, etc.)
 * Supports open-ended ranges via null min/max
 */
export interface NumericThresholdBucket extends RegimeBucketBase {
  type: "numeric_threshold";
  min: number | null; // null = negative infinity
  max: number | null; // null = positive infinity
}

/**
 * Time of day bucket for trading session analysis
 * Times are in HH:mm format (24-hour)
 */
export interface TimeOfDayBucket extends RegimeBucketBase {
  type: "time_of_day";
  startTime: string; // HH:mm format (24-hour)
  endTime: string; // HH:mm format (24-hour)
}

/**
 * Day of week bucket for weekly pattern analysis
 */
export interface DayOfWeekBucket extends RegimeBucketBase {
  type: "day_of_week";
  days: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
}

/**
 * Union type for all bucket types
 */
export type RegimeBucket = NumericThresholdBucket | TimeOfDayBucket | DayOfWeekBucket;

/**
 * Core regime definition that users create and manage
 */
export interface RegimeDefinition {
  id: string; // UUID
  name: string; // User-defined name (e.g., "VIX Regimes")
  description?: string; // Optional description
  sourceField: RegimeSourceField; // Which trade field to analyze
  fieldType: RegimeFieldType; // Determines bucket type and UI
  buckets: RegimeBucket[]; // Ordered list of buckets
  isBuiltIn: boolean; // true for system defaults (non-deletable)
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

/**
 * Filter criterion for selecting specific buckets within a regime
 */
export interface RegimeFilterCriterion {
  regimeId: string;
  selectedBucketIds: string[]; // Empty = all buckets selected (no filter)
  enabled: boolean;
}

/**
 * Complete filter configuration combining multiple regime criteria
 * All enabled criteria are combined with AND logic
 */
export interface RegimeFilterConfig {
  name?: string;
  criteria: RegimeFilterCriterion[];
}

/**
 * Preset report configuration
 */
export interface ReportPreset {
  id: string;
  name: string;
  description: string;
  filter: RegimeFilterConfig;
  visualization: "comparison" | "distribution" | "scatter" | "breakdown";
  isBuiltIn: boolean;
}

/**
 * Day of week constants
 */
export const DAY_OF_WEEK_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

/**
 * Helper to create a numeric threshold bucket
 */
export function createNumericBucket(
  name: string,
  min: number | null,
  max: number | null,
  color?: string,
): NumericThresholdBucket {
  return {
    id: crypto.randomUUID(),
    name,
    type: "numeric_threshold",
    min,
    max,
    color,
  };
}

/**
 * Helper to create a time of day bucket
 */
export function createTimeOfDayBucket(
  name: string,
  startTime: string,
  endTime: string,
  color?: string,
): TimeOfDayBucket {
  return {
    id: crypto.randomUUID(),
    name,
    type: "time_of_day",
    startTime,
    endTime,
    color,
  };
}

/**
 * Helper to create a day of week bucket
 */
export function createDayOfWeekBucket(
  name: string,
  days: number[],
  color?: string,
): DayOfWeekBucket {
  return {
    id: crypto.randomUUID(),
    name,
    type: "day_of_week",
    days,
    color,
  };
}

/**
 * Validate numeric bucket ranges for overlaps
 */
export function validateNumericBuckets(buckets: NumericThresholdBucket[]): string[] {
  const errors: string[] = [];

  // Sort by min value for overlap detection
  const sorted = [...buckets].sort((a, b) => {
    const aMin = a.min ?? -Infinity;
    const bMin = b.min ?? -Infinity;
    return aMin - bMin;
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    const currentMax = current.max ?? Infinity;
    const nextMin = next.min ?? -Infinity;

    if (currentMax > nextMin) {
      errors.push(`Buckets "${current.name}" and "${next.name}" have overlapping ranges`);
    }
  }

  return errors;
}

/**
 * Validate time of day buckets
 */
export function validateTimeOfDayBuckets(buckets: TimeOfDayBucket[]): string[] {
  const errors: string[] = [];

  buckets.forEach((bucket) => {
    const [startH, startM] = bucket.startTime.split(":").map(Number);
    const [endH, endM] = bucket.endTime.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes >= endMinutes) {
      errors.push(`Bucket "${bucket.name}" has invalid time range (start >= end)`);
    }
  });

  return errors;
}

/**
 * Validate a complete regime definition
 */
export function validateRegimeDefinition(regime: RegimeDefinition): string[] {
  const errors: string[] = [];

  if (!regime.name.trim()) {
    errors.push("Regime name is required");
  }

  if (regime.buckets.length === 0) {
    errors.push("At least one bucket is required");
  }

  if (regime.fieldType === "numeric_threshold") {
    const numericBuckets = regime.buckets.filter(
      (b): b is NumericThresholdBucket => b.type === "numeric_threshold",
    );
    errors.push(...validateNumericBuckets(numericBuckets));
  } else if (regime.fieldType === "time_of_day") {
    const timeBuckets = regime.buckets.filter(
      (b): b is TimeOfDayBucket => b.type === "time_of_day",
    );
    errors.push(...validateTimeOfDayBuckets(timeBuckets));
  }

  return errors;
}
