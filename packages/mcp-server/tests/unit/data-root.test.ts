/**
 * Unit tests for data-root module.
 *
 * Tests the setDataRoot/getDataRoot/resetDataRoot pattern
 * that allows --data-root CLI flag to override the data root directory.
 */
import { setDataRoot, getDataRoot, resetDataRoot, resolveDbPath } from "../../src/db/data-root.ts";
import { join } from "node:path";

describe("data-root", () => {
  afterEach(() => {
    resetDataRoot();
  });

  describe("resolveDbPath (single source of truth for <dataRoot>/database/<kind>.duckdb)", () => {
    it("resolves each DuckDB kind under the database/ subdirectory", () => {
      expect(resolveDbPath("/data", "backtests")).toBe(
        join("/data", "database", "backtests.duckdb"),
      );
      expect(resolveDbPath("/data", "market")).toBe(join("/data", "database", "market.duckdb"));
      expect(resolveDbPath("/data", "analytics")).toBe(
        join("/data", "database", "analytics.duckdb"),
      );
    });

    it("always includes the database/ segment (the drift guard — enterprise#983)", () => {
      // The whole point: a writer that omits `database/` silently splits from a
      // reader that includes it. Every path this resolver returns carries it.
      for (const kind of ["backtests", "market", "analytics"] as const) {
        expect(resolveDbPath("/x/y", kind).split("/")).toContain("database");
      }
    });
  });

  it("getDataRoot returns fallback when no data root is set", () => {
    expect(getDataRoot("/fallback")).toBe("/fallback");
  });

  it("getDataRoot returns override after setDataRoot is called", () => {
    setDataRoot("/custom");
    expect(getDataRoot("/fallback")).toBe("/custom");
  });

  it("getDataRoot returns fallback after resetDataRoot is called", () => {
    setDataRoot("/custom");
    resetDataRoot();
    expect(getDataRoot("/fallback")).toBe("/fallback");
  });

  it("getDataRoot always returns override regardless of fallback value", () => {
    setDataRoot("/custom");
    expect(getDataRoot("/any-other-fallback")).toBe("/custom");
    expect(getDataRoot("/yet-another")).toBe("/custom");
  });

  it("state is stored on globalThis so bundle duplicates share it", () => {
    // tsup duplicates this module across separate bundles. Each bundle gets
    // its own module-local closure, so a module-scoped variable would not be
    // visible across bundles. Storing on globalThis means whichever bundle
    // runs first sets the slot, and every other bundle reads it back.
    const KEY = "__tradeblocks_data_root__";
    setDataRoot("/from-bundle-a");
    expect((globalThis as Record<string, unknown>)[KEY]).toBe("/from-bundle-a");

    // Simulate "bundle B" writing directly to globalThis (because its own
    // module-local would have been a separate variable in real bundling).
    (globalThis as Record<string, unknown>)[KEY] = "/from-bundle-b";
    expect(getDataRoot("/fallback")).toBe("/from-bundle-b");
  });
});
