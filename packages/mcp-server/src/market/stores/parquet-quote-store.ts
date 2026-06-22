/**
 * ParquetQuoteStore — option minute NBBO quotes persisted as underlying-first
 * Hive-partitioned Parquet files
 * (option_quote_minutes/underlying=X/date=Y/data.parquet).
 *
 * D-06 / D-08: readQuotes accepts a batch of OCC tickers plus a date range and
 * returns Map<occTicker, QuoteRow[]> with timestamp-sorted values per
 * contract. Matches the primary multi-ticker consumer pattern (bulk
 * `ticker IN (...) AND date BETWEEN ...` → group-by-ticker).
 *
 * D-07 / Pitfall 4: all OCC tickers in a single call MUST resolve to the same
 * underlying. First-iteration behavior is to throw a clear error naming both
 * conflicting tickers — consumers must group reads by underlying themselves.
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode`.
 */
import { existsSync } from "fs";
import * as path from "path";
import { QuoteStore } from "./quote-store.ts";
import type { QuoteRow, CoverageReport, ReadWindowParams, WindowQuoteRow } from "./types.ts";
import { listPartitionValues } from "./coverage.ts";
import { resolveMarketDir, writeQuoteMinutesPartition } from "../../db/market-datasets.ts";
import { extractRoot } from "../tickers/resolver.ts";
import {
  describeQueryColumns,
  describeReadParquetColumns,
  escapeSqlLiteral,
  quoteParquetCanonicalProjection,
  quoteParquetCanonicalWriteProjection,
  readParquetFilesSql,
} from "../../utils/quote-parquet-projection.ts";

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
    greeks_source: row[14] == null ? null : (String(row[14]) as QuoteRow["greeks_source"]),
    greeks_revision: row[15] == null ? null : Number(row[15]),
    rate_type: row[16] == null ? null : String(row[16]),
    rate_value: row[17] == null ? null : Number(row[17]),
    gamma_source: row[18] == null ? null : String(row[18]),
  };
}

