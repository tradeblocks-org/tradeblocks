/**
 * DuckDB Connection Manager
 *
 * Provides lazy singleton connection to DuckDB analytics database (analytics.duckdb)
 * with a second database (market.duckdb) ATTACHed as the `market` catalog.
 *
 * Startup sequence on first RW open:
 *   1. Open analytics.duckdb
 *   2. DROP SCHEMA IF EXISTS market CASCADE (removes legacy inline market tables,
 *      prevents DuckDB #14421 naming conflict with the upcoming ATTACH)
 *   3. ATTACH market.duckdb AS market
 *   4. ensureMarketDataTables() — physical canonical market tables when Parquet views are absent
 *   5. ensureMutableMarketTables() — _sync_metadata, data_coverage
 *   6. createMarketParquetViews() — views over shared Parquet files (opportunistic)
 *   7. ensureSyncTables() / ensureTradeDataTable() / ensureReportingDataTable()
 *
 * On close: CHECKPOINT → DETACH market → closeSync() to flush WAL reliably.
 * On RO open: ATTACH market.duckdb READ_ONLY (no table creation).
 *
 * DuckDB is single-process: only one process can open a database file at a time
 * (even read-only fails when another process holds a write lock with an active WAL).
 * Lock recovery handles stale processes from crashed Claude Code sessions by detecting
 * orphaned MCP processes (PPID=1) and terminating them before retrying.
 *
 * Configuration via environment variables:
 *   DUCKDB_MEMORY_LIMIT    - Memory limit (default: 75% of system RAM, floor 1GB)
 *   DUCKDB_THREADS         - Number of threads (default: 2 — higher counts cause driver flakiness)
 *   DUCKDB_LOCK_RECOVERY   - Force-kill ANY lock-holding tradeblocks-mcp (default: false)
 *   DUCKDB_LOCK_RECOVERY_TIMEOUT_MS - Wait time for SIGTERM (default: 1500)
 *   MARKET_DB_PATH         - Path to market.duckdb (overrides default, overridden by --market-db)
 *
 * Security:
 *   - enable_external_access: "true" at DuckDBInstance creation allows local ATTACH
 *   - We do NOT call SET enable_external_access = false because testing confirmed it also
 *     blocks local file ATTACH operations (not just HTTP), which breaks importFromDatabase
 *   - No HTTP URLs are used in this application — local ATTACH is the only external access needed
 *
 * Schemas created on first RW connection:
 *   - trades: For block/trade data (in analytics.duckdb)
 *   - market: ATTACHed from market.duckdb (spot, spot_daily, enriched, enriched_context, option_chain, option_quote_minutes, _sync_metadata)
 */

import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { ensureSyncTables, ensureTradeDataTable, ensureReportingDataTable } from "./schemas.ts";
import { ensureMutableMarketTables, ensureMarketDataTables } from "./market-schemas.ts";
import { ensureProfilesSchema } from "./profile-schemas.ts";
import { createMarketParquetViews } from "./market-views.ts";
import { migrateMetadataToJson } from "./json-migration.ts";
import { getDataRoot } from "./data-root.ts";

// Module-level singleton state
let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;
let connectionMode: "read_write" | "read_only" | null = null;
let storedDbPath: string | null = null;
let storedThreads: string | null = null;
let storedMemoryLimit: string | null = null;
let storedMarketDbPath: string | null = null;
const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

/**
 * Default DuckDB memory limit when `DUCKDB_MEMORY_LIMIT` is unset.
 *
 * Scales to 75% of total system RAM — DuckDB's own native default is 80%; we
 * keep a small headroom for Node's heap, the OS, and other processes. Floored
 * at 1GB so very small VMs / CI containers still work; no upper cap. Returns
 * a DuckDB-compatible string like "90GB".
 */
function defaultMemoryLimit(): string {
  const totalGB = os.totalmem() / (1024 ** 3);
  const targetGB = Math.max(1, Math.floor(totalGB * 0.75));
  return `${targetGB}GB`;
}

/**
 * Default DuckDB thread count when `DUCKDB_THREADS` is unset.
 *
 * Stays at 2 — empirically, higher counts trigger intermittent
 * `Failed to execute prepared statement` errors mid-run on long parquet-mode
 * read workloads (tested 4, 8, 32 — all flaky). The hot path is per-date
 * partition reads which are I/O-bound, not CPU-bound. Users with large
 * parallel-read workloads can override via the env var.
 */
