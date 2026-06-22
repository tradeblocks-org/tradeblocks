/**
 * Jest globalSetup — build the IV-solver worker bundle beside its source.
 *
 * The IvSolverPool spawns `iv-solver-worker` in a real worker_threads Worker.
 * Under ts-jest the pool runs from `src/utils/iv-solver-pool.ts`, so its
 * `import.meta.url` resolves the worker sibling to `src/utils/`. The production
 * `.js` bundles live in `dist/` and `server/`, never in `src/`, so without this
 * step the pool falls back to spawning `src/utils/iv-solver-worker.ts` — which
 * the worker's own Node (no ts-jest transform) cannot load, throwing
 * ERR_UNKNOWN_FILE_EXTENSION on any Node that doesn't natively strip types
 * (e.g. CI's Node 20). Building the `.js` sibling here lets resolveWorkerUrl()
 * find a plain-Node-loadable bundle, so the worker spawns cleanly in every Node
 * version without relying on a prior full build having left a bundle on disk.
 *
 * This protects ANY test that spins the pool, not just the parity test, and
 * leaves the production resolveWorkerUrl branch untouched (production still
 * spawns the dist/server bundle). The `src/utils/iv-solver-worker.js` artifact
 * is transient and gitignored.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const workerSrc = resolve(here, "../src/utils/iv-solver-worker.ts");
const workerOut = resolve(here, "../src/utils/iv-solver-worker.js");

export default async function globalSetup() {
  // These esbuild options must mirror the `build:iv-worker` script in
  // package.json — the test bundle should match the production bundle's shape
  // so a loadability/behavior issue can't slip past CI by differing here.
  await build({
    entryPoints: [workerSrc],
    outfile: workerOut,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
    logLevel: "silent",
  });
}