export class ParquetQuoteStore extends QuoteStore {
  async writeQuotes(underlying: string, date: string, quotes: QuoteRow[]): Promise<void> {
    if (quotes.length === 0) return;
    // Append rows via DuckDBAppender (typed per-column, no SQL parse overhead)
    // rather than a parameterized INSERT with O(N) placeholders — the latter
    // forces DuckDB to parse a multi-megabyte SQL statement before a single
    // row lands, which was the dominant wall-clock cost on a 5M-row SPX day.
    const staging = `_quote_write_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // Greeks persist as REAL (FLOAT32): Black-Scholes outputs sit well within
    // single-precision range, and the 4-byte-per-column layout halves per-row
    // greek cost in parquet — a full SPX backfill under DOUBLE would blow the
    // 250GB archive budget; under REAL it fits comfortably.
    await this.ctx.conn.run(
      `CREATE TEMP TABLE "${staging}" (
         underlying VARCHAR, date VARCHAR, ticker VARCHAR, time VARCHAR,
         bid DOUBLE, ask DOUBLE, mid DOUBLE,
         last_updated_ns BIGINT, source VARCHAR,
         delta REAL, gamma REAL, theta REAL, vega REAL, iv REAL,
         greeks_source VARCHAR, greeks_revision INTEGER,
         rate_type VARCHAR, rate_value DOUBLE, gamma_source VARCHAR
       )`,
    );
    try {
      const appender = await this.ctx.conn.createAppender(staging);
      try {
        for (const q of quotes) {
          // QuoteRow.timestamp is "YYYY-MM-DD HH:MM" — split into date/time.
          // If the timestamp omits the time (legacy producers), default to 09:30.
          const spaceIdx = q.timestamp.indexOf(" ");
          const qdate = spaceIdx === -1 ? date : q.timestamp.slice(0, spaceIdx);
          const qtime = spaceIdx === -1 ? "09:30" : q.timestamp.slice(spaceIdx + 1);
          appender.appendVarchar(underlying);
          appender.appendVarchar(qdate);
          appender.appendVarchar(q.occ_ticker);
          appender.appendVarchar(qtime);
          appender.appendDouble(q.bid);
          appender.appendDouble(q.ask);
          appender.appendDouble((q.bid + q.ask) / 2);
          appender.appendNull(); // last_updated_ns — not tracked in QuoteRow
          if (q.source == null) appender.appendNull();
          else appender.appendVarchar(q.source);
          if (q.delta == null) appender.appendNull();
          else appender.appendFloat(q.delta);
          if (q.gamma == null) appender.appendNull();
          else appender.appendFloat(q.gamma);
          if (q.theta == null) appender.appendNull();
          else appender.appendFloat(q.theta);
          if (q.vega == null) appender.appendNull();
          else appender.appendFloat(q.vega);
          if (q.iv == null) appender.appendNull();
          else appender.appendFloat(q.iv);
          if (q.greeks_source == null) appender.appendNull();
          else appender.appendVarchar(q.greeks_source);
          if (q.greeks_revision == null) appender.appendNull();
          else appender.appendInteger(q.greeks_revision);
          if (q.rate_type == null) appender.appendNull();
          else appender.appendVarchar(q.rate_type);
          if (q.rate_value == null) appender.appendNull();
          else appender.appendDouble(q.rate_value);
          if (q.gamma_source == null) appender.appendNull();
          else appender.appendVarchar(q.gamma_source);
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
      await writeQuoteMinutesPartition(this.ctx.conn, {
        dataDir: this.ctx.dataDir,
        underlying,
        date,
        selectQuery: `SELECT * FROM "${staging}"`,
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
    partition: { underlying: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }> {
    const columns = await describeQueryColumns(this.ctx.conn, selectSql);
    // Force REAL greeks on write regardless of source type — keeps parquet
    // footprint half-size vs DOUBLE without depending on upstream producers
    // to cast correctly.
    const projection = quoteParquetCanonicalWriteProjection(columns, "q");
    return writeQuoteMinutesPartition(this.ctx.conn, {
      dataDir: this.ctx.dataDir,
      underlying: partition.underlying,
      date: partition.date,
      selectQuery: `SELECT ${projection} FROM (${selectSql}) AS q`,
    });
  }

  async readQuotes(
    occTickers: string[],
    from: string,
    to: string,
  ): Promise<Map<string, QuoteRow[]>> {
    if (occTickers.length === 0) return new Map();
    // D-07: validate all tickers resolve to the same underlying BEFORE any SQL
    // runs. A mixed batch is almost always a bug in the caller; surface it
    // with both conflicting OCC tickers + resolved underlyings for debugging.
    const firstUnderlying = this.ctx.tickers.resolve(extractRoot(occTickers[0]));
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
    const underlyingDir = path.join(
      resolveMarketDir(this.ctx.dataDir),
      "option_quote_minutes",
      `underlying=${firstUnderlying}`,
    );
    if (!existsSync(underlyingDir)) return new Map();
    const files = listPartitionValues(underlyingDir, "date")
      .filter((date) => date >= from && date <= to)
      .map((date) => path.join(underlyingDir, `date=${date}`, "data.parquet"))
      .filter((filePath) => existsSync(filePath));
    if (files.length === 0) return new Map();

    const source = readParquetFilesSql(files);
    const columns = await describeReadParquetColumns(this.ctx.conn, source);
    const projection = quoteParquetCanonicalProjection(columns, "q");
    // Inline every value as a SQL literal and call the unbound
    // runAndReadAll(sql) form — the bound (sql, values) path routes through
    // node_bindings.extract_statements, which leaks a non-destroyable handle
    // per call and eventually throws "Failed to execute prepared statement"
    // under sustained read load. See readWindow below for the full writeup.
    const fromLit = `'${escapeSqlLiteral(from)}'`;
    const toLit = `'${escapeSqlLiteral(to)}'`;
    const tickerList = occTickers.map((t) => `'${escapeSqlLiteral(t)}'`).join(", ");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT ${projection}
         FROM ${source} AS q
        WHERE q.date >= ${fromLit}
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
    const marketDir = resolveMarketDir(this.ctx.dataDir);

    for (const [underlying, perDate] of this.groupTickersByUnderlying(tickersByDate)) {
      const occUnion = new Set<string>();
      const filePaths: string[] = [];
      const wantedPairs: string[] = [];

      for (const [date, occs] of perDate) {
        if (occs.size === 0) continue;
        const partitionPath = path.join(
          marketDir,
          "option_quote_minutes",
          `underlying=${underlying}`,
          `date=${date}`,
          "data.parquet",
        );
        if (!existsSync(partitionPath)) continue;
        filePaths.push(partitionPath);
        for (const occ of occs) {
          occUnion.add(occ);
          wantedPairs.push(`('${escapeSqlLiteral(date)}', '${escapeSqlLiteral(occ)}')`);
        }
      }

      if (filePaths.length === 0 || wantedPairs.length === 0) continue;

      const source = readParquetFilesSql(filePaths);
      const columns = await describeReadParquetColumns(this.ctx.conn, source);
      const projection = quoteParquetCanonicalProjection(columns, "q");
      // Time bounds inlined as SQL literals so the call takes the unbound
      // runAndReadAll(sql) path (the (date, ticker) VALUES are already inlined
      // above). The bound form leaks an extract_statements handle per call —
      // see readWindow for the full root-cause writeup.
      const timeStartLit = `'${escapeSqlLiteral(timeStart)}'`;
      const timeEndLit = `'${escapeSqlLiteral(timeEnd)}'`;
      const sql = `WITH wanted(date, ticker) AS (
                     VALUES ${wantedPairs.join(", ")}
                   )
                   SELECT ${projection}
                   FROM ${source} AS q
                   JOIN wanted AS w
                     ON q.date = w.date AND q.ticker = w.ticker
                   WHERE q.time >= ${timeStartLit} AND q.time <= ${timeEndLit}
                   ORDER BY q.ticker, q.date, q.time`;

      const queryStart = perf ? Date.now() : 0;
      const reader = await this.ctx.conn.runAndReadAll(sql);
      const rows = reader.getRows();
      if (perf) {
        console.log(
          `    [P] readQuotesBulk underlying=${underlying} dates=${filePaths.length} ` +
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
   * single (underlying, date) partition. Joins back to the date's
   * `option_chain` partition for `contract_type`, `strike`, `expiration`,
   * `dte` so the caller doesn't OCC-parse. Greeks (delta/gamma/theta/vega/iv)
   * project as-is from the quote partition — null when not stored.
   *
   * Returns `[]` when `legEnvelopes` is empty (D-06 short-circuit pattern) or
   * when the requested (underlying, date) partition's quote / chain Parquet
   * file does not exist on disk. The OCC-parsing fallback used elsewhere when
   * `option_chain` is absent is intentionally NOT included — the entry
   * pipeline assumes chain coverage.
   */
  async readWindow(params: ReadWindowParams): Promise<WindowQuoteRow[]> {
    const { underlying, date, timeStart, timeEnd, legEnvelopes } = params;
    if (legEnvelopes.length === 0) return [];

    const marketDir = resolveMarketDir(this.ctx.dataDir);
    const quoteFile = path.join(
      marketDir,
      "option_quote_minutes",
      `underlying=${underlying}`,
      `date=${date}`,
      "data.parquet",
    );
    const chainFile = path.join(
      marketDir,
      "option_chain",
      `underlying=${underlying}`,
      `date=${date}`,
      "data.parquet",
    );
    if (!existsSync(quoteFile) || !existsSync(chainFile)) return [];

    const quoteSrc = readParquetFilesSql([quoteFile]);
    const chainSrc = readParquetFilesSql([chainFile]);

    // CRITICAL — DO NOT re-introduce parameterized binds here. Every call to
    // `runAndReadAll(sql, values)` goes through `node_bindings.extract_statements`
    // which returns a C++ handle with NO destroy method on its JS wrapper
    // (`DuckDBExtractedStatements` only has a constructor — see
    // `node_modules/@duckdb/node-api/lib/DuckDBExtractedStatements.js`). The
    // handles only release on JS GC. Because each ParquetQuoteStore.readWindow
    // embeds unique partition file paths as SQL literals, every call has
    // distinct SQL text → DuckDB caches a separate plan per call → on long
    // read workloads (~600+ calls) extract_statements handles outpace GC and
    // the driver throws `Failed to execute prepared statement` mid-run.
    //
    // The unbound `runAndReadAll(sql)` path takes `node_bindings.query()`
    // directly with no extract_statements step, so we inline every value
    // (timeStart, timeEnd, contractType, dte*, strike*) as a SQL literal.
    // Inputs are typed config (string-union / number) sourced from
    // in-process strategy definitions — no SQL injection vector.
    //
    // Phase-2 perf: project only what downstream consumers read. `underlying`
    // and `date` are pinned by the partition file paths above; `mid` is
    // derived as `(bid + ask) / 2` in `toMinuteQuoteRow`.
    const safeTimeStart = `'${escapeSqlLiteral(timeStart)}'`;
    const safeTimeEnd = `'${escapeSqlLiteral(timeEnd)}'`;
    const disjuncts: string[] = legEnvelopes.map((env) => {
      const ct = `'${escapeSqlLiteral(env.contractType)}'`;
      let clause = `(b.contract_type = ${ct} AND b.dte BETWEEN ${env.dteMin} AND ${env.dteMax}`;
      if (env.strikeMin != null) clause += ` AND b.strike >= ${env.strikeMin}`;
      if (env.strikeMax != null) clause += ` AND b.strike <= ${env.strikeMax}`;
      clause += ")";
      return clause;
    });

    const sql = `
      WITH band AS (
        SELECT DISTINCT ticker, contract_type, strike, expiration, dte
          FROM ${chainSrc} AS b
         WHERE ${disjuncts.join(" OR ")}
      )
      SELECT q.ticker, q.time,
             b.contract_type, b.strike, b.expiration, b.dte,
             q.bid, q.ask,
             q.delta, q.gamma, q.theta, q.vega, q.iv, q.greeks_source
        FROM ${quoteSrc} AS q
        JOIN band b ON q.ticker = b.ticker
       WHERE q.time BETWEEN ${safeTimeStart} AND ${safeTimeEnd}
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
      greeks_source: r[13] == null ? null : (String(r[13]) as WindowQuoteRow["greeks_source"]),
    }));
  }

  async getCoverage(underlying: string, from: string, to: string): Promise<CoverageReport> {
    const dir = path.join(
      resolveMarketDir(this.ctx.dataDir),
      "option_quote_minutes",
      `underlying=${underlying}`,
    );
    if (!existsSync(dir)) {
      return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
    }
    const allDates = listPartitionValues(dir, "date");
    const dates = allDates.filter((d) => d >= from && d <= to);
    return {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      missingDates: [],
      totalDates: dates.length,
    };
  }
}
