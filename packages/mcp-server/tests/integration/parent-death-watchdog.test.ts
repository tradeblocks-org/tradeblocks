/**
 * Integration test: stdio parent-death detection.
 *
 * Real-world topology: client -> launcher (e.g. `npx tradeblocks-mcp ...`)
 * -> node (this MCP server). When the launcher is killed without cleanly
 * propagating to its child, the MCP server is orphaned (reparented on Unix)
 * with neither of its shutdown paths firing: no SIGTERM/SIGINT ever arrives
 * (only the launcher got it, if anything), and stdin never EOFs because the
 * client — not the launcher — holds the pipe's write-end. Left alone, the
 * orphan lingers holding the DuckDB analytics database's write lock, and the
 * next session's connection attempt fails with a stale-lock error.
 *
 * This test reproduces that topology with a FIFO so the "client" write-end
 * is independent of the "launcher" process's lifecycle, kills the launcher,
 * and asserts the MCP server process exits on its own within a bounded
 * window — the proactive parent-death watchdog is the only thing that can
 * save it here.
 *
 * Spawns the BUILT server (server/index.js) — run `npm run build:mcp` first.
 * POSIX only (Unix PPID reparenting is the mechanism under test); skipped on
 * Windows.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.resolve(here, "../../server/index.js");
const LAUNCHER_SCRIPT = path.resolve(here, "../fixtures/parent-watchdog-launcher.mjs");

const describePosixOnly = process.platform === "win32" ? describe.skip : describe;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

describePosixOnly("stdio parent-death watchdog (POSIX)", () => {
  let dir: string;
  let fifoPath: string;
  let writeFd: number | null = null;
  let launcher: ChildProcess | null = null;
  let mcpPid: number | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-parent-watchdog-"));
    fifoPath = path.join(dir, "stdin.fifo");
    execFileSync("mkfifo", [fifoPath]);
    writeFd = null;
    launcher = null;
    mcpPid = null;
  });

  afterEach(() => {
    if (writeFd !== null) {
      try {
        fs.closeSync(writeFd);
      } catch {
        /* already closed */
      }
    }
    if (mcpPid !== null && isAlive(mcpPid)) {
      try {
        process.kill(mcpPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (launcher?.pid && isAlive(launcher.pid)) {
      try {
        process.kill(launcher.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("MCP server exits on its own when its launcher dies while the client keeps stdin open", async () => {
    // Fail loud (not "0 tests ran") if `npm run build:mcp` hasn't been run.
    expect(fs.existsSync(MCP_ENTRY)).toBe(true);

    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const outLog = path.join(dir, "mcp.out.log");
    const errLog = path.join(dir, "mcp.err.log");
    const pidFile = path.join(dir, "mcp.pid");

    // Open a non-blocking read end first to unblock the writer open below,
    // then hold an INDEPENDENT write-end — this is the "client" side of the
    // pipe, and it survives the launcher's death.
    const keeperFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    writeFd = fs.openSync(fifoPath, "w");
    fs.closeSync(keeperFd);

    launcher = spawn(
      process.execPath,
      [LAUNCHER_SCRIPT, MCP_ENTRY, dataDir, outLog, errLog, pidFile, fifoPath],
      { stdio: ["ignore", "ignore", "inherit"] },
    );

    // Wait for the MCP server to report ready (it opens the DuckDB
    // connection during startup, before this line ever prints).
    for (let i = 0; i < 150; i++) {
      if (fs.existsSync(pidFile)) {
        mcpPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      }
      if (mcpPid && readFileSafe(errLog).includes("ready")) break;
      await sleep(100);
    }
    if (!mcpPid || !isAlive(mcpPid)) {
      throw new Error(`MCP server never reported ready. stderr:\n${readFileSafe(errLog)}`);
    }

    // Kill the launcher. The FIFO write-end stays open (this test process
    // holds it), so the MCP server's stdin never EOFs, and it receives no
    // signal directly — only a proactive parent-death watchdog can save it.
    process.kill(launcher.pid!, "SIGKILL");

    let exitedWithinBudget = false;
    for (let i = 0; i < 80; i++) {
      if (!isAlive(mcpPid!)) {
        exitedWithinBudget = true;
        break;
      }
      await sleep(100);
    }

    expect(exitedWithinBudget).toBe(true);
  }, 20_000);
});
