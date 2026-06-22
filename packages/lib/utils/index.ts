/**
 * Utility functions exports
 */

// Legacy UI utilities (from old utils.ts)
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Truncates a strategy name to a maximum length with ellipsis.
 *
 * @param strategyName - The full strategy name
 * @param maxLength - Maximum character length (default: 40)
 * @returns Truncated strategy name with ellipsis if needed
 *
 * @example
 * truncateStrategyName("move downic super long description...", 40)
 * // Returns: "move downic super long description th..."
 */
export function truncateStrategyName(strategyName: string, maxLength: number = 40): string {
  if (!strategyName || strategyName.length <= maxLength) {
    return strategyName;
  }
  return `${strategyName.substring(0, maxLength)}...`;
}

// Core utility modules
export * from "./equity-curve.ts";
export * from "./risk-free-rate.ts";
export * from "./time-conversions.ts";
export * from "./time-formatting.ts";
export * from "./csv-headers.ts";
export * from "./export-helpers.ts";
export * from "./async-helpers.ts";
export * from "./combine-leg-groups.ts";
export * from "./performance-export.ts";
export * from "./trade-normalization.ts";
export * from "./trade-frequency.ts";
export * from "./performance-helpers.ts";
export * from "./quote-anomaly.ts";
