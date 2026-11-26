/**
 * run_sql sandbox
 *
 * User-supplied SQL (the `run_sql` tool) must not read files outside
 * --data-root, reach the network, load extensions or change configuration.
 * Pattern-matching SQL text cannot guarantee that: DuckDB has many readers
 * (`read_csv_auto`, `read_json_auto`, `read_blob`, `glob`, ...), accepts a bare
 * quoted path or URL after FROM (a replacement scan), and computes paths at run
 * time. So the restriction is enforced by DuckDB itself, on the instance that
 * runs the query:
 *
 *   - `allowed_directories` = the data root only, then `enable_external_access =
 *     false`: every filesystem or URL access outside the allow-list fails, for
 *     every function, COPY, ATTACH and replacement scan alike.
 *   - `autoinstall_known_extensions` / `autoload_known_extensions` = false and
 *     `allow_community_extensions` = false: no extension (httpfs included) can be
 *     installed or loaded, and the HTTP filesystem is disabled.
 *   - `lock_configuration = true` last, so no later SQL can undo any of it.
 *
 * The server's own connection cannot be locked down: imports, ATTACH of
 * user-chosen DuckDB files and market-data writes legitimately touch paths
 * outside the data root, and DuckDB settings are per instance (and one-way).
 * So the read path uses a short-lived, separate in-memory instance that ATTACHes
 * analytics.duckdb and market.duckdb READ_ONLY before it is locked, and is
 * closed when the query finishes. DuckDB's allow-list does not distinguish read
 * from write, so the read path also refuses anything but SELECT-class statements
 * (judged by DuckDB's own parser, see assertReadOnlyStatements): a COPY into the
 * data root would otherwise be allowed. The confirm=true mutation path locks the
 * read-write instance it just opened; that instance is closed and replaced by a
 * fresh, unrestricted read-only one when the mutation ends (downgradeToReadOnly).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DuckDBInstance, StatementType, type DuckDBConnection } from "@duckdb/node-api";
import { getConnection, getStoredOpenConfig } from "./connection.ts";

/** Quote a value as a DuckDB SQL string literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Directories a locked-down query may read. The data root, as given and with
 * symlinks resolved, so the allow-list matches however DuckDB canonicalises a
 * path. Nothing else is allowed.
 */
export function sandboxAllowedDirectories(dataRoot: string): string[] {
  const dirs = new Set<string>();
  const resolved = path.resolve(dataRoot);
  dirs.add(resolved);
  try {
    dirs.add(fs.realpathSync(resolved));
  } catch {
    // Data root does not exist yet: nothing to read there either.
  }
  return [...dirs];
}

/**
 * Apply the lockdown to a connection. Irreversible for the instance's lifetime
 * (`lock_configuration`). Order matters: the allow-list must be set while
 * external access is still on, and the lock must come last.
 */
export async function lockDownConnection(
  conn: DuckDBConnection,
  allowedDirectories: string[],
): Promise<void> {
  const list = allowedDirectories.map(sqlString).join(", ");
  await conn.run(`SET allowed_directories=[${list}]`);
  await conn.run("SET enable_external_access=false");
  await conn.run("SET autoinstall_known_extensions=false");
  await conn.run("SET autoload_known_extensions=false");
  await conn.run("SET allow_community_extensions=false");
  await conn.run("SET disabled_filesystems='HTTPFileSystem'");
  await conn.run("SET lock_configuration=true");
}

export interface QuerySandbox {
  conn: DuckDBConnection;
  close(): void;
}

/**
 * Open a locked-down, read-only view of the analytics database for one query.
 *
 * The default catalog is `analytics` (so `trades.*` resolves as on the server
 * connection) and market.duckdb is attached as `market`. Both are READ_ONLY, so
 * a query cannot modify stored data through this instance whatever it contains.
 */
