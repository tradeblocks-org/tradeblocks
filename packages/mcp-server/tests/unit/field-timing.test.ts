/**
 * Unit tests for field classification and LAG CTE builder.
 *
 * Validates:
 * - Every market.enriched and market.enriched_context column (except key columns) has a timing annotation
 * - Derived sets cover all classified columns with correct counts
 * - Sets are mutually exclusive
 * - Known pitfall classifications are correct (Return_5D, Prev_Return_Pct, etc.)
 * - buildLookaheadFreeQuery() produces valid lookahead-free SQL with multi-table VIX JOIN
 * - buildOutcomeQuery() produces valid same-day outcome SQL from normalized VIX schema
 */

// @ts-expect-error - importing from bundled output
import {
  OPEN_KNOWN_FIELDS,
  CLOSE_KNOWN_FIELDS,
  STATIC_FIELDS,
  DAILY_OPEN_FIELDS,
  DAILY_CLOSE_FIELDS,
  DAILY_STATIC_FIELDS,
  CONTEXT_OPEN_FIELDS,
  CONTEXT_CLOSE_FIELDS,
  buildLookaheadFreeQuery,
  buildOutcomeQuery,
  buildVixJoinClause,
  SCHEMA_DESCRIPTIONS,
  ensureMutableMarketTables,
  ensureMarketDataTables,
} from "../../src/test-exports.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBInstance as DuckDBInstanceType } from "@duckdb/node-api";

const dailyColumns = SCHEMA_DESCRIPTIONS.market.tables.enriched.columns;
const dateContextColumns = SCHEMA_DESCRIPTIONS.market.tables.enriched_context.columns;

describe("Field Classification", () => {
  test("every classified market.enriched column has a timing annotation", () => {
    for (const [name, desc] of Object.entries(dailyColumns) as [string, { timing?: string }][]) {
      if (name === "date" || name === "ticker") {
        expect(desc.timing).toBeUndefined();
        continue;
      }
      expect(desc.timing).toBeDefined();
      expect(["open", "close", "static"]).toContain(desc.timing);
    }
  });

  test("every classified market.enriched_context column has a timing annotation", () => {
    for (const [name, desc] of Object.entries(dateContextColumns) as [
      string,
      { timing?: string },
    ][]) {
      if (name === "date") {
        expect(desc.timing).toBeUndefined();
        continue;
      }
      expect(desc.timing).toBeDefined();
      expect(["open", "close", "static"]).toContain(desc.timing);
    }
  });

  test("date column has no timing annotation (enriched)", () => {
    expect(dailyColumns.date.timing).toBeUndefined();
  });

  test("date column has no timing annotation (enriched_context)", () => {
    expect(dateContextColumns.date.timing).toBeUndefined();
  });
});