function defaultThreads(): string {
  return "2";
}

function isLockError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("could not set lock on file") ||
    lower.includes("conflicting lock is held") ||
    lower.includes("io error: could not set lock") ||
    lower.includes("being used by another process") // Windows OS error
  );
}

function parseLockHolderPid(message: string): number | null {
  const match = message.match(/PID\s+(\d+)/i);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getProcessParentPid(pid: number): Promise<number | null> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync("wmic", [
        "process", "where", `ProcessId=${pid}`, "get", "ParentProcessId", "/value",
      ]);
      const match = stdout.match(/ParentProcessId=(\d+)/);
      if (!match) return null;
      const ppid = parseInt(match[1], 10);
      return Number.isFinite(ppid) ? ppid : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "ppid="]);
    const ppid = parseInt(stdout.trim(), 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

async function getProcessCommand(pid: number): Promise<string | null> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync("wmic", [
        "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value",
      ]);
      const match = stdout.match(/CommandLine=(.+)/);
      if (!match) return null;
      const command = match[1].trim();
      return command.length > 0 ? command : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function tryRecoverLockByTerminatingStaleProcess(
  errorMessage: string,
  dbPath: string,
  forceRecovery: boolean
): Promise<boolean> {
  const lockHolderPid = parseLockHolderPid(errorMessage);
  if (!lockHolderPid || lockHolderPid === process.pid) {
    return false;
  }

  const command = await getProcessCommand(lockHolderPid);
  if (!command) {
    return false;
  }

  // Only terminate lock holders that look like another tradeblocks-mcp session for this data dir.
  const normalizedDbPath = dbPath.replace(/\\/g, "/");
  const normalizedDbDir = path.dirname(normalizedDbPath);
  const isTradeblocksProcess =
    command.includes("tradeblocks-mcp") ||
    command.includes("/mcp-server/server/index.js") ||
    command.includes("packages/mcp-server/server/index.js") ||
    command.includes("\\mcp-server\\server\\index.js") ||
    command.includes("packages\\mcp-server\\server\\index.js");
  // Normalize command paths for consistent comparison (Windows backslashes → forward slashes)
  const normalizedCommand = command.replace(/\\/g, "/");
  const targetsSameDb = normalizedCommand.includes(normalizedDbPath) || normalizedCommand.includes(normalizedDbDir);

  if (!isTradeblocksProcess || !targetsSameDb) {
    return false;
  }

  // Check if the lock holder is orphaned (parent session is gone).
  // Unix: orphaned processes get reparented to PID 1 (init/launchd).
  // Windows: child keeps original PPID even after parent dies — check if parent is still alive.
  // Only kill non-orphaned processes if forceRecovery is explicitly enabled.
  const ppid = await getProcessParentPid(lockHolderPid);
  const orphaned = isWindows
    ? (ppid !== null && !isProcessAlive(ppid))
    : ppid === 1;
  if (!orphaned && !forceRecovery) {
    return false;
  }

  const reason = orphaned ? "orphaned" : "force-recovery";
  const timeoutMs = Number.parseInt(process.env.DUCKDB_LOCK_RECOVERY_TIMEOUT_MS || "1500", 10);

  try {
    process.kill(lockHolderPid, "SIGTERM");
  } catch {
    return false;
  }

  const exited = await waitForProcessExit(
    lockHolderPid,
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500
  );

  if (exited) {
    console.error(
      `Recovered DuckDB lock at ${dbPath} by stopping ${reason} tradeblocks-mcp process PID ${lockHolderPid}.`
    );
  }

  return exited;
}

/**
 * Resolve the path to market.duckdb.
 *
 * Precedence: CLI --market-db > MARKET_DB_PATH env > default (<dataDir>/market.duckdb)
 *
 * @param dataDir - Directory where analytics.duckdb lives (used as default parent)
 */
function resolveMarketDbPath(dataDir: string): string {
  // 1. CLI argument: --market-db /path/to/market.duckdb
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--market-db" && args[i + 1]) {
      return path.resolve(args[i + 1]);
    }
  }
  // 2. Environment variable
  if (process.env.MARKET_DB_PATH) {
    return path.resolve(process.env.MARKET_DB_PATH);
  }
  // 3. Default: alongside analytics.duckdb
  return path.join(dataDir, "market.duckdb");
}

