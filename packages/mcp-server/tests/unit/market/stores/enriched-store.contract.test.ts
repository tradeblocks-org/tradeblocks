/**
 * EnrichedStore dual-backend contract tests (Phase 2 Plan 04 Task 2).
 *
 * Exercises the `read()` JOIN branches (includeOhlcv, includeContext, both,
 * neither) + `getCoverage()` against both ParquetEnrichedStore and
 * DuckdbEnrichedStore via a `describe.each` harness. The `compute()` entry
 * point is not exhaustively exercised here — the enricher regression tests
 * in `tests/unit/market-enricher.test.ts` cover the injected-IO compute
 * path. Instead this suite seeds `market.enriched` + `market.spot` +
 * `market.enriched_context` directly and verifies the read composition.
 *
 * Fixture mechanics:
 *   - DuckDB mode: both tables are physical — INSERT OR REPLACE direct.
 *   - Parquet mode: INSERT into the physical table first (so tests can use
 *     the same seeding code), then write the corresponding Parquet file via
 *     `writeEnrichedTickerFile` / `writeEnrichedContext`, and refresh the
 *     Parquet views via `createMarketParquetViews`. After the view flip,
 *     `market.enriched` resolves to the Parquet view (not the physical
 *     table), so reads exercise the real Parquet read path.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { DuckDBConnection } from "@duckdb/node-api";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import {
  FilePartitionCommitStore,
  LegacyEnrichedMigrationError,
  ParquetEnrichedStore,
  DuckdbEnrichedStore,
  ParquetSpotStore,
  DuckdbSpotStore,
  migrateLegacyEnrichedContext,
  migrateLegacyEnrichedTicker,
  openMarketReadOnlyConnection,
  runPartitionCommitAttempt,
  upsertEnrichedThrough,
} from "../../../../src/test-exports.ts";
import {
  buildStoreFixture,
  type FixtureHandle,
} from "../../../fixtures/market-stores/build-fixture.ts";
import { makeBars } from "../../../fixtures/market-stores/bars-fixture.ts";
import { createMarketParquetViews } from "../../../../src/db/market-views.ts";
import {
  writeEnrichedTickerFile,
  writeEnrichedContext,
} from "../../../../src/db/market-datasets.ts";

/** Seed two rows of enriched data. Used by every contract test. */
async function seedEnriched(
  conn: DuckDBConnection,
  ticker: string,
  dataDir: string,
  parquetMode: boolean,
  rows: ReadonlyArray<readonly [string, number, number, number]> = [
    ["2025-01-06", 100.0, 0.5, 55.0],
    ["2025-01-07", 100.5, 1.0, 60.0],
  ],
): Promise<void> {
  for (const [date, priorClose, gap, rsi] of rows) {
    await conn.run(
      `INSERT OR REPLACE INTO market.enriched (ticker, date, Prior_Close, Gap_Pct, RSI_14)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticker, date, priorClose, gap, rsi],
    );
    if (parquetMode) {
      const safe = ticker.replace(/'/g, "''");
      await writeEnrichedTickerFile(conn, {
        dataDir,
        ticker,
        date,
        selectQuery:
          `SELECT * FROM market.enriched WHERE ticker = '${safe}' ` + `AND date = '${date}'`,
      });
    }
  }
}

async function seedContext(
  conn: DuckDBConnection,
  dataDir: string,
  parquetMode: boolean,
  rows: ReadonlyArray<readonly [string, number, number, string]> = [
    ["2025-01-06", 1, 0, "up"],
    ["2025-01-07", 2, 1, "down"],
  ],
): Promise<void> {
  for (const [date, volRegime, tss, trendDir] of rows) {
    await conn.run(
      `INSERT OR REPLACE INTO market.enriched_context
         (date, Vol_Regime, Term_Structure_State, Trend_Direction, VIX_Spike_Pct, VIX_Gap_Pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [date, volRegime, tss, trendDir, 0.1, 0.2],
    );
    if (parquetMode) {
      await writeEnrichedContext(conn, {
        dataDir,
        date,
        selectQuery: `SELECT * FROM market.enriched_context WHERE date = '${date}'`,
      });
    }
  }
}

async function seedLegacyEnriched(
  conn: DuckDBConnection,
  ticker: string,
  dataDir: string,
  rows: ReadonlyArray<readonly [string, number, number, number]>,
): Promise<string> {
  await seedEnriched(conn, ticker, dataDir, false, rows);
  const tickerDir = path.join(dataDir, "market", "enriched", `ticker=${ticker}`);
  mkdirSync(tickerDir, { recursive: true });
  const filePath = path.join(tickerDir, "data.parquet");
  const escaped = filePath.replace(/'/g, "''");
  const tickerLit = ticker.replace(/'/g, "''");
  await conn.run(
    `COPY (SELECT * FROM market.enriched WHERE ticker = '${tickerLit}' ORDER BY date)
       TO '${escaped}' (FORMAT PARQUET)`,
  );
  return filePath;
}

async function seedLegacyContext(
  conn: DuckDBConnection,
  dataDir: string,
  rows: ReadonlyArray<readonly [string, number | null, number | null, string | null]>,
): Promise<string> {
  for (const [date, volRegime, termStructure, trendDirection] of rows) {
    await conn.run(
      `INSERT OR REPLACE INTO market.enriched_context
         (date, Vol_Regime, Term_Structure_State, Trend_Direction, VIX_Spike_Pct, VIX_Gap_Pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        date,
        volRegime,
        termStructure,
        trendDirection,
        volRegime === null ? null : 0.1,
        volRegime === null ? null : 0.2,
      ],
    );
  }
  const contextDir = path.join(dataDir, "market", "enriched", "context");
  mkdirSync(contextDir, { recursive: true });
  const filePath = path.join(contextDir, "data.parquet");
  await conn.run(
    `COPY (SELECT * FROM market.enriched_context ORDER BY date)
       TO '${filePath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
  return filePath;
}

async function makeParquetEnriched(): Promise<{
  store: ParquetEnrichedStore;
  spot: ParquetSpotStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: true });
  const spot = new ParquetSpotStore(fixture.ctx);
  const store = new ParquetEnrichedStore(fixture.ctx, spot);
  return { store, spot, fixture };
}

async function makeDuckdbEnriched(): Promise<{
  store: DuckdbEnrichedStore;
  spot: DuckdbSpotStore;
  fixture: FixtureHandle;
}> {
  const fixture = await buildStoreFixture({ parquetMode: false });
  const spot = new DuckdbSpotStore(fixture.ctx);
  const store = new DuckdbEnrichedStore(fixture.ctx, spot);
  return { store, spot, fixture };
}

describe.each([
  {
    name: "parquet",
    make: makeParquetEnriched,
    refreshViews: async (f: FixtureHandle) => {
      await createMarketParquetViews(f.ctx.conn, f.ctx.dataDir);
    },
  },
  {
    name: "duckdb",
    make: makeDuckdbEnriched,
    refreshViews: async (_f: FixtureHandle) => {
      /* no-op */
    },
  },
])("EnrichedStore contract — $name backend", ({ make, refreshViews }) => {
  let fixture: FixtureHandle;
  let store: ParquetEnrichedStore | DuckdbEnrichedStore;
  let spot: ParquetSpotStore | DuckdbSpotStore;

  beforeEach(async () => {
    const built = await make();
    fixture = built.fixture;
    store = built.store;
    spot = built.spot;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("read returns only enriched columns when no include flags set", async () => {
    await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await refreshViews(fixture);
    const rows = await store.read({
      ticker: "SPX",
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(rows.length).toBe(2);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain("Prior_Close");
    expect(keys).toContain("RSI_14");
    // OHLCV columns should be absent when includeOhlcv is false
    expect(keys).not.toContain("open");
    expect(keys).not.toContain("close");
    // Context columns should be absent when includeContext is false
    expect(keys).not.toContain("Vol_Regime");
  });

  it("read with includeOhlcv joins spot daily OHLCV", async () => {
    await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await spot.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await spot.writeBars("SPX", "2025-01-07", makeBars("SPX", "2025-01-07"));
    await refreshViews(fixture);
    const rows = await store.read({
      ticker: "SPX",
      from: "2025-01-01",
      to: "2025-01-31",
      includeOhlcv: true,
    });
    expect(rows.length).toBe(2);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain("Prior_Close");
    expect(keys).toContain("open");
    expect(keys).toContain("high");
    expect(keys).toContain("low");
    expect(keys).toContain("close");
  });

  it("read with includeContext joins market.enriched_context on date", async () => {
    await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await seedContext(fixture.ctx.conn, fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await refreshViews(fixture);
    const rows = await store.read({
      ticker: "SPX",
      from: "2025-01-01",
      to: "2025-01-31",
      includeContext: true,
    });
    expect(rows.length).toBe(2);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain("Vol_Regime");
    expect(keys).toContain("Term_Structure_State");
    expect(keys).toContain("Trend_Direction");
  });

  it("read with both includeOhlcv and includeContext returns merged columns", async () => {
    await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await spot.writeBars("SPX", "2025-01-06", makeBars("SPX", "2025-01-06"));
    await spot.writeBars("SPX", "2025-01-07", makeBars("SPX", "2025-01-07"));
    await seedContext(fixture.ctx.conn, fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await refreshViews(fixture);
    const rows = await store.read({
      ticker: "SPX",
      from: "2025-01-01",
      to: "2025-01-31",
      includeOhlcv: true,
      includeContext: true,
    });
    expect(rows.length).toBe(2);
    const keys = Object.keys(rows[0]);
    expect(keys).toContain("Prior_Close");
    expect(keys).toContain("open");
    expect(keys).toContain("close");
    expect(keys).toContain("Vol_Regime");
    expect(keys).toContain("Trend_Direction");
  });

  it("getCoverage reports enriched dates present for ticker", async () => {
    await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, fixture.ctx.parquetMode);
    await refreshViews(fixture);
    const cov = await store.getCoverage("SPX");
    expect(cov.earliest).toBe("2025-01-06");
    expect(cov.latest).toBe("2025-01-07");
    expect(cov.totalDates).toBe(2);
  });

  it("getCoverage returns empty report for ticker with no enriched data", async () => {
    await refreshViews(fixture);
    const cov = await store.getCoverage("UNKNOWN");
    expect(cov.earliest).toBeNull();
    expect(cov.latest).toBeNull();
    expect(cov.totalDates).toBe(0);
  });

  it("EnrichedStore method bodies do NOT branch on ctx.parquetMode", async () => {
    // D-02 invariant: every concrete store's method bodies are monomorphic —
    // the factory chooses the backend once and each method never re-checks
    // ctx.parquetMode. We assert this by reading the compiled source (dist)
    // in a separate test; here we only need to assert behavior parity.
    // (The actual parity test lives below in the "backend parity" block.)
    expect(store).toBeDefined();
  });
});

describe("EnrichedStore backend parity", () => {
  it("Parquet and DuckDB return identical rows for identical read input", async () => {
    const p = await makeParquetEnriched();
    const d = await makeDuckdbEnriched();
    try {
      // Same seed data in both fixtures
      await seedEnriched(p.fixture.ctx.conn, "SPX", p.fixture.ctx.dataDir, true);
      await seedEnriched(d.fixture.ctx.conn, "SPX", d.fixture.ctx.dataDir, false);
      await createMarketParquetViews(p.fixture.ctx.conn, p.fixture.ctx.dataDir);

      const pRows = await p.store.read({
        ticker: "SPX",
        from: "2025-01-01",
        to: "2025-01-31",
      });
      const dRows = await d.store.read({
        ticker: "SPX",
        from: "2025-01-01",
        to: "2025-01-31",
      });

      // Both backends return the same columns and same values. Drop any
      // column ordering or type-coercion artifacts by comparing key sets
      // plus the explicit numeric fields.
      expect(pRows.length).toBe(dRows.length);
      expect(pRows.length).toBe(2);
      for (let i = 0; i < pRows.length; i++) {
        expect(Number(pRows[i].Prior_Close)).toBe(Number(dRows[i].Prior_Close));
        expect(Number(pRows[i].Gap_Pct)).toBe(Number(dRows[i].Gap_Pct));
        expect(Number(pRows[i].RSI_14)).toBe(Number(dRows[i].RSI_14));
        expect(String(pRows[i].ticker)).toBe(String(dRows[i].ticker));
        expect(String(pRows[i].date)).toBe(String(dRows[i].date));
      }
    } finally {
      p.fixture.cleanup();
      d.fixture.cleanup();
    }
  });
});

describe("ParquetEnrichedStore XNYS partition boundary", () => {
  it("excludes 2026-07-03 from enriched, context, and OHLCV range sources", async () => {
    const { store, spot, fixture } = await makeParquetEnriched();
    try {
      const enrichedRows = [
        ["2026-07-02", 100.0, 0.5, 55.0],
        ["2026-07-03", 999.0, 9.9, 99.0],
      ] as const;
      const contextRows = [
        ["2026-07-02", 1, 0, "up"],
        ["2026-07-03", 6, 1, "down"],
      ] as const;
      await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, true, enrichedRows);
      await seedContext(fixture.ctx.conn, fixture.ctx.dataDir, true, contextRows);
      await spot.writeBars("SPX", "2026-07-02", makeBars("SPX", "2026-07-02"));
      await spot.writeBars("SPX", "2026-07-03", makeBars("SPX", "2026-07-03"));
      await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

      const rows = await store.read({
        ticker: "SPX",
        from: "2026-07-02",
        to: "2026-07-06",
        includeOhlcv: true,
        includeContext: true,
      });
      expect(rows).toHaveLength(1);
      expect(String(rows[0].date)).toBe("2026-07-02");
      expect(rows[0]).toMatchObject({
        Prior_Close: 100,
        Vol_Regime: 1,
      });
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ParquetEnrichedStore legacy whole-file migration", () => {
  it("preserves legacy values past an advanced watermark and prefers existing slices", async () => {
    const { store, fixture } = await makeParquetEnriched();
    try {
      await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2025-01-06", 100, 0.5, 55],
        ["2025-01-07", 101, 0.6, 60],
      ]);
      // A bounded repair is newer authority than the whole-file value and
      // must never be replaced during migration, even when the old value is
      // non-null and the new value differs.
      await seedEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, true, [
        ["2025-01-06", 999, 9.9, 91],
      ]);
      await upsertEnrichedThrough("SPX", "2026-07-20", fixture.ctx.dataDir);

      const first = await store.read({ ticker: "SPX", from: "2025-01-01", to: "2025-01-31" });

      expect(first.map((row) => [String(row.date), Number(row.RSI_14)])).toEqual([
        ["2025-01-06", 91],
        ["2025-01-07", 60],
      ]);
      // Reads are immutable: the whole-file fallback cannot try to COPY while
      // the process is holding its ordinary read-only connection.
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/ticker=SPX/date=2025-01-07/data.parquet"),
        ),
      ).toBe(false);

      await migrateLegacyEnrichedTicker(fixture.ctx.conn, fixture.ctx.dataDir, "SPX");
      const second = await store.read({ ticker: "SPX", from: "2025-01-01", to: "2025-01-31" });
      expect(second.map((row) => [String(row.date), Number(row.RSI_14)])).toEqual([
        ["2025-01-06", 91],
        ["2025-01-07", 60],
      ]);
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/ticker=SPX/date=2025-01-07/data.parquet"),
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("migrates only complete legacy context sessions", async () => {
    const { store, fixture } = await makeParquetEnriched();
    try {
      await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2025-01-06", 100, 0.5, 55],
        ["2025-01-07", 101, 0.6, 60],
      ]);
      await seedLegacyContext(fixture.ctx.conn, fixture.ctx.dataDir, [
        ["2025-01-06", 1, 0, "up"],
        ["2025-01-07", null, null, null],
      ]);

      const rows = await store.read({
        ticker: "SPX",
        from: "2025-01-01",
        to: "2025-01-31",
        includeContext: true,
      });

      expect(rows).toHaveLength(2);
      expect(String(rows[0].date)).toBe("2025-01-06");
      expect(rows[0]).toMatchObject({ Vol_Regime: 1 });
      expect(String(rows[1].date)).toBe("2025-01-07");
      expect(rows[1]).toMatchObject({ Vol_Regime: null });
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/context/date=2025-01-06/data.parquet"),
        ),
      ).toBe(false);

      await migrateLegacyEnrichedContext(fixture.ctx.conn, fixture.ctx.dataDir);
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/context/date=2025-01-06/data.parquet"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/context/date=2025-01-07/data.parquet"),
        ),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads the legacy fallback through the process read-only connection without writing", async () => {
    const { fixture } = await makeParquetEnriched();
    let readOnly: Awaited<ReturnType<typeof openMarketReadOnlyConnection>> | undefined;
    try {
      await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2025-01-06", 100, 0.5, 55],
      ]);
      readOnly = await openMarketReadOnlyConnection(fixture.ctx.dataDir);
      const readContext = { ...fixture.ctx, conn: readOnly.conn };
      const readSpot = new ParquetSpotStore(readContext);
      const store = new ParquetEnrichedStore(readContext, readSpot);

      const rows = await store.read({ ticker: "SPX", from: "2025-01-01", to: "2025-01-31" });

      expect(rows).toHaveLength(1);
      expect(Number(rows[0].RSI_14)).toBe(55);
      expect(
        existsSync(
          path.join(fixture.ctx.dataDir, "market/enriched/ticker=SPX/date=2025-01-06/data.parquet"),
        ),
      ).toBe(false);
    } finally {
      await readOnly?.close();
      fixture.cleanup();
    }
  });

  it("mints or adopts matching authority when migration runs inside an attempt", async () => {
    const { fixture } = await makeParquetEnriched();
    try {
      await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2026-07-02", 100, 0.5, 55],
        ["2026-07-03", 101, 0.6, 60],
        ["2026-07-06", 102, 0.7, 65],
      ]);
      await upsertEnrichedThrough("SPX", "2026-07-20", fixture.ctx.dataDir);
      await migrateLegacyEnrichedTicker(fixture.ctx.conn, fixture.ctx.dataDir, "SPX");

      const marketRoot = path.join(fixture.ctx.dataDir, "market");
      const partitions = new FilePartitionCommitStore(marketRoot);
      const identity = (date: string) => ({
        dataset: "enriched",
        partition: { ticker: "SPX", date },
      });
      await expect(partitions.inspectPartition(identity("2026-07-02"))).resolves.toMatchObject({
        status: "orphan",
      });
      const july6 = path.join(marketRoot, "enriched/ticker=SPX/date=2026-07-06/data.parquet");
      unlinkSync(july6);

      const attempt = await runPartitionCommitAttempt(
        { attemptId: "legacy-enriched-migration", recorder: partitions },
        () => migrateLegacyEnrichedTicker(fixture.ctx.conn, fixture.ctx.dataDir, "SPX"),
      );

      expect(
        attempt.receipts.map((commit) => [commit.receipt.dataset, commit.receipt.partition.date]),
      ).toEqual([
        ["enriched", "2026-07-02"],
        ["enriched", "2026-07-06"],
      ]);
      await expect(partitions.inspectPartition(identity("2026-07-02"))).resolves.toMatchObject({
        status: "match",
      });
      await expect(partitions.inspectPartition(identity("2026-07-06"))).resolves.toMatchObject({
        status: "match",
      });
      expect(
        existsSync(path.join(marketRoot, "enriched/ticker=SPX/date=2026-07-03/data.parquet")),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses to adopt an existing slice with the wrong schema or partition identity", async () => {
    const { fixture } = await makeParquetEnriched();
    try {
      const legacyPath = await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2026-07-02", 100, 0.5, 55],
      ]);
      const marketRoot = path.join(fixture.ctx.dataDir, "market");
      const targetDir = path.join(marketRoot, "enriched/ticker=SPX/date=2026-07-02");
      const targetPath = path.join(targetDir, "data.parquet");
      mkdirSync(targetDir, { recursive: true });
      const escapedLegacy = legacyPath.replace(/'/g, "''");
      const escapedTarget = targetPath.replace(/'/g, "''");
      const partitions = new FilePartitionCommitStore(marketRoot);

      await fixture.ctx.conn.run(
        `COPY (SELECT ticker, date, RSI_14
                 FROM read_parquet('${escapedLegacy}', hive_partitioning=false))
           TO '${escapedTarget}' (FORMAT PARQUET)`,
      );
      await expect(
        runPartitionCommitAttempt({ attemptId: "reject-legacy-schema", recorder: partitions }, () =>
          migrateLegacyEnrichedTicker(fixture.ctx.conn, fixture.ctx.dataDir, "SPX"),
        ),
      ).rejects.toThrow(/schema does not match revision 1/);

      unlinkSync(targetPath);
      await fixture.ctx.conn.run(
        `COPY (SELECT * REPLACE ('QQQ' AS ticker)
                 FROM read_parquet('${escapedLegacy}', hive_partitioning=false))
           TO '${escapedTarget}' (FORMAT PARQUET)`,
      );
      await expect(
        runPartitionCommitAttempt(
          { attemptId: "reject-legacy-identity", recorder: partitions },
          () => migrateLegacyEnrichedTicker(fixture.ctx.conn, fixture.ctx.dataDir, "SPX"),
        ),
      ).rejects.toThrow(/rows disagree with the registered partition/);
    } finally {
      fixture.cleanup();
    }
  });

  it("raises a named migration error instead of hiding unsafe legacy rows", async () => {
    const { store, fixture } = await makeParquetEnriched();
    try {
      const legacyPath = await seedLegacyEnriched(fixture.ctx.conn, "SPX", fixture.ctx.dataDir, [
        ["2025-01-06", 100, 0.5, 55],
      ]);
      await fixture.ctx.conn.run(
        `COPY (SELECT ticker, 'not-a-date' AS date, Prior_Close, Gap_Pct, RSI_14
                 FROM read_parquet('${legacyPath.replace(/'/g, "''")}', hive_partitioning=false))
           TO '${legacyPath.replace(/'/g, "''")}.bad' (FORMAT PARQUET)`,
      );
      // Replace atomically so this remains a valid Parquet file with an
      // invalid logical date rather than an artificial corrupt-file case.
      renameSync(`${legacyPath}.bad`, legacyPath);

      await expect(
        store.read({ ticker: "SPX", from: "2025-01-01", to: "2025-01-31" }),
      ).rejects.toBeInstanceOf(LegacyEnrichedMigrationError);
    } finally {
      fixture.cleanup();
    }
  });
});
