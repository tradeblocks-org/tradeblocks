/**
 * ParquetOiDailyStore — daily option open-interest persisted as
 * underlying-first Hive-partitioned Parquet files
 * (option_oi_daily/underlying=X/date=Y/data.parquet).
 *
 * Open interest is reported at daily granularity: one row per contract per
 * day. The partition layout mirrors `option_quote_minutes` (underlying then
 * date) so the same per-underlying read grouping applies.
 *
 * Columns: underlying VARCHAR, date VARCHAR, ticker VARCHAR,
 * expiration VARCHAR, strike DOUBLE, right VARCHAR, open_interest BIGINT,
 * source VARCHAR.
 */
import { existsSync } from "fs";
import * as path from "path";
import type { StoreContext } from "./types.ts";
import type { OiDailyRow } from "./types.ts";
import { listPartitionValues } from "./coverage.ts";
import {
  resolveMarketDir,
  writeOiDailyPartition,
} from "../../db/market-datasets.ts";
import { readParquetFilesSql } from "../../utils/quote-parquet-projection.ts";

// `right` is a reserved keyword in DuckDB (the RIGHT(string, n) function), so
// it must be double-quoted everywhere it appears as a column identifier.
const OI_DAILY_COLUMNS =
  'underlying, date, ticker, expiration, strike, "right", open_interest, source';

function parseOiDailyRow(row: unknown[]): OiDailyRow {
  return {
    underlying: String(row[0]),
    date: String(row[1]),
    occ_ticker: String(row[2]),
    expiration: String(row[3]),
    strike: Number(row[4]),
    right: String(row[5]) as OiDailyRow["right"],
    open_interest: Number(row[6]),
    source: row[7] == null ? null : String(row[7]),
  };
}

export class ParquetOiDailyStore {
  protected readonly ctx: StoreContext;
  constructor(ctx: StoreContext) {
    this.ctx = ctx;
  }

  async writeOiDaily(
    underlying: string,
    date: string,
    rows: OiDailyRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // Append via DuckDBAppender (typed per-column) rather than a parameterized
    // INSERT with O(N) placeholders — mirrors the quote store's write path.
    const staging = `_oi_write_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await this.ctx.conn.run(
      `CREATE TEMP TABLE "${staging}" (
         underlying VARCHAR, date VARCHAR, ticker VARCHAR,
         expiration VARCHAR, strike DOUBLE, "right" VARCHAR,
         open_interest BIGINT, source VARCHAR
       )`,
    );
    try {
      const appender = await this.ctx.conn.createAppender(staging);
      try {
        for (const r of rows) {
          appender.appendVarchar(underlying);
          appender.appendVarchar(r.date);
          appender.appendVarchar(r.occ_ticker);
          appender.appendVarchar(r.expiration);
          appender.appendDouble(r.strike);
          appender.appendVarchar(r.right);
          appender.appendBigInt(BigInt(Math.round(r.open_interest)));
          if (r.source == null) appender.appendNull();
          else appender.appendVarchar(r.source);
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
      await writeOiDailyPartition(this.ctx.conn, {
        dataDir: this.ctx.dataDir,
        underlying,
        date,
        selectQuery: `SELECT ${OI_DAILY_COLUMNS} FROM "${staging}"`,
      });
    } finally {
      try {
        await this.ctx.conn.run(`DROP TABLE IF EXISTS "${staging}"`);
      } catch {
        /* best-effort */
      }
    }
  }

  async readOiDaily(
    underlying: string,
    from: string,
    to: string,
  ): Promise<OiDailyRow[]> {
    const underlyingDir = path.join(
      resolveMarketDir(this.ctx.dataDir),
      "option_oi_daily",
      `underlying=${underlying}`,
    );
    if (!existsSync(underlyingDir)) return [];
    const files = listPartitionValues(underlyingDir, "date")
      .filter((date) => date >= from && date <= to)
      .map((date) => path.join(underlyingDir, `date=${date}`, "data.parquet"))
      .filter((filePath) => existsSync(filePath));
    if (files.length === 0) return [];

    const source = readParquetFilesSql(files);
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT ${OI_DAILY_COLUMNS}
         FROM ${source} AS q
        WHERE q.date >= $1
          AND q.date <= $2
        ORDER BY q.date, q.ticker`,
      [from, to] as (string | number | boolean | null | bigint)[],
    );
    return reader.getRows().map(parseOiDailyRow);
  }
}
