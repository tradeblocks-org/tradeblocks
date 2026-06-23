/**
 * iv-solver-pool-exit.test.ts
 *
 * Process-exit safety for the shared worker pool.
 *
 * The shared pool spawns persistent worker_threads. If those workers keep the
 * libuv event loop ref'd while idle, a one-shot process that uses the pool and
 * then returns from main HANGS forever — the workers pin the loop and the
 * process never exits unless something calls process.exit() or an explicit
 * teardown. That is a latent hang for every clean-completion path.
 *
 * This test builds a small CHILD entry (esbuild → plain-Node .js so it loads on
 * any Node version, mirroring tests/global-setup.mjs for the worker) that:
 *   - gets the shared pool,
 *   - runs one solve large enough to actually spawn workers,
 *   - returns from main WITHOUT calling any destroy / teardown.
 * It then asserts the child exits on its own within a short timeout. Idle
 * workers must be unref'd so the process exits naturally when the real work is
 * done; an in-flight solve must keep the loop alive so results are never lost.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const childSrc = resolve(here, "../fixtures/iv-solver-pool-exit-child.ts");
// Output beside the pool source (src/utils) so the bundled pool's
// resolveWorkerUrl() finds the global-setup-built iv-solver-worker.js sibling.
const childOut = resolve(here, "../../src/utils/iv-solver-pool-exit-child.built.mjs");

interface ChildOutcome {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(timeoutMs: number): Promise<ChildOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [childOut], {
      cwd: here,
      env: { ...process.env, TRADEBLOCKS_IV_WORKERS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };

    const timer = setTimeout(() => {
      // The child never exited on its own — the hang we are guarding against.
      child.kill("SIGKILL");
      finish({ exited: false, code: null, signal: null, stdout, stderr });
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      finish({ exited: true, code, signal, stdout, stderr });
    });
  });
}

describe("IV solver pool — process-exit safety", () => {
  beforeAll(async () => {
    // Bundle the child to a plain-Node .mjs so it runs under any Node version
    // (CI's Node 20 strips no types). The bundle pulls in the pool's .ts
    // source; `packages: "external"` keeps node:* + deps external, same as the
    // worker bundle built in tests/global-setup.mjs.
    await build({
      entryPoints: [childSrc],
      outfile: childOut,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      packages: "external",
      logLevel: "silent",
    });
  });

  afterAll(async () => {
    await rm(childOut, { force: true });
  });

  test("a one-shot process exits on its own after a parallel solve (no teardown)", async () => {
    const outcome = await runChild(5_000);

    const detail = `\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`;
    // The child must reach "spawned workers" — otherwise the solve degraded to
    // inline and the test would pass vacuously without exercising the pool.
    expect(outcome.stdout).toContain("SPAWNED_WORKERS");
    expect(outcome.stdout).toContain("SOLVE_DONE");
    // The load-bearing assertion: it exited on its own, cleanly, within budget.
    expect(`${outcome.exited}${detail}`).toBe(`true${detail}`);
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
  }, 20_000);
});
