/**
 * Branded types for percentage values to prevent unit confusion at compile time.
 *
 * The codebase has two conventions for percentage values:
 * - DECIMAL (0-1): e.g., 0.12 = 12% - used by Monte Carlo, probability values
 * - PERCENTAGE (0-100): e.g., 12 = 12% - used by legacy Portfolio Stats
 *
 * These branded types help catch mismatches at compile time when TypeScript
 * strict mode is enabled. The brands are erased at runtime (zero overhead).
 *
 * @example
 * ```typescript
 * // Type-safe conversion
 * const mcDrawdown: Decimal01 = asDecimal01(0.12)
 * const displayValue: Percentage = toPercentage(mcDrawdown) // 12
 *
 * // Will show type error if units mismatch
 * const wrong = mcDrawdown / portfolioDrawdown // Type mismatch!
 * const right = mcDrawdown / toDecimal(portfolioDrawdown) // OK
 * ```
 */

// Branded type for decimal values (0 to 1, e.g., 0.12 = 12%)
declare const DecimalBrand: unique symbol;
export type Decimal01 = number & { readonly [DecimalBrand]: void };

// Branded type for percentage values (0 to 100, e.g., 12 = 12%)
declare const PercentageBrand: unique symbol;
export type Percentage = number & { readonly [PercentageBrand]: void };

/**
 * Convert a decimal value (0-1) to percentage (0-100).
 *
 * @param decimal - Value in decimal form (e.g., 0.12)
 * @returns Value in percentage form (e.g., 12)
 *
 * @example
 * const pct = toPercentage(asDecimal01(0.12)) // 12
 */
export function toPercentage(decimal: Decimal01): Percentage {
  return (decimal * 100) as Percentage;
}

/**
 * Convert a percentage value (0-100) to decimal (0-1).
 *
 * @param percentage - Value in percentage form (e.g., 12)
 * @returns Value in decimal form (e.g., 0.12)
 *
 * @example
 * const dec = toDecimal(asPercentage(12)) // 0.12
 */
export function toDecimal(percentage: Percentage): Decimal01 {
  return (percentage / 100) as Decimal01;
}

/**
 * Cast a number to Decimal01 type.
 * Logs a warning if the value is outside the expected 0-1 range.
 *
 * Use this when you have a number that you know represents a decimal percentage
 * (e.g., from Monte Carlo simulation results).
 *
 * @param value - A number expected to be in 0-1 range
 * @returns The same value cast as Decimal01
 *
 * @example
 * const mcDrawdown = asDecimal01(result.medianMaxDrawdown)
 */
export function asDecimal01(value: number): Decimal01 {
  if (process.env.NODE_ENV !== "production" && (value < -0.001 || value > 1.001)) {
    console.warn(
      `[percentage] Value ${value} outside expected decimal range 0-1. ` +
        `Did you pass a percentage instead of a decimal?`,
    );
  }
  return value as Decimal01;
}

/**
 * Cast a number to Percentage type.
 * Logs a warning if the value is outside the expected 0-100 range.
 *
 * Use this when you have a number that you know represents a percentage
 * (e.g., from Portfolio Stats results).
 *
 * @param value - A number expected to be in 0-100 range
 * @returns The same value cast as Percentage
 *
 * @example
 * const portfolioDrawdown = asPercentage(stats.maxDrawdown)
 */
export function asPercentage(value: number): Percentage {
  if (process.env.NODE_ENV !== "production" && (value < -0.1 || value > 100.1)) {
    console.warn(
      `[percentage] Value ${value} outside expected percentage range 0-100. ` +
        `Did you pass a decimal instead of a percentage?`,
    );
  }
  return value as Percentage;
}

/**
 * Format a decimal (0-1) value as a display string with % sign.
 *
 * @param decimal - Value in decimal form
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string like "12.34%"
 *
 * @example
 * formatDecimalAsPercent(asDecimal01(0.1234)) // "12.34%"
 */
export function formatDecimalAsPercent(decimal: Decimal01, decimals = 2): string {
  return `${(decimal * 100).toFixed(decimals)}%`;
}

/**
 * Format a percentage (0-100) value as a display string with % sign.
 *
 * @param percentage - Value in percentage form
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string like "12.34%"
 *
 * @example
 * formatPercentage(asPercentage(12.34)) // "12.34%"
 */
export function formatPercentage(percentage: Percentage, decimals = 2): string {
  return `${percentage.toFixed(decimals)}%`;
}

/**
 * Check if a value looks like it's in decimal form (0-1) rather than percentage form.
 * Useful for runtime validation when unit is ambiguous.
 *
 * @param value - Value to check
 * @returns true if value is between -0.01 and 1.01
 */
export function looksLikeDecimal(value: number): boolean {
  return value >= -0.01 && value <= 1.01;
}

/**
 * Check if a value looks like it's in percentage form (0-100) rather than decimal form.
 * Useful for runtime validation when unit is ambiguous.
 *
 * @param value - Value to check
 * @returns true if value is outside the 0-1 range but within 0-100
 */
export function looksLikePercentage(value: number): boolean {
  return value > 1.01 && value <= 100.1;
}
