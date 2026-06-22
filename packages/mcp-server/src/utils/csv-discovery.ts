/**
 * CSV Discovery & Type Detection
 *
 * Shared module for detecting CSV file types (tradelog, dailylog, reportinglog)
 * by examining column headers. Used by both block-loader.ts and block-sync.ts.
 *
 * This module must NOT import from block-loader.ts to avoid circular dependencies.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { REPORTING_TRADE_COLUMN_ALIASES } from "@tradeblocks/lib";

/**
 * CSV file mappings for flexible discovery
 */
export interface CsvMappings {
  tradelog?: string;
  dailylog?: string;
  reportinglog?: string;
}

/**
 * CSV type detection result
 */
export type CsvType = "tradelog" | "dailylog" | "reportinglog" | null;

/**
 * Parse a single CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Read just the header line from a CSV file (for detection)
 */
async function readCsvHeaders(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const firstLine = content.replace(/^\uFEFF/, "").split("\n")[0] || "";
  return parseCSVLine(firstLine).map((h) => h.toLowerCase().trim());
}

/**
 * Detect CSV type by examining column headers.
 * Returns the detected type or null if unrecognized.
 */
export async function detectCsvType(filePath: string): Promise<CsvType> {
  try {
    const headers = await readCsvHeaders(filePath);

    // Trade log detection:
    // Required: "P/L" or "P&L" or "Profit/Loss"
    // Plus at least 2 of: "Date Opened", "Date Closed", "Symbol", "Strategy", "Contracts", "Premium"
    const plColumnAliases = ["p/l", "p&l", "profit/loss", "pl"];
    const tradeOptionalColumns = [
      "date opened",
      "date closed",
      "symbol",
      "strategy",
      "contracts",
      "no. of contracts",
      "premium",
      "legs",
    ];

    const hasPl = plColumnAliases.some((alias) => headers.includes(alias));
    // Match trade columns - require header to contain the full column pattern
    const matchedTradeColumns = tradeOptionalColumns.filter((col) =>
      headers.some((h) => h.includes(col)),
    );

    if (hasPl && matchedTradeColumns.length >= 2) {
      // Before classifying as tradelog, check if this looks like a reporting log.
      // Option Omega reporting exports share P/L + Date Opened + Strategy + Contracts
      // but also have "Initial Premium" (or aliases) which tradelogs use "Premium" instead.
      const reportingOnlyColumns = ["initial premium", "initial credit", "initial premium ($)"];
      const hasReportingOnly = reportingOnlyColumns.some((col) =>
        headers.some((h) => h.includes(col)),
      );
      if (hasReportingOnly) {
        return "reportinglog";
      }
      return "tradelog";
    }

    // Daily log detection:
    // Required: "Date" (but not "Date Opened"/"Date Closed"), and value column
    const hasSimpleDate = headers.some(
      (h) => h === "date" || (h.includes("date") && !h.includes("opened") && !h.includes("closed")),
    );
    const valueColumnAliases = [
      "portfolio value",
      "value",
      "equity",
      "net liquidity",
      "netliquidity",
    ];
    const hasValue = valueColumnAliases.some((alias) =>
      headers.some((h) => h.includes(alias) || alias.includes(h)),
    );

    // Dailylog: has date + value columns but lacks trade-specific columns
    if (hasSimpleDate && hasValue && matchedTradeColumns.length < 2) {
      return "dailylog";
    }

    // TAT (Trade Automation Toolbox) detection:
    // Has "TradeID" AND "ProfitLoss" AND "BuyingPower"
    const tatSignature = ["tradeid", "profitloss", "buyingpower"];
    const isTat = tatSignature.every((sig) => headers.includes(sig));
    if (isTat) {
      return "reportinglog";
    }

    // Reporting log detection:
    // Has "Actual P/L" or columns from REPORTING_TRADE_COLUMN_ALIASES
    const reportingAliases = Object.keys(REPORTING_TRADE_COLUMN_ALIASES).map((k) =>
      k.toLowerCase(),
    );
    const hasReportingColumns = reportingAliases.some((alias) => headers.includes(alias));
    const hasActualPl = headers.some((h) => h.includes("actual") && h.includes("p"));
    const hasReportedStyle =
      headers.includes("trade id") || headers.some((h) => h.includes("reported"));

    if (hasActualPl || hasReportingColumns || hasReportedStyle) {
      // Double-check it's not a regular tradelog
      if (!hasPl || hasActualPl) {
        return "reportinglog";
      }
    }

    // If we have P/L and trade columns, fallback to tradelog
    if (hasPl && matchedTradeColumns.length >= 1) {
      return "tradelog";
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Discover CSV files in a folder and detect their types.
 * Returns mapping of detected CSV types to filenames.
 */
export async function discoverCsvFiles(
  folderPath: string,
): Promise<{ mappings: CsvMappings; unrecognized: string[] }> {
  const mappings: CsvMappings = {};
  const unrecognized: string[] = [];

  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const csvFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".csv"))
      .map((e) => e.name);

    // First, check for exact standard names
    if (csvFiles.includes("tradelog.csv")) {
      mappings.tradelog = "tradelog.csv";
    }
    if (csvFiles.includes("dailylog.csv")) {
      mappings.dailylog = "dailylog.csv";
    }
    if (csvFiles.includes("reportinglog.csv")) {
      mappings.reportinglog = "reportinglog.csv";
    }

    // Second, check for filename patterns (before content detection)
    if (!mappings.reportinglog) {
      const strategyLogFile = csvFiles.find((f) => {
        const lower = f.toLowerCase();
        return (
          lower.includes("strategy-trade-log") ||
          lower.includes("strategylog") ||
          lower.startsWith("strategy-log")
        );
      });
      if (strategyLogFile) {
        mappings.reportinglog = strategyLogFile;
      }
    }

    // For any remaining CSVs, detect by content
    for (const csvFile of csvFiles) {
      // Skip if already mapped via exact name or filename pattern
      if (
        csvFile === "tradelog.csv" ||
        csvFile === "dailylog.csv" ||
        csvFile === "reportinglog.csv" ||
        csvFile === mappings.reportinglog
      ) {
        continue;
      }

      const csvPath = path.join(folderPath, csvFile);
      const detectedType = await detectCsvType(csvPath);

      if (detectedType) {
        // Only assign if we haven't found this type yet
        if (detectedType === "tradelog" && !mappings.tradelog) {
          mappings.tradelog = csvFile;
        } else if (detectedType === "dailylog" && !mappings.dailylog) {
          mappings.dailylog = csvFile;
        } else if (detectedType === "reportinglog" && !mappings.reportinglog) {
          mappings.reportinglog = csvFile;
        } else {
          // Type already found, this is an extra CSV
          unrecognized.push(csvFile);
        }
      } else {
        unrecognized.push(csvFile);
      }
    }
  } catch {
    // Folder read error - return empty
  }

  return { mappings, unrecognized };
}

/**
 * Log warning when folder has CSVs but none match expected patterns
 */
export function logCsvDiscoveryWarning(folderName: string, csvFiles: string[]): void {
  console.error(
    `Warning: Folder '${folderName}' has CSV files but none match expected trade log format.`,
  );
  console.error(`  Found: ${csvFiles.join(", ")}`);
  console.error(`  Expected columns: P/L, Date Opened, Date Closed, Symbol, Strategy`);
}