describe("Derived Sets", () => {
  test("derived sets cover all classified columns across both tables", () => {
    const allClassified = new Set([...OPEN_KNOWN_FIELDS, ...CLOSE_KNOWN_FIELDS, ...STATIC_FIELDS]);

    // Get all classified columns from daily (exclude key columns without timing)
    const dailyClassified = Object.keys(dailyColumns).filter(
      (name) => name !== "date" && name !== "ticker",
    );
    const contextClassified = Object.keys(dateContextColumns).filter((name) => name !== "date");

    // Phase 75: VIX fields moved from the old context table to per-ticker enriched rows + cross-ticker
    // enriched_context. allClassified = 51 total (9 open + 39 close + 3 static).
    // dailyClassified = 27 (only schema-named enriched columns).
    // The additional 24 fields in allClassified are VIX ticker aliases (VIX_Open, VIX_Close, etc.)
    // and enriched_context columns (Vol_Regime, Term_Structure_State, etc.).
    expect(allClassified.size).toBe(51);
    for (const col of contextClassified) {
      expect(allClassified.has(col)).toBe(true);
    }

    // Every schema-described daily column should be in exactly one set
    for (const col of dailyClassified) {
      expect(allClassified.has(col)).toBe(true);
    }
  });

  test("derived sets are mutually exclusive", () => {
    // Check all three pairwise: open vs close, open vs static, close vs static
    for (const field of OPEN_KNOWN_FIELDS) {
      expect(CLOSE_KNOWN_FIELDS.has(field)).toBe(false);
      expect(STATIC_FIELDS.has(field)).toBe(false);
    }
    for (const field of CLOSE_KNOWN_FIELDS) {
      expect(OPEN_KNOWN_FIELDS.has(field)).toBe(false);
      expect(STATIC_FIELDS.has(field)).toBe(false);
    }
    for (const field of STATIC_FIELDS) {
      expect(OPEN_KNOWN_FIELDS.has(field)).toBe(false);
      expect(CLOSE_KNOWN_FIELDS.has(field)).toBe(false);
    }
  });

  test("OPEN_KNOWN_FIELDS has exactly 9 fields (5 daily + 4 VIX/derived)", () => {
    // Phase 75: VIX_RTH_Open removed (not in VIX_FIELD_MAPPINGS). VIX_Gap_Pct moved to date_context (open-known).
    expect(OPEN_KNOWN_FIELDS.size).toBe(9);
    // Daily open-known: open, Prior_Close, Gap_Pct, Prev_Return_Pct, Prior_Range_vs_ATR
    expect(DAILY_OPEN_FIELDS.size).toBe(5);
    // Context open-known: VIX_Open, VIX9D_Open, VIX3M_Open (3 VIX tickers) + VIX_Gap_Pct (from date_context) = 4
    expect(CONTEXT_OPEN_FIELDS.size).toBe(4);
  });

  test("CLOSE_KNOWN_FIELDS has exactly 39 fields (24 enriched + 15 VIX/derived)", () => {
    // Phase 75: VIX fields moved to per-ticker enriched rows + cross-ticker enriched_context.
    // Enriched close-derived: 16 Tier1 + 6 Tier3 + ivr/ivp on enriched = 24
    // VIX/derived close-derived: 11 VIX mapping close + 4 enriched_context close = 15
    expect(CLOSE_KNOWN_FIELDS.size).toBe(39);
    expect(DAILY_CLOSE_FIELDS.size).toBe(24);
    expect(CONTEXT_CLOSE_FIELDS.size).toBe(15);
  });

  test("STATIC_FIELDS has exactly 3 fields (all from enriched)", () => {
    expect(STATIC_FIELDS.size).toBe(3);
    expect(DAILY_STATIC_FIELDS.size).toBe(3);
  });

  // Specific classification correctness (guards against known pitfalls)
  test("Return_5D is close-derived (not open-known)", () => {
    expect(CLOSE_KNOWN_FIELDS.has("Return_5D")).toBe(true);
    expect(OPEN_KNOWN_FIELDS.has("Return_5D")).toBe(false);
  });

  test("Return_20D is close-derived (not open-known)", () => {
    expect(CLOSE_KNOWN_FIELDS.has("Return_20D")).toBe(true);
    expect(OPEN_KNOWN_FIELDS.has("Return_20D")).toBe(false);
  });

  test("Prev_Return_Pct is open-known (not close-derived)", () => {
    expect(OPEN_KNOWN_FIELDS.has("Prev_Return_Pct")).toBe(true);
    expect(CLOSE_KNOWN_FIELDS.has("Prev_Return_Pct")).toBe(false);
  });

  test("Prior_Range_vs_ATR is open-known (new field — prior day range/ATR known at open)", () => {
    expect(OPEN_KNOWN_FIELDS.has("Prior_Range_vs_ATR")).toBe(true);
    expect(CLOSE_KNOWN_FIELDS.has("Prior_Range_vs_ATR")).toBe(false);
  });

  test("Consecutive_Days is close-derived", () => {
    expect(CLOSE_KNOWN_FIELDS.has("Consecutive_Days")).toBe(true);
  });

  test("Realized_Vol_5D is close-derived", () => {
    expect(CLOSE_KNOWN_FIELDS.has("Realized_Vol_5D")).toBe(true);
    expect(OPEN_KNOWN_FIELDS.has("Realized_Vol_5D")).toBe(false);
  });

  test("Vol_Regime is close-derived (from market.enriched_context)", () => {
    expect(CLOSE_KNOWN_FIELDS.has("Vol_Regime")).toBe(true);
    expect(OPEN_KNOWN_FIELDS.has("Vol_Regime")).toBe(false);
    expect(CONTEXT_CLOSE_FIELDS.has("Vol_Regime")).toBe(true);
  });

  test("VIX_Open is open-known (from market.spot_daily VIX ticker rows)", () => {
    expect(OPEN_KNOWN_FIELDS.has("VIX_Open")).toBe(true);
    expect(CLOSE_KNOWN_FIELDS.has("VIX_Open")).toBe(false);
    expect(CONTEXT_OPEN_FIELDS.has("VIX_Open")).toBe(true);
  });

  test("VIX_Gap_Pct is open-known (from market.enriched_context)", () => {
    expect(OPEN_KNOWN_FIELDS.has("VIX_Gap_Pct")).toBe(true);
    expect(CLOSE_KNOWN_FIELDS.has("VIX_Gap_Pct")).toBe(false);
    expect(CONTEXT_OPEN_FIELDS.has("VIX_Gap_Pct")).toBe(true);
  });

  test("date and ticker are not in any derived set", () => {
    expect(OPEN_KNOWN_FIELDS.has("date")).toBe(false);
    expect(CLOSE_KNOWN_FIELDS.has("date")).toBe(false);
    expect(STATIC_FIELDS.has("date")).toBe(false);
    expect(OPEN_KNOWN_FIELDS.has("ticker")).toBe(false);
    expect(CLOSE_KNOWN_FIELDS.has("ticker")).toBe(false);
    expect(STATIC_FIELDS.has("ticker")).toBe(false);
  });
});

