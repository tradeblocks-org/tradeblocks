#!/usr/bin/env node
/**
 * A stand-in for a second tradeblocks-mcp server that holds the analytics
 * database, used by tests/integration/duckdb-lock-coexistence.test.ts.
 *
 * The filename deliberately contains "tradeblocks-mcp" and the db path is passed
 * as an argv element, because lock recovery only considers terminating a holder
 * whose `ps` command line matches both (see
 * tryRecoverLockByTerminatingStaleProcess). A holder that failed those checks
 * would make the fratricide tests pass for the wrong reason.
 *
 * Usage: node tradeblocks-mcp-lock-holder.mjs <db-path> <mode> [rwHoldMs]
 *
 *   mode = rw            open read-write and hold until killed
 *   mode = ro            open read-only and hold until killed
 *   mode = rw-then-ro    open read-write, hold rwHoldMs, then downgrade to
 *                        read-only and hold until killed. This is what a real
 *                        server does at startup: take the write lock to build
 *                        schemas, then release it.
 *   mode = rw-respawn    open read-write and, on SIGTERM, spawn a REPLACEMENT
 *                        holder before exiting. Stands in for a client that
 *                        restarts the server we just killed — the pathological
 *                        case the post-termination fast path must not loop on.
 *                        rwHoldMs is reused as the respawn budget: each
 *                        generation decrements it, and generation 0 stops
 *                        respawning, so the test can never leak forever.
 *
 * Prints exactly one line to stdout on each state change, so the test can await
 * a known state instead of sleeping and hoping:
 *   READY <mode> <pid>
 *   DOWNGRADED <pid>
 *
 * It also writes its PID to `<db-path>.holder-ready` once the database is open.
 * The orphan case needs that file: a double-forked holder is spawned detached with
 * stdio ignored, so its stdout is not readable by the test.
 */
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const { DuckDBInstance } = require("@duckdb/node-api");

const [dbPath, mode, rwHoldMsRaw] = process.argv.slice(2);
if (!dbPath || !mode) {
  process.stderr.write("Usage: node tradeblocks-mcp-lock-holder.mjs <db-path> <mode> [rwHoldMs]\n");
  process.exit(1);
}
const rwHoldMs = Number.parseInt(rwHoldMsRaw || "1500", 10);

const baseOptions = { threads: "1", memory_limit: "256MB", enable_external_access: "true" };

async function open(readOnly) {
  const options = readOnly ? { ...baseOptions, access_mode: "READ_ONLY" } : { ...baseOptions };
  const instance = await DuckDBInstance.create(dbPath, options);
  const connection = await instance.connect();
  return { instance, connection };
}

let held = null;

async function closeHeld() {
  if (!held) return;
  try {
    held.connection.closeSync();
  } catch {
    /* best effort */
  }
  try {
    held.instance.closeSync();
  } catch {
    /* best effort */
  }
  held = null;
}

try {
  if (mode === "ro") {
    held = await open(true);
  } else {
    held = await open(false);
    // Give the file a table so a later READ_ONLY open has real content, and so
    // the write lock is genuinely in use rather than nominally acquired.
    await held.connection.run("CREATE TABLE IF NOT EXISTS lock_holder_marker(n INTEGER)");
  }
  process.stdout.write(`READY ${mode} ${process.pid}\n`);
  fs.writeFileSync(`${dbPath}.holder-ready`, String(process.pid));

  if (mode === "rw-respawn") {
    // Record every generation's PID so the test can reap the whole chain.
    fs.appendFileSync(`${dbPath}.holder-pids`, `${process.pid}\n`);
    const generationsLeft = Number.isFinite(rwHoldMs) ? rwHoldMs : 0;
    process.on("SIGTERM", () => {
      if (generationsLeft > 0) {
        const { spawn } = require("child_process");
        const child = spawn(
          process.execPath,
          [process.argv[1], dbPath, "rw-respawn", String(generationsLeft - 1)],
          { detached: true, stdio: "ignore" },
        );
        child.unref();
      }
      process.exit(0);
    });
  }

  if (mode === "rw-then-ro") {
    setTimeout(
      async () => {
        await closeHeld();
        held = await open(true);
        process.stdout.write(`DOWNGRADED ${process.pid}\n`);
      },
      Number.isFinite(rwHoldMs) && rwHoldMs >= 0 ? rwHoldMs : 1500,
    );
  }

  // Hold until the test kills us.
  setInterval(() => {}, 60000);
} catch (error) {
  process.stderr.write(`HOLDER_FAILED ${error?.message || error}\n`);
  process.exit(1);
}
