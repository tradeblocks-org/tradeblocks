/**
 * Unit tests for spot SQL builders (Phase 2 Wave 1 — Plan 02-01).
 *
 * These builders are pure: they emit `{ sql }` with all values inlined as
 * SQL literals. Tests therefore exercise literal-presence assertions on the
 * emitted string — no fixture, no connection.
 *
 * Why inline literals: the DuckDB Node-API binding leaks C++ handles on every
 * `runAndReadAll(sql, params)` call (see `spot-sql.ts` header). The builders
 * use inline literals to kill the leak at the source.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildReadBarsSQL,
  buildReadDailyBarsSQL,
  buildReadRthOpensSQL,
} from "../../../../src/test-exports.js";

describe("spot-sql builders", () => {
  describe("buildReadBarsSQL", () => {
    it("queries market.spot with inlined ticker/from/to literals", () => {
      const { sql } = buildReadBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).toContain("FROM market.spot");
      expect(sql).toContain("ticker = 'SPX'");
      expect(sql).toContain("date >= '2025-01-01'");
      expect(sql).toContain("date <= '2025-01-06'");
    });

    it("emits no positional placeholders (leak-free runAndReadAll path)", () => {
      const { sql } = buildReadBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).not.toMatch(/\$\d/);
    });

    it("orders results deterministically by (date, time)", () => {
      const { sql } = buildReadBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).toContain("ORDER BY date, time");
    });

    it("selects the expected column set", () => {
      const { sql } = buildReadBarsSQL("SPX", "2025-01-01", "2025-01-06");
      // Spot bars contain OHLCV-ish columns + bid/ask minute-level quotes.
      for (const col of ["ticker", "date", "time", "open", "high", "low", "close", "bid", "ask"]) {
        expect(sql).toContain(col);
      }
    });

    it("escapes embedded single quotes in ticker/date inputs", () => {
      const { sql } = buildReadBarsSQL("SP'X", "2025-01-01", "2025-01-06");
      expect(sql).toContain("ticker = 'SP''X'");
      expect(sql).not.toMatch(/\$\d/);
    });
  });

  describe("buildReadDailyBarsSQL", () => {
    it("uses DuckDB aggregate first/last with ORDER BY (NOT window FIRST_VALUE)", () => {
      const { sql } = buildReadDailyBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).toContain("first(open  ORDER BY time)");
      expect(sql).toContain("last(close  ORDER BY time)");
      expect(sql).toContain("max(high)");
      expect(sql).toContain("min(low)");
      expect(sql).not.toMatch(/FIRST_VALUE/i);
      expect(sql).not.toMatch(/LAST_VALUE/i);
    });

    it("groups by ticker/date and filters to the RTH window", () => {
      const { sql } = buildReadDailyBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).toContain("GROUP BY ticker, date");
      expect(sql).toContain("time >= '09:30'");
      expect(sql).toContain("time <= '16:00'");
      expect(sql).toContain("ticker = 'SPX'");
      expect(sql).toContain("date >= '2025-01-01'");
      expect(sql).toContain("date <= '2025-01-06'");
    });

    it("queries from market.spot (single source of truth)", () => {
      const { sql } = buildReadDailyBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).toContain("FROM market.spot");
    });

    it("emits no positional placeholders (leak-free runAndReadAll path)", () => {
      const { sql } = buildReadDailyBarsSQL("SPX", "2025-01-01", "2025-01-06");
      expect(sql).not.toMatch(/\$\d/);
    });
  });

  describe("buildReadRthOpensSQL", () => {
    it("projects date+open aggregate over RTH window", () => {
      const { sql } = buildReadRthOpensSQL("VIX", "2025-01-01", "2025-01-31");
      expect(sql).toContain("first(open ORDER BY time)");
      expect(sql).toContain("FROM market.spot");
      expect(sql).toContain("GROUP BY date");
      expect(sql).toContain("time >= '09:30'");
      expect(sql).toContain("time <= '16:00'");
      expect(sql).toContain("ticker = 'VIX'");
      expect(sql).toContain("date >= '2025-01-01'");
      expect(sql).toContain("date <= '2025-01-31'");
    });

    it("emits no positional placeholders (leak-free runAndReadAll path)", () => {
      const { sql } = buildReadRthOpensSQL("VIX", "2025-01-01", "2025-01-31");
      expect(sql).not.toMatch(/\$\d/);
    });
  });
});