describe("buildLookaheadFreeQuery", () => {
  test("produces SQL with WITH joined AS and lagged AS CTEs", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain("WITH joined AS");
    expect(sql).toContain("lagged AS");
  });

  test("JOINs market.enriched with market.spot_daily target-ticker, buildVixJoinClause VIX, and market.enriched_context", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain("FROM market.enriched d");
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date",
    );
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily vix ON vix.date = d.date AND vix.ticker = 'VIX'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'",
    );
    expect(sql).toContain("LEFT JOIN market.enriched_context cd ON cd.date = d.date");
    expect(sql).not.toMatch(/market\.daily\b/);
    expect(sql).not.toMatch(/market\.date_context\b/);
  });

  test("passes open-known fields through without LAG", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    // Daily open-known fields should appear as plain identifiers, not wrapped in LAG()
    expect(sql).toContain('"Prior_Close"');
    expect(sql).toContain('"Gap_Pct"');
    // Context open-known fields should also pass through
    expect(sql).toContain('"VIX_Open"');
    // They should NOT be inside LAG() calls
    expect(sql).not.toMatch(/LAG\("Prior_Close"\)/);
    expect(sql).not.toMatch(/LAG\("Gap_Pct"\)/);
    expect(sql).not.toMatch(/LAG\("VIX_Open"\)/);
  });

  test("wraps close-derived fields in LAG() with PARTITION BY ticker", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain('LAG("close") OVER (PARTITION BY ticker ORDER BY date) AS "prev_close"');
    expect(sql).toContain(
      'LAG("RSI_14") OVER (PARTITION BY ticker ORDER BY date) AS "prev_RSI_14"',
    );
    // Context close-derived fields also get LAG
    expect(sql).toContain(
      'LAG("Vol_Regime") OVER (PARTITION BY ticker ORDER BY date) AS "prev_Vol_Regime"',
    );
    expect(sql).toContain(
      'LAG("VIX_Close") OVER (PARTITION BY ticker ORDER BY date) AS "prev_VIX_Close"',
    );
  });

  test("passes static fields through without LAG", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain('"Day_of_Week"');
    expect(sql).not.toMatch(/LAG\("Day_of_Week"\)/);
  });

  test("uses parameterized placeholders for dates", () => {
    const { sql, params } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain("$1");
    expect(params[0]).toBe("2025-01-06");
  });

  test("handles multiple dates with correct placeholders", () => {
    const dates = ["2025-01-06", "2025-01-07", "2025-01-08"];
    const { sql, params } = buildLookaheadFreeQuery(dates);
    expect(sql).toContain("$1, $2, $3");
    expect(params[0]).toBe("2025-01-06");
    expect(params[1]).toBe("2025-01-07");
    expect(params[2]).toBe("2025-01-08");
  });

  test("uses PARTITION BY ticker in LAG window (not calendar arithmetic)", () => {
    const { sql } = buildLookaheadFreeQuery(["2025-01-06"]);
    expect(sql).toContain("PARTITION BY ticker ORDER BY date");
    expect(sql).not.toContain("DATEADD");
    expect(sql).not.toContain("INTERVAL");
  });

  test("produces valid SQL with empty dates array", () => {
    const { sql, params } = buildLookaheadFreeQuery([]);
    // Empty input returns a no-match query instead of invalid WHERE date IN ()
    expect(sql).toContain("WHERE 1=0");
    expect(params).toEqual([]);
  });

  test("supports ticker+date lookup keys with ticker-partitioned LAG", () => {
    const { sql, params } = buildLookaheadFreeQuery([
      { ticker: "SPX", date: "2025-01-06" },
      { ticker: "MSFT", date: "2025-01-06" },
    ]);

    expect(sql).toContain("WITH requested(ticker, date) AS");
    expect(sql).toContain("PARTITION BY ticker ORDER BY date");
    expect(sql).toContain("lagged.ticker = requested.ticker");
    expect(sql).toContain("lagged.date = requested.date");
    expect(params).toEqual(["SPX", "2025-01-06", "MSFT", "2025-01-06"]);
  });

  test("ticker overload also JOINs market.enriched with market.spot_daily target, VIX double-JOIN, and market.enriched_context", () => {
    const { sql } = buildLookaheadFreeQuery([{ ticker: "SPX", date: "2025-01-06" }]);
    expect(sql).toContain("FROM market.enriched d");
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date",
    );
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily vix ON vix.date = d.date AND vix.ticker = 'VIX'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'",
    );
    expect(sql).toContain("LEFT JOIN market.enriched_context cd ON cd.date = d.date");
  });
});

