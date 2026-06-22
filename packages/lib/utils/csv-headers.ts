/**
 * CSV header utilities
 */

export interface HeaderValidationOptions {
  /** Optional map of alternate header names to canonical names */
  aliases?: Record<string, string> | Readonly<Record<string, string>>;
  /** Human-readable label used in error messages */
  contextLabel?: string;
}

const BOM = "\uFEFF";

/**
 * Remove UTF-8 byte order mark from a string if present
 */
export function stripBom(value: string): string {
  return value.startsWith(BOM) ? value.slice(1) : value;
}

/**
 * Parse a single CSV line into values, handling quoted fields and commas
 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (inQuotes && nextChar === '"') {
        // Escaped quote inside quoted value
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());

  if (result.length > 0) {
    result[0] = stripBom(result[0]);
  }

  return result;
}

/**
 * Normalize a CSV header by trimming whitespace, stripping BOM, and applying aliases
 */
export function normalizeHeader(
  header: string,
  aliases?: Record<string, string> | Readonly<Record<string, string>>,
): string {
  const trimmed = stripBom(header).trim();
  return aliases?.[trimmed] ?? trimmed;
}

/**
 * Normalize an array of headers
 */
export function normalizeHeaders(
  headers: string[],
  aliases?: Record<string, string> | Readonly<Record<string, string>>,
): string[] {
  return headers.map((header) => normalizeHeader(header, aliases));
}

/**
 * Validate that required headers are present. Returns the missing headers without throwing.
 */
export function findMissingHeaders(headers: string[], required: readonly string[]): string[] {
  const headerSet = new Set(headers);
  return required.filter((requiredHeader) => !headerSet.has(requiredHeader));
}

/**
 * Ensure required headers are present, throwing an Error with a helpful message when missing.
 */
export function assertRequiredHeaders(
  headers: string[],
  required: readonly string[],
  options: HeaderValidationOptions = {},
): void {
  const missing = findMissingHeaders(headers, required);
  if (missing.length === 0) {
    return;
  }

  const label = options.contextLabel ? `${options.contextLabel} ` : "";
  throw new Error(`Missing required ${label}columns: ${missing.join(", ")}`);
}
