import { describe, expect, it } from "@jest/globals";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendBackfillManifestLineDurable,
  estimateBackfillBandRequestCount,
  backfillManifestPath,
  backfillPartitionPath,
  backfillShadowPartitionPath,
  collectBackfillConcreteFallbacks,
  estimateBackfillRequestCount,
  enumerateBackfillDates,
  formatBackfillManifestLine,
  groupBackfillTickersByGreekBand,
  makeBackfillManifestEntry,
  makeBackfillRunId,
  parseBackfillOccTicker,
  projectBackfillWallTimeHours,
} from "../../../../src/utils/providers/thetadata/backfill.ts";

import { backfillRewriteSelectSql } from "../../../../src/test-exports.ts";

describe("ThetaData MDDS backfill manifest helpers", () => {
  it("builds the manifest path under the ThetaData MDDS backfill manifest directory", () => {
    expect(backfillManifestPath("/data/root", "20260505-123000")).toBe(
      "/data/root/market/_manifests/thetadata-mdds-backfill/20260505-123000.ndjson",
    );
  });

  it("projects wall time from request count, average latency, and concurrency", () => {
    expect(
      projectBackfillWallTimeHours({
        requestCount: 196_892,
        avgLatencyMs: 3000,
        concurrency: 4,
      }),
    ).toBeCloseTo(41.02, 2);
  });

  it("clamps non-positive concurrency to one when projecting wall time", () => {
    expect(
      projectBackfillWallTimeHours({
        requestCount: 10,
        avgLatencyMs: 3600,
        concurrency: 0,
      }),
    ).toBe(0.01);

    expect(
      projectBackfillWallTimeHours({
        requestCount: 10,
        avgLatencyMs: 3600,
        concurrency: -2,
      }),
    ).toBe(0.01);
  });

  it("creates a sanitized audit manifest entry", () => {
    expect(
      makeBackfillManifestEntry({
        status: "committed",
        partitionPath:
          "/data/market/option_quote_minutes/underlying=spx/date=2024-07-15/data.parquet",
        underlying: "spx",
        date: "2024-07-15",
        rowCountBefore: 100,
        rowCountAfter: 100,
        providerFirstOrderRows: 90,
        computedFallbackRows: 8,
        nullGreekRows: 2,
        endpointErrors: ["  GetOptionHistoryGreeksFirstOrder failed  "],
        startedAt: "2026-05-05T10:00:00.000Z",
        completedAt: "2026-05-05T10:01:00.000Z",
      }),
    ).toEqual({
      status: "committed",
      partitionPath:
        "/data/market/option_quote_minutes/underlying=spx/date=2024-07-15/data.parquet",
      underlying: "SPX",
      date: "2024-07-15",
      rowCountBefore: 100,
      rowCountAfter: 100,
      providerFirstOrderRows: 90,
      computedFallbackRows: 8,
      nullGreekRows: 2,
      endpointErrors: ["GetOptionHistoryGreeksFirstOrder failed"],
      startedAt: "2026-05-05T10:00:00.000Z",
      completedAt: "2026-05-05T10:01:00.000Z",
    });
  });

  it("formats manifest entries as one ndjson line", () => {
    const line = formatBackfillManifestLine(
      makeBackfillManifestEntry({
        status: "prepared",
        partitionPath:
          "/data/market/option_quote_minutes/underlying=SPX/date=2024-07-15/data.parquet",
        underlying: "SPX",
        date: "2024-07-15",
        rowCountBefore: 1,
        rowCountAfter: 1,
        providerFirstOrderRows: 1,
        computedFallbackRows: 0,
        nullGreekRows: 0,
        endpointErrors: [],
        startedAt: "2026-05-05T10:00:00.000Z",
        completedAt: "2026-05-05T10:00:01.000Z",
      }),
    );

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      status: "prepared",
      underlying: "SPX",
      date: "2024-07-15",
      rowCountBefore: 1,
      rowCountAfter: 1,
    });
  });

  it("formats post-rename manifest append failures without labeling replacement failed", () => {
    const line = formatBackfillManifestLine(
      makeBackfillManifestEntry({
        status: "committed_manifest_failed",
        partitionPath:
          "/data/market/option_quote_minutes/underlying=SPX/date=2024-07-15/data.parquet",
        underlying: "SPX",
        date: "2024-07-15",
        rowCountBefore: 1,
        rowCountAfter: 1,
        providerFirstOrderRows: 1,
        computedFallbackRows: 0,
        nullGreekRows: 0,
        endpointErrors: ["manifest append failed after live rename"],
        startedAt: "2026-05-05T10:00:00.000Z",
        completedAt: "2026-05-05T10:00:01.000Z",
      }),
    );

    expect(JSON.parse(line)).toMatchObject({
      status: "committed_manifest_failed",
      rowCountBefore: 1,
      rowCountAfter: 1,
      endpointErrors: ["manifest append failed after live rename"],
    });
  });

  it("discovers inclusive date windows and rejects reversed ranges", () => {
    expect(enumerateBackfillDates("2024-07-15", "2024-07-17")).toEqual([
      "2024-07-15",
      "2024-07-16",
      "2024-07-17",
    ]);

    expect(() => enumerateBackfillDates("2024-07-18", "2024-07-17")).toThrow(
      "from must be on or before to",
    );
  });

  it("builds canonical v3 partition and shadow paths", () => {
    const partition = backfillPartitionPath("/data/root", "spx", "2024-07-15");

    expect(partition).toBe(
      "/data/root/market/option_quote_minutes/underlying=SPX/date=2024-07-15/data.parquet",
    );
    expect(backfillShadowPartitionPath(partition)).toBe(`${partition}.shadow`);
  });

  it("projects request count from discovered contracts and partitions", () => {
    expect(
      estimateBackfillRequestCount({
        partitionCount: 2,
        contractCount: 275,
      }),
    ).toBe(550);
  });

  it("groups existing partition tickers into reusable first-order greeks bands", () => {
    expect(
      groupBackfillTickersByGreekBand(
        [
          "SPXW240805C05725000",
          "SPXW240805P05725000",
          "SPXW240816C05730000",
          "SPX240816C05730000",
          "SPXW240805C05725000",
        ],
        "2024-07-15",
      ),
    ).toEqual([
      {
        key: "SPX|2024-08-16|2024-07-15",
        symbol: "SPX",
        expiration: "2024-08-16",
        date: "2024-07-15",
        contracts: [
          {
            ticker: "SPX240816C05730000",
            symbol: "SPX",
            expiration: "2024-08-16",
            right: "call",
            strike: 5730,
            strikeText: "5730.000",
          },
        ],
      },
      {
        key: "SPXW|2024-08-05|2024-07-15",
        symbol: "SPXW",
        expiration: "2024-08-05",
        date: "2024-07-15",
        contracts: [
          {
            ticker: "SPXW240805C05725000",
            symbol: "SPXW",
            expiration: "2024-08-05",
            right: "call",
            strike: 5725,
            strikeText: "5725.000",
          },
          {
            ticker: "SPXW240805P05725000",
            symbol: "SPXW",
            expiration: "2024-08-05",
            right: "put",
            strike: 5725,
            strikeText: "5725.000",
          },
        ],
      },
      {
        key: "SPXW|2024-08-16|2024-07-15",
        symbol: "SPXW",
        expiration: "2024-08-16",
        date: "2024-07-15",
        contracts: [
          {
            ticker: "SPXW240816C05730000",
            symbol: "SPXW",
            expiration: "2024-08-16",
            right: "call",
            strike: 5730,
            strikeText: "5730.000",
          },
        ],
      },
    ]);
  });

  it("parses OCC tickers for concrete fallback calls", () => {
    expect(parseBackfillOccTicker("NDX240816P19000000")).toEqual({
      ticker: "NDX240816P19000000",
      symbol: "NDX",
      expiration: "2024-08-16",
      right: "put",
      strike: 19000,
      strikeText: "19000.000",
    });
  });

  it("estimates band-first backfill requests from band groups plus fallback contracts", () => {
    expect(
      estimateBackfillBandRequestCount({
        bandGroupCount: 42,
        fallbackContractCount: 3,
      }),
    ).toBe(45);
  });

  it("chooses concrete fallback only for partial missing minutes on band-covered contracts", () => {
    const [group] = groupBackfillTickersByGreekBand(
      ["SPXW240805C05725000", "SPXW240805P05725000"],
      "2024-07-15",
    );

    const fallbacks = collectBackfillConcreteFallbacks({
      group,
      expectedTimesByTicker: new Map([
        ["SPXW240805C05725000", new Set(["09:30", "09:31"])],
        ["SPXW240805P05725000", new Set(["09:30"])],
      ]),
      stagedRows: [{ ticker: "SPXW240805C05725000", timestamp: "2024-07-15 09:30" }],
    });

    expect(fallbacks).toEqual([
      {
        contract: {
          ticker: "SPXW240805C05725000",
          symbol: "SPXW",
          expiration: "2024-08-05",
          right: "call",
          strike: 5725,
          strikeText: "5725.000",
        },
        missingTimes: ["09:31"],
      },
    ]);
  });

  it("can opt into concrete fallback for contracts absent from the band", () => {
    const [group] = groupBackfillTickersByGreekBand(
      ["SPXW240805C05725000", "SPXW240805P05725000"],
      "2024-07-15",
    );

    const fallbacks = collectBackfillConcreteFallbacks({
      group,
      fallbackUncoveredContracts: true,
      expectedTimesByTicker: new Map([
        ["SPXW240805C05725000", new Set(["09:30", "09:31"])],
        ["SPXW240805P05725000", new Set(["09:30"])],
      ]),
      stagedRows: [{ ticker: "SPXW240805C05725000", timestamp: "2024-07-15 09:30" }],
    });

    expect(fallbacks).toEqual([
      {
        contract: {
          ticker: "SPXW240805C05725000",
          symbol: "SPXW",
          expiration: "2024-08-05",
          right: "call",
          strike: 5725,
          strikeText: "5725.000",
        },
        missingTimes: ["09:31"],
      },
      {
        contract: {
          ticker: "SPXW240805P05725000",
          symbol: "SPXW",
          expiration: "2024-08-05",
          right: "put",
          strike: 5725,
          strikeText: "5725.000",
        },
        missingTimes: ["09:30"],
      },
    ]);
  });

  it("builds deterministic filesystem-safe run ids", () => {
    expect(makeBackfillRunId(new Date("2026-05-05T10:01:02.003Z"))).toBe("20260505T100102003Z");
  });

  it("durably appends manifest lines in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tb-backfill-manifest-"));
    const manifestPath = join(dir, "manifest.ndjson");
    try {
      await appendBackfillManifestLineDurable(manifestPath, '{"status":"prepared"}\n');
      await appendBackfillManifestLineDurable(manifestPath, '{"status":"committed"}\n');

      await expect(readFile(manifestPath, "utf8")).resolves.toBe(
        '{"status":"prepared"}\n{"status":"committed"}\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves source Parquet types and narrows only provider updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tb-backfill-parquet-"));
    const sourcePath = join(dir, "source.parquet");
    const parquetPath = join(dir, "rewrite.parquet");
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    const provider = {
      delta: 0.512345678901234,
      gamma: 0.456789123,
      theta: -0.123456789123,
      vega: 1.234567891234,
      iv: 0.234567891234,
      rate_value: 0.0523456789,
    };

    try {
      await conn.run(`
        CREATE TABLE source_quote_minutes (
          underlying VARCHAR, date DATE, ticker VARCHAR, time VARCHAR,
          bid REAL, ask DOUBLE, mid REAL, last_updated_ns BIGINT, source VARCHAR,
          delta DOUBLE, gamma REAL, theta DOUBLE, vega FLOAT, iv DOUBLE,
          greeks_source VARCHAR, greeks_revision SMALLINT,
          rate_type VARCHAR, rate_value REAL, gamma_source VARCHAR,
          residual_metric DECIMAL(9, 4)
        )
      `);
      await conn.run(`
        INSERT INTO source_quote_minutes VALUES
        (
          'SPX', DATE '2024-07-15', 'SPXW240715C05000000', '09:30',
          1.0, 1.2, 1.1, 101, 'nbbo',
          0.123456789123, NULL, -0.123456789123, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, 123.4567
        ),
        (
          'SPX', DATE '2024-07-15', 'SPXW240715C05000000', '10:14',
          1.3, 1.5, 1.4, 202, 'nbbo',
          0.987654321987, -0.456789, NULL, 0.000000076543, NULL,
          'computed', 3, 'sofr', 0.04567, 'local', 765.4321
        )
      `);
      await conn.run(`
        COPY source_quote_minutes
        TO '${sourcePath.replace(/'/g, "''")}' (FORMAT PARQUET)
      `);
      await conn.run(`
        CREATE TABLE existing_quote_minutes AS
        SELECT * FROM read_parquet('${sourcePath.replace(/'/g, "''")}')
      `);
      await conn.run(`
        CREATE TABLE provider_greeks_dedup (
          ticker VARCHAR, time VARCHAR,
          delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE, iv DOUBLE,
          greeks_source VARCHAR, greeks_revision INTEGER,
          rate_type VARCHAR, rate_value DOUBLE, gamma_source VARCHAR
        )
      `);
      await conn.run(`
        INSERT INTO provider_greeks_dedup VALUES (
          'SPXW240715C05000000', '09:30',
          ${provider.delta}, ${provider.gamma}, ${provider.theta},
          ${provider.vega}, ${provider.iv},
          'thetadata', 2, 'sofr', ${provider.rate_value}, 'provider'
        )
      `);
      await conn.run(`
        COPY (
          ${backfillRewriteSelectSql({
            existingTable: "existing_quote_minutes",
            providerGreeksTable: "provider_greeks_dedup",
          })}
        ) TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)
      `);

      const sourceSchema = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet('${sourcePath.replace(/'/g, "''")}')`,
      );
      const rewrittenSchema = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}')`,
      );
      const sourceTypes = sourceSchema.getRows().map((row) => [String(row[0]), String(row[1])]);
      const rewrittenTypes = rewrittenSchema
        .getRows()
        .map((row) => [String(row[0]), String(row[1])]);
      expect(rewrittenTypes).toEqual(sourceTypes);
      expect(Object.fromEntries(rewrittenTypes)).toMatchObject({
        date: "DATE",
        bid: "FLOAT",
        delta: "DOUBLE",
        gamma: "FLOAT",
        theta: "DOUBLE",
        vega: "FLOAT",
        iv: "DOUBLE",
        greeks_revision: "SMALLINT",
        rate_value: "FLOAT",
        residual_metric: "DECIMAL(9,4)",
      });

      const sourceRows = await conn.runAndReadAll(
        `SELECT * FROM read_parquet('${sourcePath.replace(/'/g, "''")}') ORDER BY time`,
      );
      const rewrittenRows = await conn.runAndReadAll(
        `SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}') ORDER BY time`,
      );
      const before = sourceRows.getRowObjects();
      const after = rewrittenRows.getRowObjects();
      expect(after).toHaveLength(before.length);
      expect(after[1]).toEqual(before[1]);
      expect(after[0]).toMatchObject({
        delta: provider.delta,
        gamma: Math.fround(provider.gamma),
        theta: provider.theta,
        vega: Math.fround(provider.vega),
        iv: provider.iv,
        greeks_source: "thetadata",
        greeks_revision: 2,
        rate_type: "sofr",
        rate_value: Math.fround(provider.rate_value),
        gamma_source: "provider",
      });
    } finally {
      conn.closeSync();
      db.closeSync();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
