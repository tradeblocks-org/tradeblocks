/**
 * Field Timing Utilities
 *
 * Derived sets and LAG CTE builder for lookahead-free market analytics.
 * All field classifications are derived from SCHEMA_DESCRIPTIONS timing annotations
 * in schema-metadata.ts -- no hardcoded column names.
 *
 * The v3.0 market schema splits market data into:
 *   - market.enriched: per-ticker computed indicators (+ ivr/ivp for VIX-family). NO OHLCV.
 *   - market.spot_daily: view-backed RTH-aggregated daily OHLCV (open/high/low/close/bid/ask)
 *     derived from market.spot. LEFT JOIN on ticker+date to attach OHLCV to enriched rows.
 *   - market.enriched_context: cross-ticker derived fields (Vol_Regime, Term_Structure_State, etc.)
 *
 * buildLookaheadFreeQuery JOINs market.enriched d + market.spot_daily s (OHLCV for the target
 * ticker) + buildVixJoinClause (VIX-family OHLCV from spot_daily + IVR/IVP from enriched) +
 * market.enriched_context inside a CTE before applying LAG, ensuring LAG operates on the full
 * ticker history (not just trade dates). This guarantees Monday LAG returns Friday's values,
 * not the previous trade day. Per Pitfall 1 (Phase 6 RESEARCH), OHLCV column projections MUST
 * use the spot_daily alias `s` (or vix_s etc.) — `d.close` is a binder error because
 * market.enriched carries no OHLCV columns.
 *
 * Used by downstream tools (suggest_filters, analyze_regime_performance, etc.)
 * to ensure trade-entry queries only use data available at the time of trade entry.
 */

import { DEFAULT_MARKET_TICKER } from "./ticker.ts";
import { SCHEMA_DESCRIPTIONS } from "./schema-metadata.ts";

const dailyColumns = SCHEMA_DESCRIPTIONS.market.tables.enriched.columns;
const derivedColumns = SCHEMA_DESCRIPTIONS.market.tables.enriched_context.columns;

// OHLCV columns live in market.spot_daily (aliased `s`), NOT market.enriched (aliased `d`).
// When emitting SELECT projections that iterate DAILY_*_FIELDS, route these column names
// to the spot_daily alias to avoid Binder Error on the real DuckDB schema.
const OHLCV_COLS = new Set(["open", "high", "low", "close"]);
function aliasForDailyCol(col: string): "s" | "d" {
  return OHLCV_COLS.has(col) ? "s" : "d";
}

export interface MarketLookupKey {
  date: string;
  ticker: string;
}

// ============================================================================
// VIX field mapping — normalized schema
// ============================================================================

/**
 * VIX field mapping: column alias -> { table alias, source column, ticker, timing }.
 * Post Phase 6 (Pitfall 1 schema split): market.enriched has NO OHLCV columns, so
 * a single per-ticker alias cannot source both OHLCV and IVR/IVP. The VIX column
 * mappings are therefore split into:
 *   - VIX_OHLCV_MAPPINGS: OHLCV fields (open/close/high/low) sourced from market.spot_daily
 *     via alias {vix, vix9d, vix3m}.
 *   - VIX_ENRICHED_MAPPINGS: IVR/IVP fields sourced from market.enriched via the
 *     `e`-prefixed alias {evix, evix9d, evix3m}.
 */
interface VixFieldMapping {
  alias: string;       // Column name in query output (e.g., "VIX_Close")
  tableAlias: string;  // SQL table alias (e.g., "vix" for OHLCV, "evix" for enriched)
  sourceCol: string;   // Source column (e.g., "close" in spot_daily, "ivr" in enriched)
  ticker: string;      // Ticker to join on (e.g., "VIX")
  timing: 'open' | 'close';
}