describe("buildOutcomeQuery", () => {
  test("produces SELECT with close-derived fields from both tables", () => {
    const { sql } = buildOutcomeQuery(["2025-01-06"]);
    // Should include daily close-derived fields
    expect(sql).toContain('"close"');
    expect(sql).toContain('"RSI_14"');
    // Should include context close-derived fields
    expect(sql).toContain('"Vol_Regime"');
    expect(sql).toContain('"VIX_Close"');
  });

  test("queries from market.enriched with market.spot_daily target + VIX double-JOIN and market.enriched_context", () => {
    const { sql } = buildOutcomeQuery(["2025-01-06"]);
    expect(sql).toContain("FROM market.enriched d");
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date",
    );
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily vix ON vix.date = d.date AND vix.ticker = 'VIX'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'",
    );
    expect(sql).toContain("LEFT JOIN market.enriched_context cd ON cd.date = d.date");
    expect(sql).not.toMatch(/market\.daily\b/);
    expect(sql).not.toMatch(/market\.date_context\b/);
  });

  test("uses parameterized placeholders", () => {
    const { sql, params } = buildOutcomeQuery(["2025-01-06", "2025-01-07"]);
    expect(sql).toContain("$1, $2");
    expect(params[0]).toBe("2025-01-06");
    expect(params[1]).toBe("2025-01-07");
  });

  test("does NOT use LAG (returns same-day values)", () => {
    const { sql } = buildOutcomeQuery(["2025-01-06"]);
    expect(sql).not.toContain("LAG(");
    expect(sql).not.toContain("prev_");
  });

  test("includes all close-derived fields from both tables", () => {
    const { sql } = buildOutcomeQuery(["2025-01-06"]);
    // Count quoted field names — each CLOSE_KNOWN_FIELD should appear as "fieldName"
    for (const field of CLOSE_KNOWN_FIELDS) {
      expect(sql).toContain(`"${field}"`);
    }
  });

  test("should NOT include open-known or static fields", () => {
    const { sql } = buildOutcomeQuery(["2025-01-06"]);
    // Open-known and static fields should not be selected
    // (they are NOT in CLOSE_KNOWN_FIELDS, so not in the outcome query's close columns)
    // But note: these fields are selected with table aliases so just verify no Gap_Pct in select
    expect(sql).not.toContain('"Gap_Pct"');
    expect(sql).not.toContain('"Day_of_Week"');
    expect(sql).not.toContain('"VIX_Open"');
  });

  test("supports ticker+date outcome queries", () => {
    const { sql, params } = buildOutcomeQuery([
      { ticker: "SPX", date: "2025-01-06" },
      { ticker: "MSFT", date: "2025-01-07" },
    ]);

    expect(sql).toContain("WITH requested(ticker, date) AS");
    expect(sql).toContain("SELECT m.ticker, m.date");
    expect(sql).toContain("m.ticker = requested.ticker");
    expect(sql).toContain("m.date = requested.date");
    expect(params).toEqual(["SPX", "2025-01-06", "MSFT", "2025-01-07"]);
  });

  test("ticker+date path uses m/ms aliases consistently (no d. or s. references)", () => {
    const { sql } = buildOutcomeQuery([{ ticker: "SPX", date: "2025-01-06" }]);

    // VIX joins should reference m.date (not d.date) since base table alias is m
    expect(sql).toContain("vix9d.date = m.date");
    expect(sql).toContain("vix3m.date = m.date");
    // Must NOT contain corrupted alias "vix9m" (regression: regex replace turned vix9d.date into vix9m.date)
    expect(sql).not.toContain("vix9m");
    // Enrichment close columns must use m. prefix, OHLCV must use ms. prefix. No d. or s. at base.
    expect(sql).not.toMatch(/\bd\."(RSI_14|ATR_Pct)"/);
    expect(sql).not.toMatch(/\bs\."(high|low|close)"/);
    expect(sql).toContain('ms."high"');
    expect(sql).toContain('m."RSI_14"');
  });
});