/**
 * ATTACH market.duckdb to an existing connection.
 *
 * Creates the parent directory if needed. Auto-recreates market.duckdb on
 * corruption (market data is re-importable from source CSVs).
 *
 * Hard fails on any non-corruption ATTACH error — market access is required.
 */
async function attachMarketDb(
  conn: DuckDBConnection,
  marketDbPath: string,
  mode: "read_write" | "read_only"
): Promise<void> {
  await fs.mkdir(path.dirname(marketDbPath), { recursive: true });
  const readOnlyClause = mode === "read_only" ? " (READ_ONLY)" : "";
  const escapedPath = marketDbPath.replace(/'/g, "''");
  try {
    await conn.run(`ATTACH '${escapedPath}' AS market${readOnlyClause}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("corrupt") || msg.includes("Invalid") || msg.includes("cannot open")) {
      console.error(`market.duckdb appears corrupted at ${marketDbPath}. Recreating.`);
      try { await fs.unlink(marketDbPath); } catch { /* file may not exist */ }
      // Also try removing WAL file
      try { await fs.unlink(marketDbPath + ".wal"); } catch { /* ignore */ }
      await conn.run(`ATTACH '${escapedPath}' AS market${readOnlyClause}`);
    } else {
      throw new Error(`Failed to attach market.duckdb at ${marketDbPath}: ${msg}`);
    }
  }
}

/**
 * DETACH market.duckdb from a connection.
 * Non-fatal: may already be detached or market was never attached.
 */
async function detachMarketDb(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("DETACH market");
  } catch {
    // Non-fatal: may already be detached or market never attached
  }
}

async function openReadWriteConnection(
  dbPath: string,
  threads: string,
  memoryLimit: string
): Promise<DuckDBConnection> {
  // enable_external_access must be "true" at instance creation to allow ATTACH of local files.
  // DuckDB 1.4+ blocks all filesystem operations (including local ATTACH) when set to "false"
  // at the instance level. After ATTACH, we lock it down via SET to prevent remote HTTP access.
  instance = await DuckDBInstance.create(dbPath, {
    threads,
    memory_limit: memoryLimit,
    enable_external_access: "true",
  });
  connection = await instance.connect();

  // Drop legacy market schema from analytics.duckdb before ATTACH.
  // Prevents DuckDB #14421 naming conflict: having tables in both the main DB
  // and an ATTACHed DB under the same catalog name causes corruption.
  try {
    await connection.run("DROP SCHEMA IF EXISTS market CASCADE");
  } catch {
    // Non-fatal: schema may not exist (fresh DB or already dropped)
  }

  // Attach separate market.duckdb
  await attachMarketDb(connection, storedMarketDbPath!, "read_write");

  // NOTE: We intentionally do NOT call SET enable_external_access = false here.
  // Testing confirmed that SET blocks ALL new ATTACH operations (including local file ATTACH),
  // not just remote HTTP/HTTPS access. This would prevent importFromDatabase from ATTACHing
  // external DuckDB files, making the import_from_database MCP tool non-functional.
  // The enable_external_access: "true" at DuckDBInstance creation is the intended security
  // boundary — no HTTP URLs are used in this application.

  // Create schemas/tables every RW open. This keeps the process resilient if
  // analytics.duckdb is deleted/recreated while the process remains alive.
  await connection.run("CREATE SCHEMA IF NOT EXISTS trades");
  await ensureSyncTables(connection);
  await ensureTradeDataTable(connection);
  await ensureReportingDataTable(connection);
  await ensureMutableMarketTables(connection);
  await ensureProfilesSchema(connection);

  const dataDir = path.dirname(dbPath);
  const dataRoot = getDataRoot(dataDir);

  // Parquet view overlay: create views over shared Parquet files when present.
  // The env var controls WRITE path; the read path is always opportunistic —
  // views are registered whenever the Parquet files exist.
  // Runs BEFORE ensureMarketDataTables so stale views from a previous data path
  // are dropped first — otherwise CREATE TABLE IF NOT EXISTS is a no-op against
  // the existing view name, leaving a broken view referencing a missing file.
  await createMarketParquetViews(connection, dataRoot);

  // Physical market data tables as fallback for datasets not covered by Parquet views.
  //
  // IMPORTANT — lifecycle ordering:
  // Because createMarketParquetViews (above) runs FIRST, by the time we get here
  // a VIEW may already occupy any of the canonical names (e.g. market.option_quote_minutes
  // over legacy-layout Parquet files that lack the new `underlying` column). Any
  // migration-style logic inside ensureMarketDataTables that wants to DROP+recreate
  // a physical table MUST filter information_schema.tables by
  // `table_type = 'BASE TABLE'` so it does not accidentally drop a legitimate VIEW.
  // VIEWs are owned by the Parquet-view layer, not by this schema layer.
  await ensureMarketDataTables(connection);

  // One-time metadata migration: DuckDB -> JSON files.
  // Runs only when TRADEBLOCKS_PARQUET=true and JSON files don't yet exist.
  // Must run AFTER all DuckDB tables are created (profiles, sync, market schemas).
  try {
    const blocksDir = (await import("../sync/index.ts")).getBlocksDir(dataRoot);
    await migrateMetadataToJson(connection, dataRoot, blocksDir);
  } catch (err) {
    console.warn("[json-migration] Migration failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  connectionMode = "read_write";

  return connection;
}

async function openReadOnlyConnection(
  dbPath: string,
  threads: string,
  memoryLimit: string
): Promise<DuckDBConnection> {
  // enable_external_access must be "true" at instance creation to allow ATTACH.
  // We do NOT call SET enable_external_access = false because it also blocks local
  // file ATTACH operations, not just HTTP. See openReadWriteConnection for details.
  instance = await DuckDBInstance.create(dbPath, {
    threads,
    memory_limit: memoryLimit,
    enable_external_access: "true",
    access_mode: "READ_ONLY",
  });
  connection = await instance.connect();
  if (storedMarketDbPath) {
    await attachMarketDb(connection, storedMarketDbPath, "read_only");
  }
  connectionMode = "read_only";
  return connection;
}

function resetConnectionState(): void {
  if (connection) {
    try { connection.closeSync(); } catch { /* non-fatal */ }
  }
  connection = null;
  if (instance) {
    try { instance.closeSync(); } catch { /* non-fatal */ }
  }
  instance = null;
  connectionMode = null;
}

/**
 * Get or create a DuckDB connection.
 *
 * On first call:
 *   - Creates DuckDBInstance at `<dataDir>/analytics.duckdb`
 *   - Applies memory, thread, and security configuration
 *   - Drops legacy inline market schema from analytics.duckdb
 *   - ATTACHes market.duckdb as `market` catalog
 *   - Creates 'trades' schema and market tables
 *   - Stores connection for reuse
 *
 * Subsequent calls return the existing connection.
 *
 * @param dataDir - Directory where analytics.duckdb will be stored
 * @returns Promise<DuckDBConnection> - The DuckDB connection
 * @throws Error if database is corrupted or cannot be opened
 */
export async function getConnection(dataDir: string): Promise<DuckDBConnection> {
  // Return existing connection if available (singleton pattern)
  if (connection) {
    return connection;
  }

  const dbPath = path.join(dataDir, "analytics.duckdb");

  // Configuration from environment with sensible defaults — thread count and
  // memory limit auto-scale to host capacity (see helpers above).
  const threads = process.env.DUCKDB_THREADS || defaultThreads();
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || defaultMemoryLimit();

  // Store config for reuse by upgrade/downgrade
  storedDbPath = dbPath;
  storedThreads = threads;
  storedMemoryLimit = memoryLimit;
  storedMarketDbPath = resolveMarketDbPath(dataDir);
  // Lock recovery: kill other tradeblocks-mcp processes that hold the write lock.
  // Enabled by default — safe because market data is re-importable and lock holders
  // are just other Claude sessions that can lazily restart their MCP server.
  // Set DUCKDB_LOCK_RECOVERY=false to disable (only kill orphaned processes).
  const forceRecovery = (process.env.DUCKDB_LOCK_RECOVERY ?? "true") !== "false";

  try {
    await openReadWriteConnection(dbPath, threads, memoryLimit);
    // Release write lock after initialization — idle state is read-only.
    // Write tools call upgradeToReadWrite() when they need writes.
    await downgradeToReadOnly(dataDir);
    return connection!; // downgradeToReadOnly reopened as RO
  } catch (error) {
    // Provide clear error message for common issues
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Lock recovery: auto-kill orphaned tradeblocks-mcp processes (PPID=1) that hold the lock.
    // With DUCKDB_LOCK_RECOVERY=true, also kills non-orphaned holders (force mode).
    if (isLockError(errorMessage)) {
      const recovered = await tryRecoverLockByTerminatingStaleProcess(errorMessage, dbPath, forceRecovery);
      if (recovered) {
        // DuckDB file locks may linger briefly after process death — retry with backoff
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          try {
            await openReadWriteConnection(dbPath, threads, memoryLimit);
            // Release write lock after initialization
            await downgradeToReadOnly(dataDir);
            return connection!;
          } catch (retryError) {
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
            if (attempt < 2 && isLockError(retryMsg)) continue;
            resetConnectionState();
            throw new Error(
              `Failed to initialize DuckDB at ${dbPath} after lock recovery: ${retryMsg}`
            );
          }
        }
      }
    }

    // Reset state on failure
    resetConnectionState();

    // Check for corruption indicators
    if (
      errorMessage.includes("corrupt") ||
      errorMessage.includes("Invalid") ||
      errorMessage.includes("cannot open")
    ) {
      throw new Error(
        `DuckDB database appears corrupted at ${dbPath}. ` +
          `Please delete the file manually and restart. ` +
          `Original error: ${errorMessage}`
      );
    }

    throw new Error(`Failed to initialize DuckDB at ${dbPath}: ${errorMessage}`);
  }
}

/**
 * Close the DuckDB connection and release resources.
 *
 * DETACHes market.duckdb before closing to ensure WAL is checkpointed cleanly.
 * Should be called during graceful shutdown (SIGINT, SIGTERM).
 * Safe to call multiple times or when no connection exists.
 */
export async function closeConnection(): Promise<void> {
  if (connection) {
    try { await connection.run("CHECKPOINT"); } catch { /* non-fatal */ }
    try { await detachMarketDb(connection); } catch { /* non-fatal, log debug */ }
    try {
      // closeSync is the synchronous close method for DuckDB connections
      connection.closeSync();
    } catch (error) {
      // Log but don't throw during shutdown
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Error closing DuckDB connection: ${msg}`);
    }
    connection = null;
  }

  // Close the DuckDB instance to release the file lock.
  // Without this, the native handle leaks until GC and blocks subsequent RW opens.
  if (instance) {
    try { instance.closeSync(); } catch { /* non-fatal */ }
  }
  instance = null;
  connectionMode = null;
}

