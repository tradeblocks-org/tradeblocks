/**
 * enrichment-verification.ts — pure diff helper for enrichment-rebuild
 * verification.
 *
 * Compares two enriched rows (old from the legacy
 * `daily.parquet` / `date_context` files, new from the rebuilt
 * `market.enriched` / `market.enriched_context` views) with per-field
 * tolerance rules and returns a structured diff — not a boolean. The
 * verification harness consumes the diff, aggregates across ~15–20 sample
 * dates per ticker, and emits a report (markdown + JSON).
 *
 * Pure module — no filesystem, no DuckDB, no provider imports.
 *
 * Tolerance rules:
 *   - DOUBLE: `|a - b| <= 1e-9` (boundary INCLUSIVE); NaN-vs-NaN passes;
 *             NaN-vs-non-NaN fails.
 *   - INTEGER: strict `Number(a) === Number(b)`.
 *   - VARCHAR: case-sensitive `String(a) === String(b)`.
 *   - null vs null / undefined vs undefined → pass.
 *   - null vs value (or undefined vs value) → fail.
 *
 * Failure aggregation: `compareRow(...).anyFailure === true` whenever any
 * field in the row failed its tolerance test. The deletion of the legacy
 * enriched files is gated on every compared row returning
 * `anyFailure === false`.
 */

/**
 * Tolerance epsilon for DOUBLE fields. Locked at 1e-9 — the enrichment
 * math is deterministic on identical OHLCV input, so anything above machine
 * precision is a real semantic change.
 */
export const DOUBLE_EPSILON = 1e-9;

/** One of the three field-type dispatch categories. */
export type FieldType = "double" | "integer" | "varchar";

/**
 * Per-field type classification for rows materialized from
 * `market.enriched` (the ticker-first enriched store).
 *
 * Source: market-enricher.ts::DAILY_ENRICHMENT_COLUMNS + the tolerance-rule
 * classification documented in the file header.
 *
 * INTEGER fields (exact match): Gap_Filled, Consecutive_Days, High_Before_Low,
 * Reversal_Type, Day_of_Week, Month, Is_Opex.
 * DOUBLE fields (1e-9 epsilon): everything else.
 *
 * NOTE: Gap_Filled and Reversal_Type can be null on no-gap / no-reversal days;
 * the compare helper handles null-vs-null as pass.
 */
export const ENRICHED_FIELD_TYPES: Record<string, FieldType> = {
  // Tier 1 doubles
  Prior_Close: "double",
  Gap_Pct: "double",
  ATR_Pct: "double",
  RSI_14: "double",
  Price_vs_EMA21_Pct: "double",
  Price_vs_SMA50_Pct: "double",
  Realized_Vol_5D: "double",
  Realized_Vol_20D: "double",
  Return_5D: "double",
  Return_20D: "double",
  Intraday_Range_Pct: "double",
  Intraday_Return_Pct: "double",
  Close_Position_In_Range: "double",
  Prev_Return_Pct: "double",
  Prior_Range_vs_ATR: "double",
  // Tier 3 intraday timing (doubles)
  High_Time: "double",
  Low_Time: "double",
  Opening_Drive_Strength: "double",
  Intraday_Realized_Vol: "double",
  // IVR / IVP
  ivr: "double",
  ivp: "double",
  // Context-bleed fields that may appear on ticker-scoped rows in some layouts
  VIX_Spike_Pct: "double",
  VIX_Gap_Pct: "double",
  // Integer fields
  Gap_Filled: "integer",
  Consecutive_Days: "integer",
  High_Before_Low: "integer",
  Reversal_Type: "integer",
  Day_of_Week: "integer",
  Month: "integer",
  Is_Opex: "integer",
};

/**
 * Per-field type classification for rows materialized from
 * `market.enriched_context` (the global cross-ticker context view).
 *
 * Vol_Regime / Term_Structure_State are integers (classification codes per
 * classifyVolRegime / classifyTermStructure).
 * Trend_Direction is a varchar (case-sensitive).
 * VIX_Spike_Pct / VIX_Gap_Pct are doubles.
 */
