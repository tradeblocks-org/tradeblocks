/**
 * DuckdbSpotStore — spot minute bars persisted as DuckDB physical table
 * `market.spot` (schema from `ensureMarketDataTables`).
 *
 * Writes go through `INSERT OR REPLACE INTO market.spot` with positional
 * placeholders. Reads share the same SQL builders as ParquetSpotStore — the
 * `market.spot` identifier resolves to the physical table in this mode, the
 * Parquet view in the other (CONTEXT.md D-04). Coverage uses SELECT DISTINCT
 * (D-27).
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode`.
 */
import { SpotStore } from "./spot-store.ts";
import type { BarRow, CoverageReport } from "./types.ts";
import { buildReadBarsSQL, buildReadDailyBarsSQL } from "./spot-sql.ts";

export class DuckdbSpotStore extends SpotStore {
  async writeBars(
    ticker: string,
    date: string,
    bars: BarRow[],
  ): Promise<void> {
    if (bars.length === 0) return;
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
      `INSERT OR REPLACE INTO market.spot
         (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ${placeholders}`,
      params as (string | number | boolean | null | bigint)[],
    );
  }

  async writeFromSelect(
    _partition: { ticker: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }> {
    // INSERT OR REPLACE preserves idempotency semantics of writeBars.
    // Column list matches market.spot schema (ticker, date, time, open, high, low, close, bid, ask).
    const result = await this.ctx.conn.run(
      `INSERT OR REPLACE INTO market.spot
         (ticker, date, time, open, high, low, close, bid, ask)
       ${selectSql}`,
    );
    return { rowCount: Number(result.rowsChanged) };
  }

  async readBars(
    ticker: string,
    from: string,
    to: string,
  ): Promise<BarRow[]> {
    // Builders inline values as SQL literals; the unbound runAndReadAll(sql)
    // path bypasses extract_statements (see spot-sql.ts header).
    const { sql } = buildReadBarsSQL(ticker, from, to);
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

  async readDailyBars(
    ticker: string,
    from: string,
    to: string,
  ): Promise<BarRow[]> {
    const { sql } = buildReadDailyBarsSQL(ticker, from, to);
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

  async getCoverage(
    ticker: string,
    from: string,
    to: string,
  ): Promise<CoverageReport> {
    // Inline literals — same leak rationale as readBars (spot-sql.ts header).
    const tickerLit = ticker.replace(/'/g, "''");
    const fromLit = from.replace(/'/g, "''");
    const toLit = to.replace(/'/g, "''");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT DISTINCT date FROM market.spot
         WHERE ticker = '${tickerLit}' AND date >= '${fromLit}' AND date <= '${toLit}'
         ORDER BY date`,
    );
    const dates = reader.getRows().map((r) => String(r[0]));
    return {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      missingDates: [],
      totalDates: dates.length,
    };
  }
}