/**
 * Upgrade the connection to read-write mode for write operations.
 * No-op if already in read-write mode.
 * Retries with backoff if another session briefly holds the write lock.
 *
 * @param dataDir - Directory where analytics.duckdb lives
 * @param options.fallbackToReadOnly - If true, fall back to read-only on lock failure
 *   instead of throwing. Used by sync middleware where RO is acceptable (just skip sync).
 *   Default: false — callers that need writes get a clear error instead of a silent RO surprise.
 */
export async function upgradeToReadWrite(
  dataDir: string,
  options?: { fallbackToReadOnly?: boolean }
): Promise<DuckDBConnection> {
  if (connectionMode === "read_write" && connection) return connection;
  await closeConnection();

  // Open directly in RW mode — do NOT go through getConnection() which would
  // downgrade back to RO immediately after init.
  // storedDbPath/storedThreads/storedMemoryLimit are set by the initial getConnection() call.
  const dbPath = storedDbPath || path.join(dataDir, "analytics.duckdb");
  const threads = storedThreads || process.env.DUCKDB_THREADS || defaultThreads();
  const memoryLimit = storedMemoryLimit || process.env.DUCKDB_MEMORY_LIMIT || defaultMemoryLimit();
  if (!storedMarketDbPath) {
    storedMarketDbPath = resolveMarketDbPath(dataDir);
  }

  // Try RW with retries — another session may briefly hold the lock during its own sync.
  // After /mcp reconnect, the old process may not have released the DuckDB file lock yet,
  // so we retry with increasing delays to allow the lock to fully release.
  const maxRetries = 4;
  const retryDelayMs = 1000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await openReadWriteConnection(dbPath, threads, memoryLimit);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isLockError(msg)) throw error;
      lastError = error instanceof Error ? error : new Error(msg);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  // RW retries exhausted
  if (options?.fallbackToReadOnly && storedDbPath && storedThreads && storedMemoryLimit) {
    try {
      await openReadOnlyConnection(storedDbPath, storedThreads, storedMemoryLimit);
      if (connection) return connection;
    } catch {
      // RO also failed (WAL may still exist from active writer)
    }
  }

  throw lastError || new Error(
    "Cannot acquire DuckDB write lock. Another process holds it. " +
    "Kill other tradeblocks-mcp processes or restart Claude Code."
  );
}

