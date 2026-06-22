/**
 * Unit tests for the multi-level Hive partitioning overload of writeParquetPartition.
 *
 * Covers:
 * - New generic signature: { baseDir, partitions: Record<string,string>, selectQuery }
 * - Legacy single-{date} shim: { baseDir, date, selectQuery } → forwards to new API
 * - T-1-01 path-traversal whitelist (PARTITION_KEY_RE + PARTITION_VALUE_RE)
 * - Insertion-order preservation of partition segments
 * - Idempotency (overwriting an existing partition file)
 * - Custom filename support
 *
 * Pattern: standalone DuckDB :memory: instance per test, tmpdir for output.
 * Mirrors tests/unit/parquet-writer.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { writeParquetPartition } from "../../src/test-exports.ts";

describe("writeParquetPartition (multi-level)", () => {
  let tmpDir: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `parquet-writer-multi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`
      CREATE TEMP TABLE bars AS
      SELECT 'SPX' AS ticker, '2025-01-06' AS date, '09:30' AS time, 5800.0 AS close
      UNION ALL SELECT 'SPX', '2025-01-06', '09:31', 5801.5
      UNION ALL SELECT 'SPX', '2025-01-06', '09:32', 5800.75
    `);
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

  describe("new generic API", () => {
    it("writes ticker=X/date=Y/data.parquet for two-level partition", async () => {
      const baseDir = join(tmpDir, "spot");
      const result = await writeParquetPartition(conn, {
        baseDir,
        partitions: { ticker: "SPX", date: "2025-01-06" },
        selectQuery: "SELECT * FROM bars",
      });
      expect(result.rowCount).toBe(3);
      const targetPath = join(baseDir, "ticker=SPX", "date=2025-01-06", "data.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("writes underlying=X/date=Y/data.parquet for option-chain layout", async () => {
      const baseDir = join(tmpDir, "option_chain");
      const result = await writeParquetPartition(conn, {
        baseDir,
        partitions: { underlying: "SPX", date: "2025-01-06" },
        selectQuery: "SELECT * FROM bars",
      });
      expect(result.rowCount).toBe(3);
      const targetPath = join(baseDir, "underlying=SPX", "date=2025-01-06", "data.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("writes single-level ticker=X/data.parquet for enriched per-ticker layout", async () => {
      const baseDir = join(tmpDir, "enriched");
      const result = await writeParquetPartition(conn, {
        baseDir,
        partitions: { ticker: "VIX" },
        selectQuery: "SELECT * FROM bars",
      });
      expect(result.rowCount).toBe(3);
      const targetPath = join(baseDir, "ticker=VIX", "data.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("preserves partition insertion order in directory layout", async () => {
      // Inserting date BEFORE ticker should produce date=Y/ticker=X (not ticker=X/date=Y)
      const baseDir = join(tmpDir, "swapped");
      await writeParquetPartition(conn, {
        baseDir,
        partitions: { date: "2025-01-06", ticker: "SPX" },
        selectQuery: "SELECT * FROM bars",
      });
      const swappedPath = join(baseDir, "date=2025-01-06", "ticker=SPX", "data.parquet");
      const wrongPath = join(baseDir, "ticker=SPX", "date=2025-01-06", "data.parquet");
      expect(existsSync(swappedPath)).toBe(true);
      expect(existsSync(wrongPath)).toBe(false);
    });

    it("supports custom filename when caller provides one", async () => {
      const baseDir = join(tmpDir, "custom");
      await writeParquetPartition(conn, {
        baseDir,
        partitions: { ticker: "SPX" },
        selectQuery: "SELECT * FROM bars",
        filename: "snapshot.parquet",
      });
      const targetPath = join(baseDir, "ticker=SPX", "snapshot.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("is idempotent — overwrites existing partition file", async () => {
      const baseDir = join(tmpDir, "idempotent");
      const partitions = { ticker: "SPX", date: "2025-01-06" };
      await writeParquetPartition(conn, {
        baseDir,
        partitions,
        selectQuery: "SELECT * FROM bars",
      });
      // Write again with a different row count — file is replaced atomically
      await conn.run(`CREATE TEMP TABLE bars2 AS SELECT * FROM bars LIMIT 1`);
      const result = await writeParquetPartition(conn, {
        baseDir,
        partitions,
        selectQuery: "SELECT * FROM bars2",
      });
      expect(result.rowCount).toBe(1);
      const targetPath = join(baseDir, "ticker=SPX", "date=2025-01-06", "data.parquet");
      const reader = await conn.runAndReadAll(
        `SELECT COUNT(*) AS cnt FROM read_parquet('${targetPath}')`,
      );
      expect(Number(reader.getRows()[0][0])).toBe(1);
    });
  });

  describe("legacy {date} shim", () => {
    it("forwards old {date} signature to new API and writes date=Y/data.parquet", async () => {
      const baseDir = join(tmpDir, "intraday");
      const result = await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM bars",
      });
      expect(result.rowCount).toBe(3);
      const targetPath = join(baseDir, "date=2025-01-06", "data.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("legacy shim still uses data.parquet as default filename (byte-identical to pre-3.0 behavior)", async () => {
      const baseDir = join(tmpDir, "legacy");
      await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM bars",
      });
      // Should NOT use any caller-supplied filename — legacy shape has no `filename` field.
      const expected = join(baseDir, "date=2025-01-06", "data.parquet");
      expect(existsSync(expected)).toBe(true);
    });
  });

  describe("T-1-01 path-traversal whitelist", () => {
    it("rejects path traversal in partition values (..)", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { ticker: "../evil" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition value/);
    });

    it("rejects forward slashes in partition values", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { ticker: "SPX/evil" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition value/);
    });

    it("rejects whitespace in partition values", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { ticker: "SPX BAD" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition value/);
    });

    it("rejects newlines in partition values", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { ticker: "SPX\nBAD" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition value/);
    });

    it("rejects unsafe partition keys (special chars)", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { "../bad": "SPX" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition key/);
    });

    it("rejects partition keys starting with a digit", async () => {
      const baseDir = join(tmpDir, "tt");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { "0bad": "SPX" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow(/unsafe partition key/);
    });

    it("accepts dots, underscores, and hyphens in partition values", async () => {
      const baseDir = join(tmpDir, "ok");
      await writeParquetPartition(conn, {
        baseDir,
        partitions: { ticker: "ES_M-1.0" },
        selectQuery: "SELECT * FROM bars",
      });
      const targetPath = join(baseDir, "ticker=ES_M-1.0", "data.parquet");
      expect(existsSync(targetPath)).toBe(true);
    });

    it("does NOT touch the filesystem when validation fails (no partial directories created)", async () => {
      const baseDir = join(tmpDir, "guard");
      await expect(
        writeParquetPartition(conn, {
          baseDir,
          partitions: { ticker: "../evil", date: "2025-01-06" },
          selectQuery: "SELECT * FROM bars",
        }),
      ).rejects.toThrow();
      // Validation should have rejected before mkdir; baseDir itself was never created
      // by writeParquetPartition (test fixture didn't pre-create it either)
      expect(existsSync(baseDir)).toBe(false);
    });
  });

  describe("regression — compatibility with existing single-level callers", () => {
    it("legacy callers receive the same { rowCount } shape as before 3.0", async () => {
      // Existing callers (flatfile-importer, chain-loader, etc.) destructure { rowCount }.
      const baseDir = join(tmpDir, "regression");
      const result = await writeParquetPartition(conn, {
        baseDir,
        date: "2025-01-06",
        selectQuery: "SELECT * FROM bars",
      });
      expect(typeof result).toBe("object");
      expect(typeof result.rowCount).toBe("number");
      expect(result.rowCount).toBe(3);
    });
  });
});

// Suppress unused-import lint rule for fs.writeFileSync (kept for future fixtures).
void writeFileSync;
