#!/usr/bin/env node
// tools/refresh-market-data.mjs
//
// Daily / backfill market data refresh driver. Calls
// MarketIngestor.refresh() in-process for one or more dates.
//
// Default mode: refresh yesterday's ET data (used by the systemd timer).
// Backfill mode: --from YYYY-MM-DD --to YYYY-MM-DD loops day-by-day.
//

import { pathToFileURL } from "url";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { access, readdir, stat } from "fs/promises";
import { spawnSync } from "child_process";
import os from "node:os";
import v8 from "node:v8";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SHA256_ADDRESS_RE = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// How far back `--missing` looks. Five sessions is a week of cover at roughly
// 26 min a session, which keeps a worst-case catch-up inside the nightly unit's
// TimeoutStartSec=3h. Widen it deliberately with --lookback when repairing a
// longer outage; the driver always prints the full list before it starts, so a
// long catch-up is visible rather than silently capped.
const MISSING_LOOKBACK_SESSIONS = 5;

// ── Heap auto-sizing (cross-platform self-respawn) ──────
// Node's default old-space cap is ~4 GB. Dense ThetaData chains push past
// that mid-run (issue #85, 2026-05-28 OOM at ~5.7 GB RSS). Rather than pin
// a Linux-only systemd-unit value, we self-detect and respawn with
// --max-old-space-size sized to 50% of host RAM (floored at Node's default
// so small hosts aren't reduced below stock).
//
// Linux 121 GB host → target ~60000 MB (respawn fires).
// 16 GB Mac        → target ~8000 MB (respawn fires).
// 4 GB host        → target == default (~4096), no respawn.
//
// Gated on direct-script invocation so the test suite's `await import(...)`
// of this module doesn't trigger a synchronous spawn and tear down jest.
// TRADEBLOCKS_REFRESH_HEAP_SIZED env sentinel prevents respawn loops.
function maybeRespawnWithLargerHeap() {
  if (process.env.TRADEBLOCKS_REFRESH_HEAP_SIZED) return; // child of an earlier respawn
  const currentLimitMb = Math.floor(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  const targetMb = Math.max(currentLimitMb, Math.floor((os.totalmem() / 1024 / 1024) * 0.5));
  if (targetMb <= currentLimitMb) return; // host too small for 50% rule to help
  const scriptPath = fileURLToPath(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${targetMb}`, scriptPath, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, TRADEBLOCKS_REFRESH_HEAP_SIZED: String(targetMb) },
    },
  );
  process.exit(result.status ?? 1);
}

// Same module-vs-script gate used at the bottom of the file for main(). Kept
// in a local const so we evaluate it once, here at the top, before anything
// allocates real working set.
const __INVOKED_AS_SCRIPT =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (__INVOKED_AS_SCRIPT) maybeRespawnWithLargerHeap();

// The updater builds MCP dist before this tool runs. Never rebuild during a read:
// stale or missing output is an operational failure, not permission to mutate code.
const DIST_ENTRYPOINT = resolve(REPO_ROOT, "packages/mcp-server/dist/test-exports.js");
const DIST_SOURCE_PATHS = [
  resolve(REPO_ROOT, "package.json"),
  resolve(REPO_ROOT, "package-lock.json"),
  resolve(REPO_ROOT, "tsconfig.json"),
  resolve(REPO_ROOT, "packages/mcp-server/package.json"),
  resolve(REPO_ROOT, "packages/mcp-server/tsconfig.json"),
  resolve(REPO_ROOT, "packages/mcp-server/src"),
  resolve(REPO_ROOT, "packages/mcp-server/tsup.config.ts"),
];

// ── CONFIG ─────────────────────────────────────────────
// Ticker lists come from env vars so operators can vary them without editing
// the script.
//
//   TRADEBLOCKS_SPOT_TICKERS       e.g. "SPX,QQQ,VIX,VIX3M,VIX9D"
//   TRADEBLOCKS_OPTION_UNDERLYINGS e.g. "SPX,QQQ"  (feeds both chain + quote)
//
// Both are REQUIRED for the env path — no defaults. Missing/empty input
// throws and the script exits with a clear message naming the variable.
//
// CLI overrides add targeted backfills without changing the env vars or a
// running scheduler:
//
//   --spot-tickers <csv>         overrides TRADEBLOCKS_SPOT_TICKERS
//   --option-underlyings <csv>   overrides TRADEBLOCKS_OPTION_UNDERLYINGS
//   --skip-spot                  resolve spot to [] (skip stage)
//   --skip-options               resolve options to [] (skip chain+quote)
//
// CLI wins over env per resolved list. When a stage is skipped (or its CLI
// flag supplies the value), the corresponding env var is not required.
// Use `--dry-run` to confirm the resolved config before invoking for real.
// ───────────────────────────────────────────────────────

// Distinguishes "operator config is missing or shape-invalid" from genuine
// runtime failures (DuckDB lock fails, provider IO errors, etc.). The script
// catches ConfigError once and prints a one-line "Error: <msg>" (exit 1),
// matching the mutex/no-op single-liners (exit 2). Anything that isn't a
// ConfigError still surfaces with a full stack so we don't swallow real bugs.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseList(envValue, varName) {
  if (envValue === undefined || envValue === null || envValue.trim() === "") {
    throw new ConfigError(`${varName} is required; see docs/operations/market-data-deployment.md`);
  }
  const seen = new Set();
  const out = [];
  for (const raw of envValue.split(",")) {
    const token = raw.trim().toUpperCase();
    if (token === "") continue;
    if (!/^[A-Z0-9]+$/.test(token)) {
      throw new ConfigError(
        `${varName} contains invalid token "${token}"; expected /^[A-Z0-9]+$/ (see docs/operations/market-data-deployment.md)`,
      );
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  if (out.length === 0) {
    throw new ConfigError(`${varName} is required; see docs/operations/market-data-deployment.md`);
  }
  return out;
}

// Resolve spot and option lists from CLI args + env. Pure helper; exported
// for unit tests. Returns { spot, options, sources } where each `sources`
// entry is "cli" | "env" | "skip" so the startup log can surface the source
// and the operator can see exactly what would run.
//
// Precedence per list: --skip-X > --X-... > env var.
// When a stage is skipped, the corresponding env var is NOT required.
export function resolveLists(args, env) {
  let spot;
  let spotSource;
  if (args.skipSpot) {
    spot = [];
    spotSource = "skip";
  } else if (args.spotTickersCli !== null) {
    spot = parseList(args.spotTickersCli, "--spot-tickers");
    spotSource = "cli";
  } else {
    spot = parseList(env.TRADEBLOCKS_SPOT_TICKERS, "TRADEBLOCKS_SPOT_TICKERS");
    spotSource = "env";
  }

  let options;
  let optionsSource;
  if (args.skipOptions) {
    options = [];
    optionsSource = "skip";
  } else if (args.optionUnderlyingsCli !== null) {
    options = parseList(args.optionUnderlyingsCli, "--option-underlyings");
    optionsSource = "cli";
  } else {
    options = parseList(env.TRADEBLOCKS_OPTION_UNDERLYINGS, "TRADEBLOCKS_OPTION_UNDERLYINGS");
    optionsSource = "env";
  }

  return { spot, options, sources: { spot: spotSource, options: optionsSource } };
}

export function resolveRefreshProvenance(args) {
  const closure = args.provenanceClosure ?? null;
  const attemptId = args.provenanceAttemptId ?? null;
  const predecessorManifest = args.predecessorManifest ?? null;
  const predecessorRoot = args.predecessorRoot ?? null;
  const requested = [closure, attemptId, predecessorManifest, predecessorRoot].some(
    (value) => value !== null,
  );
  if (!requested) return undefined;
  if (closure === null || attemptId === null) {
    throw new Error("--provenance-closure and --provenance-attempt-id are required together");
  }
  if (!SHA256_ADDRESS_RE.test(closure)) {
    throw new Error("--provenance-closure must be a lowercase sha256 address");
  }
  if (!ATTEMPT_ID_RE.test(attemptId)) {
    throw new Error(
      "--provenance-attempt-id must be 1-128 canonical letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  if ((predecessorManifest === null) !== (predecessorRoot === null)) {
    throw new Error("--predecessor-manifest and --predecessor-root are required together");
  }
  let predecessor;
  if (predecessorManifest !== null) {
    if (!SHA256_ADDRESS_RE.test(predecessorManifest)) {
      throw new Error("--predecessor-manifest must be a lowercase sha256 address");
    }
    if (!SHA256_ADDRESS_RE.test(predecessorRoot)) {
      throw new Error("--predecessor-root must be a lowercase sha256 address");
    }
    predecessor = { manifest: predecessorManifest, aggregateRoot: predecessorRoot };
  }
  return {
    closure,
    attemptId,
    ...(predecessor ? { predecessor } : {}),
  };
}

export function buildRefreshRequest(asOf, spotTickers, optionUnderlyings, provenance) {
  return {
    asOf,
    spotTickers,
    chainUnderlyings: optionUnderlyings,
    quoteUnderlyings: optionUnderlyings,
    computeVixContext: true,
    ...(provenance ? { provenance } : {}),
  };
}

// Construct the provider once so every refresh path, including canonical
// provenance refreshes, uses the same close-aware ThetaData endpoint. Passing a
// per-call `provider: "thetadata"` bypasses MarketIngestor's injected factory
// and recreates the public provider's 16:00 default — the original wrong path.
export function makeRefreshProvider(mod, providerName) {
  const normalized = String(providerName ?? "massive").toLowerCase();
  if (normalized === "massive") return new mod.MassiveProvider();
  if (normalized !== "thetadata") {
    throw new ConfigError(
      `Unknown MARKET_DATA_PROVIDER: "${normalized}". Supported: massive, thetadata`,
    );
  }
  if (typeof mod.ThetaDataProvider !== "function" || typeof mod.indexHistoryOhlc !== "function") {
    throw new Error("TradeBlocks MCP dist lacks the close-aware ThetaData provider seams");
  }
  return new mod.ThetaDataProvider({
    indexHistoryOhlc: (client, params) =>
      mod.indexHistoryOhlc(client, { ...params, endTime: "16:15:00.000" }),
  });
}

export function formatProvenanceReceipt(asOf, result, expected) {
  const receipt = result?.provenance;
  if (!receipt) throw new Error("provenance refresh returned no cutoff receipt");
  if (receipt.attemptId !== expected.attemptId) {
    throw new Error("provenance refresh receipt attemptId does not match the request");
  }
  if (!SHA256_ADDRESS_RE.test(receipt.cutoff ?? "")) {
    throw new Error("provenance refresh returned an invalid cutoff address");
  }
  if (!SHA256_ADDRESS_RE.test(receipt.aggregateRoot ?? "")) {
    throw new Error("provenance refresh returned an invalid aggregateRoot address");
  }
  return `[refresh] ${asOf} cutoff=${receipt.cutoff} aggregateRoot=${receipt.aggregateRoot}`;
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function newestMtimeMs(path) {
  const entryStat = await stat(path);
  if (!entryStat.isDirectory()) return entryStat.mtimeMs;

  let newest = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    const childMtime = entry.isDirectory()
      ? await newestMtimeMs(child)
      : (await stat(child)).mtimeMs;
    newest = Math.max(newest, childMtime);
  }
  return newest;
}

async function newestSourceMtimeMs(paths) {
  let newest = 0;
  for (const path of paths) {
    const pathMtime = await newestMtimeMs(path);
    newest = Math.max(newest, pathMtime);
  }
  return newest;
}

export async function assertFreshDist({
  sourcePaths = DIST_SOURCE_PATHS,
  distEntrypoint = DIST_ENTRYPOINT,
} = {}) {
  const [latestSource, distMtime] = await Promise.all([
    newestSourceMtimeMs(sourcePaths),
    mtimeMs(distEntrypoint),
  ]);
  if (distMtime === null || distMtime < latestSource) {
    throw new Error(
      `TradeBlocks MCP dist is ${distMtime === null ? "missing" : "stale"}: ${distEntrypoint}; run npm run build:mcp`,
    );
  }
}

// Turn a coverage report into the list of dates to refresh, or refuse.
//
// A report we could not fully compute has an empty session list for the same
// reason a clean corpus does, and the nightly cannot tell those apart from
// the list alone. Reading `unknown` as "nothing to do" turns absence into success.
export function selectMissingDates(report) {
  if (report?.status === "complete") return [];
  // Derived from the detailed sessions, never read from a second serialized
  // list. The report used to carry `missingSessions` alongside
  // `incompleteSessions`, and the contract validated them as unrelated arrays —
  // so a report naming two incomplete sessions and one missing session
  // validated clean and this driver silently skipped the real hole.
  // One list cannot disagree with itself.
  if (report?.status === "incomplete") {
    return (report.incompleteSessions ?? []).map((entry) => entry.date);
  }
  throw new Error(
    `market-data coverage is ${report?.status ?? "missing"} — refusing to treat an ` +
      `undetermined corpus as complete (${report?.reason ?? "no reason reported"})`,
  );
}

function parseArgs(argv) {
  const args = {
    mode: null,
    asOf: null,
    from: null,
    to: null,
    missing: false,
    lookback: null,
    dryRun: false,
    spotTickersCli: null,
    optionUnderlyingsCli: null,
    skipSpot: false,
    skipOptions: false,
    provenanceClosure: null,
    provenanceAttemptId: null,
    predecessorManifest: null,
    predecessorRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--missing") {
      args.missing = true;
    } else if (arg === "--lookback") {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(2);
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(`Error: --lookback must be a positive integer (got "${next}")`);
        process.exit(2);
      }
      args.lookback = parsed;
    } else if (arg === "--skip-spot") {
      args.skipSpot = true;
    } else if (arg === "--skip-options") {
      args.skipOptions = true;
    } else if (arg === "--asOf" || arg === "--from" || arg === "--to") {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(2);
      }
      const key = arg.slice(2); // "asOf" | "from" | "to"
      args[key] = next;
    } else if (arg === "--spot-tickers") {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(2);
      }
      args.spotTickersCli = next;
    } else if (arg === "--option-underlyings") {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(2);
      }
      args.optionUnderlyingsCli = next;
    } else if (
      arg === "--provenance-closure" ||
      arg === "--provenance-attempt-id" ||
      arg === "--predecessor-manifest" ||
      arg === "--predecessor-root"
    ) {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(2);
      }
      const key = {
        "--provenance-closure": "provenanceClosure",
        "--provenance-attempt-id": "provenanceAttemptId",
        "--predecessor-manifest": "predecessorManifest",
        "--predecessor-root": "predecessorRoot",
      }[arg];
      args[key] = next;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  // Mutex: skip-X with --X-... is incoherent.
  if (args.skipSpot && args.spotTickersCli !== null) {
    console.error("Error: --skip-spot is mutually exclusive with --spot-tickers");
    process.exit(2);
  }
  if (args.skipOptions && args.optionUnderlyingsCli !== null) {
    console.error("Error: --skip-options is mutually exclusive with --option-underlyings");
    process.exit(2);
  }

  // Validate combinations
  const hasRange = args.from || args.to;
  if (hasRange && args.asOf) {
    console.error("Error: --asOf is mutually exclusive with --from/--to");
    process.exit(2);
  }
  if (args.missing && (hasRange || args.asOf)) {
    console.error("Error: --missing is mutually exclusive with --asOf and --from/--to");
    process.exit(2);
  }
  if (args.lookback !== null && !args.missing) {
    console.error("Error: --lookback requires --missing");
    process.exit(2);
  }
  if (args.from && !args.to) {
    console.error("Error: --from requires --to");
    process.exit(2);
  }
  if (args.to && !args.from) {
    console.error("Error: --to requires --from");
    process.exit(2);
  }
  for (const [k, v] of [
    ["asOf", args.asOf],
    ["from", args.from],
    ["to", args.to],
  ]) {
    if (v !== null && !isCalendarDate(v)) {
      console.error(`Error: --${k} must be a valid YYYY-MM-DD date (got "${v}")`);
      process.exit(2);
    }
  }
  // YYYY-MM-DD is lexicographically sortable, so a string compare is the
  // calendar compare. Catch reverse ranges here so the error stays in the
  // exit-2 / single-line family alongside the other CLI validations.
  if (args.from && args.to && args.from > args.to) {
    console.error(`Error: --to (${args.to}) must be >= --from (${args.from})`);
    process.exit(2);
  }

  if (hasRange) args.mode = "range";
  else if (args.asOf) args.mode = "single";
  else if (args.missing) args.mode = "missing";
  else args.mode = "yesterday";
  if (args.mode === "missing" && args.lookback === null) args.lookback = MISSING_LOOKBACK_SESSIONS;
  try {
    args.provenance = resolveRefreshProvenance(args);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
  if (args.provenance && (args.mode === "range" || args.mode === "missing")) {
    console.error(
      "Error: canonical provenance refresh accepts one date at a time; use --asOf instead of --from/--to or --missing",
    );
    process.exit(2);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: refresh-market-data.mjs [options]

Default (no flags): refresh yesterday's ET market data.

Environment variables (required when the matching CLI override is absent):
  TRADEBLOCKS_SPOT_TICKERS       Comma-separated spot tickers
                                 (e.g. "SPX,QQQ,VIX,VIX3M,VIX9D").
  TRADEBLOCKS_OPTION_UNDERLYINGS Comma-separated option underlyings
                                 (e.g. "SPX,QQQ"). Feeds both chain and
                                 quote refresh paths.

Options:
  --asOf YYYY-MM-DD          Refresh a single date.
  --from YYYY-MM-DD          Range start (requires --to).
  --to YYYY-MM-DD            Range end (requires --from). Loops day-by-day.
  --missing                  Refresh every XNYS session in the lookback window
                             that is missing a refresh-owned partition class,
                             instead of just yesterday. Normally that is
                             yesterday alone; after a failed night it is also
                             the night that failed. Refuses to run when the
                             corpus cannot be read. Mutually exclusive with
                             --asOf and --from/--to.
  --lookback N               How many trading sessions --missing looks back
                             (default ${MISSING_LOOKBACK_SESSIONS}). Requires --missing.
  --spot-tickers <csv>       Override TRADEBLOCKS_SPOT_TICKERS for this run.
  --option-underlyings <csv> Override TRADEBLOCKS_OPTION_UNDERLYINGS for this
                             run (feeds both chain + quote).
  --skip-spot                Skip the spot stage entirely (spot list := []).
                             Mutually exclusive with --spot-tickers.
  --skip-options             Skip the chain + quote stages entirely
                             (options list := []). Mutually exclusive with
                             --option-underlyings.
  --provenance-closure <sha256:...>
                             Verified input-closure address. Requires
                             --provenance-attempt-id; single-date mode only.
  --provenance-attempt-id <id>
                             Stable canonical refresh attempt identifier.
  --predecessor-manifest <sha256:...>
  --predecessor-root <sha256:...>
                             Optional predecessor pair; both are required
                             together and require provenance mode.
  --dry-run                  Resolve and echo the config + planned dates,
                             then exit cleanly. No provider calls.
  -h, --help                 Show this help.

Examples:
  refresh-market-data.mjs --missing                 # the nightly's own mode
  refresh-market-data.mjs --missing --lookback 30   # repair a longer outage
  TRADEBLOCKS_SPOT_TICKERS=SPX,QQQ,VIX,VIX3M,VIX9D \\
    TRADEBLOCKS_OPTION_UNDERLYINGS=SPX,QQQ \\
    refresh-market-data.mjs --dry-run
  refresh-market-data.mjs --asOf 2026-04-25
  refresh-market-data.mjs --from 2022-01-01 --to 2026-04-26
  refresh-market-data.mjs --spot-tickers QQQ --option-underlyings QQQ \\
    --from 2026-05-08 --to 2026-05-14
  refresh-market-data.mjs --skip-spot --option-underlyings QQQ --asOf 2026-05-08
  refresh-market-data.mjs --asOf 2026-07-21 \\
    --provenance-closure sha256:<closure> --provenance-attempt-id daily-2026-07-21 \\
    --predecessor-manifest sha256:<manifest> --predecessor-root sha256:<aggregate-root>
`);
}

// Defined locally rather than imported from MCP dist: the date math must not
// depend on a test-only export. Returns yesterday's ET date as YYYY-MM-DD.
export function yesterdayET(now = new Date()) {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = todayET.split("-").map(Number);
  const prior = new Date(Date.UTC(y, m - 1, d));
  prior.setUTCDate(prior.getUTCDate() - 1);
  const py = prior.getUTCFullYear();
  const pm = String(prior.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(prior.getUTCDate()).padStart(2, "0");
  return `${py}-${pm}-${pd}`;
}

// ThetaData (and other gRPC-backed providers) signal "no data for this
// query" via gRPC status code 5 / NOT_FOUND. The MDDS adapter surfaces it
// as `Error: 5 NOT_FOUND: No data found for your request` (string form).
// Match both the textual NOT_FOUND token AND the "No data found" phrasing
// to be robust across upstream wording changes — mirrors the regex the
// tradeblocks provider itself uses (utils/providers/thetadata.ts).
export function isNotFoundError(err) {
  if (!err) return false;
  if (err.code === 5) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /NOT_FOUND|No data found/i.test(msg);
}

function rowsWritten(result) {
  return Number.isFinite(result?.rowsWritten) ? result.rowsWritten : 0;
}

function isSatisfiedOperation(result) {
  return (
    result?.status === "ok" ||
    (result?.status === "skipped" && result?.details?.reason === "using_cached_coverage")
  );
}

export function assessRefreshResult(
  asOf,
  result,
  { expectedSpotOperations = 0, nonTradingDay = false } = {},
) {
  const perOperation = result?.perOperation ?? {};
  const groups = {
    spot: Array.isArray(perOperation.spot) ? perOperation.spot : [],
    chain: Array.isArray(perOperation.chain) ? perOperation.chain : [],
    quote: Array.isArray(perOperation.quotes) ? perOperation.quotes : [],
    openInterest: Array.isArray(perOperation.openInterest) ? perOperation.openInterest : [],
    vixContext: perOperation.vixContext ? [perOperation.vixContext] : [],
  };
  const operationCounts = Object.fromEntries(
    Object.entries(groups).map(([name, operations]) => [name, operations.length]),
  );
  const rowTotals = Object.fromEntries(
    Object.entries(groups).map(([name, operations]) => [
      name,
      operations.reduce((total, operation) => total + rowsWritten(operation), 0),
    ]),
  );
  const reportedStatus = typeof result?.status === "string" ? result.status : "error";
  const reportedErrors = Array.isArray(result?.errors) ? result.errors : [];
  const hasChildOperations = Object.values(groups).some((operations) => operations.length > 0);
  const benignClosureSkip =
    reportedStatus === "skipped" &&
    nonTradingDay &&
    reportedErrors.length === 0 &&
    !hasChildOperations;
  const failures = [];

  if (!benignClosureSkip) {
    if (reportedErrors.length > 0) {
      failures.push(`refresh reported ${reportedErrors.length} error(s)`);
    }
    if (groups.spot.length !== expectedSpotOperations) {
      failures.push(
        `spot operation count ${groups.spot.length} did not match ${expectedSpotOperations} requested targets for ${asOf}`,
      );
    }
    for (const [group, operations] of Object.entries(groups)) {
      for (const [index, operation] of operations.entries()) {
        if (!isSatisfiedOperation(operation)) {
          failures.push(`${group} operation ${index + 1} status=${operation?.status ?? "missing"}`);
        }
      }
    }
    for (const [index, operation] of groups.spot.entries()) {
      if (operation?.status === "ok" && rowsWritten(operation) === 0) {
        failures.push(`spot operation ${index + 1} for ${asOf} reported ok with zero rows`);
      }
    }
  }

  const success = benignClosureSkip || (reportedStatus === "ok" && failures.length === 0);
  return {
    status: reportedStatus === "ok" && failures.length > 0 ? "error" : reportedStatus,
    success,
    benignClosureSkip,
    operationCounts,
    rowTotals,
    failures,
  };
}

export function exitCodeForRefreshAssessment(assessment) {
  return assessment.success ? 0 : 1;
}

function isCalendarDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Roundtrip via UTC to reject impossible dates like 2026-02-30 or 2026-13-01.
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}` === s;
}

function enumerateDatesInclusive(from, to) {
  const dates = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (end < current) {
    throw new Error(`--to (${to}) must be >= --from (${from})`);
  }
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, "0");
    const d = String(current.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve ticker lists BEFORE importing the ingestor module so any missing
  // input fails fast without paying the dist-load cost. resolveLists throws
  // with a message naming the offending CLI flag or env var.
  const {
    spot: SPOT_TICKERS,
    options: OPTION_UNDERLYINGS,
    sources,
  } = resolveLists(args, process.env);

  // No-op guard: both stages skipped means nothing to do. Exit BEFORE the
  // dist import / DuckDB lock — no point taking write locks for a no-op.
  if (SPOT_TICKERS.length === 0 && OPTION_UNDERLYINGS.length === 0) {
    console.error(
      "Error: both --skip-spot and --skip-options were given (or both lists resolved empty); nothing to do",
    );
    process.exit(2);
  }

  console.log(
    `[refresh] spot_tickers       = ${JSON.stringify(SPOT_TICKERS)} (source: ${sources.spot})`,
  );
  console.log(
    `[refresh] option_underlyings = ${JSON.stringify(OPTION_UNDERLYINGS)} (source: ${sources.options})`,
  );
  console.log(`[refresh] dry_run            = ${args.dryRun}`);
  if (args.provenance) {
    console.log(
      `[refresh] provenance         = closure=${args.provenance.closure} ` +
        `attemptId=${args.provenance.attemptId}` +
        (args.provenance.predecessor
          ? ` predecessorManifest=${args.provenance.predecessor.manifest} ` +
            `predecessorRoot=${args.provenance.predecessor.aggregateRoot}`
          : ""),
    );
  }

  // `--missing` reads the corpus to decide what to refresh, so it needs the
  // calendar and the partition tree before it can name a single date. Resolved
  // here so a dry run shows the real work list rather than a placeholder.
  let missingDates = null;
  if (args.mode === "missing") {
    const { collectCoverage } = await import("./market-data-coverage.mjs");
    const report = await collectCoverage({
      args: { from: null, to: null, lookback: args.lookback, json: false },
      // The lists THIS invocation resolved, not whatever the environment says.
      // A `--spot-tickers QQQ` override with SPX in the environment otherwise
      // has coverage judging SPX while the driver writes QQQ.
      expected: { spot: SPOT_TICKERS, options: OPTION_UNDERLYINGS },
    });
    console.log(
      `[refresh] coverage window=${report.window ? `${report.window.from}..${report.window.to}` : "(none)"} ` +
        `sessions=${report.sessions} status=${report.status}`,
    );
    for (const entry of report.incompleteSessions) {
      const cells = Object.entries(entry.classes)
        .map(([name, cell]) => `${name}=${cell.present}/${cell.expected}`)
        .join(" ");
      console.log(`[refresh]   incomplete ${entry.date}  ${cells}`);
    }
    // Throws on an undetermined corpus rather than reading it as "nothing to do".
    missingDates = selectMissingDates(report);
    if (missingDates.length === 0) {
      console.log(
        `[refresh] no refreshable session missing in the last ${args.lookback} — nothing to do`,
      );
      // The completion marker is the nightly wrapper's success signal, and a
      // window with nothing missing is a clean outcome — but only because the
      // line above states what was actually checked. The marker alone would be
      // the silent no-op this mode exists to prevent.
      console.log("[refresh] all days completed cleanly");
      return;
    }
    console.log(
      `[refresh] refreshing ${missingDates.length} missing session(s): ` + missingDates.join(" "),
    );
  }

  // For --dry-run, defer the dist import too — the operator's smoke contract
  // is "did my env-var drop-in resolve?", not "does the full module graph
  // load?". Echoing the planned dates with `--dry-run --from … --to …` only
  // needs the calendar helper, which is local.
  if (args.dryRun) {
    let dates;
    if (args.mode === "yesterday") dates = ["<yesterdayET>"];
    else if (args.mode === "single") dates = [args.asOf];
    else if (args.mode === "missing") dates = missingDates;
    else dates = enumerateDatesInclusive(args.from, args.to);
    console.log(`[refresh] mode=${args.mode} dates=${dates.length}`);
    for (const d of dates) console.log(`[refresh] would refresh asOf=${d}`);
    console.log("[refresh] dry-run complete; no ingestor calls made.");
    return;
  }

  await assertFreshDist();

  const mod = await import(pathToFileURL(DIST_ENTRYPOINT).href);
  // Refresh writes data to parquet (staged in :memory:) and watermarks to JSON
  // in parquet mode; nothing goes to market.duckdb tables. Opening an analytics
  // connection read-write for the whole ingest would hold an unnecessary lock.
  // openMarketParquetConnection registers market.* views in memory without an
  // attach. Non-parquet deployments still write physical market.* tables, so
  // they keep the read-write market connection.
  const {
    setDataRoot,
    getDataRoot,
    loadRegistry,
    createMarketStores,
    openMarketOnlyConnection,
    openMarketParquetConnection,
    MarketIngestor,
    isXnysSessionDate,
  } = mod;
  const parquetMode = process.env.TRADEBLOCKS_PARQUET === "true";
  const requiredHelper = parquetMode ? "openMarketParquetConnection" : "openMarketOnlyConnection";
  if (typeof mod[requiredHelper] !== "function") {
    console.error(
      `[refresh] TradeBlocks MCP dist is missing ${requiredHelper} — run npm run build:mcp.`,
    );
    process.exit(1);
  }
  if (typeof isXnysSessionDate !== "function") {
    console.error(
      "[refresh] TradeBlocks MCP dist is missing isXnysSessionDate — run npm run build:mcp.",
    );
    process.exit(1);
  }

  let dates;
  if (args.mode === "yesterday") dates = [yesterdayET()];
  else if (args.mode === "single") dates = [args.asOf];
  else if (args.mode === "missing") dates = missingDates;
  else dates = enumerateDatesInclusive(args.from, args.to);

  console.log(`[refresh] mode=${args.mode} dates=${dates.length}`);

  // ── Bootstrap (mirrors src/index.ts:262-274) ────────────────────
  const baseDir =
    process.env.TRADEBLOCKS_DATA_DIR || `${process.env.HOME}/tradeblocks-data/database`;
  const dataRoot = process.env.TRADEBLOCKS_DATA_ROOT || `${process.env.HOME}/tradeblocks-data`;
  // Surface a clean "directory does not exist" message in the systemd journal
  // before we open DuckDB or upgrade to read-write — mirrors index.ts:206-224.
  for (const [name, path] of [
    ["baseDir", baseDir],
    ["dataRoot", dataRoot],
  ]) {
    try {
      await access(path);
    } catch {
      console.error(`Error: ${name} does not exist: ${path}`);
      process.exit(1);
    }
  }
  setDataRoot(dataRoot);

  console.log(`[refresh] baseDir=${baseDir} dataRoot=${dataRoot}`);
  console.log(
    `[refresh] provider=${process.env.MARKET_DATA_PROVIDER || "(default)"} ` +
      `parquet=${process.env.TRADEBLOCKS_PARQUET || "false"}`,
  );

  // ── Market connection (no analytics lock; no market lock in parquet mode) ──
  // Parquet mode (the operational deployment): openMarketParquetConnection
  // opens a :memory: DuckDB host with the market.* parquet views registered
  // in-memory and NO attach of market.duckdb. Enrichment reads resolve through
  // those views / direct read_parquet; all output is written via COPY ... TO
  // parquet files. analytics.duckdb is never opened and market.duckdb is never
  // locked, so concurrent processes keep full access throughout the ingest.
  // Non-parquet mode: openMarketOnlyConnection attaches market.duckdb RW —
  // required because the DuckDB stores INSERT into physical market.* tables.
  let marketConn;
  let hadError = false;
  try {
    marketConn = parquetMode
      ? await openMarketParquetConnection(baseDir)
      : await openMarketOnlyConnection(baseDir);
    const { conn } = marketConn;
    if (parquetMode) {
      console.log(`[refresh] market data_root=${marketConn.dataRoot} (parquet, no attach)`);
    } else {
      console.log(`[refresh] market_db_path=${marketConn.marketDbPath} (attached RW)`);
    }

    const tickerRegistry = await loadRegistry({ dataDir: baseDir });
    const stores = createMarketStores({
      get conn() {
        return conn;
      },
      dataDir: baseDir,
      parquetMode,
      tickers: tickerRegistry,
    });
    const provider = makeRefreshProvider(
      mod,
      args.provenance ? "thetadata" : process.env.MARKET_DATA_PROVIDER,
    );
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: getDataRoot(baseDir),
      providerFactory: () => provider,
    });

    for (const asOf of dates) {
      const startMs = Date.now();
      try {
        const result = await ingestor.refresh(
          buildRefreshRequest(asOf, SPOT_TICKERS, OPTION_UNDERLYINGS, args.provenance),
        );
        if (args.provenance) {
          console.log(formatProvenanceReceipt(asOf, result, args.provenance));
        }
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        const errCount = result.errors?.length || 0;
        const assessment = assessRefreshResult(asOf, result, {
          expectedSpotOperations: SPOT_TICKERS.length,
          nonTradingDay: !isXnysSessionDate(asOf),
        });
        const status = assessment.status;
        const skippedBatchCount = result.skipped?.length || 0;
        const counts =
          `spot_ops=${assessment.operationCounts.spot} spot_rows=${assessment.rowTotals.spot} ` +
          `chain_ops=${assessment.operationCounts.chain} chain_rows=${assessment.rowTotals.chain} ` +
          `quote_ops=${assessment.operationCounts.quote} quote_rows=${assessment.rowTotals.quote} ` +
          `open_interest_ops=${assessment.operationCounts.openInterest} ` +
          `open_interest_rows=${assessment.rowTotals.openInterest} ` +
          `vix_context_ops=${assessment.operationCounts.vixContext} ` +
          `vix_context_rows=${assessment.rowTotals.vixContext}`;
        console.log(
          `[refresh] ${asOf} status=${status} ${counts} errors=${errCount} ` +
            `skipped_batches=${skippedBatchCount} elapsed=${elapsed}s`,
        );
        if (exitCodeForRefreshAssessment(assessment) !== 0) {
          hadError = true;
          if (result.status !== "ok") {
            console.error(`[refresh]   non-success status: ${result.status ?? "missing"}`);
          }
          for (const failure of assessment.failures) {
            console.error(`[refresh]   failure: ${failure}`);
          }
        }
        if (errCount > 0) {
          for (const e of result.errors) console.error(`[refresh]   error: ${e}`);
        }
        // Issues #121 + #167 + #185: partial → some enrichQuoteRows batches
        // were dropped. Treat as non-success so CI surfaces it instead of
        // silently undercounting. Three failure modes, distinguished by `reason`:
        //   read_failed     → enrichQuoteRows threw (transient flake, schema mismatch)
        //   coverage_gap    → enrichment succeeded but >50% of attempted-lookup
        //                     rows missed underlying price (partial-day spot
        //                     bars, missing chain partition)
        //   compute_failure → underlying-price lookup succeeded but >50% of
        //                     attempted-math rows failed black-scholes
        //                     (zero/negative option price, corrupt expiration,
        //                     malformed strike grid)
        if (result.status === "partial") {
          for (const s of result.skipped ?? []) {
            const reason = s.reason ?? "read_failed";
            const ratioSuffix =
              (reason === "coverage_gap" || reason === "compute_failure") &&
              typeof s.resolveRatio === "number"
                ? ` resolveRatio=${s.resolveRatio.toFixed(2)}`
                : "";
            console.error(
              `[refresh]   skipped batch (${reason}): underlying=${s.underlying} date=${s.date}` +
                `${s.ticker ? ` ticker=${s.ticker}` : ""} rows=${s.rows}${ratioSuffix} error="${s.error}"`,
            );
          }
        }
      } catch (e) {
        // Issue #85 (2026-05-26): ThetaData returns gRPC 5 NOT_FOUND for
        // weekends/holidays. Treat as expected when the requested date is a
        // known non-trading day (weekend or NYSE full-day closure) — log
        // and continue without setting hadError. Trading-day NOT_FOUNDs
        // stay loud (real provider/data anomaly).
        if (isNotFoundError(e)) {
          if (!isXnysSessionDate(asOf)) {
            console.log(`[refresh] ${asOf} skipped: non-trading day`);
            continue;
          }
          console.error(`[refresh] ${asOf} NO DATA on trading day`);
        }
        hadError = true;
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        console.error(`[refresh] ${asOf} threw: ${msg}`);
        // Continue to next date — don't lose a multi-day backfill to one bad day.
      }
    }
  } finally {
    // Parquet mode: close() tears down the :memory: host (nothing attached, no
    // WAL, no lock). Non-parquet: close() flushes the market WAL, detaches, and
    // releases the market.duckdb file lock for the next writer. Best-effort and
    // idempotent. Guarded because the open helper itself can throw — nothing to
    // close in that case.
    if (marketConn) await marketConn.close();
  }

  if (hadError) {
    console.error("[refresh] one or more days had errors — exit 1");
    process.exit(1);
  }
  console.log("[refresh] all days completed cleanly");
}

// Only run main() when invoked directly. Tests import this file to exercise
// `parseList` and must not trigger ingestor bootstrap.
const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  main().catch((err) => {
    // ConfigError = operator-facing "your env vars / CLI flags are missing
    // or shape-invalid". Print as a clean one-liner matching the mutex
    // single-liners; exit 1 distinguishes "config missing/invalid" from the
    // mutex/no-op exit-2 family (config incoherent). Anything else surfaces
    // with a full stack — don't mask real bugs (DuckDB lock fail, etc.).
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
