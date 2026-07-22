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
 *     writeEnrichedTickerFile      → market/enriched/ticker=X/data.parquet (legacy)
 *     writeEnrichedContext         → market/enriched/context/data.parquet (legacy)
 *     writeEnrichedTickerPartition → market/enriched/ticker=X/date=Y/data.parquet
 *     writeEnrichedContextPartition → market/enriched/context/date=Y/data.parquet
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
import type { DatasetDef } from "../../src/db/market-datasets.ts";
import {
  MARKET_DATASETS,
  canonicalPartitionRelativePath,
  validatePartitionIdentity,
} from "../../src/market/provenance/dataset-registry.ts";
import {
  DATASETS_V3,
  writeSpotPartition,
  writeChainPartition,
  writeQuoteMinutesPartition,
  writeOiDailyPartition,
  writeEnrichedTickerFile,
  writeEnrichedContext,
  writeEnrichedTickerPartition,
  writeEnrichedContextPartition,
  FilePartitionCommitStore,
  runPartitionCommitAttempt,
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
    });
  });

  it("enriched: {ticker} legacy whole-file partitioning", () => {
    expect(DATASETS_V3.enriched).toEqual({
      subdir: "enriched",
      partitionKeys: ["ticker"],
      filename: "data.parquet",
    });
  });

  it("enriched_context: legacy whole-file partitioning", () => {
    expect(DATASETS_V3.enriched_context).toEqual({
      subdir: "enriched/context",
      partitionKeys: [],
      filename: "data.parquet",
    });
  });

  it("option_chain: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_chain).toEqual({
      subdir: "option_chain",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
    });
  });

  it("option_quote_minutes: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_quote_minutes).toEqual({
      subdir: "option_quote_minutes",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
    });
  });

  it("option_oi_daily: {underlying,date} partitioning", () => {
    expect(DATASETS_V3.option_oi_daily).toEqual({
      subdir: "option_oi_daily",
      partitionKeys: ["underlying", "date"],
      filename: "data.parquet",
    });
  });

  it("retains the mutable Record<string, DatasetDef> compatibility contract", () => {
    const assigned: DatasetDef = {
      subdir: "compat",
      partitionKeys: ["ticker"],
      filename: "compat.parquet",
    };
    assigned.partitionKeys.push("date");

    const registry: Record<string, DatasetDef> = DATASETS_V3;
    const compatibilityKey = "__compatibility_assignment__";
    const hadCompatibilityKey = Object.hasOwn(registry, compatibilityKey);
    const previousCompatibilityValue = registry[compatibilityKey];
    const enriched = registry.enriched;
    const originalKeys = [...enriched.partitionKeys];
    const originalFilename = enriched.filename;
    try {
      registry[compatibilityKey] = assigned;
      enriched.partitionKeys.push("compatibility_probe");
      enriched.filename = "compatibility-probe.parquet";

      expect(registry[compatibilityKey]).toBe(assigned);
      expect(enriched.partitionKeys).toEqual(["ticker", "compatibility_probe"]);
      expect(enriched.filename).toBe("compatibility-probe.parquet");
      expect(Object.isFrozen(registry)).toBe(false);
      expect(Object.isFrozen(enriched)).toBe(false);
      expect(Object.isFrozen(enriched.partitionKeys)).toBe(false);
    } finally {
      enriched.partitionKeys.splice(0, enriched.partitionKeys.length, ...originalKeys);
      enriched.filename = originalFilename;
      if (hadCompatibilityKey && previousCompatibilityValue) {
        registry[compatibilityKey] = previousCompatibilityValue;
      } else {
        delete registry[compatibilityKey];
      }
    }
  });
});

