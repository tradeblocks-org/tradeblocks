/**
 * Unit tests for parquet-writer utility module.
 *
 * Tests isParquetMode(), resolveMarketDir(), writeParquetAtomic(), and writeParquetPartition().
 * Uses standalone DuckDB instances (no connection.ts dependency).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import {
  isParquetMode,
  resolveMarketDir,
  writeParquetAtomic,
  writeParquetPartition,
} from "../../src/test-exports.ts";

describe("parquet-writer", () => {
  describe("isParquetMode()", () => {
    const originalEnv = process.env.TRADEBLOCKS_PARQUET;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.TRADEBLOCKS_PARQUET;
      } else {
        process.env.TRADEBLOCKS_PARQUET = originalEnv;
      }
    });

    it("returns true when TRADEBLOCKS_PARQUET is 'true'", () => {
      process.env.TRADEBLOCKS_PARQUET = "true";
      expect(isParquetMode()).toBe(true);
    });

    it("returns false when TRADEBLOCKS_PARQUET is 'false'", () => {
      process.env.TRADEBLOCKS_PARQUET = "false";
      expect(isParquetMode()).toBe(false);
    });

    it("returns false when TRADEBLOCKS_PARQUET is undefined", () => {
      delete process.env.TRADEBLOCKS_PARQUET;
      expect(isParquetMode()).toBe(false);
    });

    it("returns false when TRADEBLOCKS_PARQUET is empty string", () => {
      process.env.TRADEBLOCKS_PARQUET = "";
      expect(isParquetMode()).toBe(false);
    });
  });

  describe("resolveMarketDir()", () => {
    it("returns path.join(dataDir, 'market')", () => {
      const result = resolveMarketDir("/tmp/tradeblocks-data");
      expect(result).toBe(join("/tmp/tradeblocks-data", "market"));
    });

    it("works with trailing slash", () => {
      const result = resolveMarketDir("/tmp/data/");
      expect(result).toBe(join("/tmp/data/", "market"));
    });
  });

  describe("writeParquetAtomic()", () => {
    let tmpDir: string;
    let db: DuckDBInstance;
    let conn: DuckDBConnection;

    beforeEach(async () => {
      tmpDir = join(
        tmpdir(),
        `parquet-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmpDir, { recursive: true });
      db = await DuckDBInstance.create(":memory:");
      conn = await db.connect();
    });

    afterEach(async () => {
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

    it("writes a Parquet file with ZSTD compression and returns rowCount", async () => {
      // Create test data in DuckDB
      await conn.run(`
        CREATE TEMP TABLE test_data AS
        SELECT 'SPX' AS ticker, '2025-01-06' AS date, 100.0 AS close
        UNION ALL
        SELECT 'SPX', '2025-01-07', 101.5
        UNION ALL
        SELECT 'SPX', '2025-01-08', 99.0
      `);

      const targetPath = join(tmpDir, "output", "daily.parquet");

      const result = await writeParquetAtomic(conn, {
        targetPath,
        selectQuery: "SELECT * FROM test_data",
      });

      expect(result.rowCount).toBe(3);
      expect(existsSync(targetPath)).toBe(true);

      // Verify contents via read_parquet
      const reader = await conn.runAndReadAll(
        `SELECT COUNT(*) AS cnt FROM read_parquet('${targetPath}')`,
      );
      expect(Number(reader.getRows()[0][0])).toBe(3);
    });

    it("creates parent directory if missing", async () => {
      const deepPath = join(tmpDir, "a", "b", "c", "test.parquet");
      await conn.run(`CREATE TEMP TABLE t1 AS SELECT 1 AS x`);

      await writeParquetAtomic(conn, {
        targetPath: deepPath,
        selectQuery: "SELECT * FROM t1",
      });

      expect(existsSync(deepPath)).toBe(true);
    });

    it("drops staging table in finally block even on success", async () => {
      await conn.run(`CREATE TEMP TABLE t2 AS SELECT 42 AS val`);

      await writeParquetAtomic(conn, {
        targetPath: join(tmpDir, "cleanup.parquet"),
        selectQuery: "SELECT * FROM t2",
        stagingName: "_staging_cleanup_test",
      });

      // Verify staging table was dropped
      const reader = await conn.runAndReadAll(
        `SELECT table_name FROM duckdb_tables() WHERE table_name = '_staging_cleanup_test'`,
      );
      expect(reader.getRows().length).toBe(0);
    });

    it("drops staging table even on COPY TO error", async () => {
      await conn.run(`CREATE TEMP TABLE t3 AS SELECT 1 AS x`);

      // Use an invalid path that should cause COPY TO to fail
      try {
        await writeParquetAtomic(conn, {
          targetPath: "/dev/null/impossible/path/file.parquet",
          selectQuery: "SELECT * FROM t3",
          stagingName: "_staging_error_test",
        });
      } catch {
        // Expected to fail
      }

      // Staging table should still be cleaned up
      const reader = await conn.runAndReadAll(
        `SELECT table_name FROM duckdb_tables() WHERE table_name = '_staging_error_test'`,
      );
      expect(reader.getRows().length).toBe(0);
    });

    it("uses custom compression when specified", async () => {
      await conn.run(`CREATE TEMP TABLE t4 AS SELECT 'hello' AS msg`);
      const targetPath = join(tmpDir, "uncompressed.parquet");

      const result = await writeParquetAtomic(conn, {
        targetPath,
        selectQuery: "SELECT * FROM t4",
        compression: "UNCOMPRESSED",
      });

      expect(result.rowCount).toBe(1);
      expect(existsSync(targetPath)).toBe(true);
    });
  });

  describe("writeParquetPartition()", () => {
    let tmpDir: string;
    let db: DuckDBInstance;
    let conn: DuckDBConnection;

    beforeEach(async () => {
      tmpDir = join(
        tmpdir(),
        `parquet-partition-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmpDir, { recursive: true });
      db = await DuckDBInstance.create(":memory:");
      conn = await db.connect();
    });

    afterEach(async () => {
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

    it("writes to correct Hive partition directory layout", async () => {
      await conn.run(`
        CREATE TEMP TABLE intraday_data AS
        SELECT 'SPX' AS ticker, '09:30' AS time, 100.0 AS open, 105.0 AS high
      `);

      const baseDir = join(tmpDir, "intraday");

      const result = await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM intraday_data",
      });

      expect(result.rowCount).toBe(1);

      // Check Hive directory structure
      const expectedPath = join(baseDir, "date=2025-01-06", "data.parquet");
      expect(existsSync(expectedPath)).toBe(true);

      // Verify data via read_parquet
      const reader = await conn.runAndReadAll(`SELECT ticker FROM read_parquet('${expectedPath}')`);
      expect(String(reader.getRows()[0][0])).toBe("SPX");
    });

    it("overwrites existing partition file (idempotent per D-03)", async () => {
      const baseDir = join(tmpDir, "overwrite-test");

      // Write first version
      await conn.run(`CREATE TEMP TABLE v1 AS SELECT 'v1' AS version, 10.0 AS val`);
      await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM v1",
      });

      // Write second version to same partition
      await conn.run(`CREATE TEMP TABLE v2 AS SELECT 'v2' AS version, 20.0 AS val`);
      const result = await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM v2",
      });

      expect(result.rowCount).toBe(1);

      // Should contain v2 data, not v1
      const expectedPath = join(baseDir, "date=2025-01-06", "data.parquet");
      const reader = await conn.runAndReadAll(
        `SELECT version FROM read_parquet('${expectedPath}')`,
      );
      expect(String(reader.getRows()[0][0])).toBe("v2");
    });
  });
});
