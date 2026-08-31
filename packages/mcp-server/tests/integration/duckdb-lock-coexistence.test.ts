/**
 * Integration tests: coexisting with another tradeblocks-mcp server on the same
 * analytics database.
 *
 * Regression coverage for the startup disconnect loop (#444). Clients such as
 * Claude Desktop run more than one copy of this server against one data
 * directory. Startup takes the DuckDB write lock to build schemas, and that lock
 * excludes every other process — readers included. The old behaviour was to
 * SIGTERM the lock holder, which meant each freshly booted copy killed a working
 * one, the client restarted the victim, and the victim killed the survivor.
 *
 * These tests spawn a REAL second process holding the file, because nothing
 * in-process can reproduce a cross-process file lock.
 *
 * Measured lock matrix these tests depend on (see connection.ts header):
 *   read-write holder blocks read-only opens AND read-write opens
 *   read-only  holder blocks read-write opens but NOT other read-only opens
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

// @ts-expect-error - importing from the source barrel used by the other suites
import { getConnection, closeConnection, getConnectionMode } from "../../src/test-exports.ts";

const HOLDER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "tradeblocks-mcp-lock-holder.mjs",
);

type HolderMode = "rw" | "ro" | "rw-then-ro";

interface Holder {
  child: ChildProcess;
  pid: number;
  /** Resolves when the holder prints the given line prefix on stdout. */
  waitForLine: (prefix: string, timeoutMs?: number) => Promise<void>;
}

async function parentPidOf(pid: number): Promise<number | null> {
  const { promisify } = await import("util");
  const { execFile } = await import("child_process");
  try {
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "ppid="]);
    const ppid = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn the holder and resolve once it reports READY. */
async function startHolder(dbPath: string, mode: HolderMode, rwHoldMs?: number): Promise<Holder> {
  const args = [HOLDER_SCRIPT, dbPath, mode];
  if (rwHoldMs !== undefined) args.push(String(rwHoldMs));
  const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += String(d)));
  child.stderr!.on("data", (d) => (stderr += String(d)));

  const waitForLine = (prefix: string, timeoutMs = 15000) =>
    new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (stdout.split("\n").some((line) => line.startsWith(prefix))) {
          clearInterval(poll);
          resolve();
        } else if (child.exitCode !== null) {
          clearInterval(poll);
          reject(new Error(`holder exited before "${prefix}": ${stderr || "(no stderr)"}`));
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error(`timed out waiting for "${prefix}"; stderr: ${stderr || "(none)"}`));
        }
      }, 50);
    });

  await waitForLine("READY");
  return { child, pid: child.pid!, waitForLine };
}

/**
 * Spawn a holder that is genuinely orphaned (PPID 1) via double-fork: a middle
 * process spawns the holder detached and exits immediately, so the holder is
 * reparented to init.
 *
 * The holder's stdio is ignored (a detached process's pipes die with the middle
 * process), so readiness comes from the marker file the fixture writes.
 */