// OHLCV-sourced VIX columns — come from market.spot_daily, aliased as vix/vix9d/vix3m
const VIX_OHLCV_MAPPINGS: VixFieldMapping[] = [
  // VIX
  { alias: "VIX_Open",  tableAlias: "vix",  sourceCol: "open",  ticker: "VIX",  timing: "open" },
  { alias: "VIX_Close", tableAlias: "vix",  sourceCol: "close", ticker: "VIX",  timing: "close" },
  { alias: "VIX_High",  tableAlias: "vix",  sourceCol: "high",  ticker: "VIX",  timing: "close" },
  { alias: "VIX_Low",   tableAlias: "vix",  sourceCol: "low",   ticker: "VIX",  timing: "close" },
  // VIX9D
  { alias: "VIX9D_Open",  tableAlias: "vix9d", sourceCol: "open",  ticker: "VIX9D", timing: "open" },
  { alias: "VIX9D_Close", tableAlias: "vix9d", sourceCol: "close", ticker: "VIX9D", timing: "close" },
  // VIX3M
  { alias: "VIX3M_Open",  tableAlias: "vix3m", sourceCol: "open",  ticker: "VIX3M", timing: "open" },
  { alias: "VIX3M_Close", tableAlias: "vix3m", sourceCol: "close", ticker: "VIX3M", timing: "close" },
];

// Enrichment-sourced VIX columns — come from market.enriched, aliased as evix/evix9d/evix3m
const VIX_ENRICHED_MAPPINGS: VixFieldMapping[] = [
  { alias: "VIX_IVR",    tableAlias: "evix",   sourceCol: "ivr", ticker: "VIX",   timing: "close" },
  { alias: "VIX_IVP",    tableAlias: "evix",   sourceCol: "ivp", ticker: "VIX",   timing: "close" },
  { alias: "VIX9D_IVR",  tableAlias: "evix9d", sourceCol: "ivr", ticker: "VIX9D", timing: "close" },
  { alias: "VIX9D_IVP",  tableAlias: "evix9d", sourceCol: "ivp", ticker: "VIX9D", timing: "close" },
  { alias: "VIX3M_IVR",  tableAlias: "evix3m", sourceCol: "ivr", ticker: "VIX3M", timing: "close" },
  { alias: "VIX3M_IVP",  tableAlias: "evix3m", sourceCol: "ivp", ticker: "VIX3M", timing: "close" },
];

// Union of all VIX mappings (order preserved: OHLCV first, then enrichment) — used for
// SELECT column emission and open/close field-set derivation downstream.
const VIX_ALL_MAPPINGS: VixFieldMapping[] = [
  ...VIX_OHLCV_MAPPINGS,
  ...VIX_ENRICHED_MAPPINGS,
];

// Unique OHLCV table aliases needed for the JOIN clause (used by buildVixJoinClause)
const VIX_TICKER_ALIASES = [...new Set(VIX_OHLCV_MAPPINGS.map(m => m.tableAlias))];
const VIX_TICKER_FOR_ALIAS: Record<string, string> = Object.fromEntries([
  ...VIX_OHLCV_MAPPINGS.map(m => [m.tableAlias, m.ticker] as const),
  ...VIX_ENRICHED_MAPPINGS.map(m => [m.tableAlias, m.ticker] as const),
]);

// Derived fields from date_context
const DERIVED_OPEN_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(derivedColumns)
    .filter(([, desc]) => desc.timing === 'open')
    .map(([name]) => name)
);

const DERIVED_CLOSE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(derivedColumns)
    .filter(([, desc]) => desc.timing === 'close')
    .map(([name]) => name)
);

// ============================================================================
// Table-specific field sets (needed by CTE builder to know which table to alias)
// ============================================================================

/**
 * Open-known fields from market.enriched (use as d.{field} in JOIN CTE, except OHLCV
 * columns which project from the market.spot_daily alias `s`).
 * NOTE: this is still named DAILY_* for back-compat; it now reflects market.enriched
 * columns (which replaced the legacy `daily` table in the v3.0 layout).
 */
export const DAILY_OPEN_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(dailyColumns)
    .filter(([, desc]) => desc.timing === 'open')
    .map(([name]) => name)
);

/**
 * Close-derived fields from market.enriched (apply LAG in JOIN CTE; OHLCV columns
 * project from the market.spot_daily alias `s`).
 */
export const DAILY_CLOSE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(dailyColumns)
    .filter(([, desc]) => desc.timing === 'close')
    .map(([name]) => name)
);

/**
 * Static fields from market.enriched (use as d.{field} in JOIN CTE — calendar facts)
 */
export const DAILY_STATIC_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(dailyColumns)
    .filter(([, desc]) => desc.timing === 'static')
    .map(([name]) => name)
);

/**
 * Open-known fields from VIX tickers + enriched_context
 */