// =============================================================================
// Phase 6 Plan 06-00 Task 2 — buildVixJoinClause pure helper
//
// Wave 1 (Plan 06-01) swapped buildLookaheadFreeQuery + buildOutcomeQuery over
// to this named export. The helper emits the post-Phase-6 double-JOIN shape:
// one market.spot_daily JOIN (for OHLCV columns) + one market.enriched JOIN
// (for ivr/ivp) per ticker alias.
// =============================================================================

describe("buildVixJoinClause", () => {
  test("emits spot_daily + enriched JOINs for each ticker alias", () => {
    const sql = buildVixJoinClause(["vix", "vix9d"], "d");
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily vix ON vix.date = d.date AND vix.ticker = 'VIX'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.spot_daily vix9d ON vix9d.date = d.date AND vix9d.ticker = 'VIX9D'",
    );
    expect(sql).toContain(
      "LEFT JOIN market.enriched evix9d ON evix9d.date = d.date AND evix9d.ticker = 'VIX9D'",
    );
    expect(sql).not.toMatch(/market\.daily/);
    expect(sql).not.toMatch(/market\.date_context/);
  });

  test("uses custom baseAlias when provided", () => {
    const sql = buildVixJoinClause(["vix"], "m");
    expect(sql).toContain("vix.date = m.date");
    expect(sql).toContain("evix.date = m.date");
  });

  test("emits correct UPPER-cased ticker literal", () => {
    const sql = buildVixJoinClause(["vix3m"], "d");
    expect(sql).toContain("vix3m.ticker = 'VIX3M'");
  });
});

// =============================================================================
// Session-bounded LAG source (Worf gate rework, #2871 round 2)
//
// market.enriched can contain all-null non-session identity rows (Tier 3
// timing writes / working-table backfill publish them). LAG() over the
// unfiltered history made the first genuine session after such a row lag to
// NULL on enrichment-derived fields and to the holiday's own close on OHLCV
// fields joined from market.spot_daily. The lookahead-free contract requires
// LAG to consume only genuine XNYS sessions inside the calendar revision's
// supported range; out-of-range rows stay consumed (the calendar has no
// opinion there).
// =============================================================================

