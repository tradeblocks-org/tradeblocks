/**
 * Utility functions for exporting data as CSV and JSON
 */

/**
 * Escapes a value for safe CSV inclusion.
 * - Wraps in quotes if value contains comma, quote, or newline
 * - Doubles any existing quotes
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);

  // If the value contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Joins an array of values into a CSV row, properly escaping each value
 */
export function toCsvRow(values: unknown[]): string {
  return values.map(escapeCsvValue).join(",");
}

/**
 * Creates and triggers a file download
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Downloads data as a JSON file
 */
export function downloadJson(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename, "application/json");
}

/**
 * Downloads lines as a CSV file
 */
export function downloadCsv(lines: string[], filename: string): void {
  downloadFile(lines.join("\n"), filename, "text/csv;charset=utf-8;");
}

/**
 * Sanitizes a block name for use in filenames
 * Replaces spaces and special characters with hyphens
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generates a filename with the current date
 */
export function generateExportFilename(
  blockName: string,
  suffix: string,
  extension: "json" | "csv",
): string {
  const sanitized = sanitizeFilename(blockName);
  const date = new Date().toISOString().split("T")[0];
  return `${sanitized}-${suffix}-${date}.${extension}`;
}
