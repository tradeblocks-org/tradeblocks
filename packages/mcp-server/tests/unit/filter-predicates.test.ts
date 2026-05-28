/**
 * Unit tests for filter-predicates utility module.
 * Tests buildFilterPredicate with various filter configurations.
 */

import { buildFilterPredicate } from "../../src/test-exports.ts";
import type { EntryFilter } from "../../src/test-exports.ts";

describe("buildFilterPredicate", () => {
  describe("lag detection", () => {
    it("applies prev_ prefix for close-derived fields (VIX_Close)", () => {
      const filter: EntryFilter = { field: "VIX_Close", operator: "<", value: 20 };
      const pred = buildFilterPredicate(filter);
      expect(pred.isLagged).toBe(true);
      expect(pred.fieldKey).toBe("prev_VIX_Close");
    });

    it("does not apply prev_ prefix for open-known fields (Gap_Pct)", () => {
      const filter: EntryFilter = { field: "Gap_Pct", operator: ">", value: 0.5 };
      const pred = buildFilterPredicate(filter);
      expect(pred.isLagged).toBe(false);
      expect(pred.fieldKey).toBe("Gap_Pct");
    });

    it("does not apply prev_ prefix for static fields (Day_of_Week)", () => {
      const filter: EntryFilter = { field: "Day_of_Week", operator: "in", value: [1, 2, 3] };
      const pred = buildFilterPredicate(filter);
      expect(pred.isLagged).toBe(false);
      expect(pred.fieldKey).toBe("Day_of_Week");
    });

    it("applies prev_ prefix for RSI_14 (close-derived daily field)", () => {
      const filter: EntryFilter = { field: "RSI_14", operator: "<", value: 30 };
      const pred = buildFilterPredicate(filter);
      expect(pred.isLagged).toBe(true);
      expect(pred.fieldKey).toBe("prev_RSI_14");
    });
  });

  describe("comparison operators", () => {
    it("< operator: returns true when value is less", () => {
      const pred = buildFilterPredicate({ field: "VIX_Close", operator: "<", value: 20 });
      expect(pred.test({ prev_VIX_Close: 15 })).toBe(true);
      expect(pred.test({ prev_VIX_Close: 25 })).toBe(false);
      expect(pred.test({ prev_VIX_Close: 20 })).toBe(false);
    });

    it("> operator: returns true when value is greater", () => {
      const pred = buildFilterPredicate({ field: "Gap_Pct", operator: ">", value: 0.5 });
      expect(pred.test({ Gap_Pct: 1.0 })).toBe(true);
      expect(pred.test({ Gap_Pct: 0.3 })).toBe(false);
    });

    it(">= operator", () => {
      const pred = buildFilterPredicate({ field: "Gap_Pct", operator: ">=", value: 0.5 });
      expect(pred.test({ Gap_Pct: 0.5 })).toBe(true);
      expect(pred.test({ Gap_Pct: 0.4 })).toBe(false);
    });

    it("<= operator", () => {
      const pred = buildFilterPredicate({ field: "VIX_Close", operator: "<=", value: 20 });
      expect(pred.test({ prev_VIX_Close: 20 })).toBe(true);
      expect(pred.test({ prev_VIX_Close: 21 })).toBe(false);
    });
  });

  describe("== operator", () => {
    it("works for numeric equality", () => {
      const pred = buildFilterPredicate({ field: "Vol_Regime", operator: "==", value: 3 });
      expect(pred.test({ prev_Vol_Regime: 3 })).toBe(true);
      expect(pred.test({ prev_Vol_Regime: 4 })).toBe(false);
    });

    it("works for string equality", () => {
      const pred = buildFilterPredicate({ field: "Vol_Regime", operator: "==", value: "3" });
      // loose equality: "3" == 3 should be true
      expect(pred.test({ prev_Vol_Regime: 3 })).toBe(true);
    });
  });

  describe("between operator", () => {
    it("returns true when value is within range (inclusive)", () => {
      const pred = buildFilterPredicate({ field: "RSI_14", operator: "between", value: [15, 25] });
      expect(pred.test({ prev_RSI_14: 20 })).toBe(true);
      expect(pred.test({ prev_RSI_14: 15 })).toBe(true);
      expect(pred.test({ prev_RSI_14: 25 })).toBe(true);
    });

    it("returns false when value is outside range", () => {
      const pred = buildFilterPredicate({ field: "RSI_14", operator: "between", value: [15, 25] });
      expect(pred.test({ prev_RSI_14: 10 })).toBe(false);
      expect(pred.test({ prev_RSI_14: 30 })).toBe(false);
    });
  });

  describe("in operator", () => {
    it("returns true when value is in array (numbers)", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "in", value: [1, 2, 3] });
      expect(pred.test({ Day_of_Week: 2 })).toBe(true);
      expect(pred.test({ Day_of_Week: 5 })).toBe(false);
    });

    it("returns true when value is in array (strings)", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "in", value: ["1", "2", "3"] });
      // loose equality should allow numeric match
      expect(pred.test({ Day_of_Week: 2 })).toBe(true);
    });
  });

  describe("cross-field references", () => {
    it("< operator with cross-field ref: VIX_Open < prev_VIX_Close", () => {
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "<",
        value: "prev_VIX_Close",
        description: "VIX O/N Move Down",
      });
      // VIX_Open is open-known (no lag), value references prev_VIX_Close directly
      expect(pred.fieldKey).toBe("VIX_Open");
      expect(pred.test({ VIX_Open: 18, prev_VIX_Close: 20 })).toBe(true);
      expect(pred.test({ VIX_Open: 22, prev_VIX_Close: 20 })).toBe(false);
      expect(pred.test({ VIX_Open: 20, prev_VIX_Close: 20 })).toBe(false);
    });

    it("> operator with cross-field ref: Gap_Pct > Prior_Range_vs_ATR", () => {
      const pred = buildFilterPredicate({
        field: "Gap_Pct",
        operator: ">",
        value: "Prior_Range_vs_ATR",
      });
      expect(pred.test({ Gap_Pct: 1.5, Prior_Range_vs_ATR: 1.0 })).toBe(true);
      expect(pred.test({ Gap_Pct: 0.5, Prior_Range_vs_ATR: 1.0 })).toBe(false);
    });

    it(">= operator with cross-field ref", () => {
      const pred = buildFilterPredicate({
        field: "Gap_Pct",
        operator: ">=",
        value: "Prior_Range_vs_ATR",
      });
      expect(pred.test({ Gap_Pct: 1.0, Prior_Range_vs_ATR: 1.0 })).toBe(true);
      expect(pred.test({ Gap_Pct: 0.9, Prior_Range_vs_ATR: 1.0 })).toBe(false);
    });

    it("<= operator with cross-field ref", () => {
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "<=",
        value: "prev_VIX_Close",
      });
      expect(pred.test({ VIX_Open: 20, prev_VIX_Close: 20 })).toBe(true);
      expect(pred.test({ VIX_Open: 21, prev_VIX_Close: 20 })).toBe(false);
    });

    it("== operator with cross-field ref", () => {
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "==",
        value: "prev_VIX_Close",
      });
      expect(pred.test({ VIX_Open: 20, prev_VIX_Close: 20 })).toBe(true);
      expect(pred.test({ VIX_Open: 19, prev_VIX_Close: 20 })).toBe(false);
    });

    it("resolves bare close-derived field name to prev_ prefixed key", () => {
      // Value is "VIX_Close" (close-derived) but record has "prev_VIX_Close"
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "<",
        value: "VIX_Close",
      });
      expect(pred.test({ VIX_Open: 18, prev_VIX_Close: 20 })).toBe(true);
      expect(pred.test({ VIX_Open: 22, prev_VIX_Close: 20 })).toBe(false);
    });

    it("returns false when referenced field is missing from record", () => {
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "<",
        value: "NonExistentField",
      });
      expect(pred.test({ VIX_Open: 18 })).toBe(false);
    });

    it("returns false when referenced field value is null", () => {
      const pred = buildFilterPredicate({
        field: "VIX_Open",
        operator: "<",
        value: "prev_VIX_Close",
      });
      expect(pred.test({ VIX_Open: 18, prev_VIX_Close: null })).toBe(false);
    });

    it("numeric string values are NOT treated as field references", () => {
      // "20" is a numeric string, should be treated as literal 20
      const pred = buildFilterPredicate({
        field: "VIX_Close",
        operator: "<",
        value: "20",
      });
      expect(pred.test({ prev_VIX_Close: 15 })).toBe(true);
      expect(pred.test({ prev_VIX_Close: 25 })).toBe(false);
    });
  });

  describe("day-of-week name resolution", () => {
    it("== operator resolves day name to number", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "==", value: "Tuesday" });
      expect(pred.test({ Day_of_Week: 2 })).toBe(true);
      expect(pred.test({ Day_of_Week: 3 })).toBe(false);
    });

    it("== operator is case-insensitive for day names", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "==", value: "friday" });
      expect(pred.test({ Day_of_Week: 5 })).toBe(true);
    });

    it("== operator handles short day names", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "==", value: "Wed" });
      expect(pred.test({ Day_of_Week: 3 })).toBe(true);
    });

    it("in operator resolves day names in array", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "in", value: ["Monday", "Wednesday", "Friday"] });
      expect(pred.test({ Day_of_Week: 1 })).toBe(true);
      expect(pred.test({ Day_of_Week: 3 })).toBe(true);
      expect(pred.test({ Day_of_Week: 5 })).toBe(true);
      expect(pred.test({ Day_of_Week: 2 })).toBe(false);
    });

    it("in operator handles mixed day names and numbers", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "in", value: ["Tuesday", 4] });
      expect(pred.test({ Day_of_Week: 2 })).toBe(true);
      expect(pred.test({ Day_of_Week: 4 })).toBe(true);
      expect(pred.test({ Day_of_Week: 1 })).toBe(false);
    });
  });

  describe("NaN / null / undefined handling", () => {
    it("returns false when field value is NaN", () => {
      const pred = buildFilterPredicate({ field: "VIX_Close", operator: "<", value: 20 });
      expect(pred.test({ prev_VIX_Close: NaN })).toBe(false);
    });

    it("returns false when field value is null", () => {
      const pred = buildFilterPredicate({ field: "VIX_Close", operator: "<", value: 20 });
      expect(pred.test({ prev_VIX_Close: null })).toBe(false);
    });

    it("returns false when field value is undefined (missing key)", () => {
      const pred = buildFilterPredicate({ field: "VIX_Close", operator: "<", value: 20 });
      expect(pred.test({})).toBe(false);
    });

    it("returns false for NaN with between operator", () => {
      const pred = buildFilterPredicate({ field: "RSI_14", operator: "between", value: [15, 25] });
      expect(pred.test({ prev_RSI_14: NaN })).toBe(false);
    });

    it("returns false for null with in operator", () => {
      const pred = buildFilterPredicate({ field: "Day_of_Week", operator: "in", value: [1, 2, 3] });
      expect(pred.test({ Day_of_Week: null })).toBe(false);
    });
  });
});
