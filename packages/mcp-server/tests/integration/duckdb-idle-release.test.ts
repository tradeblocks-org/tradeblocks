/**
 * Integration tests: releasing the analytics handle when idle (#445).
 *
 * Background. The analytics database allows many readers at once but no writer
 * alongside them — a READER blocks a writer (measured; see the lock matrix in
 * db/connection.ts). The server used to open read-only at startup and keep that
 * handle for its whole lifetime, so a server that was doing nothing at all still
 * blocked every write in every other server on the same data directory. #444 stopped
 * the servers killing each other; this is the half that makes writes work.
 *
 * The fix is a lease: the handle is held while work is in flight and closed shortly
 * after the last lease drops. So the tests here have to cover both directions —
 * the handle really is released when nobody is using it, AND it is never released
 * out from under someone who is.
 */
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

// @ts-expect-error - importing from the source barrel used by the other suites
import {
  getConnection,
  closeConnection,
  isConnected,
  acquireConnectionLease,
  releaseConnectionLease,
  getConnectionLeaseCount,
  withConnectionLease,
} from "../../src/test-exports.ts";

const WRITE_PROBE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "tradeblocks-mcp-write-probe.mjs",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the out-of-process write probe and return its single output line. */
async function probeWrite(dbPath: string): Promise<string> {
  const child = spawn("node", [WRITE_PROBE, dbPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  await new Promise((resolve) => child.on("exit", resolve));
  return stdout.trim();
}

/** Poll until `predicate` holds, so a timer's exact firing instant is never raced. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("Releasing the analytics handle when idle", () => {
  let testDir: string;
  let dbPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "tb-idle-release-"));
    dbPath = path.join(testDir, "analytics.duckdb");
    savedEnv.DUCKDB_IDLE_RELEASE_MS = process.env.DUCKDB_IDLE_RELEASE_MS;
    // Short grace so the suite is not dominated by waiting. The behaviour under
    // test is the release itself, not its duration.
    process.env.DUCKDB_IDLE_RELEASE_MS = "150";
  }, 60000);

  afterEach(async () => {
    // Drain any lease a failing test left behind, or the next test inherits it.
    while (getConnectionLeaseCount() > 0) releaseConnectionLease();
    await closeConnection();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(testDir, { recursive: true, force: true });
  }, 60000);

  it("releases the startup handle, which no tool call owns", async () => {
    // The startup open belongs to no tool and was the specific handle that used to
    // sit on the file for the life of the process.
    await getConnection(testDir);
    expect(isConnected()).toBe(true);

    await waitFor(() => !isConnected(), 5000, "the idle handle to be released");
  }, 60000);

  it("lets another process take the write lock once this one goes idle", async () => {
    // The actual defect, end to end and across a process boundary. Before the fix
    // this probe could never succeed while this process was alive.
    await getConnection(testDir);
    await waitFor(() => !isConnected(), 5000, "the idle handle to be released");

    const result = await probeWrite(dbPath);

    expect(result).toBe("WRITE_OK");
  }, 60000);

  it("holds the handle open for as long as a lease is held", async () => {
    await getConnection(testDir);
    acquireConnectionLease();

    // Well past the grace. A release here would be closing the file under live work.
    await sleep(600);
    expect(isConnected()).toBe(true);

    releaseConnectionLease();
    await waitFor(() => !isConnected(), 5000, "release after the lease dropped");
  }, 60000);

  it("keeps a connection reference usable across the grace period", async () => {
    // Tool handlers hold a connection across awaits. That is exactly what a naive
    // idle timer would break, so it is worth asserting on the reference itself
    // rather than only on isConnected().
    const result = await withConnectionLease(async () => {
      const connection = await getConnection(testDir);
      await sleep(600);
      const rows = await connection.runAndReadAll("SELECT 7 AS answer");
      return Number(rows.getRows()[0][0]);
    });

    expect(result).toBe(7);
  }, 60000);

  it("blocks another process's write while a lease is held", async () => {
    // The converse of the release test. If this passed trivially — because the
    // handle were released regardless — the release test above would prove nothing.
    await getConnection(testDir);
    acquireConnectionLease();
    await sleep(600);

    const result = await probeWrite(dbPath);

    expect(result).toMatch(/^WRITE_BLOCKED/);
    releaseConnectionLease();
  }, 60000);

  it("shares one open across concurrent callers", async () => {
    // Two callers finding the handle released must not each open it: the second
    // open would collide with the first on the file lock and report contention
    // against our own process.
    await getConnection(testDir);
    await waitFor(() => !isConnected(), 5000, "the idle handle to be released");

    const connections = await Promise.all([
      getConnection(testDir),
      getConnection(testDir),
      getConnection(testDir),
      getConnection(testDir),
    ]);

    for (const connection of connections) {
      expect(connection).toBe(connections[0]);
    }
    const rows = await connections[0].runAndReadAll("SELECT 1");
    expect(Number(rows.getRows()[0][0])).toBe(1);
  }, 60000);

  it("reopens on demand after a release", async () => {
    await getConnection(testDir);
    await waitFor(() => !isConnected(), 5000, "the idle handle to be released");

    const connection = await getConnection(testDir);

    expect(isConnected()).toBe(true);
    const rows = await connection.runAndReadAll("SELECT 3 AS n");
    expect(Number(rows.getRows()[0][0])).toBe(3);
  }, 60000);
});
