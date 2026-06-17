/**
 * DuckdbQuoteStore — option minute NBBO quotes persisted as DuckDB physical
 * table `market.option_quote_minutes`. Phase 1 D-12 / Pitfall 1 executed a
 * DROP+recreate with `underlying` as the first key; the Phase 1 schema already
 * has the correct shape.
 *
 * Writes via `INSERT OR REPLACE INTO market.option_quote_minutes` with
 * positional placeholders; reads project the canonical quote schema with
 * nullable greeks for older physical tables. Coverage via SELECT DISTINCT.
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode`.
 */
import { QuoteStore } from "./quote-store.ts";
import type {
  QuoteRow,
  CoverageReport,
  ReadWindowParams,
  WindowQuoteRow,
} from "./types.ts";
import { extractRoot } from "../tickers/resolver.ts";
import {
  describeQueryColumns,
  quoteParquetCanonicalProjection,
  type ParquetColumnSet,
} from "../../utils/quote-parquet-projection.ts";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function parseQuoteRow(row: unknown[]): QuoteRow {
  const occ = String(row[2]);
  const date = String(row[1]);
  const time = String(row[3]);
  return {
    occ_ticker: occ,
    timestamp: `${date} ${time}`,
    bid: Number(row[4]),
    ask: Number(row[5]),
    source: row[8] == null ? null : (String(row[8]) as QuoteRow["source"]),
    delta: row[9] == null ? null : Number(row[9]),
    gamma: row[10] == null ? null : Number(row[10]),
    theta: row[11] == null ? null : Number(row[11]),
    vega: row[12] == null ? null : Number(row[12]),
    iv: row[13] == null ? null : Number(row[13]),
    greeks_source: row[14] == null ? null : String(row[14]) as QuoteRow["greeks_source"],
    greeks_revision: row[15] == null ? null : Number(row[15]),
    rate_type: row[16] == null ? null : String(row[16]),
    rate_value: row[17] == null ? null : Number(row[17]),
    gamma_source: row[18] == null ? null : String(row[18]),
  };
}

export class DuckdbQuoteStore extends QuoteStore {
  private quoteTableColumns: Promise<ParquetColumnSet> | null = null;

  private getQuoteTableColumns(): Promise<ParquetColumnSet> {
    if (!this.quoteTableColumns) {
      this.quoteTableColumns = describeQueryColumns(
        this.ctx.conn,
        "SELECT * FROM market.option_quote_minutes",
      );
    }
    return this.quoteTableColumns;
  }

  private async ensureWritableQuoteSchema(): Promise<void> {
    const additions = [
      "delta DOUBLE",
      "gamma DOUBLE",
      "theta DOUBLE",
      "vega DOUBLE",
      "iv DOUBLE",
      "greeks_source VARCHAR",
      "greeks_revision INTEGER",
      "rate_type VARCHAR",
      "rate_value DOUBLE",
      "gamma_source VARCHAR",
    ];
    for (const addition of additions) {
      await this.ctx.conn.run(
        `ALTER TABLE market.option_quote_minutes ADD COLUMN IF NOT EXISTS ${addition}`,
      );
    }
    this.quoteTableColumns = null;
  }

