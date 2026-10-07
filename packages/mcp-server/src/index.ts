/**
 * TradeBlocks MCP Server
 *
 * Provides options trading analysis capabilities via Model Context Protocol.
 * Exposes portfolio statistics, strategy comparisons, and trade data
 * to Claude Desktop, Cowork, and other MCP clients.
 *
 * CLI Commands: install-skills, uninstall-skills, and check-skills print
 * the tradeblocks-skills plugin installation instructions and exit.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { registerBlockTools } from "./tools/blocks.ts";
import { registerAnalysisTools } from "./tools/analysis.ts";
import { registerPerformanceTools } from "./tools/performance.ts";
import { registerReportTools } from "./tools/reports.ts";
import { registerImportTools } from "./tools/imports.ts";
import { registerMarketDataTools } from "./tools/market-data.ts";
import { registerMarketImportTools } from "./tools/market-imports.ts";
import { registerMarketEnrichmentTools } from "./tools/market-enrichment.ts";
import { registerSQLTools } from "./tools/sql.ts";
import { registerSchemaTools } from "./tools/schema.ts";
import { registerEdgeDecayTools } from "./tools/edge-decay.ts";
import { registerGuideTools } from "./tools/guides.ts";
import { registerProfileTools } from "./tools/profiles.ts";
import { registerProfileAnalysisTools } from "./tools/profile-analysis.ts";
import { registerRegimeAdvisorTools } from "./tools/regime-advisor.ts";
import { registerReplayTools } from "./tools/replay.ts";
import { registerSnapshotTools } from "./tools/snapshot.ts";
import { registerExitAnalysisTools } from "./tools/exit-analysis.ts";
import { registerBatchExitAnalysisTools } from "./tools/batch-exit-analysis.ts";
import { registerGreeksAttributionTools } from "./tools/greeks-attribution.ts";
import { registerMarketFetchTools } from "./tools/market-fetch.ts";
import { registerTickerTools } from "./tools/tickers.ts";
import { loadRegistry } from "./market/tickers/loader.ts";
import { closeConnection, getConnection, getCurrentConnection } from "./db/index.ts";
import { isProcessAlive, isWindows } from "./db/connection.ts";
import { setDataRoot } from "./db/data-root.ts";
import { createMarketStores } from "./market/stores/index.ts";
import { loadPublishedRates } from "./market/published-rates.ts";
import type { StoreContext, MarketStores } from "./market/stores/index.ts";
import type { TradeBlocksPlugin, TradeBlocksPluginContext } from "./plugins.ts";
import { shouldShutdownOnParentChange } from "./parent-watchdog.ts";
import { leaseToolHandlers } from "./tools/middleware/connection-lease.ts";
import { refuseUnknownArguments } from "./tools/middleware/strict-arguments.ts";
import { registerWorkflowPrompts } from "./prompts.ts";
import { runSetup } from "./setup.ts";

// How often the stdio parent-death watchdog polls process.ppid. See the
// watchdog install site in startTradeBlocksMcp() below.
const PARENT_WATCHDOG_INTERVAL_MS = 2000;

// src/ and the published server/ bundle are siblings of the installed manifest.
const packageManifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  !packageManifest ||
  typeof packageManifest !== "object" ||
  !("version" in packageManifest) ||
  typeof packageManifest.version !== "string"
) {
  throw new Error("tradeblocks-mcp package manifest has no version");
}
const packageVersion = packageManifest.version;

const serverInstructions =
  "TradeBlocks analyzes options trades and portfolios as blocks: use it to inspect realized performance, test robustness and stress risk after a backtest or trade log exists. Option Omega (OO) runs and iterates strategies in its own MCP server; TradeBlocks never calls OO. Bring OO's resulting trades in as a block via the tradeblocks-skills capture in Claude Code when installed, or a CSV export at a path this TradeBlocks server can read followed by import_csv. Do not copy trade logs through the model. OO's marked-account headline figures and TradeBlocks' trade-realized statistics are distinct; never present trade-realized drawdown as OO's marked drawdown or subtract fees twice from OO net profit. Call list_blocks first to discover block IDs; other block tools use those IDs. Before run_sql, call describe_database for schema and block_ids, then filter trades by block_id.";

export interface StartTradeBlocksMcpOptions {
  plugins?: TradeBlocksPlugin[];
}

// CLI usage help
function printUsage(): void {
  console.log(`TradeBlocks MCP Server

Usage: tradeblocks-mcp [options] <backtests-folder>
       tradeblocks-mcp <command> [command-options]

MCP Server Modes:
  tradeblocks-mcp <folder>                    stdio transport (Claude Desktop, Codex CLI)
  tradeblocks-mcp --http <folder>             HTTP transport on port 3100
  tradeblocks-mcp --http --port 8080 <folder> HTTP transport on custom port

Options:
  --http             Start HTTP server instead of stdio (for web platforms)
  --port <number>    HTTP server port (default: 3100, requires --http)
  --blocks-dir <path> Directory containing CSV block folders (default: same as <folder>)
  --data-root <path> Root directory for shared data (market/, market-meta/, strategies/, blocks/).
                     Default: same as <folder>. Use when DuckDB is local but data is shared (e.g. Syncthing).
  --market-db <path> Path to market.duckdb (default: <folder>/market.duckdb)
  --no-auth          Disable authentication (only use behind an auth proxy)

Environment:
  BLOCKS_DIRECTORY    Default backtests folder if not specified
  TRADEBLOCKS_BLOCKS_DIR  Directory for CSV block folders (overrides default, overridden by --blocks-dir)
  TRADEBLOCKS_DATA_ROOT   Root directory for shared data (overrides default, overridden by --data-root)
  MARKET_DB_PATH      Path to market.duckdb (overrides default, overridden by --market-db)

Commands:
  setup            Guided local client setup; --client, --folder, --yes, --replace, --json
  install-skills    Show plugin installation instructions
  uninstall-skills  Show plugin installation instructions
  check-skills      Show plugin installation instructions

Examples:
  tradeblocks-mcp ~/backtests
  tradeblocks-mcp --http ~/backtests
  tradeblocks-mcp --http --port 8080 ~/Trading/backtests
  tradeblocks-mcp install-skills
`);
}

// Parse CLI arguments for MCP server mode
function parseServerArgs(): {
  http: boolean;
  port: number;
  noAuth: boolean;
  directory: string | undefined;
  blocksDir: string | undefined;
  dataRoot: string | undefined;
  marketDb: string | undefined;
} {
  const args = process.argv.slice(2);
  let http = false;
  let port = 3100;
  let noAuth = false;
  let directory: string | undefined;
  let blocksDir: string | undefined;
  let dataRoot: string | undefined;
  let marketDb: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--http") {
      http = true;
    } else if (arg === "--port" && args[i + 1]) {
      const parsedPort = parseInt(args[i + 1], 10);
      if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
        port = parsedPort;
      }
      i++; // Skip next arg (the port value)
    } else if (arg === "--blocks-dir" && args[i + 1]) {
      blocksDir = args[i + 1];
      i++; // Skip next arg (the path value)
    } else if (arg === "--data-root" && args[i + 1]) {
      dataRoot = args[i + 1];
      i++; // Skip next arg (the path value)
    } else if (arg === "--market-db" && args[i + 1]) {
      marketDb = args[i + 1];
      i++; // Skip next arg (the path value)
    } else if (arg === "--no-auth") {
      noAuth = true;
    } else if (!arg.startsWith("-") && !arg.startsWith("--")) {
      // Non-flag argument is the directory
      directory = arg;
    }
  }

  // Also check environment variables
  if (!directory) {
    directory = process.env.BLOCKS_DIRECTORY;
  }
  if (!blocksDir) {
    blocksDir = process.env.TRADEBLOCKS_BLOCKS_DIR;
  }
  if (!dataRoot) {
    dataRoot = process.env.TRADEBLOCKS_DATA_ROOT;
  }
  if (!marketDb) {
    marketDb = process.env.MARKET_DB_PATH;
  }

  return { http, port, noAuth, directory, blocksDir, dataRoot, marketDb };
}

// Handle skill CLI commands (deprecated — now use plugin)
async function handleSkillCommand(command: string): Promise<void> {
  console.log("Skills have moved to a standalone plugin:");
  console.log("  https://github.com/tradeblocks-org/tradeblocks-skills");
  console.log("");
  console.log("Install via Claude Code:");
  console.log("  /plugin marketplace add tradeblocks-org/tradeblocks-skills");
  console.log("  /plugin install tradeblocks@tradeblocks-skills");

  switch (command) {
    case "install-skills":
    case "uninstall-skills":
    case "check-skills": {
      process.exit(0);
    }

    default:
      printUsage();
      process.exit(1);
  }
}

export function registerTradeBlocksCoreTools(
  server: McpServer,
  context: TradeBlocksPluginContext,
): void {
  const { baseDir, marketStores, tickerRegistry } = context;

  registerBlockTools(server, baseDir);
  registerAnalysisTools(server, baseDir);
  registerPerformanceTools(server, baseDir);
  registerReportTools(server, baseDir);
  registerImportTools(server, baseDir);
  registerMarketImportTools(server, baseDir, marketStores);
  registerMarketEnrichmentTools(server, baseDir, marketStores);
  registerMarketDataTools(server, baseDir, marketStores);
  registerSQLTools(server, baseDir);
  registerSchemaTools(server, baseDir);
  registerEdgeDecayTools(server, baseDir);
  registerGuideTools(server);
  registerProfileTools(server, baseDir);
  registerTickerTools(server, tickerRegistry, baseDir);
  registerProfileAnalysisTools(server, baseDir);
  registerRegimeAdvisorTools(server, baseDir);
  registerReplayTools(server, baseDir, marketStores);
  registerSnapshotTools(server);
  registerExitAnalysisTools(server, baseDir, marketStores);
  registerBatchExitAnalysisTools(server, baseDir, marketStores);
  registerGreeksAttributionTools(server, baseDir, marketStores);
  registerMarketFetchTools(server, baseDir, marketStores);
}

// Main entry point - handles both skill CLI commands and MCP server mode
export async function startTradeBlocksMcp(options: StartTradeBlocksMcpOptions = {}): Promise<void> {
  const plugins = options.plugins ?? [];
  const command = process.argv[2];

  if (command === "setup") {
    process.exitCode = await runSetup(process.argv.slice(3));
    return;
  }

  // Handle skill commands (exit after handling)
  if (
    command === "install-skills" ||
    command === "uninstall-skills" ||
    command === "check-skills"
  ) {
    await handleSkillCommand(command);
    return; // handleSkillCommand calls process.exit, but return for safety
  }

  // Handle help flag
  if (command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  // MCP Server mode - parse arguments
  const { http, port, noAuth, directory: backtestDir, blocksDir, dataRoot } = parseServerArgs();

  if (!backtestDir) {
    printUsage();
    process.exit(1);
  }

  const resolvedDir = path.resolve(backtestDir);

  // Verify directory exists
  try {
    await fs.access(resolvedDir);
  } catch {
    console.error(`Error: Directory does not exist: ${resolvedDir}`);
    process.exit(1);
  }

  // Configure separate data root directory if specified
  if (dataRoot) {
    const resolvedDataRoot = path.resolve(dataRoot);
    try {
      await fs.access(resolvedDataRoot);
    } catch {
      console.error(`Error: Data root directory does not exist: ${resolvedDataRoot}`);
      process.exit(1);
    }
    setDataRoot(resolvedDataRoot);
  }

  // Configure separate blocks directory if specified
  if (blocksDir) {
    const resolvedBlocksDir = path.resolve(blocksDir);
    try {
      await fs.access(resolvedBlocksDir);
    } catch {
      console.error(`Error: Blocks directory does not exist: ${resolvedBlocksDir}`);
      process.exit(1);
    }
    const { setBlocksDir } = await import("./sync/index.ts");
    setBlocksDir(resolvedBlocksDir);
  }

  // Ticker registry singleton (Market Data 3.0 — Plan 01-05).
  // Pitfall 5 / T-1-07 mitigation: ONE TickerRegistry instance per MCP process.
  // The SAME reference is passed to registerTickerTools(server, ...) below AND
  // (Phase 2) to StoreContext.tickers inside createMarketStores. Constructing
  // it once here — never inside createServer — keeps state coherent across the
  // HTTP transport's stateless per-request server instances.
  const tickerRegistry = await loadRegistry({ dataDir: resolvedDir });

  // ============================================================================
  // Market Data 3.0 — Phase 2 (Plan 02-05): StoreContext + createMarketStores
  //
  // D-03: construct ONE StoreContext per MCP process and call the factory once.
  // `parquetMode` is snapshotted at startup (Pitfall 8) — downstream stores
  // never re-read `process.env.TRADEBLOCKS_PARQUET`. `conn` is the shared
  // singleton DuckDB connection (idempotent to call getConnection here: first
  // call wires schemas/views, subsequent getConnection() calls from tool
  // handlers return the same instance).
  //
  // `marketStores` is held in process scope but NOT yet threaded into tool
  // registrations — that is Phase 4's CONSUMER-01 scope (reordered on
  // 2026-04-17 from Phase 3 — see ROADMAP.md). The `void` line below
  // suppresses the unused-variable warning until then.
  // ============================================================================
  await loadPublishedRates(resolvedDir);
  await getConnection(resolvedDir);
  const parquetMode = process.env.TRADEBLOCKS_PARQUET === "true";
  // `conn` is a getter that resolves the *current* connection on every access.
  // Required because upgradeToReadWrite / downgradeToReadOnly close-and-reopen
  // the module-level handle — a captured reference would go stale the moment a
  // tool upgrades for a write, surfacing as "connection disconnected".
  const storeContext: StoreContext = {
    get conn() {
      return getCurrentConnection();
    },
    dataDir: resolvedDir,
    parquetMode,
    tickers: tickerRegistry,
  };
  const marketStores: MarketStores = createMarketStores(storeContext);
  const pluginContext: TradeBlocksPluginContext = {
    baseDir: resolvedDir,
    marketStores,
    tickerRegistry,
    parquetMode,
    getCurrentConnection,
  };

  // stdio transport reserves stdout for the MCP JSON protocol — anything else
  // on stdout (even diagnostics) makes the client throw "not valid JSON".
  // Diagnostic output must go to stderr.
  console.error(`[market-stores] Constructed: ${parquetMode ? "parquet" : "duckdb"} backend`);

  // Factory function to create configured MCP server instances
  // Used by HTTP transport which needs fresh instances per request (stateless mode)
  const createServer = (): McpServer => {
    const server = new McpServer(
      { name: "tradeblocks-mcp", version: packageVersion },
      {
        capabilities: { tools: {} },
        instructions: serverInstructions,
      },
    );
    // Bracket every tool call in a connection lease (#445) and refuse undeclared
    // arguments (enterprise#4197), before anything registers, so core tools and
    // plugin tools are both covered without a per-tool opt-in. See
    // tools/middleware/connection-lease.ts and tools/middleware/strict-arguments.ts.
    const leasedServer = leaseToolHandlers(refuseUnknownArguments(server));
    registerTradeBlocksCoreTools(leasedServer, pluginContext);
    registerWorkflowPrompts(server);
    for (const plugin of plugins) {
      plugin.registerTools?.(leasedServer, pluginContext);
    }
    return server;
  };

  // Graceful shutdown for DuckDB connection
  // The connection is lazily initialized, so this only does work if a tool
  // actually opened the database during this session
  const shutdown = async () => {
    await closeConnection();
    process.exit(0);
  };

  if (http) {
    // Load auth config for HTTP mode
    const { loadAuthConfig } = await import("./auth/config.ts");
    let auth;
    try {
      auth = loadAuthConfig({ noAuth });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }

    const { startHttpServer } = await import("./http-server.ts");
    await startHttpServer(createServer, { port, auth });
  } else {
    // Stdio transport for Claude Desktop, Codex CLI, etc.
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`TradeBlocks MCP ready (stdio). Watching: ${resolvedDir}`);

    // The MCP SDK's StdioServerTransport doesn't listen for stdin close/end.
    // When the parent process (Claude Code) crashes or is force-quit, stdin EOF's
    // but this process lingers — holding the DuckDB write lock indefinitely.
    // Exit cleanly on stdin close so the lock is released.
    process.stdin.on("end", async () => {
      await closeConnection();
      process.exit(0);
    });

    // Proactive parent-death watchdog — defense in depth alongside the
    // stdin/SIGTERM/SIGINT handlers above.
    //
    // Some launchers (e.g. `npx tradeblocks-mcp ...`) sit between the real
    // client and this process: client -> launcher -> node (this process). If
    // the launcher is killed without cleanly propagating a signal to us, we
    // are orphaned (reparented on Unix) and NEITHER handler above fires: no
    // SIGTERM/SIGINT ever arrives (only the launcher got it, if anything
    // did), and stdin never EOFs because the client — not the launcher —
    // holds the pipe's write-end. Left alone we'd linger holding the DuckDB
    // analytics database's write lock, and the next session's connection
    // attempt would fail with a stale-lock error.
    //
    // See shouldShutdownOnParentChange for the cross-platform decision logic.
    const startupPpid = process.ppid;
    const startAlreadyOrphaned = !isWindows && startupPpid === 1;
    if (!startAlreadyOrphaned) {
      // Skip installing entirely when we start already orphaned (Unix PPID 1,
      // e.g. launched under systemd) — there is no launcher to watch, and a
      // systemd-launched process must never self-terminate on that basis.
      const watchdog = setInterval(() => {
        const shutdownNeeded = shouldShutdownOnParentChange({
          isWindows,
          startupPpid,
          currentPpid: process.ppid,
          // Windows PPID doesn't change when the parent dies, so liveness of
          // the ORIGINAL parent is the only usable signal there. Skip the
          // liveness probe on Unix, where it's unused by the decision fn.
          startupParentAlive: isWindows ? isProcessAlive(startupPpid) : true,
        });
        if (shutdownNeeded) {
          clearInterval(watchdog);
          void shutdown();
        }
      }, PARENT_WATCHDOG_INTERVAL_MS);
      // Never let the watchdog's own timer keep the process alive.
      watchdog.unref();
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Resolve the entrypoint path to the actual file that was executed
// Needed in case command is executed via symlink, often used by node version managers.
async function resolveEntrypointPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function isDirectEntrypoint(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const entrypoint = await resolveEntrypointPath(process.argv[1]);
  const currentFile = await resolveEntrypointPath(fileURLToPath(import.meta.url));

  return entrypoint === currentFile;
}

if (await isDirectEntrypoint()) {
  startTradeBlocksMcp().catch((error) => {
    console.error("Error:", error.message || error);
    process.exit(1);
  });
}
