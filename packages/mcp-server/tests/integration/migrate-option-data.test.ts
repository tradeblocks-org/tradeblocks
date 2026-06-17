/**
 * Integration tests for migrate-option-data per-date pipeline (Phase 3 Wave 0).
 *
 * Exercises the pure helpers (groupTickersByUnderlying, buildOptionChainSelectQuery,
 * buildOptionQuoteSelectQuery) together with the Phase 1 writer helpers
 * (writeChainPartition, writeQuoteMinutesPartition) against a synthetic 3-date
 * fixture. Covers the full per-date migration pipeline in wet + rerun modes
 * BEFORE the .mjs script runs against 76 GB of production data.
 *
 * Fixture shape (CONTEXT.md D-25):
 *   - 2025-01-02: SPX-only
 *   - 2025-01-03: SPX + SPXW (both resolve to SPX)
 *   - 2025-01-06: SPX + SPXL (leveraged ETF — must be dropped)
 *
 * date=2025-01-06/ option_chain uses data_0.parquet (not data.parquet) to
 * exercise the data*.parquet source glob (D-06).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  writeChainPartition,
  writeQuoteMinutesPartition,
  createMarketStores,
  TickerRegistry,
  groupTickersByUnderlying,
  buildOptionChainSelectQuery,
  buildOptionQuoteSelectQuery,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  LEVERAGED_ETFS,
} from "../../src/test-exports.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";

const REGISTRY_DEFAULTS = [
  { underlying: "SPX", roots: ["SPX", "SPXW", "SPXQ"] },
  { underlying: "QQQ", roots: ["QQQ", "QQQX"] },
];

let tmpDir: string;
let db: DuckDBInstance;
let conn: DuckDBConnection;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
});

afterEach(() => {
  try {
    conn.closeSync();
  } catch {
    /* ignore */
  }
  try {
    db.closeSync();
  } catch {
    /* ignore */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build option_chain fixture: date1 SPX-only, date2 SPX+SPXW, date3 SPX-only with data_0.parquet only */
async function buildChainFixture(): Promise<void> {
  const base = join(tmpDir, "market", "option_chain");
  // Date 1 — SPX-only (data.parquet)
  const d1 = join(base, "date=2025-01-02");
  mkdirSync(d1, { recursive: true });
  await conn.run(
    `COPY (SELECT 'SPX' AS underlying, 'SPX250117C04500000' AS ticker, 'CALL' AS contract_type,
                  4500.0 AS strike, '2025-01-17' AS expiration, 15 AS dte) TO '${join(d1, "data.parquet")}'
           (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
  // Date 2 — SPX + SPXW (both resolve to SPX), 3 rows total
  const d2 = join(base, "date=2025-01-03");
  mkdirSync(d2, { recursive: true });
  await conn.run(`COPY (
    SELECT 'SPX' AS underlying, 'SPX250117C04500000' AS ticker, 'CALL' AS contract_type, 4500.0 AS strike, '2025-01-17' AS expiration, 14 AS dte
    UNION ALL SELECT 'SPX', 'SPX250117P04500000', 'PUT', 4500.0, '2025-01-17', 14
    UNION ALL SELECT 'SPX', 'SPXW250103C04600000', 'CALL', 4600.0, '2025-01-03', 0
  ) TO '${join(d2, "data.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  // Date 3 — only data_0.parquet present (no data.parquet) — exercises the data*.parquet glob
  const d3 = join(base, "date=2025-01-06");
  mkdirSync(d3, { recursive: true });
  await conn.run(
    `COPY (SELECT 'SPX' AS underlying, 'SPX250117C04600000' AS ticker, 'CALL' AS contract_type,
                  4600.0 AS strike, '2025-01-17' AS expiration, 11 AS dte) TO '${join(d3, "data_0.parquet")}'
           (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
}

/** Build option_quote_minutes fixture: SPX-only, SPX+SPXW, SPX+SPXL */
async function buildQuoteFixture(): Promise<void> {
  const base = join(tmpDir, "market", "option_quote_minutes");
  const d1 = join(base, "date=2025-01-02");
  mkdirSync(d1, { recursive: true });
  await conn.run(`COPY (
    SELECT 'SPX250117C04500000' AS ticker, '2025-01-02' AS date, '09:30' AS time,
           5.0 AS bid, 5.2 AS ask, 5.1 AS mid, 1735831800000000000::BIGINT AS last_updated_ns
  ) TO '${join(d1, "data.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const d2 = join(base, "date=2025-01-03");
  mkdirSync(d2, { recursive: true });
  await conn.run(`COPY (
    SELECT 'SPX250117C04500000' AS ticker, '2025-01-03' AS date, '09:30' AS time,
           5.0 AS bid, 5.2 AS ask, 5.1 AS mid, 1735918200000000000::BIGINT AS last_updated_ns
    UNION ALL SELECT 'SPXW250103C04600000', '2025-01-03', '09:30', 3.0, 3.1, 3.05,
           1735918200000000000::BIGINT
  ) TO '${join(d2, "data.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const d3 = join(base, "date=2025-01-06");
  mkdirSync(d3, { recursive: true });
  await conn.run(`COPY (
    SELECT 'SPX250117C04500000' AS ticker, '2025-01-06' AS date, '09:30' AS time,
           5.0 AS bid, 5.2 AS ask, 5.1 AS mid, 1736177400000000000::BIGINT AS last_updated_ns
    UNION ALL SELECT 'SPXL250117C00060000', '2025-01-06', '09:30', 1.0, 1.1, 1.05,
           1736177400000000000::BIGINT
  ) TO '${join(d3, "data.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
}

/**
 * Per-date option_chain pipeline (mirrors RESEARCH §Pattern 1).
 * Returns { totalWritten, srcCount, underlyings }.
 */
async function migrateChainDate(
  date: string,
): Promise<{ totalWritten: number; srcCount: number; underlyings: string[] }> {
  const oldDir = join(tmpDir, "market", "option_chain", `date=${date}`);
  const sourceGlob = `${oldDir}/data*.parquet`;
  const distinct = await conn.runAndReadAll(
    `SELECT DISTINCT underlying FROM read_parquet('${sourceGlob}')`,
  );
  const underlyings = distinct.getRows().map((r) => String(r[0]));
  const srcCountRow = await conn.runAndReadAll(
    `SELECT COUNT(*) FROM read_parquet('${sourceGlob}')`,
  );
  const srcCount = Number(srcCountRow.getRows()[0][0]);
  let totalWritten = 0;
  for (const underlying of underlyings) {
    const sel = buildOptionChainSelectQuery(sourceGlob, underlying);
    const { rowCount } = await writeChainPartition(conn, {
      dataDir: tmpDir,
      underlying,
      date,
      selectQuery: sel,
    });
    totalWritten += rowCount;
  }
  if (totalWritten !== srcCount) {
    throw new Error(
      `option_chain ${date}: wrote ${totalWritten} but source had ${srcCount}`,
    );
  }
  rmSync(oldDir, { recursive: true, force: true });
  return { totalWritten, srcCount, underlyings };
}

/**
 * Per-date option_quote_minutes pipeline (mirrors RESEARCH §Pattern 2).
 * Returns { totalWritten, skippedRowCount, srcCount, underlyings }.
 */
async function migrateQuoteDate(
  date: string,
  registry: TickerRegistry,
  onSkip: (skip: { date: string; root: string; rowCount: number }) => void,
): Promise<{
  totalWritten: number;
  skippedRowCount: number;
  srcCount: number;
  underlyings: string[];
}> {
  const oldDir = join(tmpDir, "market", "option_quote_minutes", `date=${date}`);
  const sourceGlob = `${oldDir}/data*.parquet`;
  const rootsResult = await conn.runAndReadAll(
    `SELECT DISTINCT regexp_extract(ticker, '^([A-Z]+)', 1) FROM read_parquet('${sourceGlob}')`,
  );
  const roots = rootsResult.getRows().map((r) => String(r[0]));
  const { byUnderlying, skipped } = groupTickersByUnderlying(roots, registry);
  const srcCount = Number(
    (
      await conn.runAndReadAll(
        `SELECT COUNT(*) FROM read_parquet('${sourceGlob}')`,
      )
    ).getRows()[0][0],
  );
  let skippedRowCount = 0;
  if (skipped.length > 0) {
    const quoted = skipped.map((r) => `'${r}'`).join(", ");
    const skipCountRow = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM read_parquet('${sourceGlob}') WHERE regexp_extract(ticker, '^([A-Z]+)', 1) IN (${quoted})`,
    );
    skippedRowCount = Number(skipCountRow.getRows()[0][0]);
    for (const root of skipped) onSkip({ date, root, rowCount: skippedRowCount });
  }
  let totalWritten = 0;
  for (const [underlying, rootList] of byUnderlying) {
    const sel = buildOptionQuoteSelectQuery(sourceGlob, rootList);
    const { rowCount } = await writeQuoteMinutesPartition(conn, {
      dataDir: tmpDir,
      underlying,
      date,
      selectQuery: sel,
    });
    totalWritten += rowCount;
  }
  if (totalWritten + skippedRowCount !== srcCount) {
    throw new Error(
      `option_quote_minutes ${date}: wrote ${totalWritten} + skipped ${skippedRowCount} != source ${srcCount}`,
    );
  }
  rmSync(oldDir, { recursive: true, force: true });
  return {
    totalWritten,
    skippedRowCount,
    srcCount,
    underlyings: [...byUnderlying.keys()],
  };
}

describe("option_chain migration", () => {
  it("option_chain underlying-first layout — date dirs become underlying=X/date=Y/data.parquet", async () => {
    await buildChainFixture();
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateChainDate(date);
    }
    const expectedPath = join(
      tmpDir,
      "market",
      "option_chain",
      "underlying=SPX",
      "date=2025-01-02",
      "data.parquet",
    );
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("data_0.parquet handled by data*.parquet glob — date 2025-01-06 source becomes data.parquet target", async () => {
    await buildChainFixture();
    await migrateChainDate("2025-01-06");
    const target = join(
      tmpDir,
      "market",
      "option_chain",
      "underlying=SPX",
      "date=2025-01-06",
      "data.parquet",
    );
    expect(existsSync(target)).toBe(true);
    const cnt = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM read_parquet('${target}')`,
    );
    expect(Number(cnt.getRows()[0][0])).toBe(1);
  });

  it("old directories removed after successful per-date verify", async () => {
    await buildChainFixture();
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateChainDate(date);
      expect(
        existsSync(
          join(tmpDir, "market", "option_chain", `date=${date}`),
        ),
      ).toBe(false);
    }
  });
});

