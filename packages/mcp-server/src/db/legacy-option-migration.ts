import type { DuckDBConnection } from "@duckdb/node-api";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveMarketDir, writeChainPartition } from "./market-datasets.ts";
import { escapeSqlLiteral } from "../utils/quote-parquet-projection.ts";

async function retainTable(conn: DuckDBConnection, table: string, reason: string): Promise<void> {
  const retained = `${table}_legacy_retained_${randomUUID().replaceAll("-", "")}`;
  await conn.run(`ALTER TABLE market.${table} RENAME TO ${retained}`);
  console.error(
    `[option-storage] Retained market.${retained}: ${reason}. No rows were dropped; inspect this table before reconciling it with Parquet.`,
  );
}

/** Run before the first Parquet view overlay on a read-write connection. */
export async function migrateLegacyOptionTables(
  conn: DuckDBConnection,
  dataDir: string,
): Promise<void> {
  const tables = await conn.runAndReadAll(`
    SELECT table_name FROM information_schema.tables
    WHERE table_catalog = 'market' AND table_schema = 'main' AND table_type = 'BASE TABLE'
      AND table_name IN ('option_chain', 'option_quote_minutes')
    ORDER BY table_name
  `);
  for (const row of tables.getRows()) {
    const table = String(row[0]);
    if (table === "option_quote_minutes") {
      // No public release created this physical table. Preserve nonstandard
      // installations without inventing a migration for an unknown schema.
      const rows = await conn.runAndReadAll("SELECT 1 FROM market.option_quote_minutes LIMIT 1");
      if (rows.getRows().length > 0) {
        await retainTable(
          conn,
          table,
          "nonstandard physical option quote table; automatic schema migration is unavailable",
        );
      } else {
        await conn.run("DROP TABLE market.option_quote_minutes");
      }
      continue;
    }

    // The shipped chain schema has underlying and all eight canonical columns.
    // Keep the source intact during publication, including on interruption.
    const partitions = await conn.runAndReadAll(`
      SELECT underlying, date, count(*) FROM market.option_chain GROUP BY underlying, date
    `);
    let overlap = false;
    for (const [underlyingValue, dateValue, count] of partitions.getRows()) {
      const underlying = String(underlyingValue);
      const date = String(dateValue);
      const datasetDir = join(resolveMarketDir(dataDir), "option_chain");
      if (
        existsSync(join(datasetDir, `underlying=${underlying}`, `date=${date}`, "data.parquet")) ||
        existsSync(join(datasetDir, `date=${date}`, "data.parquet"))
      ) {
        overlap = true;
        continue;
      }
      const { rowCount } = await writeChainPartition(conn, {
        dataDir,
        underlying,
        date,
        selectQuery: `SELECT underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style
          FROM market.option_chain WHERE underlying = '${escapeSqlLiteral(underlying)}' AND date = '${escapeSqlLiteral(date)}'`,
        quality: { inputRows: Number(count), droppedRows: 0 },
      });
      if (rowCount !== Number(count)) {
        throw new Error(
          `Legacy option_chain migration published ${rowCount} of ${count} rows for ${underlying}/${date}; source table retained`,
        );
      }
    }
    if (overlap) {
      // This also safely handles a retry after interrupted publication: already
      // published partitions are not guessed to be identical to the source.
      await retainTable(
        conn,
        table,
        "one or more chain partitions already exist; overlapping rows were not merged or overwritten",
      );
    } else {
      // Every row has been published through the canonical atomic writer.
      await conn.run("DROP TABLE market.option_chain");
    }
  }
}
