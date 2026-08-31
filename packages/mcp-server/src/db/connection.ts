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
 * DuckDB's cross-process locking, as measured against @duckdb/node-api:
 *
 *   holder      new open     result
 *   read-write  read-only    fails
 *   read-write  read-write   fails
 *   read-only   read-write   fails
 *   read-only   read-only    SUCCEEDS
 *
 * So any number of servers coexist as long as they are all read-only, and a single
 * read-write holder excludes everyone — including readers. Because this server takes
 * the write lock only to build schemas at startup and then downgrades, a second
 * server booting concurrently must WAIT OUT that window and then open read-only.
 * It must never terminate the holder: a live holder is another working session
 * (clients such as Claude Desktop run more than one copy of this server), and
 * killing it produces a mutual-destruction loop where each restart kills the
 * survivor. See getConnection's lock handling.
 *
 * Genuinely abandoned holders are handled two ways: the parent-death watchdog in
 * index.ts makes an orphaned server shut itself down within seconds, and lock
 * recovery terminates a holder that is already reparented to PID 1. Killing a LIVE
 * holder requires the explicit DUCKDB_LOCK_RECOVERY=true opt-in.
 *
 * The read-only row above has a second consequence, and it is why the handle is
 * LEASED rather than parked (#445). A reader blocks a writer. A server that opens
 * read-only at startup and keeps that handle for its whole lifetime therefore blocks
 * every write in every other server on the same data directory, including while it
 * sits doing nothing. So:
 *
 *   - acquireConnectionLease / releaseConnectionLease bracket a unit of work. The
 *     handle stays open while any lease is held, so a caller may hold a connection
 *     reference across awaits safely.
 *   - When the last lease drops, the handle closes after DUCKDB_IDLE_RELEASE_MS,
 *     freeing the file. The next getConnection reopens it (~10ms).
 *   - Leases are taken in exactly ONE place: the tool-registration wrapper in
 *     index.ts, which brackets every registered tool handler. Individual tools do
 *     not acquire leases, and must not need to.
 *   - Concurrent callers that find the handle closed share a single open. Two
 *     independent opens in one process would collide on the file lock and report
 *     contention against ourselves.
 *
 * Configuration via environment variables:
 *   DUCKDB_MEMORY_LIMIT    - Memory limit (default: 75% of system RAM, floor 1GB)
 *   DUCKDB_THREADS         - Number of threads (default: 2 — higher counts cause driver flakiness)
 *   DUCKDB_LOCK_RECOVERY   - Opt in to force-killing a LIVE lock-holding tradeblocks-mcp
 *                            (default: false — orphaned holders are still terminated).
 *                            Set to "true" only to clear a genuinely wedged holder.
 *   DUCKDB_LOCK_RECOVERY_TIMEOUT_MS - Wait time for SIGTERM (default: 1500)
 *   DUCKDB_OPEN_WAIT_MS    - Total budget for waiting out a concurrent server's startup
 *                            before giving up on opening at all (default: 15000)
 *   DUCKDB_IDLE_RELEASE_MS - Grace after the last lease drops before the handle is
 *                            closed and the file freed (default: 3000). 0 releases
 *                            immediately; a large value re-creates the cross-server
 *                            write block this exists to remove.
 *   DUCKDB_WRITE_LOCK_RETRIES - One-second attempts to acquire the write lock before
 *                            giving up (default: 10). Must outlast another server's
 *                            DUCKDB_IDLE_RELEASE_MS.
 *   MARKET_DB_PATH         - Path to market.duckdb (overrides default, overridden by --market-db)
 *   TRADEBLOCKS_DUCKDB_MEMORY_LIMIT - Resource cap for the parquet market connection
 *                            (openMarketParquetConnection); unset = DuckDB native default
 *   TRADEBLOCKS_DUCKDB_THREADS      - Thread cap for the parquet market connection
 *                            (openMarketParquetConnection); unset = DuckDB native default
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
//
// Lease + idle-release state (#445). The analytics file is exclusive to one
// read-write holder and shared by any number of readers, but a READER also blocks
// a writer (see the lock matrix in the header). So a server that parks a read-only
// connection for its whole lifetime blocks every write in every other server on the
// same data directory — including when it is doing nothing at all. The handle is
// therefore leased: held while work is in flight, released shortly after the last
// lease drops.
let leaseCount = 0;
let idleTimer: NodeJS.Timeout | null = null;
// Concurrent acquirers must share ONE open. Without this, two tool handlers that
// both find the connection closed would each open it, and the second would fail
// against the first's lock — manufacturing the very contention this fixes.
let openInFlight: Promise<DuckDBConnection> | null = null;
// A close yields (CHECKPOINT, DETACH) while `connection` is still non-null, so a
// caller arriving mid-teardown would otherwise be handed a handle that is about to
// be torn down under it. Callers wait for this instead and then open fresh.
let closeInFlight: Promise<void> | null = null;
let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;
let connectionMode: "read_write" | "read_only" | null = null;
let storedDbPath: string | null = null;
let storedThreads: string | null = null;
let storedMemoryLimit: string | null = null;
let storedMarketDbPath: string | null = null;
const execFileAsync = promisify(execFile);
// Exported so other lock-recovery-adjacent callers (e.g. the stdio
// parent-death watchdog in index.ts) can branch on platform without
// re-deriving it.
export const isWindows = process.platform === "win32";

/**
 * Default DuckDB memory limit when `DUCKDB_MEMORY_LIMIT` is unset.
 *
 * Scales to 75% of total system RAM — DuckDB's own native default is 80%; we
 * keep a small headroom for Node's heap, the OS, and other processes. Floored
 * at 1GB so very small VMs / CI containers still work; no upper cap. Returns
 * a DuckDB-compatible string like "90GB".
 */
function defaultMemoryLimit(): string {
  const totalGB = os.totalmem() / 1024 ** 3;
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

// Exported so other lock-recovery-adjacent callers (e.g. the stdio
// parent-death watchdog in index.ts) can reuse this instead of reimplementing
// a `process.kill(pid, 0)` liveness probe.
export function isProcessAlive(pid: number): boolean {
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
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "ParentProcessId",
        "/value",
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
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "CommandLine",
        "/value",
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
  forceRecovery: boolean,
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
  const targetsSameDb =
    normalizedCommand.includes(normalizedDbPath) || normalizedCommand.includes(normalizedDbDir);

  if (!isTradeblocksProcess || !targetsSameDb) {
    return false;
  }

  // Check if the lock holder is orphaned (parent session is gone).
  // Unix: orphaned processes get reparented to PID 1 (init/launchd).
  // Windows: child keeps original PPID even after parent dies — check if parent is still alive.
  // Only kill non-orphaned processes if forceRecovery is explicitly enabled.
  const ppid = await getProcessParentPid(lockHolderPid);
  const orphaned = isWindows ? ppid !== null && !isProcessAlive(ppid) : ppid === 1;
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
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500,
  );

  if (exited) {
    console.error(
      `Recovered DuckDB lock at ${dbPath} by stopping ${reason} tradeblocks-mcp process PID ${lockHolderPid}.`,
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
  mode: "read_write" | "read_only",
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
      try {
        await fs.unlink(marketDbPath);
      } catch {
        /* file may not exist */
      }
      // Also try removing WAL file
      try {
        await fs.unlink(marketDbPath + ".wal");
      } catch {
        /* ignore */
      }
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
  memoryLimit: string,
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
    console.warn(
      "[json-migration] Migration failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  connectionMode = "read_write";

  return connection;
}

async function openReadOnlyConnection(
  dbPath: string,
  threads: string,
  memoryLimit: string,
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
  cancelIdleRelease();
  if (connection) {
    try {
      connection.closeSync();
    } catch {
      /* non-fatal */
    }
  }
  connection = null;
  if (instance) {
    try {
      instance.closeSync();
    } catch {
      /* non-fatal */
    }
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
 * When another server already holds the file, this waits that server out and then
 * opens READ_ONLY rather than terminating it — see openWithLockContention.
 *
 * @param dataDir - Directory where analytics.duckdb will be stored
 * @returns Promise<DuckDBConnection> - The DuckDB connection
 * @throws Error if database is corrupted, or if no open of any mode succeeds
 *   within DUCKDB_OPEN_WAIT_MS
 */
export async function getConnection(dataDir: string): Promise<DuckDBConnection> {
  // Never hand out a handle that is being torn down. A close yields part-way
  // through while `connection` is still set, and a tool call arriving in that
  // window would take the handle and then have it closed underneath it.
  if (closeInFlight) {
    await closeInFlight;
  }

  // Return existing connection if available (singleton pattern)
  if (connection) {
    return connection;
  }

  // Share a single open across concurrent callers. Two callers that both find the
  // connection released would otherwise race, and the loser would report a lock
  // conflict against its own process's other open.
  if (openInFlight) {
    return openInFlight;
  }

  openInFlight = openConnectionUnshared(dataDir)
    .then((conn) => {
      // Covers the startup open, which belongs to no tool call and would otherwise
      // sit on the file forever — the whole point of #445.
      if (leaseCount === 0) scheduleIdleRelease();
      return conn;
    })
    .finally(() => {
      openInFlight = null;
    });
  return openInFlight;
}

async function openConnectionUnshared(dataDir: string): Promise<DuckDBConnection> {
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
  // Terminating a LIVE lock holder is opt-in only. A live holder is almost always
  // another working server for the same data directory — clients such as Claude
  // Desktop run more than one copy — and killing it makes each restart kill the
  // survivor in turn. Orphaned holders (PPID=1) are still terminated without the
  // opt-in. See tryRecoverLockByTerminatingStaleProcess.
  const forceRecovery = (process.env.DUCKDB_LOCK_RECOVERY ?? "false") === "true";

  try {
    return await openWithLockContention(dbPath, dataDir, threads, memoryLimit, forceRecovery);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

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
          `Original error: ${errorMessage}`,
      );
    }

    throw new Error(`Failed to initialize DuckDB at ${dbPath}: ${errorMessage}`);
  }
}

/**
 * Open the analytics database at startup, coexisting with any other server that
 * holds the file.
 *
 * Startup wants the write lock so it can build schemas, but that lock excludes
 * every other server — readers included. A second server booting a moment later
 * must therefore not treat the conflict as a fault to be cleared by force. The
 * loop below encodes the measured lock matrix (see the file header):
 *
 *   1. Try read-write. Winning means we own the init; downgrade to read-only so
 *      other servers can open, and return.
 *   2. If read-write is locked, try READ-ONLY. Succeeding means the holder is
 *      itself read-only and has already run the identical, idempotent init —
 *      there is nothing for us to build, so we join as a reader. This is the
 *      normal outcome for the second of two concurrently booting servers.
 *   3. If read-only is locked too, someone is mid-init. Terminate the holder only
 *      if it is an orphan (or force mode is opted in), then sleep and retry.
 *
 * Init is never lost by taking the read-only path: the first write operation calls
 * upgradeToReadWrite, which runs the full schema-ensure path before writing.
 *
 * Throws only when the whole budget elapses without any successful open.
 */
/** Cap on immediate post-termination retries. See the fast path in the loop below. */
const MAX_TERMINATIONS = 4;

async function openWithLockContention(
  dbPath: string,
  dataDir: string,
  threads: string,
  memoryLimit: string,
  forceRecovery: boolean,
): Promise<DuckDBConnection> {
  const budgetMs = Number.parseInt(process.env.DUCKDB_OPEN_WAIT_MS || "15000", 10);
  const deadline = Date.now() + (Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 15000);
  let announcedWait = false;
  let lastLockError = "";
  let attempt = 0;
  let terminations = 0;

  for (;;) {
    // ── Step 1: read-write, so we can build schemas ──
    try {
      await openReadWriteConnection(dbPath, threads, memoryLimit);
      // Release write lock after initialization — idle state is read-only, which
      // is what lets other servers open the same file at all.
      await downgradeToReadOnly(dataDir);
      return connection!; // downgradeToReadOnly reopened as RO
    } catch (rwError) {
      const rwMessage = rwError instanceof Error ? rwError.message : String(rwError);
      if (!isLockError(rwMessage)) throw rwError;
      lastLockError = rwMessage;
      resetConnectionState();
    }

    // ── Step 2: read-only, joining a holder that has already run the init ──
    try {
      await openReadOnlyConnection(dbPath, threads, memoryLimit);
      console.error(
        `Another tradeblocks-mcp server holds ${dbPath}; opened READ_ONLY and skipped ` +
          `schema init (the holder runs the same init). Writes will acquire the lock on demand.`,
      );
      return connection!;
    } catch (roError) {
      const roMessage = roError instanceof Error ? roError.message : String(roError);
      if (!isLockError(roMessage)) throw roError;
      resetConnectionState();
    }

    // ── Step 3: a read-write holder is mid-init. Clear it only if abandoned. ──
    // Re-read the holder from the CURRENT error every pass: with more than one
    // contending process, the PID named in the first error is not the PID that
    // holds the lock after that one exits.
    //
    // We deliberately pass the READ-WRITE failure's message, not the read-only
    // one. Both name the same process — a read-write holder is what blocks both
    // modes — so the PID is identical, and the read-write message is the one whose
    // holder we have re-read this pass. Do not "fix" this by passing the read-only
    // message: on the pass after a kill, the read-only attempt can fail against a
    // DIFFERENT contender, and terminating that one out of turn is how the old
    // single-shot recovery failed to converge.
    // Bounded on purpose, and the bound is on TERMINATIONS, not on retries. An
    // unbounded "kill, retry, kill" is the exact shape of the loop this change
    // exists to remove: a client that restarts the server we just terminated keeps
    // handing us a fresh holder, and we keep killing it. Capping only the immediate
    // retry does not fix that — the slow path would go on killing, once per sleep,
    // until the deadline. So once the cap is reached we stop terminating entirely
    // and wait out the remaining budget like any other contended open. Four covers
    // the observed multi-contender case (three processes) with headroom.
    if (terminations < MAX_TERMINATIONS) {
      const terminated = await tryRecoverLockByTerminatingStaleProcess(
        lastLockError,
        dbPath,
        forceRecovery,
      );

      // A confirmed kill means the path may be clear right now, so retry
      // immediately rather than spending the remaining budget on a sleep, and do
      // not fail on a deadline we crossed while doing the killing.
      if (terminated) {
        terminations += 1;
        attempt = 0;
        continue;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(lastLockError);
    }

    if (!announcedWait) {
      announcedWait = true;
      console.error(
        `Waiting for another tradeblocks-mcp server to finish opening ${dbPath} ` +
          `(up to ${Math.round((deadline - Date.now()) / 1000)}s). Set DUCKDB_LOCK_RECOVERY=true ` +
          `to terminate a wedged holder instead.`,
      );
    }

    // Backoff, capped, and never past the deadline.
    const delayMs = Math.min(250 * 2 ** attempt, 2000);
    attempt += 1;
    await new Promise((r) => setTimeout(r, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Default idle grace before a released handle is closed.
 *
 * Short on purpose. A writer in another server can only proceed once every reader
 * has let go, so a long grace re-creates the block this exists to remove. Reopening
 * costs about 10ms (measured: instance create plus market ATTACH against a 6MB
 * analytics file), which is noise next to any real tool call, so there is little to
 * buy by holding on longer.
 */
const DEFAULT_IDLE_RELEASE_MS = 3000;

function idleReleaseMs(): number {
  const raw = Number.parseInt(process.env.DUCKDB_IDLE_RELEASE_MS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_RELEASE_MS;
}

function cancelIdleRelease(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleRelease(): void {
  cancelIdleRelease();
  if (leaseCount > 0) return;
  const delay = idleReleaseMs();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Re-check under the timer: a lease taken between scheduling and firing must
    // win, or we would close the file out from under live work.
    if (leaseCount > 0) return;
    // Nothing awaits this — it runs on a timer with no caller to return an error
    // to. An unhandled rejection here would take the whole server down over a
    // failed close, so swallow it loudly instead. The next getConnection reopens
    // regardless, and a stuck handle degrades to the pre-#445 behaviour rather
    // than to a crash.
    closeConnection({ abortIfLeased: true }).catch((error: unknown) => {
      console.error(
        `Failed to release the idle DuckDB handle: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, delay);
  // Never let the release timer hold the process open.
  idleTimer.unref?.();
}

/**
 * Take a lease on the analytics handle for the duration of a unit of work.
 *
 * While any lease is held the handle stays open, so a caller can hold a connection
 * reference across awaits without it being closed underneath. Every acquire MUST be
 * paired with a release in a `finally` — the tool-registration wrapper in index.ts
 * does this once for every tool, which is why individual tool handlers do not.
 */
export function acquireConnectionLease(): void {
  leaseCount += 1;
  cancelIdleRelease();
}

/**
 * Release a lease. When the last one drops, the handle is closed after the idle
 * grace, freeing the file for a writer in any other server.
 */
export function releaseConnectionLease(): void {
  if (leaseCount === 0) return;
  leaseCount -= 1;
  if (leaseCount === 0) {
    scheduleIdleRelease();
  }
}

/** Live lease count. Diagnostics and tests. */
export function getConnectionLeaseCount(): number {
  return leaseCount;
}

/**
 * Run `work` holding a lease, releasing it even if `work` throws.
 *
 * Prefer this over the bare acquire/release pair anywhere a lease is taken by hand.
 */
export async function withConnectionLease<T>(work: () => Promise<T>): Promise<T> {
  acquireConnectionLease();
  try {
    return await work();
  } finally {
    releaseConnectionLease();
  }
}

/**
 * Close the DuckDB connection and release resources.
 *
 * DETACHes market.duckdb before closing to ensure WAL is checkpointed cleanly.
 * Should be called during graceful shutdown (SIGINT, SIGTERM).
 * Safe to call multiple times or when no connection exists.
 */
export async function closeConnection(options?: { abortIfLeased?: boolean }): Promise<void> {
  if (closeInFlight) {
    return closeInFlight;
  }
  closeInFlight = closeConnectionUnshared(options).finally(() => {
    closeInFlight = null;
  });
  return closeInFlight;
}

/**
 * @param options.abortIfLeased - Give up the close if a lease is taken while we are
 *   checkpointing. ONLY the idle release passes this. A deliberate close must never
 *   abort on a lease: upgradeToReadWrite closes and reopens from inside a leased
 *   tool handler, so an unconditional abort would break every write path.
 */
async function closeConnectionUnshared(options?: { abortIfLeased?: boolean }): Promise<void> {
  const abortIfLeased = options?.abortIfLeased === true;
  // Whether this is the idle release firing or a shutdown, no timer should outlive
  // the handle it was going to close.
  cancelIdleRelease();
  if (connection) {
    try {
      await connection.run("CHECKPOINT");
    } catch {
      /* non-fatal */
    }
    // CHECKPOINT is the one yield here that leaves the handle fully usable, so it is
    // the only point at which backing out is free. A lease taken during it means a
    // tool call has just been handed this handle; leave it open and let the next
    // release try again. Past this point the teardown is committed, and a caller
    // arriving late waits on closeInFlight rather than seeing a half-detached handle.
    if (abortIfLeased && leaseCount > 0) {
      return;
    }
    try {
      await detachMarketDb(connection);
    } catch {
      /* non-fatal, log debug */
    }
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
    try {
      instance.closeSync();
    } catch {
      /* non-fatal */
    }
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
  options?: { fallbackToReadOnly?: boolean },
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
  //
  // The budget must comfortably outlast another server's idle release (#445): a reader
  // there lets go of the file DEFAULT_IDLE_RELEASE_MS after its last activity, and a
  // writer that gives up sooner than that fails on a lock which was about to clear.
  // Overridable for a data directory shared by unusually busy servers.
  const configuredRetries = Number.parseInt(process.env.DUCKDB_WRITE_LOCK_RETRIES || "", 10);
  const maxRetries =
    Number.isFinite(configuredRetries) && configuredRetries >= 0 ? configuredRetries : 10;
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

  throw (
    lastError ||
    new Error(
      "Cannot acquire DuckDB write lock. Another tradeblocks-mcp server holds the " +
        "database — writes need exclusive access even when the holder is only reading, " +
        "and a reader keeps its handle for the life of the process. Going idle does not " +
        "release it: the other server has to exit.",
    )
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

export async function openMarketOnlyConnection(baseDir: string): Promise<MarketOnlyConnection> {
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
    try {
      await conn.run("CHECKPOINT market");
    } catch {
      /* non-fatal */
    }
    try {
      await detachMarketDb(conn);
    } catch {
      /* non-fatal */
    }
    try {
      conn.closeSync();
    } catch {
      /* non-fatal */
    }
    try {
      memoryInstance.closeSync();
    } catch {
      /* non-fatal */
    }
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
/**
 * Optional DuckDB resource bounds for a parquet market connection.
 *
 * Both fields are additive and OFF by default. When a field is omitted AND its
 * environment override is unset, that resource is left at DuckDB's native
 * default — i.e. today's behavior, unchanged. This is the backwards-compatible
 * contract: an existing caller that passes no options and sets no env var gets a
 * connection that is byte- and perf-identical to before this option existed.
 *
 * Per-field precedence: explicit option > environment variable > native default.
 *   - memoryLimit ← TRADEBLOCKS_DUCKDB_MEMORY_LIMIT
 *   - threads     ← TRADEBLOCKS_DUCKDB_THREADS
 *
 * When set, the bounds are applied via `SET memory_limit=...` / `SET threads=...`
 * immediately after the connection opens, before any consumer statement (schema
 * creation, view registration, or caller query) runs.
 */
export interface MarketConnectionOptions {
  /**
   * DuckDB `memory_limit` for the connection, e.g. "4GB", "512MB", "8GiB".
   * Accepts a number followed by a DuckDB memory unit (KB/MB/GB/TB decimal or
   * KiB/MiB/GiB/TiB binary). Malformed values throw before any connection is
   * opened — they never reach DuckDB as SQL.
   */
  memoryLimit?: string;
  /**
   * DuckDB `threads` for the connection, a positive integer. The analytics
   * connection defaults to 2 threads (see defaultThreads() above) because higher
   * thread counts trigger intermittent prepared-statement failures on long
   * reads. NOTE: this parquet path's UNSET default is DuckDB native (all
   * cores), not 2 — set this option (or the env var) to bound it. Non-integer
   * or non-positive values throw before any connection is opened.
   */
  threads?: number;
}

// DuckDB `SET memory_limit` accepts a number + a memory unit only: KB/MB/GB/TB
// (decimal, 1000^i) or KiB/MiB/GiB/TiB (binary, 1024^i). Note it rejects the
// `%` form here even though instance-creation config accepts it — so this
// pattern deliberately excludes `%`. Validating against this closed grammar is
// what makes the value safe to interpolate into the SET statement: a passing
// value cannot contain a quote or any other SQL metacharacter.
const DUCKDB_MEMORY_LIMIT_PATTERN = /^\d+(\.\d+)?(KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i;

function validateMemoryLimit(value: string): string {
  const trimmed = value.trim();
  if (!DUCKDB_MEMORY_LIMIT_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid DuckDB memory_limit ${JSON.stringify(value)}. ` +
        `Expected a number followed by a unit, e.g. "4GB", "512MB", or "8GiB" ` +
        `(units: KB, MB, GB, TB, KiB, MiB, GiB, TiB).`,
    );
  }
  return trimmed;
}

function validateThreads(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid DuckDB threads ${JSON.stringify(value)}. Expected a positive integer.`,
    );
  }
  return value;
}

/**
 * Resolve the effective resource bounds from an options object and the
 * environment, applying the explicit-option > env > native-default precedence
 * and validating both fields. Returns only the fields that are set; an unset
 * field means "leave DuckDB at its native default" (issue no SET for it).
 *
 * Validation happens here — before any DuckDBInstance is created — so malformed
 * input throws cleanly without leaking a native handle.
 */
function resolveResourceBounds(options?: MarketConnectionOptions): {
  memoryLimit?: string;
  threads?: number;
} {
  const resolved: { memoryLimit?: string; threads?: number } = {};

  const memoryLimitRaw = options?.memoryLimit ?? envValue("TRADEBLOCKS_DUCKDB_MEMORY_LIMIT");
  if (memoryLimitRaw !== undefined) {
    resolved.memoryLimit = validateMemoryLimit(memoryLimitRaw);
  }

  const threadsEnv = envValue("TRADEBLOCKS_DUCKDB_THREADS");
  const threadsRaw =
    options?.threads ?? (threadsEnv !== undefined ? Number(threadsEnv) : undefined);
  if (threadsRaw !== undefined) {
    resolved.threads = validateThreads(threadsRaw);
  }

  return resolved;
}

/** Read an env var, treating unset or all-whitespace as absent (matches the `|| default` idiom elsewhere in this module). */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/**
 * Apply already-resolved resource bounds to an open connection via runtime SET
 * statements. Interpolation is safe: memoryLimit has passed the closed-grammar
 * validator (no quote/metacharacter can survive) and threads is a validated
 * integer.
 */
async function applyResourceBounds(
  conn: DuckDBConnection,
  bounds: { memoryLimit?: string; threads?: number },
): Promise<void> {
  if (bounds.memoryLimit !== undefined) {
    await conn.run(`SET memory_limit='${bounds.memoryLimit}'`);
  }
  if (bounds.threads !== undefined) {
    await conn.run(`SET threads=${bounds.threads}`);
  }
}

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
  options?: MarketConnectionOptions,
): Promise<MarketParquetConnection> {
  // Resolve + validate resource bounds BEFORE allocating any native handle, so
  // malformed input (e.g. a bad memory_limit string) throws cleanly without
  // leaking a DuckDBInstance. Unset option + unset env = empty bounds = no SET
  // issued = DuckDB native defaults (the backwards-compatible path).
  const bounds = resolveResourceBounds(options);

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

  // Apply resource bounds first — before schema creation, view registration, or
  // any caller query — so every statement on this connection runs under the cap.
  await applyResourceBounds(conn, bounds);

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
    try {
      conn.closeSync();
    } catch {
      /* non-fatal */
    }
    try {
      memoryInstance.closeSync();
    } catch {
      /* non-fatal */
    }
  };

  return { conn, dataRoot, close };
}

/**
 * Read-side name for {@link openMarketParquetConnection}. Retained as the
 * canonical handle for read-only parquet consumers; the underlying connection
 * is identical (parquet has no read/write distinction once the shared market
 * database file is out of the picture). Accepts the same optional resource
 * bounds ({@link MarketConnectionOptions}), forwarded verbatim.
 */
export type MarketReadOnlyConnection = MarketParquetConnection;

export function openMarketReadOnlyConnection(
  baseDir: string,
  options?: MarketConnectionOptions,
): Promise<MarketReadOnlyConnection> {
  return openMarketParquetConnection(baseDir, options);
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
      "No active DuckDB connection. The handle is released when idle (#445), so a " +
        "store context must only be used inside a leased unit of work — the tool " +
        "wrapper in index.ts takes that lease for every registered tool. Code " +
        "reaching here runs outside any lease: wrap it in withConnectionLease().",
    );
  }
  return connection;
}

// Note: the legacy intraday write-target getter / module-state variable and
// the consumer override hook have been removed. Every spot write now flows
// through SpotStore.writeBars (the canonical Hive-partitioned
// `spot/ticker=X/date=Y/` layout); there is no longer a per-process override
// of the write target.