describe("buildLookaheadFreeQuery session-bounded LAG source", () => {
  let db: DuckDBInstanceType;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMutableMarketTables(conn);
    await ensureMarketDataTables(conn);
    await conn.run(`
      CREATE OR REPLACE VIEW market.spot_daily AS
        SELECT ticker, date,
               first(open ORDER BY time) AS open,
               max(high)                 AS high,
               min(low)                  AS low,
               last(close ORDER BY time) AS close,
               first(bid ORDER BY time)  AS bid,
               last(ask ORDER BY time)   AS ask
        FROM market.spot
        WHERE time >= '09:30' AND time <= '16:00'
        GROUP BY ticker, date
    `);
    const spotBars: Array<[string, number]> = [
      ["2022-05-27", 4158.24], // last genuine session before the closure
      ["2022-05-28", 4200.0], // priced Saturday partition — never a session
      ["2022-05-30", 4148.5], // priced Memorial Day partition
      ["2022-05-31", 4132.0], // first session after the closure
    ];
    for (const [date, close] of spotBars) {
      await conn.run(
        `INSERT INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
         VALUES ('SPX', $1, '09:30', $2 - 1, $2 + 2, $2 - 2, $2, NULL, NULL)`,
        [date, close],
      );
    }
    // The 2022-05-28 and 2022-05-30 enriched rows are all-null identity rows —
    // exactly what Tier 3 / backfill mechanics leave behind for non-session
    // dates (weekend AND full-day closure).
    await conn.run(`
      INSERT INTO market.enriched (ticker, date, RSI_14) VALUES
        ('SPX', '2022-05-27', 55.5),
        ('SPX', '2022-05-28', NULL),
        ('SPX', '2022-05-30', NULL),
        ('SPX', '2022-05-31', 61.25)
    `);
  });

  afterEach(() => {
    try {
      conn.closeSync();
    } catch {
      /* */
    }
    try {
      db.closeSync();
    } catch {
      /* */
    }
  });

  async function queryRecords(
    keys: Array<{ ticker: string; date: string }>,
  ): Promise<Array<Record<string, unknown>>> {
    const { sql, params } = buildLookaheadFreeQuery(keys);
    const reader = await conn.runAndReadAll(sql, params);
    const names = Array.from({ length: reader.columnCount }, (_, i) => reader.columnName(i));
    return Array.from(reader.getRows(), (row) =>
      Object.fromEntries(names.map((name, i) => [name, row[i]])),
    );
  }

  test("first session after an all-null closure identity row lags to the prior SESSION", async () => {
    const records = await queryRecords([{ ticker: "SPX", date: "2022-05-31" }]);
    expect(records).toHaveLength(1);
    // Enrichment-derived close field: Friday's RSI, NOT the identity row's null.
    expect(Number(records[0].prev_RSI_14)).toBeCloseTo(55.5, 6);
    // OHLCV close field joined from spot_daily: Friday's close, NOT the holiday's 4148.5.
    expect(Number(records[0].prev_close)).toBeCloseTo(4158.24, 6);
  });

  test("requested non-session identity row keeps its output row, priors null", async () => {
    // Only the LAG input set changes. A requested closure identity row still
    // returns its row (presence preserved), but it is excluded from the LAG
    // source set itself, so its prev_* lookups are NULL — there is no
    // meaningful prior-session value for a day the market was closed.
    const records = await queryRecords([{ ticker: "SPX", date: "2022-05-30" }]);
    expect(records).toHaveLength(1);
    expect(records[0].prev_RSI_14 ?? null).toBeNull();
    expect(records[0].prev_close ?? null).toBeNull();
  });

  test("out-of-range dates stay LAG-consumed (bounded-calendar keep-doctrine)", async () => {
    // 2021-12-26 is a Sunday outside the calendar revision: the calendar has
    // no opinion there, so the row must keep feeding the lag chain exactly as
    // before — documented limitation, guarded against over-exclusion.
    await conn.run(
      `INSERT INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('SPX', '2021-12-26', '09:30', 99, 102, 98, 101, NULL, NULL)`,
    );
    await conn.run(`
      INSERT INTO market.enriched (ticker, date, RSI_14) VALUES
        ('SPX', '2021-12-26', 40.0),
        ('SPX', '2022-01-03', 41.0)
    `);
    const records = await queryRecords([{ ticker: "SPX", date: "2022-01-03" }]);
    expect(records).toHaveLength(1);
    expect(Number(records[0].prev_RSI_14)).toBeCloseTo(40.0, 6);
  });
});
