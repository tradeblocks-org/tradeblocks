/**
 * Integration tests for `validateColumnMapping`.
 *
 * Earlier iterations of this file also tested `importMarketCsvFile(conn, ...)`
 * and `importFromDatabase(conn, ...)` directly, but both signatures were
 * removed alongside the legacy `target_table`-driven write path. The new
 * stores-based contract is exercised by `market-imports-v2.test.ts`
 * (integration) and `tests/unit/market-imports.test.ts` (unit).
 *
 * `validateColumnMapping` survives unchanged — pure helper, still useful for
 * any future caller that wants to fail fast on a missing schema field.
 */
// @ts-expect-error - importing from bundled output
import { validateColumnMapping } from "../../src/test-exports.js";

// =============================================================================
// validateColumnMapping — pure function, no DB needed
// =============================================================================

describe("validateColumnMapping", () => {
  describe("daily table", () => {
    it("accepts valid daily mapping with all required fields", () => {
      const mapping = {
        time: "date",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
      };
      const result = validateColumnMapping(mapping, "daily");
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
    });

    it("rejects daily mapping missing open, high, low, close", () => {
      const mapping = { time: "date" }; // only date mapped
      const result = validateColumnMapping(mapping, "daily");
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain("open");
      expect(result.missingFields).toContain("high");
      expect(result.missingFields).toContain("low");
      expect(result.missingFields).toContain("close");
    });

    it("rejects daily mapping missing only the date field", () => {
      const mapping = { o: "open", h: "high", l: "low", c: "close" };
      const result = validateColumnMapping(mapping, "daily");
      expect(result.valid).toBe(false);
      expect(result.missingFields).toEqual(["date"]);
    });
  });

  describe("date_context table", () => {
    it("accepts valid date_context mapping with only date", () => {
      const mapping = { trade_date: "date", vix: "VIX_Close" };
      const result = validateColumnMapping(mapping, "date_context");
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
    });

    it("rejects date_context mapping missing date", () => {
      const mapping = { vix: "VIX_Close" }; // no date mapped
      const result = validateColumnMapping(mapping, "date_context");
      expect(result.valid).toBe(false);
      expect(result.missingFields).toEqual(["date"]);
    });
  });

  describe("intraday table", () => {
    it("accepts valid intraday mapping with all required fields", () => {
      const mapping = {
        ts: "date",
        t: "time",
        o: "open",
        h: "high",
        l: "low",
        c: "close",
      };
      const result = validateColumnMapping(mapping, "intraday");
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
    });

    it("accepts intraday mapping without time when date is mapped (auto-derived from Unix timestamp)", () => {
      const mapping = {
        ts: "date",
        o: "open",
        h: "high",
        l: "low",
        c: "close",
        // time is intentionally missing — auto-derived from Unix timestamp in date column
      };
      const result = validateColumnMapping(mapping, "intraday");
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
    });
  });
});
