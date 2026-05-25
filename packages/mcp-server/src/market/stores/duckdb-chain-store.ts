/**
 * DuckdbChainStore — option chain persisted as DuckDB physical table
 * `market.option_chain`. Phase 1 schema already includes the `underlying`
 * column (D-13), so no DROP+recreate migration is needed.
 *
 * Writes via `INSERT OR REPLACE INTO market.option_chain` with positional
 * placeholders; reads via shared `buildReadChainSQL`. Coverage via
 * SELECT DISTINCT date (D-27).
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode`.
 */
import { ChainStore } from "./chain-store.js";
import type { ContractRow, CoverageReport } from "./types.js";
import { buildReadChainSQL } from "./chain-sql.js";

export class DuckdbChainStore extends ChainStore {
  async writeChain(
    underlying: string,
    date: string,
    rows: ContractRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows
      .map((_, i) => {
        const b = i * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      })
      .join(", ");
    const params: unknown[] = rows.flatMap((r) => [
      underlying,
      date,
      r.ticker,
      r.contract_type,
      r.strike,
      r.expiration,
      r.dte ?? null,
      r.exercise_style ?? null,
    ]);
    await this.ctx.conn.run(
      `INSERT OR REPLACE INTO market.option_chain
         (underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style)
       VALUES ${placeholders}`,
      params as (string | number | boolean | null | bigint)[],
    );
  }

  async writeFromSelect(
    _partition: { underlying: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }> {
    const result = await this.ctx.conn.run(
      `INSERT OR REPLACE INTO market.option_chain
         (underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style)
       ${selectSql}`,
    );
    return { rowCount: Number(result.rowsChanged) };
  }

  async readChain(
    underlying: string,
    date: string,
  ): Promise<ContractRow[]> {
    // Builder inlines values; unbound runAndReadAll(sql) bypasses
    // extract_statements (chain-sql.ts header).
    const { sql } = buildReadChainSQL(underlying, date);
    const reader = await this.ctx.conn.runAndReadAll(sql);
    return reader.getRows().map((r) => ({
      underlying: String(r[0]),
      date: String(r[1]),
      ticker: String(r[2]),
      contract_type: String(r[3]) as ContractRow["contract_type"],
      strike: Number(r[4]),
      expiration: String(r[5]),
      dte: Number(r[6]),
      exercise_style: String(r[7]),
    }));
  }

  async getCoverage(
    underlying: string,
    from: string,
    to: string,
  ): Promise<CoverageReport> {
    // Inline literals — same leak rationale as readChain.
    const underlyingLit = underlying.replace(/'/g, "''");
    const fromLit = from.replace(/'/g, "''");
    const toLit = to.replace(/'/g, "''");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT DISTINCT date FROM market.option_chain
         WHERE underlying = '${underlyingLit}' AND date >= '${fromLit}' AND date <= '${toLit}'
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
