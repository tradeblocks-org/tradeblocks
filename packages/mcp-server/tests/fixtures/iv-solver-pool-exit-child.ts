/**
 * Child process for the pool process-exit-safety test.
 *
 * Gets the shared pool, runs one parallel solve large enough to spawn real
 * workers, then returns from main WITHOUT any teardown. If idle workers keep
 * the event loop alive this process hangs; if they are unref'd it exits on its
 * own. The parent asserts a clean self-exit within a short timeout.
 *
 * Markers on stdout let the parent confirm the pool actually went parallel
 * (so the assertion isn't vacuously satisfied by an inline degrade).
 */

import { getSharedIvSolverPool } from "../../src/utils/iv-solver-pool.ts";
import type { IvSolveJob } from "../../src/utils/iv-solver-pool.ts";

async function main(): Promise<void> {
  const pool = getSharedIvSolverPool();

  // Comfortably above the inline threshold (2000) so the batch shards across
  // real workers rather than solving inline on this thread.
  const count = 8_000;
  const jobs: IvSolveJob[] = Array.from({ length: count }, (_, i) => ({
    optionPrice: 30 + (i % 40),
    underlyingPrice: 5150,
    strike: 5000 + (i % 300),
    dte: 5 + (i % 60),
    type: (i % 2 === 0 ? "C" : "P") as "C" | "P",
    riskFreeRate: 0.045,
    dividendYield: 0,
  }));

  const results = await pool.solve(jobs);

  // Confirm the pool actually held workers (i.e. went parallel). The private
  // `pool` array is read reflectively only to assert the test exercised the
  // worker path; production code never reaches in like this.
  const workerCount = (pool as unknown as { pool: unknown[] }).pool.length;
  if (workerCount > 0) {
    process.stdout.write(`SPAWNED_WORKERS=${workerCount}\n`);
  }
  process.stdout.write(`SOLVE_DONE=${results.length}\n`);

  // Intentionally NO destroy()/destroySharedIvSolverPool() here. A correct,
  // exit-safe pool leaves its idle workers unref'd, so returning from main
  // lets the process exit naturally.
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
