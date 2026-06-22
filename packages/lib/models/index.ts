// Core data models
export * from "./trade.ts";
export * from "./daily-log.ts";
export * from "./portfolio-stats.ts";
export * from "./strategy-alignment.ts";
export * from "./block.ts";
export * from "./walk-forward.ts";
export * from "./reporting-trade.ts";
export * from "./report-config.ts";
export * from "./tail-risk.ts";
export * from "./static-dataset.ts";
export * from "./enriched-trade.ts";
export * from "./regime.ts";

// Type utilities
export type ProcessingStage = "uploading" | "parsing" | "processing" | "calculating" | "storing";
export type ProcessingStatus = "pending" | "processing" | "completed" | "error";

// Error types
export interface ProcessingError {
  type: "validation" | "parsing" | "calculation" | "storage";
  message: string;
  details?: Record<string, unknown>;
  rowNumber?: number;
  columnName?: string;
}

export interface ValidationError extends ProcessingError {
  type: "validation";
  field: string;
  value: unknown;
  expected: string;
}

export interface ParsingError extends ProcessingError {
  type: "parsing";
  line: number;
  column?: string;
  raw: string;
}

// Re-export commonly used types
export type { AnalysisConfig, TimePeriod } from "./portfolio-stats.ts";
