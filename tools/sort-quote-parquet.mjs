#!/usr/bin/env node
/**
 * Sort option_quote_minutes parquet files by (ticker, time) in place.
 *
 * Why: when partitions were originally written sorted by (time, ticker),
 * each row group spans the full ticker range, so DuckDB cannot prune row
 * groups on `WHERE ticker IN (...)`. Sorting by ticker gives each row
 * group a tight ticker range, enabling row-group skipping for the dominant
 * ticker-windowed read pattern. This is a one-shot migration helper for
 * users with pre-existing data written under the old sort key.
 *
 * Safety:
 *  - Per-file shadow tmpfile + atomic rename (originals untouched until
 *    rename succeeds).
 *  - Pre/post checksum: COUNT(*) + SUM(bid+ask) must match before rename.
 *  - Already-sorted detection: skip files whose first two row groups have
 *    non-overlapping ticker ranges (idempotent).
 *  - Stale tmpfile cleanup at start (resume-safe).
 *
 * Data root resolution:
 *  - TRADEBLOCKS_DATA_ROOT env var if set (matches mcp-server convention)
 *  - Otherwise $HOME/tradeblocks-data
 *
 * Usage:
 *   node tools/sort-quote-parquet.mjs                        # all underlyings
 *   node tools/sort-quote-parquet.mjs --underlying SPX        # one underlying
 *   node tools/sort-quote-parquet.mjs --dry-run               # report only
 *   node tools/sort-quote-parquet.mjs --concurrency 4         # workers (default 4)
 *   node tools/sort-quote-parquet.mjs --limit 10              # process only N files
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { readdirSync, statSync, renameSync, unlinkSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";

const ROOT = process.env.TRADEBLOCKS_DATA_ROOT
  ? resolve(process.env.TRADEBLOCKS_DATA_ROOT, "market", "option_quote_minutes")
  : resolve(process.env.HOME, "tradeblocks-data", "market", "option_quote_minutes");

const TMP_SUFFIX = ".tmp.sort";

function parseArgs(argv) {
  const args = { underlying: null, dryRun: false, concurrency: 4, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--underlying") {
      args.underlying = next;
      i++;
    } else if (flag === "--dry-run") {
      args.dryRun = true;
    } else if (flag === "--concurrency") {
      args.concurrency = parseInt(next, 10);
      i++;
    } else if (flag === "--limit") {
      args.limit = parseInt(next, 10);
      i++;
    } else if (flag === "--help" || flag === "-h") {
      console.log(`Usage: node tools/sort-quote-parquet.mjs [options]

Re-sort option_quote_minutes parquet partitions by (ticker, time) in place.

Options:
  --underlying <SYM>   Process only one underlying (e.g. SPX)
  --dry-run            Report what would change without writing
  --concurrency <N>    Parallel workers (default 4)
  --limit <N>          Process at most N files (useful for testing)
  --help, -h           Show this help

Data root: TRADEBLOCKS_DATA_ROOT env var, else $HOME/tradeblocks-data.
`);
      process.exit(0);
    }
  }
  return args;
}

function listPartitionFiles(underlyingFilter) {
  const out = [];
  if (!existsSync(ROOT)) {
    console.error(`No data dir at ${ROOT}`);
    process.exit(1);
  }
  const underlyings = readdirSync(ROOT)
    .filter((n) => n.startsWith("underlying="))
    .filter((n) => !underlyingFilter || n === `underlying=${underlyingFilter}`);
  for (const u of underlyings) {
    const uDir = resolve(ROOT, u);
    const dates = readdirSync(uDir).filter((n) => n.startsWith("date="));
    for (const d of dates) {
      const file = resolve(uDir, d, "data.parquet");
      if (existsSync(file)) out.push(file);
    }
  }
  return out.sort();
}

async function cleanupStaleTmpfiles(files) {
  let cleaned = 0;
  for (const f of files) {
    const tmp = f + TMP_SUFFIX;
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
        cleaned++;
      } catch (e) {
        console.error(`  warning: could not remove stale ${tmp}: ${e.message}`);
      }
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} stale tmpfile(s) from prior runs.`);
}

async function isAlreadySorted(conn, file) {
  // A file is already sorted if the row groups have non-overlapping ticker
  // ranges in increasing order (RG[0].max <= RG[1].min, etc.).
  const r = await conn.runAndReadAll(`
    SELECT row_group_id, stats_min, stats_max
    FROM parquet_metadata('${file}')
    WHERE path_in_schema = 'ticker'
    ORDER BY row_group_id
    LIMIT 5
  `);
  const rows = r.getRows();
  if (rows.length < 2) return true; // single row group is trivially sorted
  for (let i = 0; i < rows.length - 1; i++) {
    const curMax = String(rows[i][2]);
    const nextMin = String(rows[i + 1][1]);
    if (curMax > nextMin) return false; // overlap → not sorted
  }
  return true;
}

async function checksumOf(conn, file) {
  const r = await conn.runAndReadAll(`
    SELECT COUNT(*), SUM(bid+ask)
    FROM read_parquet('${file}')
  `);
  const row = r.getRows()[0];
  return { count: Number(row[0]), sum: Number(row[1]) };
}

async function sortOne(conn, file, dryRun) {
  const tmp = file + TMP_SUFFIX;
  const stat = statSync(file);

  const sortedAlready = await isAlreadySorted(conn, file);
  if (sortedAlready) {
    return { file, status: "skip-sorted", sizeMB: stat.size / 1024 / 1024 };
  }

  if (dryRun) {
    return { file, status: "would-sort", sizeMB: stat.size / 1024 / 1024 };
  }

  // Pre-checksum
  const before = await checksumOf(conn, file);

  // Write sorted to tmpfile
  const t0 = Date.now();
  await conn.runAndReadAll(`
    COPY (SELECT * FROM read_parquet('${file}') ORDER BY ticker, time)
    TO '${tmp}' (FORMAT 'parquet', COMPRESSION 'zstd')
  `);
  const writeMs = Date.now() - t0;

  // Post-checksum on tmpfile
  const after = await checksumOf(conn, tmp);

  if (before.count !== after.count) {
    unlinkSync(tmp);
    return {
      file,
      status: "fail-rowcount-mismatch",
      detail: `before=${before.count} after=${after.count}`,
    };
  }

  // Tolerance for floating-point sum (DuckDB SUM order can differ)
  const sumDiff = Math.abs(before.sum - after.sum);
  const sumTolerance = Math.max(0.01, Math.abs(before.sum) * 1e-9);
  if (sumDiff > sumTolerance) {
    unlinkSync(tmp);
    return {
      file,
      status: "fail-checksum-mismatch",
      detail: `before=${before.sum} after=${after.sum} diff=${sumDiff} tol=${sumTolerance}`,
    };
  }

  // Atomic rename
  renameSync(tmp, file);
  const newStat = statSync(file);

  return {
    file,
    status: "sorted",
    writeMs,
    sizeBeforeMB: stat.size / 1024 / 1024,
    sizeAfterMB: newStat.size / 1024 / 1024,
    rows: before.count,
  };
}

async function worker(workerId, queue, dryRun, results, totals) {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) break;
    try {
      const r = await sortOne(conn, file, dryRun);
      results.push(r);
      totals.processed++;
      if (r.status === "sorted") {
        totals.sorted++;
        totals.bytesBefore += (r.sizeBeforeMB || 0) * 1024 * 1024;
        totals.bytesAfter += (r.sizeAfterMB || 0) * 1024 * 1024;
        totals.rows += r.rows || 0;
      } else if (r.status === "skip-sorted") {
        totals.skipped++;
      } else if (r.status === "would-sort") {
        totals.wouldSort++;
      } else {
        totals.failed++;
        console.error(
          `  [worker ${workerId}] FAIL ${basename(dirname(file))}/${basename(file)}: ${r.status} ${r.detail || ""}`,
        );
      }
      if (totals.processed % 10 === 0 || r.status === "sorted") {
        const pct = ((totals.processed / totals.total) * 100).toFixed(1);
        const tag =
          r.status === "sorted"
            ? `sorted in ${r.writeMs}ms (${((r.sizeAfterMB / r.sizeBeforeMB) * 100).toFixed(0)}% size)`
            : r.status;
        console.log(
          `  [${pct}% ${totals.processed}/${totals.total}] ${basename(dirname(dirname(file)))}/${basename(dirname(file))} → ${tag}`,
        );
      }
    } catch (e) {
      totals.failed++;
      console.error(`  [worker ${workerId}] ERROR ${file}: ${e.message}`);
      results.push({ file, status: "exception", detail: e.message });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const provenanceRoot = resolve(ROOT, "..", ".provenance");
  if (!args.dryRun && existsSync(provenanceRoot)) {
    throw new Error(
      `Refusing an in-place bypass rewrite of provenance-managed partitions under ${ROOT}. ` +
        `Rewrite through the canonical partition writer instead.`,
    );
  }
  console.log(`Root: ${ROOT}`);
  console.log(`Filter: ${args.underlying ?? "(all underlyings)"}`);
  console.log(`Mode: ${args.dryRun ? "DRY-RUN" : "IN-PLACE REWRITE"}`);
  console.log(`Concurrency: ${args.concurrency} workers`);

  const allFiles = listPartitionFiles(args.underlying);
  let files = allFiles;
  if (args.limit > 0) files = files.slice(0, args.limit);

  console.log(`\nFound ${allFiles.length} partition files; processing ${files.length}.`);
  await cleanupStaleTmpfiles(files);

  const queue = [...files];
  const results = [];
  const totals = {
    total: files.length,
    processed: 0,
    sorted: 0,
    skipped: 0,
    wouldSort: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    rows: 0,
  };

  console.log(`\nStarting ${args.concurrency} workers...`);
  const wallStart = Date.now();
  await Promise.all(
    Array.from({ length: args.concurrency }, (_, i) =>
      worker(i, queue, args.dryRun, results, totals),
    ),
  );
  const wallMs = Date.now() - wallStart;

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  Total files:      ${totals.total}`);
  console.log(`  Sorted:           ${totals.sorted}`);
  console.log(`  Skipped (sorted): ${totals.skipped}`);
  if (args.dryRun) console.log(`  Would sort:       ${totals.wouldSort}`);
  console.log(`  Failed:           ${totals.failed}`);
  if (totals.sorted > 0) {
    console.log(`  Rows rewritten:   ${totals.rows.toLocaleString()}`);
    console.log(`  Bytes before:     ${(totals.bytesBefore / 1024 / 1024 / 1024).toFixed(2)}GB`);
    console.log(
      `  Bytes after:      ${(totals.bytesAfter / 1024 / 1024 / 1024).toFixed(2)}GB (${((totals.bytesAfter / totals.bytesBefore) * 100).toFixed(0)}%)`,
    );
  }
  console.log(`  Wall time:        ${(wallMs / 1000).toFixed(1)}s`);
  if (totals.failed > 0) {
    console.log("\nFAILED files:");
    for (const r of results) {
      if (r.status !== "sorted" && r.status !== "skip-sorted" && r.status !== "would-sort") {
        console.log(`  ${r.file}: ${r.status} ${r.detail || ""}`);
      }
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
