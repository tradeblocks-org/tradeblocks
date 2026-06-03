#!/usr/bin/env node
/**
 * Production daily option open-interest backfill driver.
 *
 * Fetches daily open interest from ThetaData MDDS and writes it to the
 * canonical parquet store (market/option_oi_daily/underlying=X/date=Y/data.parquet),
 * one parquet partition per (underlying, date).
 *
 * Fetch shape (live-profiled prescription — DO NOT change without re-profiling):
 *   - Expiration WILDCARD ("*") + weekly date-range chunks. One wildcard stream
 *     per root per chunk. Profiled: wildcard+1day ~14.7k rows/2.6s,
 *     wildcard+5day ~1.5s/day. Single-expiration+range TIMES OUT (>120s/month);
 *     NEVER iterate per-expiration over a range.
 *
 * Checkpointing & resume:
 *   - Each completed chunk's per-date partitions are written before moving to
 *     the next chunk, so a crash resumes from the last completed chunk.
 *   - Date partitions already present on disk are skipped (resume). A chunk
 *     whose every date partition already exists is skipped entirely (no fetch).
 *
 * Retry:
 *   - Transient gRPC errors (UNAVAILABLE / DEADLINE_EXCEEDED / RESOURCE_EXHAUSTED)
 *     are retried per chunk with linear backoff.
 *   - `Invalid session ID` / UNAUTHENTICATED fails loud immediately (single
 *     account session shared with the running terminal — never retry-storm).
 *
 * All params are required (fail-loud, no silent defaults) except --chunk-days
 * (default 7) and --logfile (default ./oi-backfill-<ts>.log).
 *
 * Usage:
 *   THETADATA_CREDENTIALS_FILE=/home/romeo/thetadata/creds.txt \
 *   node tools/oi-backfill.mjs \
 *     --roots "SPXW SPX" \
 *     --start 2022-01-03 \
 *     --end 2026-03-31 \
 *     --store-root /home/romeo/tradeblocks-data \
 *     [--chunk-days 7] [--logfile /path/to/oi-backfill.log]
 */

import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, mkdirSync, createWriteStream } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "../packages/mcp-server/dist/test-exports.js");

const TRANSIENT_RE = /UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|ECONNRESET|socket hang up/i;
const SESSION_RE = /Invalid session ID|UNAUTHENTICATED/i;
const NOT_FOUND_RE = /NOT_FOUND|No data found/i;
const MAX_CHUNK_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;

function die(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) die(`Unexpected positional argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) die(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function requireDate(value, name) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) die(`--${name} is required and must use YYYY-MM-DD`);
  const date = new Date(`${text}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    die(`--${name} must be a valid calendar date`);
  }
  return text;
}

function requireRoots(value) {
  if (!value) die("--roots is required (e.g. --roots \"SPXW SPX\")");
  const roots = String(value)
    .split(/[\s,]+/)
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  if (roots.length === 0) die("--roots must include at least one root");
  return [...new Set(roots)];
}

