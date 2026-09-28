/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // Map to the built server output which has all dependencies bundled
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        isolatedModules: true,
      },
    ],
  },
  testMatch: ["**/tests/**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  // Builds src/utils/iv-solver-worker.js before any test runs so the
  // worker pool can spawn a plain-Node-loadable bundle under ts-jest. See
  // tests/global-setup.mjs for why this is needed (CI's Node 20 rejects the
  // .ts worker fallback that resolveWorkerUrl uses when the .js is absent).
  globalSetup: "<rootDir>/tests/global-setup.mjs",
  // --------------------------------------------------------------------------
  // Worker recycling — see .planning/debug/ci-jest-oom.md for the full writeup.
  //
  // The mcp-server suite allocates a lot of native DuckDB state across ~50
  // test files. V8's GC can't reclaim native handles, so a single long-lived
  // worker accumulates memory across suites until it hits the heap ceiling
  // (symptom: slow GC death spiral, average mu ≈ 0.08, heap climbing toward
  // `--max-old-space-size` over ~10 min, then SIGABRT).
  //
  // `workerIdleMemoryLimit` makes Jest 29+ recycle the worker process once
  // its RSS exceeds the threshold — this releases all native DuckDB memory
  // cleanly, independent of per-test hygiene. `maxWorkers: '50%'` is an
  // explicit cap so CI (4-core ubuntu-latest) consistently runs 2 workers.
  // --------------------------------------------------------------------------
  workerIdleMemoryLimit: "512MB",
  maxWorkers: "50%",
  // --------------------------------------------------------------------------
  // Test timeout: the suite is I/O-bound, not CPU-bound.
  //
  // Most suites use real DuckDB files, Parquet writes and the durable
  // provenance stores in os.tmpdir(). The provenance stores fsync every
  // directory they touch, so one suite can issue ~9,500 serialized fsyncs, and
  // a CPU profile of the slowest test is ~90% idle waiting on them. A test's
  // wall time follows the disk's flush latency, which grows with every other
  // writer on the machine: other Jest workers, other checkouts, builds. On an
  // idle 32-core box the slowest test takes ~8.5 s; under ordinary shared-host
  // load, passing tests reached ~14 s, against Jest's 5 s default and the 15 s
  // the provenance suites used to set. The tests are correct but I/O-bound, so
  // they get a budget sized for a loaded host rather than an idle one.
  // Measured with strace and --cpu-prof on the provenance suites.
  // --------------------------------------------------------------------------
  testTimeout: 60_000,
};
