/**
 * SQL Query Tool
 *
 * Provides direct SQL query access to the DuckDB analytics database.
 * Enables ad-hoc analysis, hypothesis testing, and data exploration
 * across trades and market data.
 *
 * Security:
 *   - SELECT queries run freely; DELETE/UPDATE require confirm=true
 *   - Queries run on a DuckDB instance locked down by DuckDB's own settings
 *     (see ../db/query-sandbox.ts): file and URL access is limited to --data-root,
 *     extensions cannot be installed or loaded, and configuration cannot be
 *     changed. This holds for every reader, COPY, ATTACH and replacement scan;
 *     the SQL-text checks below only give earlier, friendlier errors.
 *   - Confirmed mutations (INSERT, CREATE, ...) run under the same lockdown
 *   - 30-second query timeout with clear error message
 *
 * Available tables:
 *   - trades.trade_data: Trade records from all blocks (includes inferred ticker)
 *   - trades.reporting_data: Reporting/actual trade records from strategy logs
 *   - market.spot: Minute bars, ticker-first layout (indicators source)
 *   - market.spot_daily: RTH-aggregated daily OHLCV view over market.spot (ticker, date)
 *   - market.enriched: Daily technical indicators (RSI, ATR, IVR/IVP, etc.), ticker-first
 *   - market.enriched_context: Cross-ticker derived fields (Vol_Regime, Term_Structure_State, etc.)
 *   - market.option_chain: Option contract metadata keyed by (underlying, date)
 *   - market.option_quote_minutes: Option NBBO minute bars keyed by (underlying, date)
 *   - market._sync_metadata: Import/enrichment tracking metadata
 */

import * as path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DuckDBDateValue, type DuckDBConnection } from "@duckdb/node-api";
import { upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.ts";
import {
  assertReadOnlyStatements,
  lockDownConnection,
  openQuerySandbox,
  statementLeadingKeywords,
  sandboxAllowedDirectories,
  type QuerySandbox,
} from "../db/query-sandbox.ts";
import { getDataRoot } from "../db/data-root.ts";
import { withFullSync } from "./middleware/sync-middleware.ts";
import { createToolOutput } from "../utils/output-formatter.ts";

/**
 * Available tables for reference in error messages
 */
const AVAILABLE_TABLES = [
  "trades.trade_data",
  "trades.reporting_data",
  "market.spot",
  "market.spot_daily",
  "market.enriched",
  "market.enriched_context",
  "market.option_chain",
  "market.option_quote_minutes",
  "market._sync_metadata",
];

/**
 * Always-blocked SQL patterns — external access, writes, and config changes.
 *
 * These give an early, readable refusal. They are not the security boundary:
 * the sandbox (../db/query-sandbox.ts) enforces the same limits inside DuckDB.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; operation: string }> = [
  // External access
  { pattern: /\bCOPY\b/i, operation: "COPY" },
  { pattern: /\bEXPORT\b/i, operation: "EXPORT" },
  { pattern: /\bATTACH\b/i, operation: "ATTACH" },
  { pattern: /\bDETACH\b/i, operation: "DETACH" },

  // File functions that write or read arbitrary text
  { pattern: /\bread_text\s*\(/i, operation: "read_text()" },
  { pattern: /\bwrite_csv\s*\(/i, operation: "write_csv()" },

  // Logging setters write to caller-chosen storage
  { pattern: /\b(?:enable|disable)_logging\s*\(/i, operation: "enable_logging()" },
];

/**
 * Statement-leading keywords that change configuration or load code. Checked on
 * every statement of a multi-statement query (not only the first), with
 * comments and quoted text ignored. `UPDATE ... SET` is unaffected: only a
 * statement's first word counts.
 */
const BLOCKED_STATEMENT_KEYWORDS = new Set(["SET", "RESET", "INSTALL", "LOAD", "FORCE"]);

export { statementLeadingKeywords };

/** Name of the first blocked operation in `sql`, or null. */
function findBlockedOperation(sql: string): string | null {
  for (const { pattern, operation } of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) return operation;
  }
  for (const keyword of statementLeadingKeywords(sql)) {
    if (BLOCKED_STATEMENT_KEYWORDS.has(keyword)) {
      return keyword === "FORCE" ? "INSTALL" : keyword;
    }
  }
  return null;
}