function requirePositiveInt(value, name, fallback) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    die(`--${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) die(`--${name} must be a positive integer`);
  return parsed;
}

// Wire root -> canonical underlying for partitioning. SPXW (weeklies/dailies)
// and SPX (monthlies) both partition under underlying=SPX, mirroring the quote
// store. Other roots partition under themselves.
function underlyingForRoot(root) {
  if (root === "SPX" || root === "SPXW") return "SPX";
  return root;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildChunks(start, end, chunkDays) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    let chunkEnd = addDaysIso(cursor, chunkDays - 1);
    if (chunkEnd > end) chunkEnd = end;
    chunks.push({ from: cursor, to: chunkEnd });
    cursor = addDaysIso(chunkEnd, 1);
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeLogger(logfile) {
  mkdirSync(dirname(logfile), { recursive: true });
  const stream = createWriteStream(logfile, { flags: "a" });
  return {
    log(line) {
      const stamped = `${new Date().toISOString()} ${line}`;
      console.log(stamped);
      stream.write(`${stamped}\n`);
    },
    close() {
      return new Promise((r) => stream.end(r));
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = requireRoots(args.roots);
  const start = requireDate(args.start, "start");
  const end = requireDate(args.end, "end");
  if (start > end) die("--start must be on or before --end");
  const chunkDays = requirePositiveInt(args["chunk-days"], "chunk-days", 7);
  const storeRoot = args["store-root"];
  if (!storeRoot) die("--store-root is required (e.g. --store-root /home/romeo/tradeblocks-data)");
  // --no-resume disables the chunk-level skip-if-partition-exists check. Needed when a
  // second root (SPX) shares an underlying partition with a root already written (SPXW):
  // the per-date write below merges by occ_ticker, so re-fetching is idempotent and only
  // ADDS the second root's (distinct) tickers. Without this, SPX skips every chunk SPXW
  // already created.
  const noResume = process.argv.includes("--no-resume");

  process.env.THETADATA_CREDENTIALS_FILE =
    process.env.THETADATA_CREDENTIALS_FILE || "/home/romeo/thetadata/creds.txt";
  process.env.THETADATA_MDDS_HOST = process.env.THETADATA_MDDS_HOST || "mdds-01.thetadata.us";
  process.env.THETADATA_MDDS_PORT = process.env.THETADATA_MDDS_PORT || "443";
  process.env.THETADATA_MDDS_CLIENT_TYPE = process.env.THETADATA_MDDS_CLIENT_TYPE || "terminal";

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logfile = args.logfile
    ? resolve(args.logfile)
    : resolve(process.cwd(), `oi-backfill-${ts}.log`);
  const logger = makeLogger(logfile);

  logger.log(`START roots=${roots.join(",")} window=${start}..${end} chunkDays=${chunkDays} storeRoot=${storeRoot} logfile=${logfile}`);

  const mod = await import(DIST);
  const {
    ThetaMddsClient,
    optionHistoryOpenInterest,
    ParquetOiDailyStore,
    resolveMarketDir,
    TickerRegistry,
  } = mod;
  const { DuckDBInstance } = await import("@duckdb/node-api");

  const marketDir = resolveMarketDir(storeRoot);

  function partitionFile(underlying, date) {
    return join(marketDir, "option_oi_daily", `underlying=${underlying}`, `date=${date}`, "data.parquet");
  }

  // One :memory: DuckDB instance with external access for COPY ... TO parquet.
  const instance = await DuckDBInstance.create(":memory:", { enable_external_access: "true" });
  const conn = await instance.connect();
  const ctx = {
    conn,
    dataDir: storeRoot,
    parquetMode: true,
    tickers: new TickerRegistry([]),
  };
  const store = new ParquetOiDailyStore(ctx);

  const client = new ThetaMddsClient();
  await client.connect();
  logger.log(`CONNECT authenticated session acquired target=${process.env.THETADATA_MDDS_HOST}:${process.env.THETADATA_MDDS_PORT}`);

  const startedAt = Date.now();
  const perRoot = new Map(roots.map((r) => [r, { rows: 0, written: 0, skippedChunks: 0, failedChunks: 0 }]));
  let cumulativeRows = 0;
  const failedChunkList = [];

  try {
    for (const root of roots) {
      const underlying = underlyingForRoot(root);
      const chunks = buildChunks(start, end, chunkDays);
      const rootStats = perRoot.get(root);

      for (const chunk of chunks) {
        // Resume: if every date partition in this chunk already exists, skip the
        // whole fetch. (We can't know which trading days exist without fetching,
        // so we only skip a chunk when there is at least one existing partition
        // covering it AND no missing trading-day partitions would be created —
        // conservative: skip only when ALL calendar dates have partitions OR the
        // chunk is fully behind the latest existing partition. Simpler + safe:
        // skip when the chunk's partition file for every weekday already exists.)
        const calendarDates = [];
        for (let d = chunk.from; d <= chunk.to; d = addDaysIso(d, 1)) calendarDates.push(d);
        const weekdays = calendarDates.filter((d) => {
          const dow = new Date(`${d}T12:00:00.000Z`).getUTCDay();
          return dow !== 0 && dow !== 6;
        });
        const allWeekdaysPresent =
          weekdays.length > 0 && weekdays.every((d) => existsSync(partitionFile(underlying, d)));
        if (!noResume && allWeekdaysPresent) {
          rootStats.skippedChunks += 1;
          logger.log(`[${root}] ${chunk.from}..${chunk.to} SKIP (all weekday partitions present)`);
          continue;
        }

        const chunkStart = Date.now();
        let oiRows = null;
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
          try {
            oiRows = await optionHistoryOpenInterest(client, {
              symbol: root,
              expiration: "*",
              startDate: chunk.from,
              endDate: chunk.to,
            });
            break;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (SESSION_RE.test(msg)) {
              logger.log(`[${root}] ${chunk.from}..${chunk.to} ERROR session-collision: ${msg}`);
              await logger.close();
              client.close();
              console.error("ERROR Invalid session ID / UNAUTHENTICATED — single account session collided with the running terminal. STOPPING (no retry).");
              process.exit(2);
            }
            if (NOT_FOUND_RE.test(msg)) {
              oiRows = [];
              break;
            }
            lastError = error;
            if (!TRANSIENT_RE.test(msg) || attempt === MAX_CHUNK_ATTEMPTS) break;
            logger.log(`[${root}] ${chunk.from}..${chunk.to} RETRY attempt=${attempt} transient: ${msg}`);
            await sleep(RETRY_BASE_MS * attempt);
          }
        }

        if (oiRows === null) {
          const msg = lastError instanceof Error ? lastError.message : String(lastError);
          rootStats.failedChunks += 1;
          failedChunkList.push({ root, from: chunk.from, to: chunk.to, error: msg });
          logger.log(`[${root}] ${chunk.from}..${chunk.to} ERROR fetch failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${msg}`);
          continue;
        }

        // Group rows by (underlying, date). All rows for SPX/SPXW resolve to the
        // SPX underlying partition; date comes from the normalized OI report date.
        const byDate = new Map();
        for (const r of oiRows) {
          let bucket = byDate.get(r.date);
          if (!bucket) {
            bucket = [];
            byDate.set(r.date, bucket);
          }
          bucket.push({
            occ_ticker: r.ticker,
            underlying,
            date: r.date,
            expiration: r.expiration,
            strike: r.strike,
            right: r.right,
            open_interest: r.openInterest,
            source: "thetadata",
          });
        }

        // Checkpoint: write each date partition. Skip dates already on disk
        // (resume at partition granularity). For roots that share an underlying
        // (SPX + SPXW), a later root must NOT clobber an earlier root's
        // partition — so when both roots target the same underlying, append by
        // reading existing rows and merging. SPXW runs first by convention;
        // append-merge keeps it safe regardless of order.
        let written = 0;
        for (const [date, rows] of byDate) {
          const file = partitionFile(underlying, date);
          if (existsSync(file)) {
            // Merge with existing partition (other root or prior run) and
            // de-dup on occ_ticker so re-runs are idempotent.
            const existing = await store.readOiDaily(underlying, date, date);
            const merged = new Map();
            for (const er of existing) merged.set(er.occ_ticker, er);
            for (const nr of rows) merged.set(nr.occ_ticker, nr);
            await store.writeOiDaily(underlying, date, [...merged.values()]);
          } else {
            await store.writeOiDaily(underlying, date, rows);
          }
          written += rows.length;
        }

        const wall = ((Date.now() - chunkStart) / 1000).toFixed(1);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        rootStats.rows += oiRows.length;
        rootStats.written += written;
        cumulativeRows += oiRows.length;
        logger.log(`[${root}] ${chunk.from}..${chunk.to} rows=${oiRows.length} wall=${wall}s cumulative=${cumulativeRows}/${elapsed}s`);
      }

      logger.log(`DONE ${root} rows=${rootStats.rows} written=${rootStats.written} skippedChunks=${rootStats.skippedChunks} failedChunks=${rootStats.failedChunks}`);
    }
  } finally {
    client.close();
    try { conn.closeSync(); } catch { /* non-fatal */ }
    try { instance.closeSync(); } catch { /* non-fatal */ }
  }

  const totalWall = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.log("SUMMARY ----------------------------------------");
  for (const [root, s] of perRoot) {
    logger.log(`SUMMARY [${root}] rows=${s.rows} written=${s.written} skippedChunks=${s.skippedChunks} failedChunks=${s.failedChunks}`);
  }
  logger.log(`SUMMARY totalRows=${cumulativeRows} wall=${totalWall}s failedChunks=${failedChunkList.length}`);
  for (const f of failedChunkList) {
    logger.log(`SUMMARY FAILED-CHUNK [${f.root}] ${f.from}..${f.to} ${f.error}`);
  }
  logger.log(failedChunkList.length === 0 ? "DONE ALL" : `DONE WITH FAILURES (${failedChunkList.length} chunks)`);
  await logger.close();
  process.exitCode = failedChunkList.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("ERROR", error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