describe("bounded provenance dataset registry", () => {
  it("remains deeply frozen and strict for bounded enriched identities", () => {
    expect(Object.isFrozen(MARKET_DATASETS)).toBe(true);
    for (const definition of Object.values(MARKET_DATASETS)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.partitionKeys)).toBe(true);
      expect(Object.isFrozen(definition.provenance)).toBe(true);
    }
    expect(MARKET_DATASETS.enriched.partitionKeys).toEqual(["ticker", "date"]);
    expect(MARKET_DATASETS.enriched_context.partitionKeys).toEqual(["date"]);
    expect(() =>
      validatePartitionIdentity({ dataset: "enriched", partition: { ticker: "SPX" } }),
    ).toThrow(/Invalid provenance partition keys/);
    expect(
      canonicalPartitionRelativePath({
        dataset: "enriched",
        partition: { ticker: "SPX", date: "2025-01-06" },
      }),
    ).toBe("enriched/ticker=SPX/date=2025-01-06/data.parquet");
  });

  it("keeps bounded writers isolated from mutable public registry overrides", async () => {
    const publicDefinition = DATASETS_V3.enriched;
    const originalSubdir = publicDefinition.subdir;
    const originalFilename = publicDefinition.filename;
    try {
      publicDefinition.subdir = "compatibility-override";
      publicDefinition.filename = "compatibility-override.parquet";
      await writeEnrichedTickerPartition(conn, {
        dataDir: tmpDir,
        ticker: "SPX",
        date: "2025-01-06",
        selectQuery: "SELECT 'SPX' ticker, '2025-01-06' date, id, label FROM src",
      });

      expect(
        existsSync(
          join(tmpDir, "market", "enriched", "ticker=SPX", "date=2025-01-06", "data.parquet"),
        ),
      ).toBe(true);
      expect(existsSync(join(tmpDir, "market", "compatibility-override"))).toBe(false);
    } finally {
      publicDefinition.subdir = originalSubdir;
      publicDefinition.filename = originalFilename;
    }
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

describe("bounded writer date validation", () => {
  it("rejects JS callers that omit dates before composing any partition path", async () => {
    await expect(
      writeSpotPartition(conn, {
        dataDir: tmpDir,
        ticker: "SPX",
        selectQuery: "SELECT * FROM src",
      } as unknown as Parameters<typeof writeSpotPartition>[1]),
    ).rejects.toThrow(/writeSpotPartition: date must be an ISO calendar date/);
    await expect(
      writeChainPartition(conn, {
        dataDir: tmpDir,
        underlying: "SPX",
        selectQuery: "SELECT * FROM src",
      } as unknown as Parameters<typeof writeChainPartition>[1]),
    ).rejects.toThrow(/writeChainPartition: date must be an ISO calendar date/);
    await expect(
      writeQuoteMinutesPartition(conn, {
        dataDir: tmpDir,
        underlying: "SPX",
        selectQuery: "SELECT * FROM src",
      } as unknown as Parameters<typeof writeQuoteMinutesPartition>[1]),
    ).rejects.toThrow(/writeQuoteMinutesPartition: date must be an ISO calendar date/);
    await expect(
      writeOiDailyPartition(conn, {
        dataDir: tmpDir,
        underlying: "SPX",
        selectQuery: "SELECT * FROM src",
      } as unknown as Parameters<typeof writeOiDailyPartition>[1]),
    ).rejects.toThrow(/writeOiDailyPartition: date must be an ISO calendar date/);

    expect(existsSync(join(tmpDir, "market", "spot", "ticker=SPX", "date=undefined"))).toBe(false);
    for (const dataset of ["option_chain", "option_quote_minutes", "option_oi_daily"]) {
      expect(existsSync(join(tmpDir, "market", dataset, "underlying=SPX", "date=undefined"))).toBe(
        false,
      );
    }
  });
});

describe("legacy enriched whole-file writer compatibility", () => {
  it("keeps writeEnrichedTickerFile at the legacy ticker destination", async () => {
    const { rowCount } = await writeEnrichedTickerFile(conn, {
      dataDir: tmpDir,
      ticker: "SPX",
      selectQuery: "SELECT 'SPX' ticker, '2025-01-06' date, id, label FROM src",
    });
    expect(rowCount).toBe(3);
    expect(existsSync(join(tmpDir, "market", "enriched", "ticker=SPX", "data.parquet"))).toBe(true);
    expect(existsSync(join(tmpDir, "market", "enriched", "ticker=SPX", "date=undefined"))).toBe(
      false,
    );
  });

  it("keeps writeEnrichedContext at the legacy context destination", async () => {
    const { rowCount } = await writeEnrichedContext(conn, {
      dataDir: tmpDir,
      selectQuery: "SELECT * FROM src",
    });
    expect(rowCount).toBe(3);
    expect(existsSync(join(tmpDir, "market", "enriched", "context", "data.parquet"))).toBe(true);
    expect(existsSync(join(tmpDir, "market", "enriched", "context", "date=undefined"))).toBe(false);
  });
});

describe("writeEnrichedTickerPartition — bounded partitioning", () => {
  it("writes to {dataDir}/market/enriched/ticker=SPX/date=Y/data.parquet", async () => {
    const { rowCount } = await writeEnrichedTickerPartition(conn, {
      dataDir: tmpDir,
      ticker: "SPX",
      date: "2025-01-06",
      selectQuery: "SELECT 'SPX' ticker, '2025-01-06' date, id, label FROM src",
    });
    expect(rowCount).toBe(3);
    expect(
      existsSync(
        join(tmpDir, "market", "enriched", "ticker=SPX", "date=2025-01-06", "data.parquet"),
      ),
    ).toBe(true);
  });

  it("captures its exact bounded receipt inside an active provenance attempt", async () => {
    const store = new FilePartitionCommitStore(join(tmpDir, "market"));
    const attempt = await runPartitionCommitAttempt(
      { attemptId: "bounded-enriched", recorder: store },
      () =>
        writeEnrichedTickerPartition(conn, {
          dataDir: tmpDir,
          ticker: "SPX",
          date: "2025-01-06",
          selectQuery: "SELECT 'SPX' ticker, '2025-01-06' date, id, label FROM src",
          quality: { kind: "writer-input-complete" },
        }),
    );
    expect(attempt.receipts).toHaveLength(1);
    expect(attempt.receipts[0].receipt).toMatchObject({
      dataset: "enriched",
      partition: { ticker: "SPX", date: "2025-01-06" },
      coverage: { kind: "date-range", from: "2025-01-06", through: "2025-01-06" },
      quality: { inputRows: 3, writtenRows: 3, droppedRows: 0 },
    });
  });

  it.each([undefined, "", "2025-02-30", "2025/01/06"])(
    "rejects a JS caller date of %p before composing a partition path",
    async (date) => {
      await expect(
        writeEnrichedTickerPartition(conn, {
          dataDir: tmpDir,
          ticker: "SPX",
          date,
          selectQuery: "SELECT * FROM src",
        } as Parameters<typeof writeEnrichedTickerPartition>[1]),
      ).rejects.toThrow(/date (must be an ISO calendar date|is not a real calendar date)/);
      expect(
        existsSync(join(tmpDir, "market", "enriched", "ticker=SPX", `date=${String(date)}`)),
      ).toBe(false);
    },
  );
});

describe("writeEnrichedContextPartition — bounded date partition", () => {
  const completeContextQuery =
    "SELECT '2025-01-06' date, 4::INTEGER Vol_Regime, " +
    "1::INTEGER Term_Structure_State, 'flat'::VARCHAR Trend_Direction, " +
    "2.5::DOUBLE VIX_Spike_Pct, 1.25::DOUBLE VIX_Gap_Pct";

  it("writes to {dataDir}/market/enriched/context/date=Y/data.parquet", async () => {
    const { rowCount } = await writeEnrichedContextPartition(conn, {
      dataDir: tmpDir,
      date: "2025-01-06",
      selectQuery: completeContextQuery,
    });
    expect(rowCount).toBe(1);
    expect(
      existsSync(join(tmpDir, "market", "enriched", "context", "date=2025-01-06", "data.parquet")),
    ).toBe(true);
    expect(existsSync(join(tmpDir, "market", "enriched", "context", "data.parquet"))).toBe(false);
  });

  it("captures its exact bounded receipt inside an active provenance attempt", async () => {
    const store = new FilePartitionCommitStore(join(tmpDir, "market"));
    const attempt = await runPartitionCommitAttempt(
      { attemptId: "bounded-enriched-context", recorder: store },
      () =>
        writeEnrichedContextPartition(conn, {
          dataDir: tmpDir,
          date: "2025-01-06",
          selectQuery: completeContextQuery,
          quality: { kind: "writer-input-complete" },
        }),
    );
    expect(attempt.receipts).toHaveLength(1);
    expect(attempt.receipts[0].receipt).toMatchObject({
      dataset: "enriched_context",
      partition: { date: "2025-01-06" },
      coverage: { kind: "date-range", from: "2025-01-06", through: "2025-01-06" },
      quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
    });
  });

  it("refuses a bounded context row without same-session VIX completeness fields", async () => {
    await expect(
      writeEnrichedContextPartition(conn, {
        dataDir: tmpDir,
        date: "2025-01-06",
        selectQuery:
          "SELECT '2025-01-06' date, 4::INTEGER Vol_Regime, " +
          "NULL::INTEGER Term_Structure_State, NULL::VARCHAR Trend_Direction, " +
          "NULL::DOUBLE VIX_Spike_Pct, NULL::DOUBLE VIX_Gap_Pct",
      }),
    ).rejects.toThrow(/missing required VIX completeness fields/);
  });

  it("refuses context without its prior-session VIX gap input", async () => {
    await expect(
      writeEnrichedContextPartition(conn, {
        dataDir: tmpDir,
        date: "2025-01-06",
        selectQuery:
          "SELECT '2025-01-06' date, 4::INTEGER Vol_Regime, " +
          "1::INTEGER Term_Structure_State, 'flat'::VARCHAR Trend_Direction, " +
          "2.5::DOUBLE VIX_Spike_Pct, NULL::DOUBLE VIX_Gap_Pct",
      }),
    ).rejects.toThrow(/missing required VIX completeness fields/);
  });

  it.each([undefined, "", "2025-02-30", "2025/01/06"])(
    "rejects a JS caller date of %p before querying or composing a partition path",
    async (date) => {
      await expect(
        writeEnrichedContextPartition(conn, {
          dataDir: tmpDir,
          date,
          selectQuery: completeContextQuery,
        } as Parameters<typeof writeEnrichedContextPartition>[1]),
      ).rejects.toThrow(/date (must be an ISO calendar date|is not a real calendar date)/);
      expect(
        existsSync(join(tmpDir, "market", "enriched", "context", `date=${String(date)}`)),
      ).toBe(false);
    },
  );
});
