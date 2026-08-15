import { describe, it, expect } from "@jest/globals";
import {
  quoteParquetGreekProjection,
  readWindowGreekProjection,
  assertKnownGreeks,
} from "../../../src/utils/quote-parquet-projection.ts";

describe("quoteParquetGreekProjection", () => {
  const allColumns = new Set([
    "delta",
    "gamma",
    "theta",
    "vega",
    "iv",
    "greeks_source",
    "greeks_revision",
  ]);

  it("defaults to projecting all five greeks when `needed` is omitted (back-compat)", () => {
    const sql = quoteParquetGreekProjection(allColumns, "q");
    expect(sql).toContain("q.delta AS delta");
    expect(sql).toContain("q.gamma AS gamma");
    expect(sql).toContain("q.theta AS theta");
    expect(sql).toContain("q.vega AS vega");
    expect(sql).toContain("q.iv AS iv");
    expect(sql).toContain("greeks_source");
    expect(sql).toContain("greeks_revision");
  });

  it("projects only requested greeks and emits NULL for the rest when `needed` is provided", () => {
    const sql = quoteParquetGreekProjection(allColumns, "q", ["delta", "iv"]);
    expect(sql).toContain("q.delta AS delta");
    expect(sql).toContain("q.iv AS iv");
    expect(sql).toContain("NULL::DOUBLE AS gamma");
    expect(sql).toContain("NULL::DOUBLE AS theta");
    expect(sql).toContain("NULL::DOUBLE AS vega");
    expect(sql).toContain("greeks_source");
    expect(sql).toContain("greeks_revision");
  });

  it("emits NULL for every greek when `needed` is empty", () => {
    const sql = quoteParquetGreekProjection(allColumns, "q", []);
    expect(sql).toContain("NULL::DOUBLE AS delta");
    expect(sql).toContain("NULL::DOUBLE AS gamma");
    expect(sql).toContain("NULL::DOUBLE AS theta");
    expect(sql).toContain("NULL::DOUBLE AS vega");
    expect(sql).toContain("NULL::DOUBLE AS iv");
  });
});

describe("readWindowGreekProjection", () => {
  it("projects every greek as-is when `needed` is omitted (byte-identical default)", () => {
    expect(readWindowGreekProjection("q")).toBe("q.delta, q.gamma, q.theta, q.vega, q.iv");
  });

  it("references only the requested greeks and NULLs the rest, position-stable", () => {
    expect(readWindowGreekProjection("q", ["delta", "iv"])).toBe(
      "q.delta, NULL::DOUBLE AS gamma, NULL::DOUBLE AS theta, NULL::DOUBLE AS vega, q.iv",
    );
  });

  it("NULLs every greek when `needed` is empty", () => {
    expect(readWindowGreekProjection("q", [])).toBe(
      "NULL::DOUBLE AS delta, NULL::DOUBLE AS gamma, NULL::DOUBLE AS theta, NULL::DOUBLE AS vega, NULL::DOUBLE AS iv",
    );
  });

  it("throws a clear error on an unknown greek name", () => {
    expect(() => readWindowGreekProjection("q", ["banana"] as never)).toThrow(
      /Unknown greek "banana"/,
    );
  });
});

describe("assertKnownGreeks", () => {
  it("passes for the valid greek names", () => {
    expect(() => assertKnownGreeks(["delta", "gamma", "theta", "vega", "iv"])).not.toThrow();
  });

  it("throws naming the offending value and the valid set", () => {
    expect(() => assertKnownGreeks(["delta", "rho"])).toThrow(
      /Unknown greek "rho" — valid greeks are: delta, gamma, theta, vega, iv\./,
    );
  });
});