/**
 * File-read functions allowed only when every path argument resolves under
 * --data-root. Lets debug queries inspect managed Parquet/CSV/JSON while
 * preventing filesystem traversal via SQL. Early, friendly refusal only: the
 * sandbox enforces the same limit for every reader inside DuckDB.
 */
const PATH_GATED_READ_FUNCTIONS = [
  "read_parquet",
  "parquet_scan",
  "read_csv",
  "read_csv_auto",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "read_json_objects",
  "read_ndjson_objects",
] as const;

interface FileReadCall {
  fn: string;
  paths: string[];
}

function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scan SQL for path-gated file-read calls. Returns null if any call can't
 * be parsed safely — the caller should treat null as a block verdict.
 */
function extractFileReadCalls(sql: string): FileReadCall[] | null {
  const calls: FileReadCall[] = [];
  for (const fn of PATH_GATED_READ_FUNCTIONS) {
    const nameRegex = new RegExp(`\\b${fn}\\s*\\(`, "gi");
    let m: RegExpExecArray | null;
    while ((m = nameRegex.exec(sql)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(sql, openIdx);
      if (closeIdx === -1) return null;
      const args = sql.slice(openIdx + 1, closeIdx);
      const paths: string[] = [];
      const strRegex = /(['"])((?:\\.|(?!\1).)*)\1/g;
      let s: RegExpExecArray | null;
      while ((s = strRegex.exec(args)) !== null) {
        paths.push(s[2]);
      }
      if (paths.length === 0) return null;
      calls.push({ fn, paths });
    }
  }
  return calls;
}

/**
 * Is the given path under dataRoot? Strips glob characters from the end so
 * patterns like `<root>/market/spot/ ** /*.parquet` validate against their
 * literal prefix. Resolves both paths absolutely and compares with a
 * separator guard to prevent `<root>-evil` from matching `<root>`.
 */
export function isUnderDataRoot(filePath: string, dataRoot: string): boolean {
  const globMatch = filePath.match(/[*?[]/);
  const prefix = globMatch?.index !== undefined ? filePath.slice(0, globMatch.index) : filePath;
  const resolved = path.resolve(prefix);
  const resolvedRoot = path.resolve(dataRoot);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolved === resolvedRoot || resolved.startsWith(rootWithSep);
}

/**
 * Default and maximum query timeout in milliseconds
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Maximum rows that can be returned
 */
const MAX_ROWS = 1000;

/**
 * Mutating patterns that require confirm=true.
 * Without confirm, returns a preview of what would be affected.
 */
const CONFIRM_REQUIRED_PATTERNS: Array<{ pattern: RegExp; operation: string }> = [
  { pattern: /\bDELETE\b/i, operation: "DELETE" },
  { pattern: /\bUPDATE\b/i, operation: "UPDATE" },
  { pattern: /\bINSERT\b/i, operation: "INSERT" },
  { pattern: /\bTRUNCATE\b/i, operation: "TRUNCATE" },
  { pattern: /\bDROP\b/i, operation: "DROP" },
  { pattern: /\bCREATE\b/i, operation: "CREATE" },
  { pattern: /\bALTER\b/i, operation: "ALTER" },
];

/**
 * Validate SQL query for dangerous patterns.
 * Returns null if valid, or an error message if invalid.
 */
export function validateQuery(sql: string, dataRoot: string): string | null {
  const blocked = findBlockedOperation(sql);
  if (blocked) {
    return `${blocked} operations are not allowed.`;
  }

  const calls = extractFileReadCalls(sql);
  if (calls === null) {
    return "File-read function calls could not be parsed safely. Use the market.* views instead.";
  }
  for (const call of calls) {
    for (const p of call.paths) {
      if (!isUnderDataRoot(p, dataRoot)) {
        return `${call.fn}() path must be under --data-root: ${p}`;
      }
    }
  }

  return null;
}

/**
 * Validate a user-supplied SELECT passed into import_flat_file.
 *
 * Keeps the hard blocks on external access, writes, and config changes —
 * but relaxes the read_parquet/read_csv/read_json path gate because the
 * purpose of the import tool is to pull data from arbitrary source files
 * the LLM has been pointed at. The output location is sandboxed by the
 * store's partition-path composer (data-root-relative, whitelisted
 * partition values), so a malicious SELECT can only pollute the store
 * it's writing to — it cannot exfiltrate or write outside the data root.
 */
export function validateImportSelect(sql: string): string | null {
  const blocked = findBlockedOperation(sql);
  if (blocked) {
    return `${blocked} operations are not allowed in select_sql.`;
  }
  if (/^\s*SELECT\b/i.test(sql) === false && /^\s*WITH\b/i.test(sql) === false) {
    return "select_sql must be a SELECT or WITH statement.";
  }
  return null;
}

/**
 * Check if a query is destructive (DELETE/UPDATE) and needs confirmation.
 */
function isDestructiveQuery(sql: string): { destructive: boolean; operation: string } {
  for (const { pattern, operation } of CONFIRM_REQUIRED_PATTERNS) {
    if (pattern.test(sql)) {
      return { destructive: true, operation };
    }
  }
  return { destructive: false, operation: "" };
}

/**
 * Convert a DELETE/UPDATE statement to a SELECT COUNT(*) preview query.
 * DELETE FROM table WHERE ... → SELECT COUNT(*) as affected_rows FROM table WHERE ...
 * UPDATE table SET ... WHERE ... → SELECT COUNT(*) as affected_rows FROM table WHERE ...
 */
function toPreviewQuery(sql: string): string {
  const trimmed = sql.trim().replace(/;$/, "");

  // DELETE FROM table WHERE ...
  const deleteMatch = trimmed.match(/^\s*DELETE\s+FROM\s+(.+?)(?:\s+WHERE\s+(.+))?$/is);
  if (deleteMatch) {
    const table = deleteMatch[1].trim();
    const where = deleteMatch[2] ? ` WHERE ${deleteMatch[2]}` : "";
    return `SELECT COUNT(*) as affected_rows FROM ${table}${where}`;
  }

  // UPDATE table SET ... WHERE ...
  const updateMatch = trimmed.match(/^\s*UPDATE\s+(\S+)\s+.*?(?:WHERE\s+(.+))?$/is);
  if (updateMatch) {
    const table = updateMatch[1].trim();
    const where = updateMatch[2] ? ` WHERE ${updateMatch[2]}` : "";
    return `SELECT COUNT(*) as affected_rows FROM ${table}${where}`;
  }

  return `SELECT 'Could not generate preview' as warning`;
}

/**
 * Check if query already has a LIMIT clause
 */
function hasLimitClause(sql: string): boolean {
  // Match LIMIT at word boundary, not inside a string literal
  // This is a simple check - complex queries with LIMIT in subqueries
  // will still pass, which is fine (better to let DuckDB handle it)
  return /\bLIMIT\s+\d+/i.test(sql);
}

/**
 * Query result with column metadata
 */
interface QueryResult {
  rows: Record<string, unknown>[];
  columns: Array<{ name: string; type: string }>;
  totalRows: number;
}

/**
 * Execute a SQL query with timeout protection.
 *
 * @param conn - DuckDB connection
 * @param sql - SQL query to execute
 * @param limit - Maximum rows to return
 * @param timeoutMs - Timeout in milliseconds
 * @returns Query results with column metadata
 */
async function executeWithTimeout(
  conn: DuckDBConnection,
  sql: string,
  limit: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QueryResult> {
  // Add LIMIT if not present
  let finalSql = sql.trim();
  if (finalSql.endsWith(";")) {
    finalSql = finalSql.slice(0, -1);
  }

  if (!hasLimitClause(finalSql)) {
    finalSql = `${finalSql} LIMIT ${limit}`;
  }

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      // Stop the work: the sandbox instance is closed right after this returns.
      try {
        conn.interrupt();
      } catch {
        /* nothing running */
      }
      reject(
        new Error("Query exceeded 30s timeout. Consider adding LIMIT or filtering by block_id."),
      );
    }, timeoutMs);
  });

  // Execute query with timeout
  const queryPromise = (async (): Promise<QueryResult> => {
    const result = await conn.runAndReadAll(finalSql);

    // Extract column metadata
    const columnCount = result.columnCount;
    const columns: Array<{ name: string; type: string }> = [];

    for (let i = 0; i < columnCount; i++) {
      columns.push({
        name: result.columnName(i),
        type: result.columnType(i).toString(),
      });
    }

    // Convert rows to objects
    const rows: Record<string, unknown>[] = [];
    for (const row of result.getRows()) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columnCount; i++) {
        const value = row[i];
        // Convert BigInt to Number for JSON serialization; DATE values are calendar days.
        obj[columns[i].name] =
          typeof value === "bigint"
            ? Number(value)
            : value instanceof DuckDBDateValue
              ? value.toString()
              : value;
      }
      rows.push(obj);
    }

    return {
      rows,
      columns,
      totalRows: rows.length,
    };
  })();

  return Promise.race([queryPromise, timeoutPromise]);
}