export async function openQuerySandbox(dataDir: string, dataRoot: string): Promise<QuerySandbox> {
  // Ensures the database exists and the stored paths/limits below are set.
  await getConnection(dataDir);
  const cfg = getStoredOpenConfig();
  if (!cfg.dbPath) {
    throw new Error("run_sql sandbox: database path is not initialised");
  }

  const instance = await DuckDBInstance.create(":memory:", {
    ...(cfg.threads ? { threads: cfg.threads } : {}),
    ...(cfg.memoryLimit ? { memory_limit: cfg.memoryLimit } : {}),
    // Needed only to ATTACH the database files below; locked off before any
    // user SQL runs.
    enable_external_access: "true",
  });
  let conn: DuckDBConnection | null = null;
  try {
    conn = await instance.connect();
    await conn.run(`ATTACH ${sqlString(cfg.dbPath)} AS analytics (READ_ONLY)`);
    if (cfg.marketDbPath && fs.existsSync(cfg.marketDbPath)) {
      await conn.run(`ATTACH ${sqlString(cfg.marketDbPath)} AS market (READ_ONLY)`);
    }
    await conn.run("USE analytics");
    await lockDownConnection(conn, sandboxAllowedDirectories(dataRoot));
  } catch (error) {
    try {
      conn?.closeSync();
    } catch {
      /* non-fatal */
    }
    try {
      instance.closeSync();
    } catch {
      /* non-fatal */
    }
    throw error;
  }

  const opened = conn;
  return {
    conn: opened,
    close() {
      try {
        opened.closeSync();
      } catch {
        /* non-fatal */
      }
      try {
        instance.closeSync();
      } catch {
        /* non-fatal */
      }
    },
  };
}

/**
 * Split SQL into statements, dropping comments. Steps over '...', "..." and
 * $$...$$ quoting so a `;` inside text does not split. Used to look at what each
 * statement starts with; DuckDB's parser is still the authority on its type.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      current += sql.slice(start, i);
      continue;
    }
    if (c === "$" && next === "$") {
      const end = sql.indexOf("$$", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ";") {
      flush();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  flush();
  return out;
}

/** First keyword of every statement in `sql`, upper-cased. */
export function statementLeadingKeywords(sql: string): string[] {
  return splitStatements(sql).map(
    (stmt) => /^[\s(]*([A-Za-z_]+)/.exec(stmt)?.[1]?.toUpperCase() ?? "",
  );
}

// Leading keywords of statements that only read. DuckDB spells SELECT many ways.
const READ_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "FROM",
  "VALUES",
  "TABLE",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "PIVOT",
  "UNPIVOT",
  "PRAGMA",
]);

// CALL is allowed only for the introspection functions (pragma_table_info, ...).
const READ_ONLY_CALL = /^CALL\s+(?:pragma_|duckdb_)\w+\s*\(/i;

function isReadOnlyStatementText(stmt: string): boolean {
  // EXPLAIN [ANALYZE] [(options)] <statement>: judge the statement it wraps,
  // because EXPLAIN ANALYZE executes it.
  const wrapped = /^\s*EXPLAIN\s+(?:ANALYZE\s+)?(?:\([^)]*\)\s*)?([\s\S]*)$/i.exec(stmt);
  const body = wrapped ? wrapped[1] : stmt;
  if (READ_ONLY_CALL.test(body.trim())) return true;
  const keyword = /^[\s(]*([A-Za-z_]+)/.exec(body)?.[1]?.toUpperCase() ?? "";
  return READ_KEYWORDS.has(keyword);
}

/**
 * Refuse anything but read-only statements, judged twice: by the first keyword
 * of each statement, and by the statement type DuckDB's own parser assigns.
 * Needed because the DuckDB allow-list (`allowed_directories`) permits writes
 * inside the data root as well as reads. Throws before anything runs.
 */
export async function assertReadOnlyStatements(conn: DuckDBConnection, sql: string): Promise<void> {
  const refuse = (what: string): never => {
    throw new Error(
      `${what} is not allowed in run_sql without confirm=true; only read queries (SELECT, WITH, DESCRIBE, SHOW, EXPLAIN) run here.`,
    );
  };
  for (const stmt of splitStatements(sql)) {
    if (!isReadOnlyStatementText(stmt)) {
      refuse(`${/^[\s(]*([A-Za-z_]+)/.exec(stmt)?.[1]?.toUpperCase() ?? "This statement"}`);
    }
  }
  const extracted = await conn.extractStatements(sql);
  for (let i = 0; i < extracted.count; i++) {
    const prepared = await extracted.prepare(i);
    const type = prepared.statementType;
    if (type === StatementType.SELECT || type === StatementType.EXPLAIN) continue;
    if (type === StatementType.CALL && READ_ONLY_CALL.test(splitStatements(sql)[i] ?? "")) continue;
    refuse(`Statement type ${StatementType[type] ?? type}`);
  }
}