/**
 * Downgrade the connection to read-only mode after sync/write operations.
 * No-op if already in read-only mode.
 * Closes the RW connection (checkpoints WAL, releases write lock) and reopens as RO.
 * Multiple processes can hold RO connections simultaneously.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function downgradeToReadOnly(dataDir: string): Promise<void> {
  if (connectionMode === "read_only") return;
  if (!connection) return;
  await closeConnection();
  if (storedDbPath && storedThreads && storedMemoryLimit) {
    await openReadOnlyConnection(storedDbPath, storedThreads, storedMemoryLimit);
  }
}

/**
 * Open a DuckDB connection scoped to writes against market.duckdb only, with
 * NO host file opened against analytics.duckdb.
 *
 * Shape: in-memory host instance, market.duckdb ATTACHed as `market` in
 * READ_WRITE mode, market parquet views registered on the connection. Writes
 * resolve to the attached market catalog; reads against the `market.*` views
 * are served from the canonical parquet files under `<dataRoot>/market/`.
 *
 * Why this helper exists: callers whose only job is to write market data
 * (intraday bar ingest, option-chain refresh, quote backfill) should not
 * acquire any lock on analytics.duckdb. Holding analytics RW for a
 * long-running market refresh blocks every parallel reader (other shells,
 * dashboards, evaluation processes) from even opening analytics READ_ONLY —
 * DuckDB rejects RO opens against a file that has an active WAL written by
 * another process. Routing market writes through a `:memory:` host with
 * market attached RW leaves analytics.duckdb completely untouched for the
 * duration of the ingest, so concurrent processes keep their normal RO
 * access. Market writes are still single-writer (the OS-level file lock on
 * market.duckdb is unchanged) — this helper trades only the analytics lock.
 *
 * Important: the returned connection is NOT shared via the module-level
 * singleton. `getCurrentConnection()` is not affected. The caller owns the
 * lifecycle and must call `close()` to flush the market WAL and release the
 * market.duckdb file lock.
 *
 * @param baseDir - Directory passed to the rest of the db/ module (the same
 *   directory that `getConnection(baseDir)` would receive). Used as the
 *   fallback parent for market.duckdb when neither `--market-db` nor
 *   `MARKET_DB_PATH` is set, and as the fallback for `getDataRoot()`.
 */