export const CONTEXT_FIELD_TYPES: Record<string, FieldType> = {
  Vol_Regime: "integer",
  Term_Structure_State: "integer",
  Trend_Direction: "varchar",
  VIX_Spike_Pct: "double",
  VIX_Gap_Pct: "double",
};

/**
 * Structured per-field diff result.
 *
 * `delta` is only populated for DOUBLE fields (where `|a - b|` is meaningful).
 * `passed` is the single source of truth for gate decisions — downstream code
 * should never re-derive pass/fail from raw `oldValue`/`newValue`.
 */
export interface FieldDiff {
  field: string;
  type: FieldType;
  oldValue: unknown;
  newValue: unknown;
  passed: boolean;
  delta?: number;
}

/**
 * Row-level diff with a precomputed `anyFailure` flag for fast aggregation
 * across many sample rows — any failure blocks deletion of the legacy
 * enriched files.
 */
export interface RowDiff {
  ticker: string;
  date: string;
  kind: "enriched" | "context";
  fields: FieldDiff[];
  anyFailure: boolean;
}

/** null or undefined — the pair both-missing is always a PASS. */
function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

/**
 * Compare the fields of two rows per a `fieldTypes` dispatch map.
 *
 * Iterates `Object.entries(fieldTypes)` so the returned array length always
 * equals `Object.keys(fieldTypes).length`. Extra keys in the input rows are
 * ignored; missing keys in the rows surface as `oldValue === undefined`
 * (null-vs-null pass if both are missing, fail if only one is missing).
 */
export function compareFields(
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
  fieldTypes: Record<string, FieldType>,
): FieldDiff[] {
  return Object.entries(fieldTypes).map(([field, type]) => {
    const oldValue = oldRow[field];
    const newValue = newRow[field];

    const oldNull = isNullish(oldValue);
    const newNull = isNullish(newValue);
    if (oldNull && newNull) {
      return { field, type, oldValue, newValue, passed: true };
    }
    if (oldNull !== newNull) {
      return { field, type, oldValue, newValue, passed: false };
    }

    if (type === "double") {
      const oldNum = Number(oldValue);
      const newNum = Number(newValue);
      const oldNaN = Number.isNaN(oldNum);
      const newNaN = Number.isNaN(newNum);
      if (oldNaN && newNaN) {
        return { field, type, oldValue, newValue, passed: true };
      }
      if (oldNaN !== newNaN) {
        return { field, type, oldValue, newValue, passed: false };
      }
      const delta = Math.abs(oldNum - newNum);
      return {
        field,
        type,
        oldValue,
        newValue,
        passed: delta <= DOUBLE_EPSILON,
        delta,
      };
    }

    if (type === "integer") {
      return {
        field,
        type,
        oldValue,
        newValue,
        passed: Number(oldValue) === Number(newValue),
      };
    }

    // varchar
    return {
      field,
      type,
      oldValue,
      newValue,
      passed: String(oldValue) === String(newValue),
    };
  });
}

/**
 * Compare two rows using the field-type dispatch map that matches `kind`.
 *
 * `kind: 'enriched'` uses `ENRICHED_FIELD_TYPES` (per-ticker enriched row).
 * `kind: 'context'` uses `CONTEXT_FIELD_TYPES` (global cross-ticker context row).
 *
 * The resulting `RowDiff.anyFailure` is the aggregation signal the deletion
 * gate reads — a single `true` anywhere in the sample blocks deletion of
 * the legacy enriched files.
 */
export function compareRow(
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
  kind: "enriched" | "context",
  ticker: string,
  date: string,
): RowDiff {
  const types = kind === "enriched" ? ENRICHED_FIELD_TYPES : CONTEXT_FIELD_TYPES;
  const fields = compareFields(oldRow, newRow, types);
  return {
    ticker,
    date,
    kind,
    fields,
    anyFailure: fields.some((f) => !f.passed),
  };
}