describe("option_quote_minutes migration", () => {
  it("option_quote_minutes underlying-first layout — files land at underlying=X/date=Y/data.parquet", async () => {
    await buildQuoteFixture();
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateQuoteDate(date, registry, () => {});
    }
    expect(
      existsSync(
        join(
          tmpDir,
          "market",
          "option_quote_minutes",
          "underlying=SPX",
          "date=2025-01-03",
          "data.parquet",
        ),
      ),
    ).toBe(true);
  });

  it("SPXL rows dropped with warning — date 2025-01-06 SPXL filtered, callback invoked", async () => {
    await buildQuoteFixture();
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    const skips: Array<{ date: string; root: string; rowCount: number }> = [];
    await migrateQuoteDate("2025-01-06", registry, (s) => skips.push(s));
    expect(skips.some((s) => s.root === "SPXL")).toBe(true);
    // Output partition for SPX must NOT contain any SPXL ticker
    const target = join(
      tmpDir,
      "market",
      "option_quote_minutes",
      "underlying=SPX",
      "date=2025-01-06",
      "data.parquet",
    );
    const result = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM read_parquet('${target}') WHERE regexp_extract(ticker, '^([A-Z]+)', 1) = 'SPXL'`,
    );
    expect(Number(result.getRows()[0][0])).toBe(0);
  });

  it("row count balance — sum(written across underlyings) + skipped == source for every date", async () => {
    await buildQuoteFixture();
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      const r = await migrateQuoteDate(date, registry, () => {});
      expect(r.totalWritten + r.skippedRowCount).toBe(r.srcCount);
    }
  });
});

describe("cross-cutting invariants", () => {
  it("all files named data.parquet — no data_0.parquet or tmp_data.parquet survive in either tree", async () => {
    await buildChainFixture();
    await buildQuoteFixture();
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateChainDate(date);
      await migrateQuoteDate(date, registry, () => {});
    }
    // Walk both trees, fail if any file is not data.parquet
    function walk(dir: string, found: string[]): void {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, found);
        else if (full.endsWith(".parquet")) found.push(full);
      }
    }
    const all: string[] = [];
    walk(join(tmpDir, "market", "option_chain"), all);
    walk(join(tmpDir, "market", "option_quote_minutes"), all);
    for (const f of all) {
      expect(f.endsWith("/data.parquet")).toBe(true);
    }
  });

  it("idempotent rerun — running pipeline on a partially-migrated date produces same final state", async () => {
    await buildChainFixture();
    // First run on date 2025-01-03
    await migrateChainDate("2025-01-03");
    // Recreate the source dir (simulating a partial state where source survived)
    const oldDir = join(tmpDir, "market", "option_chain", "date=2025-01-03");
    mkdirSync(oldDir, { recursive: true });
    await conn.run(`COPY (
      SELECT 'SPX' AS underlying, 'SPX250117C04500000' AS ticker, 'CALL' AS contract_type, 4500.0 AS strike, '2025-01-17' AS expiration, 14 AS dte
      UNION ALL SELECT 'SPX', 'SPX250117P04500000', 'PUT', 4500.0, '2025-01-17', 14
      UNION ALL SELECT 'SPX', 'SPXW250103C04600000', 'CALL', 4600.0, '2025-01-03', 0
    ) TO '${join(oldDir, "data.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    // Re-run — should overwrite atomically and verify
    await migrateChainDate("2025-01-03");
    const target = join(
      tmpDir,
      "market",
      "option_chain",
      "underlying=SPX",
      "date=2025-01-03",
      "data.parquet",
    );
    const cnt = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM read_parquet('${target}')`,
    );
    expect(Number(cnt.getRows()[0][0])).toBe(3);
  });

  it("getCoverage matches pre-inventory — ChainStore.getCoverage returns dates that exist in fixture", async () => {
    await buildChainFixture();
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateChainDate(date);
    }
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    const stores = createMarketStores({
      conn,
      dataDir: tmpDir,
      parquetMode: true,
      tickers: registry,
    });
    const coverage = await stores.chain.getCoverage(
      "SPX",
      "2025-01-01",
      "2025-01-31",
    );
    // All 3 fixture dates fall within window — none should be missing
    const expectedDates = ["2025-01-02", "2025-01-03", "2025-01-06"];
    for (const d of expectedDates) {
      expect(coverage.missingDates).not.toContain(d);
    }
  });

  it("readQuotes returns grouped series — Map<occTicker, QuoteRow[]> after migration", async () => {
    await buildQuoteFixture();
    const registry = new TickerRegistry(REGISTRY_DEFAULTS);
    for (const date of ["2025-01-02", "2025-01-03", "2025-01-06"]) {
      await migrateQuoteDate(date, registry, () => {});
    }
    // readQuotes queries the `market.option_quote_minutes` view — register it
    // over the new underlying=X/date=Y/data.parquet layout after migration.
    await conn.run("CREATE SCHEMA IF NOT EXISTS market");
    await createMarketParquetViews(conn, tmpDir);
    const stores = createMarketStores({
      conn,
      dataDir: tmpDir,
      parquetMode: true,
      tickers: registry,
    });
    const result = await stores.quote.readQuotes(
      ["SPX250117C04500000", "SPXW250103C04600000"],
      "2025-01-02",
      "2025-01-03",
    );
    expect(result instanceof Map).toBe(true);
    expect(result.has("SPX250117C04500000")).toBe(true);
    expect(result.has("SPXW250103C04600000")).toBe(true);
  });
});
