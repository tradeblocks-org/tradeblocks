/**
 * Unit tests for the Phase 5 enrichment verification helper (VALIDATION tasks
 * 5-00-02 and 5-00-03).
 *
 * Covers:
 *   - D-09 tolerance boundary (DOUBLE 1e-9 inclusive, INTEGER exact, VARCHAR
 *     case-sensitive)
 *   - Null handling (both null PASS, null-vs-value FAIL)
 *   - NaN handling on DOUBLE (both NaN PASS, NaN-vs-number FAIL)
 *   - D-11 failure aggregation (single drift → anyFailure=true)
 *   - Field-type registry shape (ENRICHED vs. CONTEXT)
 *
 * Pure unit — no DuckDB, no filesystem, no provider.
 *
 * Imports via `../../src/test-exports.js` per Phase 4 D-31 (test-exports is
 * the canonical barrel; Task 3 of Plan 05-00 wires the Phase 5 exports in
 * BEFORE the ext.js wildcard).
 */
import { describe, it, expect } from "@jest/globals";
// Imports flow through the test-exports barrel per Phase 4 D-31 — the Phase 5
// block in test-exports.ts MUST appear BEFORE the ext.js wildcard (Pitfall 10).
import {
  compareFields,
  compareRow,
  DOUBLE_EPSILON,
  ENRICHED_FIELD_TYPES,
  CONTEXT_FIELD_TYPES,
  type FieldDiff,
  type RowDiff,
} from "../../src/test-exports.ts";

describe("compareFields tolerance gate (D-09)", () => {
  it("DOUBLE_EPSILON is exactly 1e-9", () => {
    expect(DOUBLE_EPSILON).toBe(1e-9);
  });

  it("DOUBLE: |a - b| == 1e-9 is PASS (boundary is inclusive)", () => {
    const out = compareFields({ RSI_14: 50.0 }, { RSI_14: 50.0 + 1e-9 }, { RSI_14: "double" });
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(true);
    expect(out[0].type).toBe("double");
    // Floating-point subtraction may land at exactly 1e-9 or very close; both accepted.
    expect(out[0].delta).toBeLessThanOrEqual(1e-9 + 1e-20);
  });

  it("DOUBLE: |a - b| == 2e-9 is FAIL (above boundary)", () => {
    const out = compareFields({ RSI_14: 50.0 }, { RSI_14: 50.0 + 2e-9 }, { RSI_14: "double" });
    expect(out[0].passed).toBe(false);
  });

  it("DOUBLE: exact equal (delta 0) is PASS", () => {
    const out = compareFields({ Gap_Pct: 0.01 }, { Gap_Pct: 0.01 }, { Gap_Pct: "double" });
    expect(out[0].passed).toBe(true);
    expect(out[0].delta).toBe(0);
  });

  it("INTEGER: any difference is FAIL (no tolerance)", () => {
    const out = compareFields({ Gap_Filled: 1 }, { Gap_Filled: 0 }, { Gap_Filled: "integer" });
    expect(out[0].passed).toBe(false);
    expect(out[0].type).toBe("integer");
  });

  it("INTEGER: exact equal is PASS", () => {
    const out = compareFields({ Is_Opex: 1 }, { Is_Opex: 1 }, { Is_Opex: "integer" });
    expect(out[0].passed).toBe(true);
  });

  it("VARCHAR: exact string match only (case-sensitive)", () => {
    const out = compareFields(
      { Trend_Direction: "bull" },
      { Trend_Direction: "Bull" },
      { Trend_Direction: "varchar" },
    );
    expect(out[0].passed).toBe(false);
    expect(out[0].type).toBe("varchar");
  });

  it("VARCHAR: identical string is PASS", () => {
    const out = compareFields(
      { Trend_Direction: "bull" },
      { Trend_Direction: "bull" },
      { Trend_Direction: "varchar" },
    );
    expect(out[0].passed).toBe(true);
  });

  it("both-null DOUBLE is PASS; null-vs-value is FAIL (Gap_Pct no-gap days)", () => {
    const bothNull = compareFields({ Gap_Pct: null }, { Gap_Pct: null }, { Gap_Pct: "double" });
    expect(bothNull[0].passed).toBe(true);

    const onlyOne = compareFields({ Gap_Pct: null }, { Gap_Pct: 0 }, { Gap_Pct: "double" });
    expect(onlyOne[0].passed).toBe(false);
  });

  it("both-null INTEGER is PASS; null-vs-value is FAIL (Gap_Filled no-gap days)", () => {
    const bothNull = compareFields(
      { Gap_Filled: null },
      { Gap_Filled: null },
      { Gap_Filled: "integer" },
    );
    expect(bothNull[0].passed).toBe(true);

    const onlyOne = compareFields(
      { Gap_Filled: null },
      { Gap_Filled: 0 },
      { Gap_Filled: "integer" },
    );
    expect(onlyOne[0].passed).toBe(false);
  });

  it("both-null VARCHAR is PASS", () => {
    const out = compareFields(
      { Trend_Direction: null },
      { Trend_Direction: null },
      { Trend_Direction: "varchar" },
    );
    expect(out[0].passed).toBe(true);
  });

  it("undefined is treated the same as null (both-undefined PASS)", () => {
    const out = compareFields({}, {}, { Gap_Filled: "integer" });
    expect(out[0].passed).toBe(true);
  });

  it("NaN-vs-NaN on DOUBLE is PASS", () => {
    const out = compareFields({ RSI_14: NaN }, { RSI_14: NaN }, { RSI_14: "double" });
    expect(out[0].passed).toBe(true);
  });

  it("NaN-vs-number on DOUBLE is FAIL", () => {
    const out = compareFields({ RSI_14: NaN }, { RSI_14: 50.0 }, { RSI_14: "double" });
    expect(out[0].passed).toBe(false);
  });
});