export interface MarketOnlyConnection {
  /** The active DuckDB connection. Backed by a `:memory:` host with `market` attached RW. */
  conn: DuckDBConnection;
  /** Resolved path to the market.duckdb file that was attached. */
  marketDbPath: string;
  /**
   * Flush the market WAL, detach the market catalog, and close the connection
   * + in-memory host instance. Best-effort on each step — surfaces no errors;
   * the goal is to release the market.duckdb file lock for the next writer.
   * Safe to call multiple times (subsequent calls are no-ops).
   */
  close(): Promise<void>;
}

export async function openMarketOnlyConnection(
  baseDir: string,
): Promise<MarketOnlyConnection> {
  const marketDbPath = resolveMarketDbPath(baseDir);

  // `:memory:` host means the connection does not open any on-disk database
  // as the catalog root — analytics.duckdb is never touched by this code
  // path. `enable_external_access: "true"` is required at instance creation
  // to permit the ATTACH of a local file (DuckDB 1.4+ otherwise blocks all
  // filesystem operations from within the connection).
  const memoryInstance = await DuckDBInstance.create(":memory:", {
    enable_external_access: "true",
  });
  const conn = await memoryInstance.connect();

  // ATTACH market.duckdb as RW. Reuses the same path-resolution +
  // corruption-recovery logic as the regular RW path so callers see
  // consistent behavior.
  await attachMarketDb(conn, marketDbPath, "read_write");

  // Register views over the canonical market parquet partitions on this
  // fresh connection. Without this, `SELECT ... FROM market.option_chain`
  // (and friends) resolve only against the physical tables inside the
  // attached market.duckdb — which is empty in the parquet-mode deployment
  // where the partition files are the source of truth. createMarketParquetViews
  // uses CREATE OR REPLACE so this is idempotent against pre-existing views
  // inside market.duckdb.
  const dataRoot = getDataRoot(baseDir);
  await createMarketParquetViews(conn, dataRoot);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Flush the market WAL before detach so the file on disk is consistent
    // for the next reader. DETACH is best-effort — if it fails (e.g. an
    // in-flight statement still references the catalog), we still want to
    // close the handle so subsequent processes can acquire the RW lock.
    try { await conn.run("CHECKPOINT market"); } catch { /* non-fatal */ }
    try { await detachMarketDb(conn); } catch { /* non-fatal */ }
    try { conn.closeSync(); } catch { /* non-fatal */ }
    try { memoryInstance.closeSync(); } catch { /* non-fatal */ }
  };

  return { conn, marketDbPath, close };
}