export const CONTEXT_OPEN_FIELDS: ReadonlySet<string> = new Set([
  ...VIX_ALL_MAPPINGS.filter(m => m.timing === 'open').map(m => m.alias),
  ...DERIVED_OPEN_FIELDS,
]);

/**
 * Close-derived fields from VIX tickers + enriched_context
 */
export const CONTEXT_CLOSE_FIELDS: ReadonlySet<string> = new Set([
  ...VIX_ALL_MAPPINGS.filter(m => m.timing === 'close').map(m => m.alias),
  ...DERIVED_CLOSE_FIELDS,
]);

// ============================================================================
// Combined field sets (for callers that don't need to know origin table)
// ============================================================================

/**
 * Fields known at or before market open (Prior_Close, Gap_Pct, VIX_Open, etc.)
 * Union of open-known fields from market.enriched, VIX tickers (spot_daily OHLCV +
 * enriched IVR/IVP), and market.enriched_context.
 * Safe to use as same-day values in trade-entry queries.
 */
export const OPEN_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...DAILY_OPEN_FIELDS,
  ...CONTEXT_OPEN_FIELDS,
]);

/**
 * Fields only known after market close (RSI_14, Vol_Regime, Close, etc.)
 * Union of close-derived fields from market.enriched, VIX tickers (spot_daily +
 * enriched), and market.enriched_context.
 * Must use LAG() to get prior trading day's value in trade-entry queries.
 */
export const CLOSE_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...DAILY_CLOSE_FIELDS,
  ...CONTEXT_CLOSE_FIELDS,
]);

/**
 * Calendar/metadata facts known before the trading day (Day_of_Week, Month, Is_Opex).
 * Only from market.enriched (context has no static fields).
 * Safe to use as same-day values in trade-entry queries.
 */
export const STATIC_FIELDS: ReadonlySet<string> = new Set([
  ...DAILY_STATIC_FIELDS,
]);

// ============================================================================
// Query Builders
// ============================================================================

/**
 * Phase 6 (D-02 extraction) — public helper that emits the VIX JOIN clause
 * against BOTH market.spot_daily (OHLCV for open/high/low/close/bid/ask) AND
 * market.enriched (for ivr/ivp). Called by buildLookaheadFreeQuery and
 * buildOutcomeQuery as of Wave 1.
 *
 * Pitfall 1 context: market.enriched has no OHLCV columns, so a single alias
 * per ticker cannot source both sets. This helper emits TWO joins per alias —
 * the OHLCV alias (e.g. `vix`) attaches spot_daily; the `e`-prefixed alias
 * (e.g. `evix`) attaches enriched.
 *
 * @param tickerAliases  e.g. ['vix', 'vix9d', 'vix3m']
 * @param baseAlias      alias of the main table the joins attach to (default 'd')
 * @returns SQL fragment string with \n + 6-space indent between JOINs
 */
export function buildVixJoinClause(
  tickerAliases: string[],
  baseAlias: string = "d",
): string {
  return tickerAliases
    .flatMap(alias => {
      const ticker = VIX_TICKER_FOR_ALIAS[alias];
      return [
        `LEFT JOIN market.spot_daily ${alias} ON ${alias}.date = ${baseAlias}.date AND ${alias}.ticker = '${ticker}'`,
        `LEFT JOIN market.enriched e${alias} ON e${alias}.date = ${baseAlias}.date AND e${alias}.ticker = '${ticker}'`,
      ];
    })
    .join("\n      ");
}

// SELECT columns from VIX OHLCV + enrichment mappings, e.g. vix."close" AS "VIX_Close",
// evix."ivr" AS "VIX_IVR", ...
function buildVixSelectCols(): string {
  return VIX_ALL_MAPPINGS
    .map(m => `${m.tableAlias}."${m.sourceCol}" AS "${m.alias}"`)
    .join(", ");
}

// SELECT columns from enriched_context: cd."Vol_Regime", ...
function buildDerivedSelectCols(): string {
  return [...DERIVED_OPEN_FIELDS, ...DERIVED_CLOSE_FIELDS].map(f => `cd."${f}"`).join(", ");
}

