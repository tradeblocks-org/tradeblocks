/**
 * ParquetSpotStore — spot minute bars persisted as ticker-first Hive-partitioned
 * Parquet files (spot/ticker=X/date=Y/data.parquet).
 *
 * Writes flow through `writeSpotPartition` (Phase 1 typed helper); reads use
 * the shared SQL builders from `./spot-sql.ts` against the `market.spot`
 * view that `createMarketParquetViews` registers when partitions exist.
 * Coverage uses filesystem enumeration via `listPartitionValues` (D-26).
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode` — the factory
 * chooses the backend once at construction and every method is monomorphic.
 */
import { existsSync } from "fs";
import * as path from "path";
import { SpotStore } from "./spot-store.ts";
import type { BarRow, CoverageReport } from "./types.ts";
import { buildReadBarsSQL, buildReadDailyBarsSQL } from "./spot-sql.ts";
import { listPartitionValues } from "./coverage.ts";
import { resolveMarketDir, writeSpotPartition } from "../../db/market-datasets.ts";

export class ParquetSpotStore extends SpotStore {
  async writeBars(ticker: string, date: string, bars: BarRow[]): Promise<void> {
    if (bars.length === 0) return;
    const inputRowCount = bars.length;

    // Defense-in-depth write-side filter (per-bar).
    //
    // Reject any bar whose OHLC contains a zero or non-finite price. These
    // come from provider outages, holiday responses, or partial sessions and
    // poison every downstream aggregate that touches them: market.spot_daily
    // (min(low) → 0), enriched indicators (RSI/ATR/EMA gradient blowups),
    // and Prior_Range_vs_ATR (Intraday_Range_Pct → ~100% when low=0). The
    // earlier guard rejected only ALL-zero batches, but real-world bad data
    // tends to be partial — a few zero rows mixed into an otherwise valid
    // session. We filter those rows here so the staging table never sees them.
    //
    // Weekend dates (Sat/Sun) carry no real market activity; if the provider
    // returns rows for them, they're junk regardless of price values. Reject
    // the entire write rather than persisting a partition that downstream
    // logic will never use legitimately.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) {
      console.warn(
        `ParquetSpotStore.writeBars: skipping weekend write ` +
          `(ticker=${ticker} date=${date} rows=${bars.length})`,
      );
      return;
    }

    const cleanBars = bars.filter(
      (b) =>
        Number.isFinite(b.open) &&
        b.open > 0 &&
        Number.isFinite(b.high) &&
        b.high > 0 &&
        Number.isFinite(b.low) &&
        b.low > 0 &&
        Number.isFinite(b.close) &&
        b.close > 0,
    );
    const dropped = bars.length - cleanBars.length;
    if (dropped > 0) {
      console.warn(
        `ParquetSpotStore.writeBars: dropped ${dropped}/${bars.length} bars ` +
          `with zero/null/non-finite prices (ticker=${ticker} date=${date})`,
      );
    }
    if (cleanBars.length === 0) {
      console.warn(
        `ParquetSpotStore.writeBars: skipping write — all ${bars.length} bars ` +
          `filtered (ticker=${ticker} date=${date})`,
      );
      return;
    }
    bars = cleanBars;
    const staging = `_spot_write_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await this.ctx.conn.run(
      `CREATE TEMP TABLE "${staging}" (
         ticker VARCHAR, date VARCHAR, time VARCHAR,
         open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
         bid DOUBLE, ask DOUBLE
       )`,
    );
    try {
      const placeholders = bars
        .map((_, i) => {
          const b = i * 9;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
        })
        .join(", ");
      const params: unknown[] = bars.flatMap((b) => [
        ticker,
        date,
        b.time ?? "09:30",
        b.open,
        b.high,
        b.low,
        b.close,
        b.bid ?? null,
        b.ask ?? null,
      ]);
      await this.ctx.conn.run(
        `INSERT INTO "${staging}" VALUES ${placeholders}`,
        params as (string | number | boolean | null | bigint)[],
      );
      await writeSpotPartition(this.ctx.conn, {
        dataDir: this.ctx.dataDir,
        ticker,
        date,
        selectQuery: `SELECT * FROM "${staging}"`,
        quality: { inputRows: inputRowCount, droppedRows: dropped },
      });
    } finally {
      try {
        await this.ctx.conn.run(`DROP TABLE IF EXISTS "${staging}"`);
      } catch {
        /* best-effort */
      }
    }
  }

  async writeFromSelect(
    partition: { ticker: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }> {
    const { rowCount } = await writeSpotPartition(this.ctx.conn, {
      dataDir: this.ctx.dataDir,
      ticker: partition.ticker,
      date: partition.date,
      selectQuery: selectSql,
      quality: { kind: "writer-input-complete" },
    });
    return { rowCount };
  }

  async readBars(ticker: string, from: string, to: string): Promise<BarRow[]> {
    const direct = this.buildDirectParquetReadBarsSQL(ticker, from, to);
    // Both paths inline values — bound-param runAndReadAll(sql, values) leaks
    // extract_statements handles (parquet-quote-store.ts:327, spot-sql.ts).
    const { sql } = direct ?? buildReadBarsSQL(ticker, from, to);
    const reader = await this.ctx.conn.runAndReadAll(sql);
    return reader.getRows().map((r) => ({
      ticker: String(r[0]),
      date: String(r[1]),
      time: String(r[2]),
      open: Number(r[3]),
      high: Number(r[4]),
      low: Number(r[5]),
      close: Number(r[6]),
      bid: r[7] == null ? undefined : Number(r[7]),
      ask: r[8] == null ? undefined : Number(r[8]),
      volume: 0,
    }));
  }

  async readDailyBars(ticker: string, from: string, to: string): Promise<BarRow[]> {
    const direct = this.buildDirectParquetReadBarsSQL(ticker, from, to, { dailyAgg: true });
    // Same leak rationale as readBars — both paths run via unbound query().
    const { sql } = direct ?? buildReadDailyBarsSQL(ticker, from, to);
    const reader = await this.ctx.conn.runAndReadAll(sql);
    return reader.getRows().map((r) => ({
      ticker: String(r[0]),
      date: String(r[1]),
      time: "09:30",
      open: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      close: Number(r[5]),
      bid: r[6] == null ? undefined : Number(r[6]),
      ask: r[7] == null ? undefined : Number(r[7]),
      volume: 0,
    }));
  }

  async getCoverage(ticker: string, from: string, to: string): Promise<CoverageReport> {
    const tickerDir = path.join(resolveMarketDir(this.ctx.dataDir), "spot", `ticker=${ticker}`);
    if (!existsSync(tickerDir)) {
      return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
    }
    const allDates = listPartitionValues(tickerDir, "date");
    const dates = allDates.filter((d) => d >= from && d <= to);
    return {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      missingDates: [],
      totalDates: dates.length,
    };
  }
}
