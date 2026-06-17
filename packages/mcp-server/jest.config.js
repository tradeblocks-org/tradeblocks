/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Map to the built server output which has all dependencies bundled
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      isolatedModules: true
    }]
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
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
  workerIdleMemoryLimit: '512MB',
  maxWorkers: '50%'
};