/**
 * Builds a SQL query that joins trade keys to market.enriched + market.spot_daily
 * (for OHLCV) + market.enriched_context + VIX tickers (both spot_daily OHLCV and
 * enriched IVR/IVP) with lookahead bias prevention:
 * - Open-known fields: used as-is (same-day values, known before market open)
 * - Static fields: used as-is (calendar facts, known in advance)
 * - Close-derived fields: LAG(field) OVER (PARTITION BY ticker ORDER BY date)
 *   gives prior trading day's value
 *
 * The post-Phase-6 JOIN pattern is:
 *   market.enriched d
 *   LEFT JOIN market.spot_daily s   ON s.ticker = d.ticker AND s.date = d.date   -- OHLCV for target
 *   LEFT JOIN market.spot_daily vix   ON vix.date   = d.date AND vix.ticker   = 'VIX'
 *   LEFT JOIN market.enriched   evix  ON evix.date  = d.date AND evix.ticker  = 'VIX'
 *   LEFT JOIN market.spot_daily vix9d  ON vix9d.date  = d.date AND vix9d.ticker  = 'VIX9D'
 *   LEFT JOIN market.enriched   evix9d ON evix9d.date = d.date AND evix9d.ticker = 'VIX9D'
 *   LEFT JOIN market.spot_daily vix3m  ON vix3m.date  = d.date AND vix3m.ticker  = 'VIX3M'
 *   LEFT JOIN market.enriched   evix3m ON evix3m.date = d.date AND evix3m.ticker = 'VIX3M'
 *   LEFT JOIN market.enriched_context cd ON cd.date = d.date
 *
 * Pitfall 1: market.enriched carries NO OHLCV columns; OHLCV projections MUST use the
 * spot_daily alias (`s` for the target ticker, `vix/vix9d/vix3m` for VIX-family).
 *
 * LAG operates on the FULL ticker history (all trading days for the ticker),
 * NOT just the requested dates. This ensures LAG sees the correct prior trading day
 * across weekends, holidays, and sparse trading strategies.
 *
 * @param tradeDatesOrKeys - Array of dates (legacy string[] overload) or ticker+date keys
 * @returns Object with `sql` (the query string) and `params` (the parameter values)
 */
