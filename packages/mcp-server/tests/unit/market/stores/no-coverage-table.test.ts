/**
 * Phase 2 Plan 02 — COV-01 / D-11 static-grep proof.
 *
 * Asserts that no code under packages/mcp-server/src/ references market.data_coverage
 * in any form (bare identifier, FROM clause, INSERT INTO). If anyone re-adds a reader
 * or writer this test fails fast, preventing a dead-code resurrection.
 */
import { describe, it, expect } from "@jest/globals";
import { execSync } from "child_process";
import * as path from "path";

function srcDirPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // here = .../packages/mcp-server/tests/unit/market/stores
  return path.resolve(here, "..", "..", "..", "..", "src");
}

describe("COV-01 / D-11: no code references market.data_coverage", () => {
  it("zero matches for 'market.data_coverage' under packages/mcp-server/src/", () => {
    const srcDir = srcDirPath();
    const result = execSync(
      `grep -rE "market\\.data_coverage" "${srcDir}" || true`,
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("");
  });

  it("zero FROM market.data_coverage matches under packages/mcp-server/src/", () => {
    const srcDir = srcDirPath();
    const result = execSync(
      `grep -rE "FROM[[:space:]]+market\\.data_coverage" "${srcDir}" || true`,
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("");
  });

  it("zero INSERT INTO market.data_coverage matches under packages/mcp-server/src/", () => {
    const srcDir = srcDirPath();
    const result = execSync(
      `grep -rE "INSERT[[:space:]]+INTO[[:space:]]+market\\.data_coverage" "${srcDir}" || true`,
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("");
  });
});