/**
 * Open a parquet-backed market-data connection: an in-memory host with the
 * `market.*` views registered over the canonical parquet partitions under
 * `<dataRoot>/market/`, and WITHOUT attaching the shared market database file.
 * No host file is opened against the analytics database either.
 *
 * This is the canonical helper for every parquet-mode consumer — read AND
 * write. Once the shared market database file is out of the picture there is no
 * read/write distinction for the *connection*: both inputs and outputs are
 * parquet. Reads resolve against the in-memory `market.*` views (or direct
 * `read_parquet` on absolute file paths, which store callers prefer). Writes go
 * through `COPY ... TO '<file>' (FORMAT PARQUET)` staged in a per-connection
 * `TEMP` table — a filesystem write that needs no attached catalog. The store
 * write path stages and copies; it never `INSERT`s into the `market.*` views.
 *
 * Shape: in-memory host instance, a `market` schema created in-memory, and the
 * market parquet views registered on that schema. Nothing is attached, so no
 * OS-level file lock is taken on the shared market database — multiple readers,
 * multiple parquet writers, and a legacy attach-based market writer all coexist
 * without contention.
 *
 * Why this helper exists: the parquet-mode path's only inputs and outputs are
 * the parquet partitions. The shared market database file is never the source
 * of truth on this path, so attaching it is pure liability — it makes the
 * caller block (or be blocked by) any other process holding the database file
 * lock. Routing through a `:memory:` host with parquet views registered leaves
 * the shared market database completely untouched. This is the parquet analog
 * of `openMarketOnlyConnection` (the attach-based RW helper that non-parquet
 * deployments still require for physical-table `INSERT`s into `market.*`); the
 * one structural difference is that this path must CREATE the `market` schema
 * itself (no attach creates it) before registering the views.
 *
 * Important: the returned connection is NOT shared via the module-level
 * singleton. `getCurrentConnection()` is not affected. The caller owns the
 * lifecycle and must call `close()`.
 *
 * @param baseDir - Directory passed to the rest of the db/ module (the same
 *   directory that `getConnection(baseDir)` would receive). Used as the
 *   fallback for `getDataRoot()` when neither `--data-root` nor the data-root
 *   env var is set.
 */
export interface MarketParquetConnection {
  /** The active DuckDB connection. Backed by a `:memory:` host with `market.*` parquet views. */
  conn: DuckDBConnection;
  /** Resolved data root the parquet views were registered against (for logging/parity). */
  dataRoot: string;
  /**
   * Close the connection + in-memory host instance. Best-effort on each step.
   * Nothing is attached on this path, so there is no WAL to flush and no
   * catalog to detach. Safe to call multiple times (subsequent calls are
   * no-ops).
   */
  close(): Promise<void>;
}

