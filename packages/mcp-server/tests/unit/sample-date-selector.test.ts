/**
 * Unit tests for the Phase 5 sample-date selector (VALIDATION task 5-00-01).
 *
 * Asserts:
 *   1. Deterministic seeding — same seed → same list.
 *   2. Known-event and structural dates always included.
 *   3. Size bounds per D-08 (15 ≤ n ≤ 20 for the default 9-random config).
 *   4. Date-sorted output.
 *   5. Different seed → different random dates (but same known/structural).
 *
 * Pure unit — no DuckDB, no filesystem, no provider. Imports pass through
 * `../../src/test-exports.js` per Phase 4 D-31 (test-exports is the barrel;
 * Task 3 of Plan 05-00 wires the Phase 5 exports into it).
 */
import { describe, it, expect } from "@jest/globals";
// Imports flow through the test-exports barrel per Phase 4 D-31 — the Phase 5
// block in test-exports.ts MUST appear BEFORE the ext.js wildcard (Pitfall 10).
import {
  selectVerificationSampleDates,
  PHASE_5_FIXTURE_SEED,
  PHASE_5_KNOWN_EVENTS,
  PHASE_5_STRUCTURAL_DATES,
  type SampleDate,
} from "../../src/test-exports.ts";

describe("selectVerificationSampleDates (D-08 deterministic seeding)", () => {
  it("returns the SAME list on repeat calls with the same seed", () => {
    const a = selectVerificationSampleDates("2022-01-01", "2026-04-17", PHASE_5_FIXTURE_SEED, 9);
    const b = selectVerificationSampleDates("2022-01-01", "2026-04-17", PHASE_5_FIXTURE_SEED, 9);
    expect(a).toEqual(b);
  });

  it("always includes the 6 known-event dates regardless of seed/range", () => {
    const sample = selectVerificationSampleDates(
      "2022-01-01",
      "2026-04-17",
      PHASE_5_FIXTURE_SEED,
      9,
    );
    const dates = new Set(sample.map((s) => s.date));
    for (const ke of PHASE_5_KNOWN_EVENTS) {
      expect(dates.has(ke.date)).toBe(true);
    }
    // Spot-check the two headline dates from D-08 explicitly.
    expect(dates.has("2024-08-05")).toBe(true);
    expect(dates.has("2025-04-08")).toBe(true);
  });

  it("always includes the 3 structural dates regardless of seed/range", () => {
    const sample = selectVerificationSampleDates(
      "2022-01-01",
      "2026-04-17",
      PHASE_5_FIXTURE_SEED,
      9,
    );
    const dates = new Set(sample.map((s) => s.date));
    for (const sd of PHASE_5_STRUCTURAL_DATES) {
      expect(dates.has(sd.date)).toBe(true);
    }
    expect(dates.has("2022-01-03")).toBe(true);
    expect(dates.has("2024-07-03")).toBe(true);
    expect(dates.has("2024-11-27")).toBe(true);
  });

  it("produces 15–20 dates total per D-08 sizing (default 9 random)", () => {
    const sample = selectVerificationSampleDates(
      "2022-01-01",
      "2026-04-17",
      PHASE_5_FIXTURE_SEED,
      9,
    );
    expect(sample.length).toBeGreaterThanOrEqual(15);
    expect(sample.length).toBeLessThanOrEqual(20);
  });

  it("result is sorted ascending by date", () => {
    const sample = selectVerificationSampleDates(
      "2022-01-01",
      "2026-04-17",
      PHASE_5_FIXTURE_SEED,
      9,
    );
    for (let i = 1; i < sample.length; i++) {
      expect(sample[i].date.localeCompare(sample[i - 1].date)).toBeGreaterThanOrEqual(0);
    }
  });

  it("different seeds produce different random samples but same known-event / structural sets", () => {
    const a = selectVerificationSampleDates("2022-01-01", "2026-04-17", 11111, 9);
    const b = selectVerificationSampleDates("2022-01-01", "2026-04-17", 22222, 9);

    // Known + structural dates are identical in BOTH samples.
    const fixed = new Set([
      ...PHASE_5_KNOWN_EVENTS.map((s) => s.date),
      ...PHASE_5_STRUCTURAL_DATES.map((s) => s.date),
    ]);
    for (const s of [...a, ...b]) {
      if (s.category !== "random") expect(fixed.has(s.date)).toBe(true);
    }

    // Random sets almost certainly differ across seeds over a 4-year pool.
    const ar: string[] = a.filter((s: SampleDate) => s.category === "random").map((s) => s.date);
    const br: string[] = b.filter((s: SampleDate) => s.category === "random").map((s) => s.date);
    expect(ar).not.toEqual(br);
  });

  it("returned entries are well-typed — each has {date, category} and a valid category", () => {
    const sample = selectVerificationSampleDates(
      "2022-01-01",
      "2026-04-17",
      PHASE_5_FIXTURE_SEED,
      9,
    );
    for (const s of sample) {
      expect(typeof s.date).toBe("string");
      expect(["known_event", "structural", "random"]).toContain(s.category);
    }
  });
});
