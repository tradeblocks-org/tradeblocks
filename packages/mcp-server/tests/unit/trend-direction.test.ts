/**
 * Unit tests for classifyTrendDirection function.
 * Tests Return_20D classification into up/down/flat with boundary cases.
 */

import { classifyTrendDirection } from "../../src/test-exports.ts";

describe("classifyTrendDirection", () => {
  it("classifies positive Return_20D > 1% as 'up'", () => {
    expect(classifyTrendDirection(5.0)).toBe("up");
  });

  it("classifies negative Return_20D < -1% as 'down'", () => {
    expect(classifyTrendDirection(-3.0)).toBe("down");
  });

  it("classifies Return_20D within [-1%, 1%] as 'flat'", () => {
    expect(classifyTrendDirection(0.5)).toBe("flat");
  });

  it("returns null for null input", () => {
    expect(classifyTrendDirection(null)).toBeNull();
  });

  it("returns null for NaN input", () => {
    expect(classifyTrendDirection(NaN)).toBeNull();
  });

  it("classifies exactly 1.0 as 'flat' (boundary: not > 1)", () => {
    expect(classifyTrendDirection(1.0)).toBe("flat");
  });

  it("classifies exactly -1.0 as 'flat' (boundary: not < -1)", () => {
    expect(classifyTrendDirection(-1.0)).toBe("flat");
  });

  it("classifies 1.01 as 'up' (just above threshold)", () => {
    expect(classifyTrendDirection(1.01)).toBe("up");
  });

  it("classifies -1.01 as 'down' (just below threshold)", () => {
    expect(classifyTrendDirection(-1.01)).toBe("down");
  });

  it("classifies 0 as 'flat'", () => {
    expect(classifyTrendDirection(0)).toBe("flat");
  });
});
