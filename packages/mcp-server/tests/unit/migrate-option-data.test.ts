/**
 * Unit tests for the migrate-option-data pure helpers.
 *
 * Covers:
 *   - groupTickersByUnderlying: SPX-family grouping, leveraged-ETF exclusion,
 *     unknown-root identity fallback, empty input, custom skipSet override.
 *   - buildOptionChainSelectQuery: EXCLUDE (underlying), WHERE filter,
 *     glob interpolation.
 *   - buildOptionQuoteSelectQuery: regexp_extract IN-list, no EXCLUDE
 *     (quote-minute partitions don't carry an underlying column),
 *     empty-roots throw.
 */
import { describe, it, expect } from "@jest/globals";
import {
  groupTickersByUnderlying,
  buildOptionChainSelectQuery,
  buildOptionQuoteSelectQuery,
  LEVERAGED_ETFS,
  TickerRegistry,
} from "../../src/test-exports.js";

// Fixture mirrors the production defaults so tests align with real ticker semantics.
const defaults = [
  { underlying: "SPX",   roots: ["SPX", "SPXW", "SPXQ"] },
  { underlying: "QQQ",   roots: ["QQQ", "QQQX"] },
  { underlying: "VIX",   roots: ["VIX"] },
  { underlying: "VIX9D", roots: ["VIX9D"] },
  { underlying: "VIX3M", roots: ["VIX3M"] },
  { underlying: "ES",    roots: ["ES"] },
  { underlying: "NDX",   roots: ["NDX", "NDXP"] },
  { underlying: "RUT",   roots: ["RUT", "RUTW"] },
];

describe("groupTickersByUnderlying — SPX family", () => {
  it("groups SPX + SPXW under SPX underlying with empty skipped", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying(["SPX", "SPXW"], registry);
    expect(result.byUnderlying.get("SPX")).toEqual(["SPX", "SPXW"]);
    expect(result.skipped).toEqual([]);
  });
  it("groups multiple underlyings preserving insertion order per underlying", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying(["SPX", "QQQ", "SPXW"], registry);
    expect(result.byUnderlying.get("SPX")).toEqual(["SPX", "SPXW"]);
    expect(result.byUnderlying.get("QQQ")).toEqual(["QQQ"]);
  });
});

describe("groupTickersByUnderlying — leveraged ETFs dropped", () => {
  it("excludes SPXL/SPXS/SPXU/SPXC and records them in skipped", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying(
      ["SPX", "SPXL", "SPXS", "SPXU", "SPXC", "SPXW"],
      registry,
    );
    expect(result.byUnderlying.get("SPX")).toEqual(["SPX", "SPXW"]);
    expect(result.byUnderlying.size).toBe(1);
    expect(result.skipped.sort()).toEqual(["SPXC", "SPXL", "SPXS", "SPXU"]);
  });
  it("LEVERAGED_ETFS constant contains exactly the four expected roots", () => {
    expect([...LEVERAGED_ETFS].sort()).toEqual(["SPXC", "SPXL", "SPXS", "SPXU"]);
  });
});

describe("groupTickersByUnderlying — unknown roots identity-mapped", () => {
  it("maps unknown roots to themselves (registry.resolve identity fallback)", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying(["NOVELROOT"], registry);
    expect(result.byUnderlying.get("NOVELROOT")).toEqual(["NOVELROOT"]);
    expect(result.skipped).toEqual([]);
  });
});

describe("groupTickersByUnderlying — edge cases", () => {
  it("returns empty maps on empty input", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying([], registry);
    expect(result.byUnderlying.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });
  it("custom skipSet overrides the default leveraged-ETF list", () => {
    const registry = new TickerRegistry(defaults);
    const result = groupTickersByUnderlying(
      ["FOO", "BAR"],
      registry,
      new Set(["FOO"]),
    );
    expect(result.byUnderlying.get("BAR")).toEqual(["BAR"]);
    expect(result.byUnderlying.has("FOO")).toBe(false);
    expect(result.skipped).toEqual(["FOO"]);
  });
});

describe("buildOptionChainSelectQuery", () => {
  it("includes EXCLUDE (underlying) to avoid duplicating the partition column", () => {
    const sql = buildOptionChainSelectQuery("/tmp/dir/data*.parquet", "SPX");
    expect(sql).toContain("* EXCLUDE (underlying)");
  });
  it("includes WHERE clause filtering by underlying", () => {
    const sql = buildOptionChainSelectQuery("/tmp/dir/data*.parquet", "SPX");
    expect(sql).toContain("WHERE underlying = 'SPX'");
  });
  it("interpolates the source glob into read_parquet", () => {
    const sql = buildOptionChainSelectQuery("/tmp/dir/data*.parquet", "SPX");
    expect(sql).toContain("read_parquet('/tmp/dir/data*.parquet')");
  });
});

describe("buildOptionQuoteSelectQuery", () => {
  it("emits regexp_extract IN-list for a single root", () => {
    const sql = buildOptionQuoteSelectQuery("/tmp/dir/data*.parquet", ["SPX"]);
    expect(sql).toContain("regexp_extract(ticker, '^([A-Z]+)', 1)");
    expect(sql).toContain("IN ('SPX')");
  });
  it("emits comma-joined quoted IN-list for multiple roots in insertion order", () => {
    const sql = buildOptionQuoteSelectQuery("/tmp/dir/data*.parquet", ["SPX", "SPXW"]);
    expect(sql).toContain("IN ('SPX', 'SPXW')");
  });
  it("does NOT include EXCLUDE (quote-minute body has no underlying column)", () => {
    const sql = buildOptionQuoteSelectQuery("/tmp/dir/data*.parquet", ["SPX"]);
    expect(sql).not.toContain("EXCLUDE");
  });
  it("throws when roots is empty", () => {
    expect(() => buildOptionQuoteSelectQuery("/tmp/dir/data*.parquet", [])).toThrow(
      /roots must not be empty/,
    );
  });
});