export function buildLookaheadFreeQuery(tradeDates: string[]): { sql: string; params: string[] };
export function buildLookaheadFreeQuery(tradeKeys: MarketLookupKey[]): { sql: string; params: string[] };
export function buildLookaheadFreeQuery(
  tradeDatesOrKeys: string[] | MarketLookupKey[]
): { sql: string; params: string[] } {
  if (tradeDatesOrKeys.length === 0) {
    return { sql: `SELECT * FROM market.enriched WHERE 1=0`, params: [] };
  }

  // Build field lists for the joined CTE. OHLCV columns project from alias `s`
  // (market.spot_daily); enrichment columns project from alias `d` (market.enriched).
  const dailyOpenCols = [...DAILY_OPEN_FIELDS].map((f) => `${aliasForDailyCol(f)}."${f}"`).join(", ");
  const dailyStaticCols = [...DAILY_STATIC_FIELDS].map((f) => `${aliasForDailyCol(f)}."${f}"`).join(", ");
  const dailyCloseCols = [...DAILY_CLOSE_FIELDS].map((f) => `${aliasForDailyCol(f)}."${f}"`).join(", ");
  const vixSelectCols = buildVixSelectCols();
  const derivedSelectCols = buildDerivedSelectCols();
  const vixJoins = buildVixJoinClause(VIX_TICKER_ALIASES, "d");

  // LAG columns — all close-derived fields from daily-enriched and VIX/derived
  const dailyLagCols = [...DAILY_CLOSE_FIELDS]
    .map((field) => `LAG("${field}") OVER (PARTITION BY ticker ORDER BY date) AS "prev_${field}"`)
    .join(",\n        ");
  const vixLagCols = VIX_ALL_MAPPINGS
    .filter(m => m.timing === 'close')
    .map(m => `LAG("${m.alias}") OVER (PARTITION BY ticker ORDER BY date) AS "prev_${m.alias}"`)
    .join(",\n        ");
  const derivedLagCols = [...DERIVED_CLOSE_FIELDS]
    .map(f => `LAG("${f}") OVER (PARTITION BY ticker ORDER BY date) AS "prev_${f}"`)
    .join(",\n        ");

  // Pass-through columns for the lagged CTE (unaliased, from joined CTE output)
  const dailyOpenPassthrough = [...DAILY_OPEN_FIELDS].map((f) => `"${f}"`).join(", ");
  const dailyStaticPassthrough = [...DAILY_STATIC_FIELDS].map((f) => `"${f}"`).join(", ");
  const vixOpenPassthrough = VIX_ALL_MAPPINGS
    .filter(m => m.timing === 'open')
    .map(m => `"${m.alias}"`)
    .join(", ");
  const derivedOpenPassthrough = [...DERIVED_OPEN_FIELDS].map(f => `"${f}"`).join(", ");

  // Legacy path for existing date-only callers (single ticker = DEFAULT_MARKET_TICKER)
  if (typeof tradeDatesOrKeys[0] === "string") {
    const tradeDates = tradeDatesOrKeys as string[];
    const placeholders = tradeDates.map((_, i) => `$${i + 1}`).join(", ");

    const sql = `WITH joined AS (
      SELECT
        d.ticker,
        d.date,
        ${dailyOpenCols},
        ${dailyStaticCols},
        ${vixSelectCols},
        ${derivedSelectCols ? derivedSelectCols + "," : ""}
        ${dailyCloseCols}
      FROM market.enriched d
      LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
      ${vixJoins}
      LEFT JOIN market.enriched_context cd ON cd.date = d.date
      WHERE d.ticker = $${tradeDates.length + 1}
    ),
    lagged AS (
      SELECT
        ticker,
        date,
        ${dailyOpenPassthrough},
        ${dailyStaticPassthrough},
        ${vixOpenPassthrough ? vixOpenPassthrough + "," : ""}
        ${derivedOpenPassthrough ? derivedOpenPassthrough + "," : ""}
        ${dailyLagCols},
        ${vixLagCols ? vixLagCols + "," : ""}
        ${derivedLagCols}
      FROM joined
    )
    SELECT * FROM lagged
    WHERE date IN (${placeholders})`;

    return { sql, params: [...tradeDates, DEFAULT_MARKET_TICKER] };
  }

  const tradeKeys = tradeDatesOrKeys as MarketLookupKey[];
  const normalizedKeys = tradeKeys.map((k) => ({
    date: k.date,
    ticker: k.ticker || DEFAULT_MARKET_TICKER,
  }));

  const values: string[] = [];
  const valuePlaceholders = normalizedKeys.map((key) => {
    values.push(key.ticker, key.date);
    return `($${values.length - 1}, $${values.length})`;
  });

  const sql = `WITH requested(ticker, date) AS (
      VALUES ${valuePlaceholders.join(", ")}
    ),
    joined AS (
      SELECT
        d.ticker,
        d.date,
        ${dailyOpenCols},
        ${dailyStaticCols},
        ${vixSelectCols},
        ${derivedSelectCols ? derivedSelectCols + "," : ""}
        ${dailyCloseCols}
      FROM market.enriched d
      LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
      ${vixJoins}
      LEFT JOIN market.enriched_context cd ON cd.date = d.date
      WHERE d.ticker IN (SELECT DISTINCT ticker FROM requested)
    ),
    lagged AS (
      SELECT
        ticker,
        date,
        ${dailyOpenPassthrough},
        ${dailyStaticPassthrough},
        ${vixOpenPassthrough ? vixOpenPassthrough + "," : ""}
        ${derivedOpenPassthrough ? derivedOpenPassthrough + "," : ""}
        ${dailyLagCols},
        ${vixLagCols ? vixLagCols + "," : ""}
        ${derivedLagCols}
      FROM joined
    )
    SELECT lagged.*
    FROM lagged
    JOIN requested
      ON lagged.ticker = requested.ticker
     AND lagged.date = requested.date`;

  return { sql, params: values };
}

/**
 * Builds a SQL query that returns same-day close-derived values (no LAG).
 * Used for outcome/post-hoc analysis when includeOutcomeFields=true.
 *
 * These are values that were NOT available at trade entry time --
 * they represent the end-of-day result for the trade date itself.
 * Sources from market.enriched (+ market.spot_daily for OHLCV), VIX ticker rows
 * (spot_daily + enriched), and market.enriched_context via LEFT JOIN.
 *
 * @param tradeDatesOrKeys - Array of dates or ticker+date keys
 * @returns Object with `sql` (the query string) and `params` (the date values)
 */
