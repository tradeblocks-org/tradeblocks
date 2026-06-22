import { describe, it, expect } from "@jest/globals";
import { quoteParquetGreekProjection } from "../../../src/utils/quote-parquet-projection.ts";

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
