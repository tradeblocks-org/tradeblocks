/**
 * ChainStore — Abstract base for option chain snapshot storage.
 *
 * Phase 1: Signatures only.
 *
 * Option chains are partitioned by (underlying, date). `readChain(underlying, date)`
 * returns all contracts observed for that underlying on that trading date.
 */
import type { StoreContext, ContractRow, CoverageReport } from "./types.ts";
import { buildReadChainDatesSQL } from "./chain-sql.ts";

export abstract class ChainStore {
  protected readonly ctx: StoreContext;
  constructor(ctx: StoreContext) {
    this.ctx = ctx;
  }

  abstract writeChain(underlying: string, date: string, rows: ContractRow[]): Promise<void>;

  /**
   * Write chain rows for a single (underlying, date) partition from a user-supplied SELECT.
   *
   * The SELECT must produce columns matching `market.option_chain`
   * (underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style).
   * Single-partition semantics mirror `SpotStore.writeFromSelect`.
   */
  abstract writeFromSelect(
    partition: { underlying: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }>;

  abstract readChain(underlying: string, date: string): Promise<ContractRow[]>;

  /**
   * Cheap chain-existence probe used by entry-pipeline snapshot reads. Returns
   * `true` when the (underlying, date) chain partition has at least one
   * contract; otherwise `false`. Lets the resolver skip a date without paying
   * the ~342ms / 39K-row cost of a full `readChain` call when only the empty
   * check matters.
   */
  async hasChain(underlying: string, date: string): Promise<boolean> {
    // Inline literals — bound-param path leaks extract_statements handles
    // (see chain-sql.ts / spot-sql.ts headers).
    const underlyingLit = underlying.replace(/'/g, "''");
    const dateLit = date.replace(/'/g, "''");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT 1 FROM market.option_chain
        WHERE underlying = '${underlyingLit}' AND date = '${dateLit}'
        LIMIT 1`,
    );
    return reader.getRows().length > 0;
  }

  /**
   * Bulk read chains for N dates under a single underlying. Returns a flat list;
   * the caller groups by `date`. Both backends share the same SQL path since
   * `market.option_chain` resolves to either a Parquet view or a physical table
   * with identical columns. Use this instead of N per-date `readChain` calls —
   * per-call glob-expansion / planning overhead dominates for view reads.
   */
  async readChainDates(
    underlying: string,
    dates: string[],
  ): Promise<ContractRow[]> {
    if (dates.length === 0) return [];
    // Builder inlines values; unbound runAndReadAll(sql) bypasses extract_statements.
    const { sql } = buildReadChainDatesSQL(underlying, dates);
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

  abstract getCoverage(underlying: string, from: string, to: string): Promise<CoverageReport>;
}
