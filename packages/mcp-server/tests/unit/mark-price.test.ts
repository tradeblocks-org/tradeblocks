/**
 * Unit tests for markPrice helper
 *
 * Verifies bid/ask mid preference with HL2 fallback behavior.
 */

import { markPrice } from "../../src/test-exports.ts";

describe("markPrice", () => {
  it("returns HL2 when no bid/ask present", () => {
    expect(markPrice({ high: 10, low: 8 })).toBe(9);
  });

  it("returns bid/ask midpoint when both are present and non-zero", () => {
    expect(markPrice({ high: 10, low: 8, bid: 9.1, ask: 9.3 })).toBeCloseTo(9.2, 10);
  });

  it("returns HL2 when only bid is present", () => {
    expect(markPrice({ high: 10, low: 8, bid: 9.1 })).toBe(9);
  });

  it("returns HL2 when only ask is present", () => {
    expect(markPrice({ high: 10, low: 8, ask: 9.3 })).toBe(9);
  });

  it("returns HL2 when both bid and ask are zero", () => {
    expect(markPrice({ high: 10, low: 8, bid: 0, ask: 0 })).toBe(9);
  });

  it("returns HL2 when bid and ask are undefined", () => {
    expect(markPrice({ high: 10, low: 8, bid: undefined, ask: undefined })).toBe(9);
  });
});
