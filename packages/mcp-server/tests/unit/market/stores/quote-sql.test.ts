/**
 * Unit tests for quote SQL builder (Phase 2 Wave 1 — Plan 02-01).
 *
 * The quote builder emits a multi-ticker IN (...) clause with inlined SQL
 * literals (no positional placeholders — see `spot-sql.ts` header for the
 * extract_statements GC leak rationale).
 */
import { describe, it, expect } from "@jest/globals";
import { buildReadQuotesSQL } from "../../../../src/test-exports.ts";

describe("buildReadQuotesSQL", () => {
  it("queries market.option_quote_minutes with inlined underlying + date range", () => {
    const { sql } = buildReadQuotesSQL(
      "SPX",
      ["SPXW251219C05000000"],
      "2025-01-01",
      "2025-01-02",
    );
    expect(sql).toContain("FROM market.option_quote_minutes");
    expect(sql).toContain("underlying = 'SPX'");
    expect(sql).toContain("date >= '2025-01-01'");
    expect(sql).toContain("date <= '2025-01-02'");
    expect(sql).toContain("ticker IN ('SPXW251219C05000000')");
  });

  it("emits no positional placeholders (leak-free runAndReadAll path)", () => {
    const { sql } = buildReadQuotesSQL(
      "SPX",
      ["SPXW251219C05000000", "SPXW251219P05000000"],
      "2025-01-01",
      "2025-01-02",
    );
    expect(sql).not.toMatch(/\$\d/);
  });

  it("inlines a comma-separated IN list for a two-ticker basket", () => {
    const { sql } = buildReadQuotesSQL(
      "SPX",
      ["SPXW251219C05000000", "SPXW251219P05000000"],
      "2025-01-01",
      "2025-01-02",
    );
    expect(sql).toContain("ticker IN ('SPXW251219C05000000', 'SPXW251219P05000000')");
  });

  it("scales the IN list correctly for a five-ticker basket", () => {
    const occTickers = [
      "SPXW251219C05000000",
      "SPXW251219C05100000",
      "SPXW251219C05200000",
      "SPXW251219P04900000",
      "SPXW251219P04800000",
    ];
    const { sql } = buildReadQuotesSQL("SPX", occTickers, "2025-01-01", "2025-01-02");
    for (const t of occTickers) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toContain("ticker IN (");
  });

  it("orders results by (ticker, date, time) for grouped-series consumers", () => {
    const { sql } = buildReadQuotesSQL("SPX", ["SPXW251219C05000000"], "2025-01-01", "2025-01-02");
    expect(sql).toContain("ORDER BY ticker, date, time");
  });

  it("projects quote columns the QuoteRow shape expects", () => {
    const { sql } = buildReadQuotesSQL("SPX", ["SPXW251219C05000000"], "2025-01-01", "2025-01-02");
    for (const col of ["ticker", "date", "time", "bid", "ask"]) {
      expect(sql).toContain(col);
    }
  });

  it("projects quote rate and gamma provenance columns after greek provenance", () => {
    const { sql } = buildReadQuotesSQL("SPX", ["SPXW251219C05000000"], "2025-01-01", "2025-01-02");
    const normalized = sql.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "greeks_source, greeks_revision, rate_type, rate_value, gamma_source",
    );
    expect(sql).toContain("FROM market.option_quote_minutes");
  });

  it("inlines an optional time-window filter when timeStart/timeEnd are supplied", () => {
    const { sql } = buildReadQuotesSQL(
      "SPX",
      ["SPXW251219C05000000"],
      "2025-01-01",
      "2025-01-02",
      { timeStart: "09:30", timeEnd: "09:35" },
    );
    expect(sql).toContain("time >= '09:30'");
    expect(sql).toContain("time <= '09:35'");
  });


  it("throws when occTickers is empty (avoids emitting invalid `ticker IN ()`)", () => {
    expect(() => buildReadQuotesSQL("SPX", [], "2025-01-01", "2025-01-02")).toThrow(
      /must not be empty/,
    );
  });
});
