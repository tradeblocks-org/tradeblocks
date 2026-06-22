/**
 * Output Formatter
 *
 * Utilities for formatting MCP tool output.
 *
 * JSON-First Pattern:
 * Tools return structured JSON as the primary format. JSON is machine-readable,
 * enabling reliable data extraction without parsing natural language.
 *
 * A brief text summary is included for user visibility, but the JSON
 * is the authoritative source for all data and reasoning.
 */

/**
 * MCP content item types
 */
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType: string;
    text: string;
  };
}

export type McpContent = McpTextContent | McpResourceContent;

export interface ToolOutput {
  [x: string]: unknown;
  content: McpContent[];
}

// Legacy alias for backward compatibility
export type DualOutput = ToolOutput;

/**
 * Create JSON-first output for MCP tools.
 *
 * The structured JSON is the primary data source for Claude reasoning.
 * A brief text summary is provided for user visibility.
 *
 * @param summary - Brief text summary (1-3 lines) for user display
 * @param data - Structured data object - the authoritative data source
 * @returns MCP-compatible response with JSON as primary content
 */
export function createToolOutput(summary: string, data: object): ToolOutput {
  return {
    content: [
      { type: "text", text: summary },
      {
        type: "resource",
        resource: {
          uri: "data:application/json",
          mimeType: "application/json",
          text: JSON.stringify(data),
        },
      },
    ],
  };
}

/**
 * Legacy function - redirects to createToolOutput.
 * @deprecated Use createToolOutput instead
 */
export function createDualOutput(markdown: string, data: object): DualOutput {
  // Extract a brief summary from the markdown (first non-empty line or heading)
  const lines = markdown.split("\n").filter((l) => l.trim());
  const summary = lines[0]?.replace(/^#+\s*/, "") || "Results available";
  return createToolOutput(summary, data);
}

/**
 * Format a number as currency ($1,234.56)
 */
export function formatCurrency(value: number): string {
  const isNegative = value < 0;
  const absValue = Math.abs(value);
  const formatted = absValue.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `-$${formatted}` : `$${formatted}`;
}

/**
 * Format a number as percentage (12.34%)
 */
export function formatPercent(value: number, decimals: number = 2): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format a ratio with specified decimals
 */
export function formatRatio(value: number | undefined, decimals: number = 2): string {
  if (value === undefined || value === null || !isFinite(value)) {
    return "N/A";
  }
  return value.toFixed(decimals);
}
