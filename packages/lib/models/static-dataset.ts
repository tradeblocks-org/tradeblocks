/**
 * Static Dataset Models
 *
 * Static datasets are global time-series data (VIX, SPX OHLC, etc.) that can be
 * matched to trades across any block based on configurable matching strategies.
 */

/**
 * Match strategy determines how trade timestamps are matched to dataset rows
 */
export type MatchStrategy = "exact" | "same-day" | "nearest-before" | "nearest-after" | "nearest";

/**
 * Human-readable labels for match strategies
 */
export const MATCH_STRATEGY_LABELS: Record<MatchStrategy, string> = {
  exact: "Exact",
  "same-day": "Same Day",
  "nearest-before": "Nearest Before",
  "nearest-after": "Nearest After",
  nearest: "Nearest",
};

/**
 * Descriptions for match strategies (for tooltips/help text)
 */
export const MATCH_STRATEGY_DESCRIPTIONS: Record<MatchStrategy, string> = {
  exact: "Match only when timestamps are exactly equal",
  "same-day": "Match to the row on the same calendar day (for daily data)",
  "nearest-before": "Match to the most recent row at or before the trade time",
  "nearest-after": "Match to the earliest row at or after the trade time",
  nearest: "Match to the closest row on the same day",
};

/**
 * Static dataset metadata - stored separately from rows for efficient listing
 */
export interface StaticDataset {
  /** Unique identifier */
  id: string;

  /** User-provided name, used as field prefix in Report Builder (e.g., "vix" -> "vix.close") */
  name: string;

  /** Original filename from upload */
  fileName: string;

  /** When the dataset was uploaded */
  uploadedAt: Date;

  /** Total number of data rows */
  rowCount: number;

  /** Date range covered by the dataset */
  dateRange: {
    start: Date;
    end: Date;
  };

  /** Column names (excluding timestamp column which is always first) */
  columns: string[];

  /** How to match trade timestamps to dataset rows */
  matchStrategy: MatchStrategy;
}

/**
 * A single row of static dataset data
 * Stored separately from metadata for performance with large datasets
 */
export interface StaticDatasetRow {
  /** Reference to parent dataset */
  datasetId: string;

  /** Timestamp parsed from first column of CSV */
  timestamp: Date;

  /** All other column values, keyed by column name */
  values: Record<string, number | string>;
}

/**
 * Stored version of StaticDatasetRow with auto-generated ID for IndexedDB
 */
export interface StoredStaticDatasetRow extends StaticDatasetRow {
  id?: number;
}

/**
 * Result of matching a trade to a static dataset
 */
export interface DatasetMatchResult {
  /** The dataset that was matched */
  datasetId: string;

  /** The dataset name (for field prefixing) */
  datasetName: string;

  /** The matched row, or null if no match found */
  matchedRow: StaticDatasetRow | null;

  /** The timestamp that was matched (for display in preview) */
  matchedTimestamp: Date | null;

  /** Time difference in milliseconds between trade and matched row (for diagnostics) */
  timeDifferenceMs: number | null;
}

/**
 * Aggregated match statistics for preview display
 */
export interface DatasetMatchStats {
  /** Total number of trades */
  totalTrades: number;

  /** Number of trades that found a match */
  matchedTrades: number;

  /** Number of trades outside dataset date range */
  outsideDateRange: number;

  /** Match percentage (0-100) */
  matchPercentage: number;
}
