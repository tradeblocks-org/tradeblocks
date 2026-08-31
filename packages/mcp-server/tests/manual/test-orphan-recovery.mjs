#!/usr/bin/env node
/**
 * Test: Auto-recover DuckDB locks from orphaned MCP processes
 *
 * Uses the double-fork pattern to create a truly orphaned process (PPID=1)
 * that holds the DuckDB write lock, then verifies a new MCP server
 * connection auto-recovers.
 *
 * Usage: node packages/mcp-server/tests/manual/test-orphan-recovery.mjs [data-dir]
 */

import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "../..");
const LOCK_HOLDER_SCRIPT = path.join(__dirname, "_tradeblocks-mcp-lock-holder.mjs");

// Use a temp directory so we don't conflict with existing MCP sessions.
// Copy the real DB to avoid needing real block data (the lock is file-level).
const realDataDir = process.argv[2] || path.join(process.env.HOME, "backtests");
const realDbPath = path.join(realDataDir, "analytics.duckdb");

if (!fs.existsSync(realDataDir)) {
  console.error(`FAIL: Data directory ${realDataDir} does not exist.`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(
  path.join(fs.realpathSync(import.meta.dirname || __dirname), ".test-orphan-"),
);
const dbPath = path.join(dataDir, "analytics.duckdb");

// Copy the DB file so the lock holder and recovery test work on a fresh copy
if (fs.existsSync(realDbPath)) {
  fs.copyFileSync(realDbPath, dbPath);
  console.log(`Copied DB to test dir: ${dataDir}`);
} else {
  console.log(`No existing DB — will create fresh: ${dataDir}`);
}

// Clean up temp dir on exit
function cleanupTempDir() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanupTempDir);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getPpid(pid) {
  try {
    return parseInt(
      execFileSync("ps", ["-p", String(pid), "-o", "ppid="])
        .toString()
        .trim(),
      10,
    );
  } catch {
    return null;
  }
}

function getCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="])
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== Test: Orphan Lock Recovery ===");
  console.log(`Data dir: ${dataDir}`);
  console.log(`DB path:  ${dbPath}`);
  console.log();

  // ── Step 1: Create an orphaned lock holder via double-fork ──
  // We spawn a "middle" child that spawns a detached grandchild (the lock holder),
  // then the middle child exits immediately. The grandchild's PPID becomes 1.
  console.log("Step 1: Creating orphaned lock holder via double-fork...");

  const pidFile = path.join(dataDir, ".test-orphan-pid");

  // Middle child: spawns the lock holder detached, writes its PID, then exits.
  const middle = spawn(
    "node",
    [
      "-e",
      `
    const { spawn } = require("child_process");
    const fs = require("fs");
    const child = spawn("node", [${JSON.stringify(LOCK_HOLDER_SCRIPT)}, ${JSON.stringify(dbPath)}], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.exit(0);
  `,
    ],
    { stdio: "ignore" },
  );

  await new Promise((resolve) => middle.on("exit", resolve));
  await sleep(2000); // Let the lock holder open DuckDB

  let lockHolderPid;
  try {
    lockHolderPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    fs.unlinkSync(pidFile);
  } catch {
    console.error("FAIL: Could not read lock holder PID file.");
    process.exit(1);
  }

  if (!isAlive(lockHolderPid)) {
    console.error(`FAIL: Lock holder (PID ${lockHolderPid}) is not alive.`);
    // Check if it wrote an error
    const errFile = dbPath + ".test-err";
    if (fs.existsSync(errFile)) {
      console.error("Lock holder error:", fs.readFileSync(errFile, "utf-8"));
      fs.unlinkSync(errFile);
    }
    process.exit(1);
  }

  const ppid = getPpid(lockHolderPid);
  const cmd = getCommand(lockHolderPid);
  console.log(`  Lock holder PID: ${lockHolderPid}`);
  console.log(`  Lock holder PPID: ${ppid}`);
  console.log(`  Lock holder command: ${cmd}`);

  if (ppid !== 1) {
    console.error(
      `  WARNING: PPID is ${ppid}, not 1. Orphaning may not work on this macOS version.`,
    );
  }

  // ── Step 2: Import and call getConnection — should detect orphan and recover ──
  console.log();
  console.log("Step 2: Attempting getConnection (should detect orphan and recover)...");

  // Use --call to invoke a tool, which triggers getConnection() internally.
  console.log("  Starting new MCP server via --call to trigger lock recovery...");

  let stderr = "";
  let stdout = "";
  let exitCode;

  try {
    const result = spawn(
      "node",
      [path.join(MCP_ROOT, "server", "index.js"), "--call", "list_blocks", "{}"],
      {
        env: { ...process.env, TRADEBLOCKS_DATA_DIR: dataDir },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      },
    );

    const stderrChunks = [];
    const stdoutChunks = [];
    result.stderr.on("data", (d) => stderrChunks.push(d));
    result.stdout.on("data", (d) => stdoutChunks.push(d));

    exitCode = await new Promise((resolve) => {
      result.on("exit", resolve);
      setTimeout(() => {
        result.kill();
        resolve(-1);
      }, 15000);
    });

    stderr = Buffer.concat(stderrChunks).toString();
    stdout = Buffer.concat(stdoutChunks).toString();
  } catch (e) {
    console.error(`  Error running --call: ${e.message}`);
  }

  console.log();
  console.log("=== Recovery stderr ===");
  console.log(stderr || "(empty)");
  console.log("=======================");
  console.log();

  // ── Step 3: Verify results ──
  // This test covers ONE case: a holder that is genuinely abandoned (PPID=1).
  // Terminating that holder is correct. Terminating a LIVE holder is not, and is
  // never a pass here — the old grading accepted "force-recovery" as success,
  // which is why the sibling-killing disconnect loop (#444) shipped. Coexistence
  // with a live holder is covered automatically in
  // tests/integration/duckdb-lock-coexistence.test.ts.
  const orphanRecovered = stderr.includes("Recovered DuckDB lock") && stderr.includes("orphaned");
  const forceRecovered =
    stderr.includes("Recovered DuckDB lock") && stderr.includes("force-recovery");
  const lockHolderDead = !isAlive(lockHolderPid);

  if (forceRecovered) {
    console.log("FAIL: Recovered via force mode, not orphan detection.");
    console.log(`  The holder's PPID was ${ppid}. Orphan detection expects 1.`);
    console.log("  Force mode must stay opt-in (DUCKDB_LOCK_RECOVERY=true) — a live");
    console.log("  holder is another working session, and killing it loops (#444).");
    cleanup(lockHolderPid);
    process.exit(1);
  }

  if (orphanRecovered) {
    console.log("PASS: Detected orphaned process and recovered the DuckDB lock.");
  } else if (lockHolderDead) {
    console.log("PASS: Lock holder is dead (likely recovered before log message).");
  } else {
    console.log(`INFO: Exit code=${exitCode}, lock holder alive=${!lockHolderDead}`);
    console.log("  stdout:", stdout.slice(0, 200));
    console.log("FAIL: Orphaned lock holder is still alive and was not recovered.");
    cleanup(lockHolderPid);
    process.exit(1);
  }

  cleanup(lockHolderPid);
  console.log();
  console.log("=== Test Complete ===");
}

function cleanup(pid) {
  if (pid && isAlive(pid)) {
    console.log(`  Cleaning up lock holder PID ${pid}...`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
