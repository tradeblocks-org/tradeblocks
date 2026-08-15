/**
 * Parent-death detection for the stdio MCP transport.
 *
 * Some launchers (e.g. `npx tradeblocks-mcp ...`) sit between the real
 * client and this process: client -> launcher -> node (MCP server). If the
 * launcher is killed without cleanly propagating a signal to its child, this
 * process is orphaned and neither of the existing shutdown paths fires — no
 * SIGTERM/SIGINT ever arrives (only the launcher got it, if anything did),
 * and stdin never EOFs because the client, not the launcher, holds the
 * pipe's write-end. Left alone, the orphan lingers holding the DuckDB
 * analytics database's write lock, and the next session's connection
 * attempt fails with a stale-lock error.
 *
 * This module holds the pure "should we shut down?" decision so it can be
 * unit-tested without spawning real processes. The poll loop that calls it
 * on an interval lives in index.ts, stdio mode only.
 */

export interface ShouldShutdownOnParentChangeParams {
  /** True when running on Windows (`process.platform === "win32"`). */
  isWindows: boolean;
  /** `process.ppid` captured once at process startup. */
  startupPpid: number;
  /** `process.ppid` read at the moment of the check. Ignored on Windows. */
  currentPpid: number;
  /**
   * Whether the ORIGINAL parent process (`startupPpid`) is still alive right
   * now. Ignored on Unix, where reparenting — not liveness — is the signal.
   */
  startupParentAlive: boolean;
}

/**
 * Decide whether the stdio MCP server should proactively exit because its
 * launching parent process appears to have died.
 *
 * Unix: a child that loses its parent is reparented (typically to PID 1, the
 * OS's orphan reaper), so comparing the current PPID against the PPID
 * captured at startup is the signal. If the process was ALREADY parented to
 * PID 1 when it started (e.g. launched directly under systemd), there is no
 * launcher to watch — never fire, regardless of `currentPpid`.
 *
 * Windows: PPID does not change when a parent process dies, so reparenting
 * can't be used as the signal there. Instead, watch whether the original
 * parent (captured at startup) is still alive.
 */
export function shouldShutdownOnParentChange(params: ShouldShutdownOnParentChangeParams): boolean {
  const { isWindows, startupPpid, currentPpid, startupParentAlive } = params;

  if (isWindows) {
    return !startupParentAlive;
  }

  if (startupPpid === 1) {
    // Already orphaned at startup (e.g. systemd-launched) — nothing to watch.
    return false;
  }

  return currentPpid !== startupPpid;
}