export async function openMarketParquetConnection(
  baseDir: string,
): Promise<MarketParquetConnection> {
  // `:memory:` host means the connection does not open any on-disk database as
  // the catalog root — neither the analytics database nor the shared market
  // database file is touched by this code path. `enable_external_access:
  // "true"` is required at instance creation to permit reads of local parquet
  // files AND `COPY ... TO '<file>'` writes (DuckDB 1.4+ otherwise blocks all
  // filesystem operations from within the connection).
  const memoryInstance = await DuckDBInstance.create(":memory:", {
    enable_external_access: "true",
  });
  const conn = await memoryInstance.connect();

  // The `market.*` views target the `market` schema. On the attach-based
  // paths the ATTACH creates that schema; here there is no attach, so we must
  // create it before registering the views or every CREATE VIEW market.* fails
  // with a catalog error.
  await conn.run("CREATE SCHEMA IF NOT EXISTS market");

  // Register views over the canonical market parquet partitions. These are the
  // source of truth for reads; no physical market tables are consulted. The
  // ingest write path uses these views for read-back during enrichment (e.g.
  // the `market.spot_daily` identity-row backfill) and writes its output via
  // `COPY ... TO` to parquet files — never an INSERT into a view.
  const dataRoot = getDataRoot(baseDir);
  await createMarketParquetViews(conn, dataRoot);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { conn.closeSync(); } catch { /* non-fatal */ }
    try { memoryInstance.closeSync(); } catch { /* non-fatal */ }
  };

  return { conn, dataRoot, close };
}

/**
 * Read-side name for {@link openMarketParquetConnection}. Retained as the
 * canonical handle for read-only parquet consumers; the underlying connection
 * is identical (parquet has no read/write distinction once the shared market
 * database file is out of the picture).
 */
export type MarketReadOnlyConnection = MarketParquetConnection;

export function openMarketReadOnlyConnection(
  baseDir: string,
): Promise<MarketReadOnlyConnection> {
  return openMarketParquetConnection(baseDir);
}

/**
 * Open a fresh read-only connection without going through `getConnection()`'s
 * RW-init phase. The standard `getConnection()` flow always opens RW briefly
 * to create schemas + parquet views before downgrading; that brief RW window
 * is exclusive across processes (DuckDB is single-process-write) and races
 * fatally with sibling readers when multiple consumers spin up at once.
 *
 * Use this when:
 *   - Schemas + market views already exist (some prior RW caller initialized them)
 *   - The caller only needs to *read* — no write tools, no schema setup
 *   - Multiple processes need concurrent access to the same database
 *
 * The fork-pool in `self-improve.mjs --score all` is the canonical caller —
 * each child worker reads strategy JSON + OO trades + parquet partitions and
 * writes nothing back. Two RO connections never conflict.
 *
 * Returns a connection that's NOT shared via the module-level singleton —
 * the caller owns it and is responsible for closing. (The internal
 * `connection`/`instance` module state is still mutated for compatibility
 * with `getCurrentConnection()` / store contexts that read from it; in a
 * subprocess that's fine since the module state is per-worker.)
 */
export async function getReadOnlyConnection(dataDir: string): Promise<DuckDBConnection> {
  if (connection) return connection;
  const dbPath = path.join(dataDir, "analytics.duckdb");
  const threads = process.env.DUCKDB_THREADS || defaultThreads();
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || defaultMemoryLimit();
  storedDbPath = dbPath;
  storedThreads = threads;
  storedMemoryLimit = memoryLimit;
  storedMarketDbPath = resolveMarketDbPath(dataDir);
  await openReadOnlyConnection(dbPath, threads, memoryLimit);
  return connection!;
}

/**
 * Get the current connection mode.
 * Used by middleware to determine if sync should be skipped (RO fallback).
 */
export function getConnectionMode(): "read_write" | "read_only" | null {
  return connectionMode;
}

/**
 * Check if a connection is currently active.
 * Useful for diagnostics and testing.
 */
export function isConnected(): boolean {
  return connection !== null;
}

/**
 * Sync accessor for the currently-active module-level connection.
 *
 * Resolves the *current* DuckDBConnection at call time. Designed to back a
 * `get conn()` getter on `StoreContext` so stores that hold the ctx forever
 * still see the connection that `upgradeToReadWrite` / `downgradeToReadOnly`
 * swap in after init (the old handle is `closeSync()`-ed and would otherwise
 * surface as "connection disconnected" on any subsequent read/write).
 *
 * Throws if no connection is open — callers should have already awaited
 * `getConnection(dataDir)` during server init.
 */
export function getCurrentConnection(): DuckDBConnection {
  if (!connection) {
    throw new Error(
      "No active DuckDB connection. Call getConnection(dataDir) during server init before accessing store contexts.",
    );
  }
  return connection;
}

// Note: the legacy intraday write-target getter / module-state variable and
// the consumer override hook have been removed. Every spot write now flows
// through SpotStore.writeBars (the canonical Hive-partitioned
// `spot/ticker=X/date=Y/` layout); there is no longer a per-process override
// of the write target.
