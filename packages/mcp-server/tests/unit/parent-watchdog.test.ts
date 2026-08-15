/**
 * Unit tests for the stdio parent-death decision function.
 *
 * Pure, cross-platform coverage for `shouldShutdownOnParentChange` — the
 * "should we shut down?" logic factored out of index.ts's poll loop so it
 * can be exercised without spawning real processes. See
 * tests/integration/parent-death-watchdog.test.ts for the POSIX
 * end-to-end proof.
 */

import { shouldShutdownOnParentChange } from "../../src/parent-watchdog.ts";

describe("shouldShutdownOnParentChange", () => {
  it("fires on Unix when reparented (PPID changed from the captured startup PPID)", () => {
    // The launcher (PID 4242) died; the OS reparented us to PID 1 (init).
    expect(
      shouldShutdownOnParentChange({
        isWindows: false,
        startupPpid: 4242,
        currentPpid: 1,
        startupParentAlive: false, // irrelevant on Unix
      }),
    ).toBe(true);
  });

  it("fires on Windows when the original parent is no longer alive", () => {
    // Windows PPID never changes, so currentPpid stays equal to startupPpid
    // even after the parent dies — startupParentAlive is the only signal.
    expect(
      shouldShutdownOnParentChange({
        isWindows: true,
        startupPpid: 4242,
        currentPpid: 4242,
        startupParentAlive: false,
      }),
    ).toBe(true);
  });

  it("does not fire on Unix while the launcher's PID is still our parent", () => {
    expect(
      shouldShutdownOnParentChange({
        isWindows: false,
        startupPpid: 4242,
        currentPpid: 4242,
        startupParentAlive: true,
      }),
    ).toBe(false);
  });

  it("does not fire on Windows while the original parent is still alive", () => {
    expect(
      shouldShutdownOnParentChange({
        isWindows: true,
        startupPpid: 4242,
        currentPpid: 4242,
        startupParentAlive: true,
      }),
    ).toBe(false);
  });

  it("never fires on Unix when already orphaned at startup (PPID 1, e.g. systemd)", () => {
    // No launcher to watch — installing the watchdog would be dead weight,
    // and even if it ran, it must never self-terminate a systemd-launched
    // process just because it stays parented to PID 1.
    expect(
      shouldShutdownOnParentChange({
        isWindows: false,
        startupPpid: 1,
        currentPpid: 1,
        startupParentAlive: true,
      }),
    ).toBe(false);
  });

  it("stays silent for an already-orphaned Unix start even if currentPpid drifts", () => {
    // Defense in depth: the "already orphaned at startup" guard holds
    // regardless of what currentPpid later reports.
    expect(
      shouldShutdownOnParentChange({
        isWindows: false,
        startupPpid: 1,
        currentPpid: 99,
        startupParentAlive: true,
      }),
    ).toBe(false);
  });
});