async function startOrphanedHolder(dbPath: string): Promise<number> {
  const readyFile = `${dbPath}.holder-ready`;
  const middleScript = [
    'const { spawn } = require("child_process");',
    `const child = spawn(process.execPath, [${JSON.stringify(HOLDER_SCRIPT)}, ${JSON.stringify(dbPath)}, "rw"], { detached: true, stdio: "ignore" });`,
    "child.unref();",
    "process.exit(0);",
  ].join("\n");

  const middle = spawn("node", ["-e", middleScript], { stdio: "ignore" });
  await new Promise((resolve) => middle.on("exit", resolve));

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const pid = Number.parseInt(await fs.readFile(readyFile, "utf-8"), 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error("orphaned holder never became ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopHolder(holder: Holder | null): Promise<void> {
  if (!holder) return;
  if (isAlive(holder.pid)) {
    holder.child.kill("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 100));
}

describe("DuckDB lock coexistence with a second server", () => {
  let testDir: string;
  let dbPath: string;
  let holder: Holder | null = null;
  // An orphaned holder has no parent to reap it, so the test must clean it up by PID.
  let orphanPidToClean: number | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "tb-lock-coexist-"));
    dbPath = path.join(testDir, "analytics.duckdb");
    savedEnv.DUCKDB_LOCK_RECOVERY = process.env.DUCKDB_LOCK_RECOVERY;
    savedEnv.DUCKDB_OPEN_WAIT_MS = process.env.DUCKDB_OPEN_WAIT_MS;
    delete process.env.DUCKDB_LOCK_RECOVERY;
    delete process.env.DUCKDB_OPEN_WAIT_MS;

    // Seed the data directory the way a first-ever run would: full schema init,
    // analytics.duckdb and market.duckdb both present, then release everything.
    await getConnection(testDir);
    await closeConnection();
  }, 60000);

  afterEach(async () => {
    await stopHolder(holder);
    holder = null;
    if (orphanPidToClean !== null && isAlive(orphanPidToClean)) {
      try {
        process.kill(orphanPidToClean, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    orphanPidToClean = null;
    await closeConnection();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(testDir, { recursive: true, force: true });
  }, 60000);

  it("joins a read-only holder as a second reader without touching it", async () => {
    holder = await startHolder(dbPath, "ro");

    await getConnection(testDir);

    expect(isAlive(holder.pid)).toBe(true);
    expect(getConnectionMode()).toBe("read_only");
  }, 60000);

  it("waits out a holder's startup write lock instead of killing it", async () => {
    // The holder mimics a real server booting first: write lock for 2s to build
    // schemas, then downgrade to read-only and keep running. Before the fix, the
    // call below SIGTERMed this process and the client saw "Server disconnected".
    holder = await startHolder(dbPath, "rw-then-ro", 2000);

    const connection = await getConnection(testDir);

    expect(isAlive(holder.pid)).toBe(true);
    // The holder is still running as a reader, so we cannot hold the write lock.
    expect(getConnectionMode()).toBe("read_only");
    // And we are genuinely usable, not just open.
    const result = await connection.runAndReadAll("SELECT 42 AS answer");
    expect(Number(result.getRows()[0][0])).toBe(42);
  }, 60000);

  it("never terminates a live holder by default, even when that means failing to open", async () => {
    // A holder that never releases the write lock. Opening is impossible in any
    // mode, so the only two outcomes are "kill it" or "give up". The default
    // must be to give up: the holder is somebody's working session.
    process.env.DUCKDB_OPEN_WAIT_MS = "2000";
    holder = await startHolder(dbPath, "rw");

    await expect(getConnection(testDir)).rejects.toThrow(/lock/i);

    expect(isAlive(holder.pid)).toBe(true);
  }, 60000);

  it("terminates an ORPHANED holder with no opt-in, and takes the lock", async () => {
    // The one kill that stays automatic. An orphaned server has no launcher left,
    // cannot be anybody's working session, and would otherwise hold the lock until
    // the machine reboots. Nothing is opted in here: DUCKDB_LOCK_RECOVERY is unset.
    //
    // This case had NO working coverage before #444. The old tests/manual version
    // invoked a `--call` flag the server no longer has, so it failed in argument
    // parsing without ever opening a database — verified against pre-fix code,
    // which failed identically. It was deleted in favour of this test.
    const orphanPid = await startOrphanedHolder(dbPath);
    orphanPidToClean = orphanPid;

    // If the platform does not reparent to init, this test cannot test what it
    // claims, so say so rather than passing vacuously.
    const ppid = await parentPidOf(orphanPid);
    expect(ppid).toBe(1);

    await getConnection(testDir);

    expect(isAlive(orphanPid)).toBe(false);
  }, 60000);

  it("terminates a live holder when force recovery is explicitly opted in", async () => {
    // The escape hatch for a genuinely wedged holder stays available.
    process.env.DUCKDB_LOCK_RECOVERY = "true";
    process.env.DUCKDB_OPEN_WAIT_MS = "20000";
    holder = await startHolder(dbPath, "rw");

    await getConnection(testDir);

    expect(isAlive(holder.pid)).toBe(false);
  }, 60000);
});
