/**
 * Unit tests for enriched SQL builder (Phase 2 Wave 1 — Plan 02-01).
 *
 * Confirms the four include-flag combinations emit the correct set of
 * JOINs + columns. Values are inlined as SQL literals (no positional
 * placeholders) — see `spot-sql.ts` header for the extract_statements
 * GC leak rationale.
 */
import { describe, it, expect } from "@jest/globals";
import { buildReadEnrichedSQL } from "../../../../src/test-exports.js";

describe("buildReadEnrichedSQL", () => {
  const base = { ticker: "SPX", from: "2025-01-01", to: "2025-01-06" } as const;

  it("queries market.enriched aliased as `e` with inlined literals and orders by date", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: false, includeContext: false });
    expect(sql).toContain("FROM market.enriched e");
    expect(sql).toContain("e.ticker = 'SPX'");
    expect(sql).toContain("e.date >= '2025-01-01'");
    expect(sql).toContain("e.date <= '2025-01-06'");
    expect(sql).toContain("ORDER BY e.date");
  });

  it("inlines [ticker, from, to] in every include-flag variant", () => {
    const variants = [
      { includeOhlcv: false, includeContext: false },
      { includeOhlcv: true, includeContext: false },
      { includeOhlcv: false, includeContext: true },
      { includeOhlcv: true, includeContext: true },
    ] as const;

    for (const v of variants) {
      const { sql } = buildReadEnrichedSQL({ ...base, ...v });
      expect(sql).toContain("'SPX'");
      expect(sql).toContain("'2025-01-01'");
      expect(sql).toContain("'2025-01-06'");
      expect(sql).not.toMatch(/\$\d/);
    }
  });

  it("omits the OHLCV join subquery when includeOhlcv=false", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: false, includeContext: false });
    expect(sql).not.toContain("s_daily");
    expect(sql).not.toContain("first(open  ORDER BY time)");
  });

  it("adds the RTH daily-aggregate subquery when includeOhlcv=true", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: true, includeContext: false });
    expect(sql).toContain("LEFT JOIN");
    expect(sql).toContain("first(open  ORDER BY time)");
    expect(sql).toContain("last(close  ORDER BY time)");
    expect(sql).toContain("s_daily");
    expect(sql).toContain("s_daily.ticker = e.ticker");
    expect(sql).toContain("s_daily.date = e.date");
    // The OHLCV columns are projected alongside e.*
    expect(sql).toContain("s_daily.open");
    expect(sql).toContain("s_daily.high");
    expect(sql).toContain("s_daily.low");
    expect(sql).toContain("s_daily.close");
    // Must NOT use window FIRST_VALUE
    expect(sql).not.toMatch(/FIRST_VALUE/i);
  });

  it("omits the enriched_context join when includeContext=false", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: false, includeContext: false });
    expect(sql).not.toContain("market.enriched_context");
    expect(sql).not.toContain("Vol_Regime");
  });

  it("adds the enriched_context join + selected context columns when includeContext=true", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: false, includeContext: true });
    expect(sql).toContain("LEFT JOIN market.enriched_context c");
    expect(sql).toContain("c.date = e.date");
    expect(sql).toContain("c.Vol_Regime");
    expect(sql).toContain("c.Term_Structure_State");
    expect(sql).toContain("c.Trend_Direction");
  });

  it("combines both JOINs when both flags are true", () => {
    const { sql } = buildReadEnrichedSQL({ ...base, includeOhlcv: true, includeContext: true });
    expect(sql).toContain("s_daily");
    expect(sql).toContain("market.enriched_context");
    expect(sql).toContain("s_daily.open");
    expect(sql).toContain("c.Vol_Regime");
  });

  it("inlines the same ticker/date literals inside the OHLCV subquery", () => {
    const { sql } = buildReadEnrichedSQL({
      ...base,
      includeOhlcv: true,
      includeContext: false,
    });
    // Subquery and outer WHERE both reference inlined values; no positional params anywhere.
    expect(sql).not.toMatch(/\$\d/);
    // The inlined literals appear at least twice (outer + inner) when OHLCV is included.
    const tickerMatches = sql.match(/'SPX'/g) ?? [];
    expect(tickerMatches.length).toBeGreaterThanOrEqual(2);
  });
});
