import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import { validateQuery, isUnderDataRoot } from "../../src/test-exports.ts";

const DATA_ROOT = path.resolve("/tmp/tb-test-data-root");

describe("validateQuery — hard blocks", () => {
  it.each([
    ["COPY sensitive TO '/tmp/out.csv'", "COPY"],
    ["EXPORT DATABASE '/tmp/db'", "EXPORT"],
    ["ATTACH '/tmp/other.db'", "ATTACH"],
    ["DETACH other_db", "DETACH"],
    ["SELECT write_csv('/tmp/x.csv', 'data')", "write_csv()"],
    ["SELECT read_text('/etc/passwd')", "read_text()"],
    ["SET memory_limit='1GB'", "SET"],
  ])("blocks %s", (sql, op) => {
    expect(validateQuery(sql, DATA_ROOT)).toContain(op);
  });
});

describe("validateQuery — path-gated read_parquet", () => {
  it("allows read_parquet under data-root", () => {
    const sql = `SELECT * FROM read_parquet('${DATA_ROOT}/market/spot/ticker=SPX/date=2024-06-03/data.parquet')`;
    expect(validateQuery(sql, DATA_ROOT)).toBeNull();
  });

  it("allows read_parquet with hive-partition glob", () => {
    const sql = `SELECT * FROM read_parquet('${DATA_ROOT}/market/spot/**/*.parquet', hive_partitioning=true)`;
    expect(validateQuery(sql, DATA_ROOT)).toBeNull();
  });

  it("allows read_parquet with array of paths under data-root", () => {
    const sql = `SELECT * FROM read_parquet(['${DATA_ROOT}/a.parquet', '${DATA_ROOT}/b.parquet'])`;
    expect(validateQuery(sql, DATA_ROOT)).toBeNull();
  });

  it("blocks read_parquet outside data-root", () => {
    const sql = `SELECT * FROM read_parquet('/etc/passwd')`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("must be under --data-root");
  });

  it("blocks path traversal via ..", () => {
    const sql = `SELECT * FROM read_parquet('${DATA_ROOT}/../etc/passwd')`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("must be under --data-root");
  });

  it("blocks <data-root>-evil sibling directory", () => {
    const sql = `SELECT * FROM read_parquet('${DATA_ROOT}-evil/secret.parquet')`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("must be under --data-root");
  });

  it("blocks mixed array with one path outside data-root", () => {
    const sql = `SELECT * FROM read_parquet(['${DATA_ROOT}/ok.parquet', '/etc/passwd'])`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("must be under --data-root");
  });

  it("blocks read_parquet call that has no string literal", () => {
    const sql = `SELECT * FROM read_parquet(some_column)`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("could not be parsed safely");
  });

  it("blocks read_parquet with unbalanced parens", () => {
    const sql = `SELECT * FROM read_parquet('${DATA_ROOT}/x.parquet'`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("could not be parsed safely");
  });
});

describe("validateQuery — read_csv and read_json", () => {
  it("allows read_csv under data-root", () => {
    const sql = `SELECT * FROM read_csv('${DATA_ROOT}/blocks/manifest.csv')`;
    expect(validateQuery(sql, DATA_ROOT)).toBeNull();
  });

  it("allows read_json under data-root", () => {
    const sql = `SELECT * FROM read_json('${DATA_ROOT}/strategies/profile.json')`;
    expect(validateQuery(sql, DATA_ROOT)).toBeNull();
  });

  it("blocks read_csv outside data-root", () => {
    const sql = `SELECT * FROM read_csv('/etc/fstab')`;
    expect(validateQuery(sql, DATA_ROOT)).toContain("must be under --data-root");
  });
});

describe("validateQuery — normal SELECT still works", () => {
  it("passes through a plain SELECT", () => {
    expect(validateQuery("SELECT * FROM market.spot LIMIT 1", DATA_ROOT)).toBeNull();
  });

  it("passes through SELECT with embedded 'read_parquet' string literal (over-blocks accepted)", () => {
    // Known trade-off: string literals that contain a function-name lookalike
    // will be over-blocked. Not a correctness bug — block > allow when unsure.
    const sql = `SELECT 'read_parquet(abc)' AS msg`;
    // No quoted path inside the "call", so extractor returns null → block.
    expect(validateQuery(sql, DATA_ROOT)).not.toBeNull();
  });
});

describe("isUnderDataRoot", () => {
  it("accepts exact data-root", () => {
    expect(isUnderDataRoot(DATA_ROOT, DATA_ROOT)).toBe(true);
  });

  it("accepts subpaths", () => {
    expect(isUnderDataRoot(`${DATA_ROOT}/market/spot/x.parquet`, DATA_ROOT)).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isUnderDataRoot(`${DATA_ROOT}/../etc/passwd`, DATA_ROOT)).toBe(false);
  });

  it("rejects <root>-evil sibling", () => {
    expect(isUnderDataRoot(`${DATA_ROOT}-evil/x`, DATA_ROOT)).toBe(false);
  });

  it("strips glob suffix for prefix comparison", () => {
    expect(isUnderDataRoot(`${DATA_ROOT}/market/**/*.parquet`, DATA_ROOT)).toBe(true);
  });
});
