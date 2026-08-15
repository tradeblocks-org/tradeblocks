import type { DuckDBConnection } from "@duckdb/node-api";

export type ParquetColumnSet = Set<string>;

const describeCache = new Map<string, Promise<ParquetColumnSet>>();

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function readParquetGlobSql(glob: string): string {
  return `read_parquet('${escapeSqlLiteral(glob)}', hive_partitioning=true, union_by_name=true)`;
}

export function readParquetFilesSql(files: string[]): string {
  if (files.length === 0) {
    throw new Error("readParquetFilesSql: files must not be empty");
  }
  const fileList = files.map((filePath) => `'${escapeSqlLiteral(filePath)}'`).join(", ");
  return `read_parquet([${fileList}], hive_partitioning=true, union_by_name=true)`;
}

export async function describeReadParquetColumns(
  conn: DuckDBConnection,
  readParquetSql: string,
): Promise<ParquetColumnSet> {
  let pending = describeCache.get(readParquetSql);
  if (!pending) {
    pending = (async () => {
      const reader = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${readParquetSql}`);
      return new Set(reader.getRows().map((row) => String(row[0]).toLowerCase()));
    })();
    describeCache.set(readParquetSql, pending);
  }
  return pending;
}

export async function describeQueryColumns(
  conn: DuckDBConnection,
  querySql: string,
): Promise<ParquetColumnSet> {
  const reader = await conn.runAndReadAll(`DESCRIBE ${querySql}`);
  return new Set(reader.getRows().map((row) => String(row[0]).toLowerCase()));
}

function hasColumn(columns: ParquetColumnSet, name: string): boolean {
  return columns.has(name.toLowerCase());
}

export function quoteParquetColumnExpr(
  columns: ParquetColumnSet,
  alias: string,
  name: string,
  fallbackType: string,
): string {
  return hasColumn(columns, name) ? `${alias}.${name}` : `NULL::${fallbackType}`;
}

export function quoteParquetMidExpr(columns: ParquetColumnSet, alias: string): string {
  return hasColumn(columns, "mid")
    ? `${alias}.mid`
    : `((CAST(${alias}.bid AS DOUBLE) + CAST(${alias}.ask AS DOUBLE)) / 2)`;
}

export type GreekColumn = "delta" | "gamma" | "theta" | "vega" | "iv";

export const ALL_GREEKS: readonly GreekColumn[] = [
  "delta",
  "gamma",
  "theta",
  "vega",
  "iv",
] as const;

const ALL_GREEK_SET: ReadonlySet<string> = new Set(ALL_GREEKS);

/**
 * Single validation gate for caller-supplied greek names. TypeScript pins the
 * `GreekColumn` union at compile time, but a name arriving from JSON / config
 * (e.g. a strategy definition) bypasses that check — so anything selecting a
 * projected subset routes through here first and throws a clear error naming
 * both the offending value and the valid set.
 */
export function assertKnownGreeks(
  needed: readonly string[],
): asserts needed is readonly GreekColumn[] {
  for (const name of needed) {
    if (!ALL_GREEK_SET.has(name)) {
      throw new Error(`Unknown greek "${name}" — valid greeks are: ${ALL_GREEKS.join(", ")}.`);
    }
  }
}

/**
 * Greek SELECT list for `QuoteStore.readWindow`. readWindow targets a single
 * known (underlying, date) partition, so it references the greek columns
 * directly (`q.delta`) rather than guarding on column existence the way the
 * canonical projection does.
 *
 * `needed` omitted ⇒ every greek projects as-is, byte-identical to the historic
 * full projection. `needed` supplied ⇒ only those greeks project from the
 * partition; the rest emit `NULL::DOUBLE` so the row stays position-stable. The
 * NULL emitted for a trimmed greek is indistinguishable at the SQL level from a
 * stored NULL — the "not requested" vs "genuinely missing" distinction is
 * carried out-of-band by `WindowQuoteRow.projectedGreeks`, never by the value.
 */
export function readWindowGreekProjection(alias: string, needed?: readonly GreekColumn[]): string {
  if (needed === undefined) {
    return ALL_GREEKS.map((name) => `${alias}.${name}`).join(", ");
  }
  assertKnownGreeks(needed);
  const want = new Set<GreekColumn>(needed);
  return ALL_GREEKS.map((name) =>
    want.has(name) ? `${alias}.${name}` : `NULL::DOUBLE AS ${name}`,
  ).join(", ");
}

export function quoteParquetGreekProjection(
  columns: ParquetColumnSet,
  alias = "q",
  needed: readonly GreekColumn[] = ALL_GREEKS,
): string {
  // When `needed` excludes a greek, project NULL with the same DuckDB type that
  // quoteParquetColumnExpr would have used. Downstream row parsing reads each
  // column position-wise, so the projection must emit a value at every
  // position (just NULL when not requested) to keep the row shape stable.
  const wantSet = new Set<GreekColumn>(needed);
  const projectGreek = (name: GreekColumn): string =>
    wantSet.has(name)
      ? `${quoteParquetColumnExpr(columns, alias, name, "DOUBLE")} AS ${name}`
      : `NULL::DOUBLE AS ${name}`;
  return [
    projectGreek("delta"),
    projectGreek("gamma"),
    projectGreek("theta"),
    projectGreek("vega"),
    projectGreek("iv"),
    `${quoteParquetColumnExpr(columns, alias, "greeks_source", "VARCHAR")} AS greeks_source`,
    `${quoteParquetColumnExpr(columns, alias, "greeks_revision", "INTEGER")} AS greeks_revision`,
    `${quoteParquetColumnExpr(columns, alias, "rate_type", "VARCHAR")} AS rate_type`,
    `${quoteParquetColumnExpr(columns, alias, "rate_value", "DOUBLE")} AS rate_value`,
    `${quoteParquetColumnExpr(columns, alias, "gamma_source", "VARCHAR")} AS gamma_source`,
  ].join(",\n              ");
}

/**
 * Write-side greek projection: casts delta/gamma/theta/vega/iv to REAL
 * (FLOAT32) so new or rewritten option_quote_minutes parquets halve the
 * per-row greek footprint vs storing them as DOUBLE. Black-Scholes outputs
 * (bounded derivatives, implied vols) are well within FLOAT32's ~7 decimal
 * digits of precision — the measured size win on a representative SPX day
 * is ~180MB/date vs DOUBLE (~4.1x overhead vs no-greeks instead of 7.6x),
 * bringing a full SPX archive backfill under the 250GB budget.
 * Read path (`quoteParquetGreekProjection` above) stays untouched so
 * existing DOUBLE partitions continue to read without widening cost.
 */
export function quoteParquetGreekWriteProjection(columns: ParquetColumnSet, alias = "q"): string {
  const castReal = (name: string) =>
    hasColumn(columns, name) ? `CAST(${alias}.${name} AS REAL)` : `NULL::REAL`;
  return [
    `${castReal("delta")} AS delta`,
    `${castReal("gamma")} AS gamma`,
    `${castReal("theta")} AS theta`,
    `${castReal("vega")} AS vega`,
    `${castReal("iv")} AS iv`,
    `${quoteParquetColumnExpr(columns, alias, "greeks_source", "VARCHAR")} AS greeks_source`,
    `${quoteParquetColumnExpr(columns, alias, "greeks_revision", "INTEGER")} AS greeks_revision`,
    `${quoteParquetColumnExpr(columns, alias, "rate_type", "VARCHAR")} AS rate_type`,
    `${quoteParquetColumnExpr(columns, alias, "rate_value", "DOUBLE")} AS rate_value`,
    `${quoteParquetColumnExpr(columns, alias, "gamma_source", "VARCHAR")} AS gamma_source`,
  ].join(",\n              ");
}

export function quoteParquetCanonicalProjection(columns: ParquetColumnSet, alias = "q"): string {
  return [
    `${quoteParquetColumnExpr(columns, alias, "underlying", "VARCHAR")} AS underlying`,
    `${quoteParquetColumnExpr(columns, alias, "date", "VARCHAR")} AS date`,
    `${quoteParquetColumnExpr(columns, alias, "ticker", "VARCHAR")} AS ticker`,
    `${quoteParquetColumnExpr(columns, alias, "time", "VARCHAR")} AS time`,
    `${quoteParquetColumnExpr(columns, alias, "bid", "DOUBLE")} AS bid`,
    `${quoteParquetColumnExpr(columns, alias, "ask", "DOUBLE")} AS ask`,
    `${quoteParquetMidExpr(columns, alias)} AS mid`,
    `${quoteParquetColumnExpr(columns, alias, "last_updated_ns", "BIGINT")} AS last_updated_ns`,
    `${quoteParquetColumnExpr(columns, alias, "source", "VARCHAR")} AS source`,
    quoteParquetGreekProjection(columns, alias),
  ].join(",\n              ");
}

/**
 * Canonical projection for parquet writes. Identical to
 * quoteParquetCanonicalProjection but substitutes the REAL-cast greek
 * projection so the written partition's physical column types are
 * FLOAT32 for delta/gamma/theta/vega/iv.
 */
export function quoteParquetCanonicalWriteProjection(
  columns: ParquetColumnSet,
  alias = "q",
): string {
  return [
    `${quoteParquetColumnExpr(columns, alias, "underlying", "VARCHAR")} AS underlying`,
    `${quoteParquetColumnExpr(columns, alias, "date", "VARCHAR")} AS date`,
    `${quoteParquetColumnExpr(columns, alias, "ticker", "VARCHAR")} AS ticker`,
    `${quoteParquetColumnExpr(columns, alias, "time", "VARCHAR")} AS time`,
    `${quoteParquetColumnExpr(columns, alias, "bid", "DOUBLE")} AS bid`,
    `${quoteParquetColumnExpr(columns, alias, "ask", "DOUBLE")} AS ask`,
    `${quoteParquetMidExpr(columns, alias)} AS mid`,
    `${quoteParquetColumnExpr(columns, alias, "last_updated_ns", "BIGINT")} AS last_updated_ns`,
    `${quoteParquetColumnExpr(columns, alias, "source", "VARCHAR")} AS source`,
    quoteParquetGreekWriteProjection(columns, alias),
  ].join(",\n              ");
}
