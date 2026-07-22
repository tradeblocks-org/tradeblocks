import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listExcludedXnysPartitionValues,
  listXnysSessionPartitionValues,
} from "../../../../src/test-exports.ts";

describe("XNYS disk partition enumeration", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const date of ["2021-12-31", "2025-01-06", "2026-07-03", "2031-01-02", "not-a-date"]) {
      const dir = join(root, `date=${date}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "data.parquet"), "fixture");
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("preserves real out-of-horizon dates while skipping malformed and known closures", () => {
    expect(listXnysSessionPartitionValues(root, "1970-01-01", "9999-12-31")).toEqual([
      "2021-12-31",
      "2025-01-06",
      "2031-01-02",
    ]);
    expect(listExcludedXnysPartitionValues(root, "1970-01-01", "9999-12-31")).toEqual([
      "2026-07-03",
      "not-a-date",
    ]);
  });
});