describe("compareRow anyFailure aggregation (D-11 failure blocks deletion)", () => {
  it("anyFailure=false when all fields within tolerance", () => {
    const oldRow = { RSI_14: 50.0, Gap_Filled: 1 };
    const newRow = { RSI_14: 50.0 + 5e-10, Gap_Filled: 1 };
    const diff: RowDiff = compareRow(oldRow, newRow, "enriched", "SPX", "2024-08-05");
    expect(diff.anyFailure).toBe(false);
    expect(diff.ticker).toBe("SPX");
    expect(diff.date).toBe("2024-08-05");
    expect(diff.kind).toBe("enriched");
  });

  it("anyFailure=true when ONE field drifts past 1e-9", () => {
    const oldRow = { RSI_14: 50.0, Gap_Filled: 1 };
    const newRow = { RSI_14: 50.0 + 2e-9, Gap_Filled: 1 };
    const diff = compareRow(oldRow, newRow, "enriched", "SPX", "2024-08-05");
    expect(diff.anyFailure).toBe(true);
    const rsi: FieldDiff | undefined = diff.fields.find((f: FieldDiff) => f.field === "RSI_14");
    expect(rsi?.passed).toBe(false);
    const gap: FieldDiff | undefined = diff.fields.find((f: FieldDiff) => f.field === "Gap_Filled");
    expect(gap?.passed).toBe(true);
  });

  it("anyFailure=true when integer field differs", () => {
    const oldRow = { Gap_Filled: 1 };
    const newRow = { Gap_Filled: 0 };
    const diff = compareRow(oldRow, newRow, "enriched", "SPX", "2024-08-05");
    expect(diff.anyFailure).toBe(true);
  });
});

describe("field-type registry shape", () => {
  it("ENRICHED_FIELD_TYPES classifies core Tier-1 doubles correctly", () => {
    expect(ENRICHED_FIELD_TYPES.RSI_14).toBe("double");
    expect(ENRICHED_FIELD_TYPES.ATR_Pct).toBe("double");
    expect(ENRICHED_FIELD_TYPES.Gap_Pct).toBe("double");
    expect(ENRICHED_FIELD_TYPES.Realized_Vol_5D).toBe("double");
    expect(ENRICHED_FIELD_TYPES.Return_20D).toBe("double");
    expect(ENRICHED_FIELD_TYPES.ivr).toBe("double");
    expect(ENRICHED_FIELD_TYPES.ivp).toBe("double");
  });

  it("ENRICHED_FIELD_TYPES classifies integer-valued fields correctly", () => {
    expect(ENRICHED_FIELD_TYPES.Gap_Filled).toBe("integer");
    expect(ENRICHED_FIELD_TYPES.Day_of_Week).toBe("integer");
    expect(ENRICHED_FIELD_TYPES.Is_Opex).toBe("integer");
    expect(ENRICHED_FIELD_TYPES.Consecutive_Days).toBe("integer");
    expect(ENRICHED_FIELD_TYPES.Month).toBe("integer");
  });

  it("CONTEXT_FIELD_TYPES has Vol_Regime + Term_Structure_State as integers", () => {
    expect(CONTEXT_FIELD_TYPES.Vol_Regime).toBe("integer");
    expect(CONTEXT_FIELD_TYPES.Term_Structure_State).toBe("integer");
  });

  it("CONTEXT_FIELD_TYPES has Trend_Direction as varchar", () => {
    expect(CONTEXT_FIELD_TYPES.Trend_Direction).toBe("varchar");
  });

  it("CONTEXT_FIELD_TYPES has VIX_Spike_Pct + VIX_Gap_Pct as doubles", () => {
    expect(CONTEXT_FIELD_TYPES.VIX_Spike_Pct).toBe("double");
    expect(CONTEXT_FIELD_TYPES.VIX_Gap_Pct).toBe("double");
  });
});
