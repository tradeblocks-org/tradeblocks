/**
 * Unit tests for the Market Data 3.0 dataset registry + per-dataset write helpers
 * (`packages/mcp-server/src/db/market-datasets.ts`, Phase 1 / Plan 04).
 *
 * Covers:
 * - DATASETS_V3 shape (5 entries matching D-14 verbatim)
 * - End-to-end path resolution for each helper
 *     writeSpotPartition           → market/spot/ticker=X/date=Y/data.parquet
 *     writeChainPartition          → market/option_chain/underlying=X/date=Y/data.parquet
 *     writeQuoteMinutesPartition   → market/option_quote_minutes/underlying=X/date=Y/data.parquet
 *     writeEnrichedTickerFile      → market/enriched/ticker=X/data.parquet
 *     writeEnrichedContext         → market/enriched/context/data.parquet  (special case)
 * - Pattern 7 regression shield: writeEnrichedContext does NOT land at market/enriched/data.parquet
 * - T-1-01 propagation: unsafe partition value rejected through helper layer
 *
 * Pattern: standalone DuckDB :memory: instance per test, tmpdir for output.
 * Mirrors tests/unit/parquet-writer-multi.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import {
  DATASETS_V3,
  writeSpotPartition,
  writeChainPartition,
  writeQuoteMinutesPartition,
  writeOiDailyPartition,
  writeEnrichedTickerFile,
  writeEnrichedContext,
  FilePartitionCommitStore,
  runPartitionCommitAttempt,
  UnmanifestedParquetWriteError,
} from "../../src/test-exports.ts";

let tmpDir: string; // serves as dataDir
let db: DuckDBInstance;
let conn: DuckDBConnection;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `market-datasets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpDir, "market"), { recursive: true });
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
  await conn.run("CREATE TABLE src AS SELECT * FROM (VALUES (1,'a'),(2,'b'),(3,'c')) t(id,label);");
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

describe("DATASETS_V3 — shape matches D-14 spec", () => {
  it("has exactly 6 entries", () => {
    expect(Object.keys(DATASETS_V3).sort()).toEqual([
      "enriched",
      "enriched_context",
      "option_chain",
      "option_oi_daily",
      "option_quote_minutes",
      "spot",
    ]);
  });

  it("spot: {ticker,date} partitioning", () => {
    expect(DATASETS_V3.spot).toEqual({
      subdir: "spot",
      partitionKeys: ["ticker", "date"],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });

  it("enriched: {ticker} single-level partitioning", () => {
    expect(DATASETS_V3.enriched).toEqual({
      subdir: "enriched",
      partitionKeys: ["ticker"],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });

  it("enriched_context: zero partitions", () => {
    expect(DATASETS_V3.enriched_context).toEqual({
      subdir: "enriched/context",
      partitionKeys: [],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });

  it("option_chain: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_chain).toEqual({
      subdir: "option_chain",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });

  it("option_quote_minutes: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_quote_minutes).toEqual({
      subdir: "option_quote_minutes",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });

  it("option_oi_daily: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_oi_daily).toEqual({
      subdir: "option_oi_daily",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
      schemaRevision: 1,
    });
  });
});

describe("writeSpotPartition — path resolution", () => {
  it("writes to {dataDir}/market/spot/ticker=SPX/date=2025-01-06/data.parquet", async () => {
    const { rowCount } = await writeSpotPartition(conn, {
      dataDir: tmpDir,
      ticker: "SPX",
      date: "2025-01-06",
      selectQuery: "SELECT * FROM src",
    });
    expect(rowCount).toBe(3);
    expect(
      existsSync(join(tmpDir, "market", "spot", "ticker=SPX", "date=2025-01-06", "data.parquet")),
    ).toBe(true);
  });

  it("propagates T-1-01 rejection from the writer layer", async () => {
    await expect(
      writeSpotPartition(conn, {
        dataDir: tmpDir,
        ticker: "SP/X", // unsafe — contains /
        date: "2025-01-06",
        selectQuery: "SELECT * FROM src",
      }),
    ).rejects.toThrow(/unsafe partition value/);
  });

  it("supplies canonical dataset identity to attempt-scoped provenance", async () => {
    const store = new FilePartitionCommitStore(join(tmpDir, "market"));
    const attempt = await runPartitionCommitAttempt(
      { attemptId: "dataset-helper-test", recorder: store },
      () =>
        writeSpotPartition(conn, {
          dataDir: tmpDir,
          ticker: "SPX",
          date: "2025-01-06",
          selectQuery: "SELECT *, '2025-01-06' AS date FROM src",
          quality: { inputRows: 3, droppedRows: 0 },
        }),
    );

    expect(attempt.receipts).toHaveLength(1);
    expect(attempt.receipts[0].receipt).toMatchObject({
      dataset: "spot",
      partition: { ticker: "SPX", date: "2025-01-06" },
      schemaRevision: 1,
      relativePath: "spot/ticker=SPX/date=2025-01-06/data.parquet",
      classification: "append",
      coverage: { kind: "date-range", from: "2025-01-06", through: "2025-01-06" },
      quality: { inputRows: 3, writtenRows: 3, droppedRows: 0 },
      file: { rows: 3 },
    });
  });
});

describe("writeChainPartition — path resolution", () => {
  it("writes to {dataDir}/market/option_chain/underlying=SPX/date=2025-01-06/data.parquet", async () => {
    const { rowCount } = await writeChainPartition(conn, {
      dataDir: tmpDir,
      underlying: "SPX",
      date: "2025-01-06",
      selectQuery: "SELECT * FROM src",
    });
    expect(rowCount).toBe(3);
    expect(
      existsSync(
        join(tmpDir, "market", "option_chain", "underlying=SPX", "date=2025-01-06", "data.parquet"),
      ),
    ).toBe(true);
  });
});

describe("writeQuoteMinutesPartition — path resolution", () => {
  it("writes to {dataDir}/market/option_quote_minutes/underlying=SPX/date=2025-01-06/data.parquet", async () => {
    // Inline VALUES with time + ticker so the ORDER BY q.time, q.ticker inside
    // writeQuoteMinutesPartition can resolve the columns.
    const selectQuery = `SELECT * FROM (VALUES
      ('09:30'::VARCHAR, 'A'::VARCHAR),
      ('09:30'::VARCHAR, 'B'::VARCHAR),
      ('09:35'::VARCHAR, 'C'::VARCHAR)
    ) t(time, ticker)`;
    const { rowCount } = await writeQuoteMinutesPartition(conn, {
      dataDir: tmpDir,
      underlying: "SPX",
      date: "2025-01-06",
      selectQuery,
    });
    expect(rowCount).toBe(3);
    expect(
      existsSync(
        join(
          tmpDir,
          "market",
          "option_quote_minutes",
          "underlying=SPX",
          "date=2025-01-06",
          "data.parquet",
        ),
      ),
    ).toBe(true);
  });
});

describe("writeOiDailyPartition — path resolution", () => {
  it("writes to {dataDir}/market/option_oi_daily/underlying=SPX/date=2025-01-06/data.parquet", async () => {
    // Inline VALUES with a ticker column so the ORDER BY q.ticker inside
    // writeOiDailyPartition can resolve.
    const selectQuery = `SELECT * FROM (VALUES
      ('A'::VARCHAR, 100::BIGINT),
      ('B'::VARCHAR, 200::BIGINT),
      ('C'::VARCHAR, 300::BIGINT)
    ) t(ticker, open_interest)`;
    const { rowCount } = await writeOiDailyPartition(conn, {
      dataDir: tmpDir,
      underlying: "SPX",
      date: "2025-01-06",
      selectQuery,
    });
    expect(rowCount).toBe(3);
    expect(
      existsSync(
        join(
          tmpDir,
          "market",
          "option_oi_daily",
          "underlying=SPX",
          "date=2025-01-06",
          "data.parquet",
        ),
      ),
    ).toBe(true);
  });
});

describe("writeEnrichedTickerFile — single-level partitioning", () => {
  it("writes to {dataDir}/market/enriched/ticker=SPX/data.parquet", async () => {
    const { rowCount } = await writeEnrichedTickerFile(conn, {
      dataDir: tmpDir,
      ticker: "SPX",
      selectQuery: "SELECT * FROM src",
    });
    expect(rowCount).toBe(3);
    expect(existsSync(join(tmpDir, "market", "enriched", "ticker=SPX", "data.parquet"))).toBe(true);
  });

  it("refuses its unbounded whole-history file inside an active provenance attempt", async () => {
    const store = new FilePartitionCommitStore(join(tmpDir, "market"));
    await expect(
      runPartitionCommitAttempt({ attemptId: "bounded-only", recorder: store }, () =>
        writeEnrichedTickerFile(conn, {
          dataDir: tmpDir,
          ticker: "SPX",
          selectQuery: "SELECT * FROM src",
        }),
      ),
    ).rejects.toBeInstanceOf(UnmanifestedParquetWriteError);
    expect(existsSync(join(tmpDir, "market", "enriched", "ticker=SPX", "data.parquet"))).toBe(
      false,
    );
  });
});

describe("writeEnrichedContext — zero-partition special case", () => {
  it("writes to {dataDir}/market/enriched/context/data.parquet (NOT enriched/data.parquet)", async () => {
    const { rowCount } = await writeEnrichedContext(conn, {
      dataDir: tmpDir,
      selectQuery: "SELECT * FROM src",
    });
    expect(rowCount).toBe(3);
    expect(existsSync(join(tmpDir, "market", "enriched", "context", "data.parquet"))).toBe(true);
    // Regression shield for the Pattern 7 note: must NOT land at enriched/data.parquet
    expect(existsSync(join(tmpDir, "market", "enriched", "data.parquet"))).toBe(false);
  });
});