  async writeQuotes(
    underlying: string,
    date: string,
    quotes: QuoteRow[],
  ): Promise<void> {
    if (quotes.length === 0) return;
    await this.ensureWritableQuoteSchema();
    const placeholders = quotes
      .map((_, i) => {
        const b = i * 19;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18},$${b + 19})`;
      })
      .join(", ");
    const params: unknown[] = quotes.flatMap((q) => {
      const [qdate, qtime] = q.timestamp.split(" ");
      const mid = (q.bid + q.ask) / 2;
      return [
        underlying,
        qdate ?? date,
        q.occ_ticker,
        qtime ?? "09:30",
        q.bid,
        q.ask,
        mid,
        null,                 // last_updated_ns — not tracked in QuoteRow
        q.source ?? null,     // source — populated when provider tags rows (Task 6)
        q.delta ?? null,
        q.gamma ?? null,
        q.theta ?? null,
        q.vega ?? null,
        q.iv ?? null,
        q.greeks_source ?? null,
        q.greeks_revision ?? null,
        q.rate_type ?? null,
        q.rate_value ?? null,
        q.gamma_source ?? null,
      ];
    });
    await this.ctx.conn.run(
      `INSERT OR REPLACE INTO market.option_quote_minutes
         (underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source,
          delta, gamma, theta, vega, iv, greeks_source, greeks_revision,
          rate_type, rate_value, gamma_source)
       VALUES ${placeholders}`,
      params as (string | number | boolean | null | bigint)[],
    );
  }

  async writeFromSelect(
    _partition: { underlying: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }> {
    await this.ensureWritableQuoteSchema();
    const columns = await describeQueryColumns(this.ctx.conn, selectSql);
    const projection = quoteParquetCanonicalProjection(columns, "q");
    const result = await this.ctx.conn.run(
      `INSERT OR REPLACE INTO market.option_quote_minutes
         (underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source,
          delta, gamma, theta, vega, iv, greeks_source, greeks_revision,
          rate_type, rate_value, gamma_source)
       SELECT ${projection}
         FROM (${selectSql}) AS q`,
    );
    return { rowCount: Number(result.rowsChanged) };
  }

  async readQuotes(
    occTickers: string[],
    from: string,
    to: string,
  ): Promise<Map<string, QuoteRow[]>> {
    if (occTickers.length === 0) return new Map();
    const firstUnderlying = this.ctx.tickers.resolve(
      extractRoot(occTickers[0]),
    );
    for (const t of occTickers) {
      const u = this.ctx.tickers.resolve(extractRoot(t));
      if (u !== firstUnderlying) {
        throw new Error(
          `QuoteStore.readQuotes: mixed underlyings in batch — ` +
            `${occTickers[0]} resolves to ${firstUnderlying}, ${t} resolves to ${u}. ` +
            `Consumers must group reads by underlying.`,
        );
      }
    }
    const columns = await this.getQuoteTableColumns();
    const projection = quoteParquetCanonicalProjection(columns, "q");
    // Inline every value as a SQL literal and call the unbound
    // runAndReadAll(sql) form — the bound (sql, values) path routes through
    // node_bindings.extract_statements, which leaks a non-destroyable handle
    // per call and eventually throws "Failed to execute prepared statement"
    // under sustained read load. See spot-sql.ts header for the full writeup.
    const underlyingLit = `'${escapeSqlLiteral(firstUnderlying)}'`;
    const fromLit = `'${escapeSqlLiteral(from)}'`;
    const toLit = `'${escapeSqlLiteral(to)}'`;
    const tickerList = occTickers
      .map((t) => `'${escapeSqlLiteral(t)}'`)
      .join(", ");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT ${projection}
         FROM market.option_quote_minutes AS q
        WHERE q.underlying = ${underlyingLit}
          AND q.date >= ${fromLit}
          AND q.date <= ${toLit}
          AND q.ticker IN (${tickerList})
        ORDER BY q.ticker, q.date, q.time`,
    );
    const out = new Map<string, QuoteRow[]>();
    for (const row of reader.getRows()) {
      const qr = parseQuoteRow(row);
      const occ = qr.occ_ticker;
      let arr = out.get(occ);
      if (!arr) {
        arr = [];
        out.set(occ, arr);
      }
      arr.push(qr);
    }
    return out;
  }

  override async readQuotesBulk(
    tickersByDate: Map<string, Set<string>>,
    timeStart: string,
    timeEnd: string,
  ): Promise<Map<string, QuoteRow[]>> {
    const out = new Map<string, QuoteRow[]>();
    if (tickersByDate.size === 0) return out;

    const perf = process.env.QUOTE_STORE_PERF_DEBUG === "1";

    for (const [underlying, perDate] of this.groupTickersByUnderlying(tickersByDate)) {
      const occUnion = new Set<string>();
      const wantedPairs: string[] = [];

      for (const [date, occs] of perDate) {
        if (occs.size === 0) continue;
        for (const occ of occs) {
          occUnion.add(occ);
          wantedPairs.push(`('${escapeSqlLiteral(date)}', '${escapeSqlLiteral(occ)}')`);
        }
      }

      if (wantedPairs.length === 0) continue;

      const columns = await this.getQuoteTableColumns();
      const projection = quoteParquetCanonicalProjection(columns, "q");
      // Underlying + time bounds inlined as SQL literals so the call takes the
      // unbound runAndReadAll(sql) path (the (date, ticker) VALUES are already
      // inlined above). The bound form leaks an extract_statements handle per
      // call — see spot-sql.ts header for the full root-cause writeup.
      const underlyingLit = `'${escapeSqlLiteral(underlying)}'`;
      const timeStartLit = `'${escapeSqlLiteral(timeStart)}'`;
      const timeEndLit = `'${escapeSqlLiteral(timeEnd)}'`;
      const sql = `WITH wanted(date, ticker) AS (
                     VALUES ${wantedPairs.join(", ")}
                   )
                   SELECT ${projection}
                   FROM market.option_quote_minutes AS q
                   JOIN wanted AS w
                     ON q.date = w.date AND q.ticker = w.ticker
                   WHERE q.underlying = ${underlyingLit}
                     AND q.time >= ${timeStartLit} AND q.time <= ${timeEndLit}
                   ORDER BY q.ticker, q.date, q.time`;

      const queryStart = perf ? Date.now() : 0;
      const reader = await this.ctx.conn.runAndReadAll(sql);
      const rows = reader.getRows();
      if (perf) {
        console.log(
          `    [P] readQuotesBulk underlying=${underlying} dates=${perDate.size} ` +
          `tickers=${occUnion.size} rows=${rows.length} queryMs=${Date.now() - queryStart}`,
        );
      }
      for (const row of rows) {
        const quote = parseQuoteRow(row);
        const occ = quote.occ_ticker;
        const bucket = out.get(occ);
        if (bucket) bucket.push(quote);
        else out.set(occ, [quote]);
      }
    }

    return out;
  }

  /**
   * Read every option-quote row whose contract falls inside the union of the
   * supplied leg envelopes, between `timeStart` and `timeEnd` inclusive on a
   * single (underlying, date) partition. Joins back to `market.option_chain`
   * for `contract_type`, `strike`, `expiration`, `dte` so the caller doesn't
   * OCC-parse. Greeks (delta/gamma/theta/vega/iv) project as-is from the
   * quote table — null when not stored.
   *
   * Times are 24-hour US Eastern wall-clock strings ("HH:MM") matching
   * `ReadWindowParams.timeStart` / `timeEnd`. Strike envelope bounds
   * (`strikeMin` / `strikeMax`) are optional; when absent the leg matches all
   * strikes within the dte band for that contract type.
   *
   * Returns `[]` when `legEnvelopes` is empty (D-06 short-circuit pattern).
   * No SQL ranking; ranking + top-N selection happen in JS at the call site.
   */
  async readWindow(params: ReadWindowParams): Promise<WindowQuoteRow[]> {
    const { underlying, date, timeStart, timeEnd, legEnvelopes } = params;
    if (legEnvelopes.length === 0) return [];

    // Inline every value as a SQL literal and call the unbound
    // runAndReadAll(sql) form — the bound (sql, values) path routes through
    // node_bindings.extract_statements, which leaks a non-destroyable handle
    // per call and eventually throws "Failed to execute prepared statement"
    // under sustained read load. See spot-sql.ts header for the full writeup.
    // String values (underlying, date, times, contract_type) are
    // single-quote-escaped; dte/strike bounds are typed numbers from
    // in-process strategy definitions, inlined directly — no injection vector.
    const pUnderlying = `'${escapeSqlLiteral(underlying)}'`;
    const pDate = `'${escapeSqlLiteral(date)}'`;
    const pTimeStart = `'${escapeSqlLiteral(timeStart)}'`;
    const pTimeEnd = `'${escapeSqlLiteral(timeEnd)}'`;

    const disjuncts: string[] = [];
    for (const env of legEnvelopes) {
      const ct = `'${escapeSqlLiteral(env.contractType)}'`;
      let clause = `(b.contract_type = ${ct} AND b.dte BETWEEN ${env.dteMin} AND ${env.dteMax}`;
      if (env.strikeMin != null) {
        clause += ` AND b.strike >= ${env.strikeMin}`;
      }
      if (env.strikeMax != null) {
        clause += ` AND b.strike <= ${env.strikeMax}`;
      }
      clause += ")";
      disjuncts.push(clause);
    }

    // Phase-2 perf: project only what downstream consumers read. `underlying`
    // and `date` are filter-pinned by the WHERE clause, and `mid` is derived
    // as `(bid + ask) / 2` in `toMinuteQuoteRow` — fetching + decoding those
    // three columns for ~100K rows per call was wasted work.
    const sql = `
      WITH band AS (
        SELECT DISTINCT ticker, contract_type, strike, expiration, dte
          FROM market.option_chain b
         WHERE b.underlying = ${pUnderlying} AND b.date = ${pDate}
           AND (${disjuncts.join(" OR ")})
      )
      SELECT q.ticker, q.time,
             b.contract_type, b.strike, b.expiration, b.dte,
             q.bid, q.ask,
             q.delta, q.gamma, q.theta, q.vega, q.iv, q.greeks_source
        FROM market.option_quote_minutes q
        JOIN band b ON q.ticker = b.ticker
       WHERE q.underlying = ${pUnderlying}
         AND q.date = ${pDate}
         AND q.time BETWEEN ${pTimeStart} AND ${pTimeEnd}
    `;

    const reader = await this.ctx.conn.runAndReadAll(sql);
    return reader.getRows().map((r) => ({
      ticker: String(r[0]),
      time: String(r[1]),
      contract_type: String(r[2]) as "call" | "put",
      strike: Number(r[3]),
      expiration: String(r[4]),
      dte: Number(r[5]),
      bid: Number(r[6]),
      ask: Number(r[7]),
      delta: r[8] == null ? null : Number(r[8]),
      gamma: r[9] == null ? null : Number(r[9]),
      theta: r[10] == null ? null : Number(r[10]),
      vega: r[11] == null ? null : Number(r[11]),
      iv: r[12] == null ? null : Number(r[12]),
      greeks_source: r[13] == null ? null : String(r[13]) as WindowQuoteRow["greeks_source"],
    }));
  }

  async getCoverage(
    underlying: string,
    from: string,
    to: string,
  ): Promise<CoverageReport> {
    // Inline literal path — same leak rationale (see spot-sql.ts header).
    const underlyingLit = underlying.replace(/'/g, "''");
    const fromLit = from.replace(/'/g, "''");
    const toLit = to.replace(/'/g, "''");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT DISTINCT date FROM market.option_quote_minutes
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