export function buildOutcomeQuery(tradeDates: string[]): { sql: string; params: string[] };
export function buildOutcomeQuery(tradeKeys: MarketLookupKey[]): { sql: string; params: string[] };
export function buildOutcomeQuery(
  tradeDatesOrKeys: string[] | MarketLookupKey[]
): { sql: string; params: string[] } {
  if (tradeDatesOrKeys.length === 0) {
    return { sql: `SELECT * FROM market.enriched WHERE 1=0`, params: [] };
  }

  const vixCloseCols = VIX_ALL_MAPPINGS
    .filter(m => m.timing === 'close')
    .map(m => `${m.tableAlias}."${m.sourceCol}" AS "${m.alias}"`)
    .join(", ");
  const derivedCloseCols = [...DERIVED_CLOSE_FIELDS].map(f => `cd."${f}"`).join(", ");

  if (typeof tradeDatesOrKeys[0] === "string") {
    return buildOutcomeQueryForDates(tradeDatesOrKeys as string[], vixCloseCols, derivedCloseCols);
  }

  return buildOutcomeQueryForKeys(tradeDatesOrKeys as MarketLookupKey[], vixCloseCols, derivedCloseCols);
}

// Emit OHLCV-aware projection for the target-ticker close columns. Columns in
// OHLCV_COLS come from the spot_daily alias `sAlias`; other enrichment-close
// columns come from the enriched alias `eAlias`.
function buildTargetCloseCols(
  eAlias: string,
  sAlias: string,
): string {
  return [...DAILY_CLOSE_FIELDS]
    .map((f) => `${OHLCV_COLS.has(f) ? sAlias : eAlias}."${f}"`)
    .join(", ");
}

function buildOutcomeQueryForDates(
  tradeDates: string[], vixCloseCols: string, derivedCloseCols: string
): { sql: string; params: string[] } {
  const eAlias = "d";
  const sAlias = "s";
  const dailyCloseCols = buildTargetCloseCols(eAlias, sAlias);
  const placeholders = tradeDates.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `SELECT ${eAlias}.date, ${dailyCloseCols}, ${vixCloseCols}, ${derivedCloseCols}
    FROM market.enriched ${eAlias}
    LEFT JOIN market.spot_daily ${sAlias} ON ${sAlias}.ticker = ${eAlias}.ticker AND ${sAlias}.date = ${eAlias}.date
    ${buildVixJoinClause(VIX_TICKER_ALIASES, eAlias)}
    LEFT JOIN market.enriched_context cd ON cd.date = ${eAlias}.date
    WHERE ${eAlias}.ticker = $${tradeDates.length + 1}
      AND ${eAlias}.date IN (${placeholders})`;
  return { sql, params: [...tradeDates, DEFAULT_MARKET_TICKER] };
}

function buildOutcomeQueryForKeys(
  tradeKeys: MarketLookupKey[], vixCloseCols: string, derivedCloseCols: string
): { sql: string; params: string[] } {
  const eAlias = "m";
  const sAlias = "ms";
  const dailyCloseCols = buildTargetCloseCols(eAlias, sAlias);
  const normalizedKeys = tradeKeys.map((k) => ({
    date: k.date,
    ticker: k.ticker || DEFAULT_MARKET_TICKER,
  }));

  const values: string[] = [];
  const valuePlaceholders = normalizedKeys.map((key) => {
    values.push(key.ticker, key.date);
    return `($${values.length - 1}, $${values.length})`;
  });

  const sql = `WITH requested(ticker, date) AS (
      VALUES ${valuePlaceholders.join(", ")}
    )
    SELECT ${eAlias}.ticker, ${eAlias}.date, ${dailyCloseCols}, ${vixCloseCols}, ${derivedCloseCols}
    FROM market.enriched ${eAlias}
    LEFT JOIN market.spot_daily ${sAlias} ON ${sAlias}.ticker = ${eAlias}.ticker AND ${sAlias}.date = ${eAlias}.date
    ${buildVixJoinClause(VIX_TICKER_ALIASES, eAlias)}
    LEFT JOIN market.enriched_context cd ON cd.date = ${eAlias}.date
    JOIN requested
      ON ${eAlias}.ticker = requested.ticker
     AND ${eAlias}.date = requested.date`;

  return { sql, params: values };
}