/**
 * Enhance error messages with helpful suggestions.
 *
 * @param error - Original error
 * @returns Enhanced error message
 */
function enhanceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // Table not found - suggest available tables
  if (
    message.toLowerCase().includes("table") &&
    (message.toLowerCase().includes("not found") ||
      message.toLowerCase().includes("does not exist") ||
      message.toLowerCase().includes("catalog error"))
  ) {
    return `${message}\n\nAvailable tables:\n${AVAILABLE_TABLES.map((t) => `  - ${t}`).join("\n")}`;
  }

  // Column not found - suggest DESCRIBE
  if (
    message.toLowerCase().includes("column") &&
    (message.toLowerCase().includes("not found") ||
      message.toLowerCase().includes("does not exist") ||
      message.toLowerCase().includes("binder error"))
  ) {
    return `${message}\n\nTip: Use DESCRIBE trades.trade_data; to see available columns.`;
  }

  // Timeout messages are already helpful
  if (message.includes("timeout")) {
    return message;
  }

  // Pass through other errors (syntax errors include line/column info from DuckDB)
  return message;
}

/**
 * Register SQL query tools with the MCP server.
 *
 * @param server - MCP server instance
 * @param baseDir - Base directory for data files
 */
export function registerSQLTools(server: McpServer, baseDir: string): void {
  server.registerTool(
    "run_sql",
    {
      description:
        "Execute a SQL query against the DuckDB analytics database. " +
        "SELECT runs freely. All mutating operations (DELETE, UPDATE, INSERT, CREATE, ALTER, DROP, TRUNCATE) " +
        "require confirm=true — without it, returns a preview or confirmation prompt. " +
        "Query trades (trades.trade_data, trades.reporting_data) and market data " +
        "(market.spot, market.enriched, market.enriched_context, market.spot_daily, " +
        "market.option_chain, market.option_quote_minutes, market._sync_metadata). " +
        "Trade queries should filter by block_id (e.g. WHERE block_id = 'my-strategy'). " +
        "Call describe_database first to discover available block_ids and column names. " +
        "Returns up to 1000 rows for SELECT queries.",
      inputSchema: z.object({
        query: z.string().describe("SQL query to execute"),
        limit: z
          .number()
          .min(1)
          .max(MAX_ROWS)
          .default(100)
          .describe(`Maximum rows to return (default: 100, max: ${MAX_ROWS})`),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Required for all mutating operations (DELETE, UPDATE, INSERT, CREATE, ALTER, DROP, TRUNCATE). Without it, returns a preview or prompt.",
          ),
      }),
    },
    withFullSync(baseDir, async ({ query, limit, confirm }) => {
      // Validate query for dangerous patterns
      const validationError = validateQuery(query, getDataRoot(baseDir));
      if (validationError) {
        return {
          content: [{ type: "text" as const, text: validationError }],
          isError: true as const,
        };
      }

      // Check if mutating — require confirm
      const { destructive, operation } = isDestructiveQuery(query);
      if (destructive && !confirm) {
        // For DELETE/UPDATE, try to preview affected row count
        if (operation === "DELETE" || operation === "UPDATE") {
          let sandbox: QuerySandbox | null = null;
          try {
            // The preview embeds the caller's WHERE clause, so it runs sandboxed.
            sandbox = await openQuerySandbox(baseDir, getDataRoot(baseDir));
            const previewSql = toPreviewQuery(query);
            await assertReadOnlyStatements(sandbox.conn, previewSql);
            const result = await executeWithTimeout(sandbox.conn, previewSql, 1);
            const count = result.rows[0]?.affected_rows ?? "unknown";
            return createToolOutput(
              `⚠️ ${operation} would affect ${count} row(s). Re-run with confirm=true to execute.`,
              { operation, affectedRows: count, query, preview: true },
            );
          } catch (error) {
            return createToolOutput(
              `⚠️ ${operation} requires confirm=true. Could not preview: ${error instanceof Error ? error.message : String(error)}`,
              { operation, query, preview: true },
            );
          } finally {
            sandbox?.close();
          }
        }
        // For other mutating ops (INSERT, CREATE, ALTER, DROP, TRUNCATE) — no preview, just gate
        return createToolOutput(`⚠️ ${operation} requires confirm=true to execute.`, {
          operation,
          query,
          preview: true,
        });
      }

      try {
        if (destructive && confirm) {
          // Upgrade to read-write for mutations, then lock the instance down so the
          // statement cannot read outside --data-root, reach the network or change
          // configuration. downgradeToReadOnly closes this instance and reopens a
          // fresh, unrestricted read-only one for the server's other tools.
          try {
            const rwConn = await upgradeToReadWrite(baseDir);
            await lockDownConnection(rwConn, sandboxAllowedDirectories(getDataRoot(baseDir)));
            const result = await rwConn.run(query);
            const changed = Number(result.rowsChanged);
            return createToolOutput(`${operation} completed: ${changed} row(s) affected.`, {
              operation,
              rowsAffected: changed,
            });
          } finally {
            await downgradeToReadOnly(baseDir);
          }
        }

        // Execute SELECT query with timeout on a locked-down, read-only instance
        // that exists only for this call.
        const sandbox = await openQuerySandbox(baseDir, getDataRoot(baseDir));
        let result: QueryResult;
        try {
          await assertReadOnlyStatements(sandbox.conn, query);
          result = await executeWithTimeout(sandbox.conn, query, limit);
        } finally {
          sandbox.close();
        }

        // Determine if results were truncated
        const returnedRows = result.rows.length;
        const truncated = returnedRows >= limit;

        // Create summary
        const summary = `Query returned ${returnedRows} row(s)${truncated ? ` (limited to ${limit})` : ""}`;

        // Return structured output
        return createToolOutput(summary, {
          rows: result.rows,
          columns: result.columns,
          totalRows: result.totalRows,
          returnedRows,
          truncated,
        });
      } catch (error) {
        const enhancedMessage = enhanceError(error);
        return {
          content: [{ type: "text" as const, text: enhancedMessage }],
          isError: true as const,
        };
      }
    }),
  );
}
