/**
 * Unit tests for chain SQL builder (Phase 2 Wave 1 — Plan 02-01).
 *
 * The chain builder targets a single underlying + date partition. Values are
 * inlined as SQL literals to bypass the DuckDB `extract_statements` GC leak
 * (see `spot-sql.ts` header / `feedback_duckdb_extract_statements_leak.md`).
 */
import { describe, it, expect } from "@jest/globals";
import { buildReadChainSQL } from "../../../../src/test-exports.js";

describe("buildReadChainSQL", () => {
  it("queries market.option_chain with inlined underlying/date literals", () => {
    const { sql } = buildReadChainSQL("SPX", "2025-01-06");
    expect(sql).toContain("FROM market.option_chain");
    expect(sql).toContain("underlying = 'SPX'");
    expect(sql).toContain("AND date = '2025-01-06'");
  });

  it("emits no positional placeholders (leak-free runAndReadAll path)", () => {
    const { sql } = buildReadChainSQL("SPX", "2025-01-06");
    expect(sql).not.toMatch(/\$\d/);
  });

  it("projects the contract columns the ContractRow shape expects", () => {
    const { sql } = buildReadChainSQL("SPX", "2025-01-06");
    for (const col of [
      "underlying",
      "date",
      "ticker",
      "contract_type",
      "strike",
      "expiration",
      "dte",
      "exercise_style",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("orders results by ticker for deterministic consumer iteration", () => {
    const { sql } = buildReadChainSQL("SPX", "2025-01-06");
    expect(sql).toContain("ORDER BY ticker");
  });

  it("handles non-SPX underlyings without SPX-specific hardcoding", () => {
    const { sql } = buildReadChainSQL("QQQ", "2025-06-20");
    expect(sql).toContain("FROM market.option_chain");
    expect(sql).toContain("underlying = 'QQQ'");
    expect(sql).toContain("AND date = '2025-06-20'");
  });

  it("escapes embedded single quotes in inputs", () => {
    const { sql } = buildReadChainSQL("Q'Q", "2025-01-06");
    expect(sql).toContain("underlying = 'Q''Q'");
  });
});
