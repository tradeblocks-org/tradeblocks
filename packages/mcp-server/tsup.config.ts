import { defineConfig } from "tsup";

export default defineConfig([
  // Main MCP server entry (executable) - outputs to server/ (the `bin` target)
  {
    entry: ["src/index.ts"],
    outDir: "server",
    format: ["esm"],
    target: "node18",
    clean: true,
    dts: true,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    // npm resolves runtime dependencies from the installed node_modules, so they
    // stay external (not inlined). DuckDB's native bindings (.node files) in
    // particular cannot be bundled and are always resolved at runtime.
    // http-server.ts is dynamically imported - built separately below
    external: ["./http-server.js", "@duckdb/node-api", "@duckdb/node-bindings", /^@duckdb\//],
    // Bundle @tradeblocks workspace packages
    noExternal: [/^@tradeblocks\//],
  },
  // Test exports module - bundle utilities for testing
  {
    entry: ["src/test-exports.ts"],
    outDir: "dist",
    format: ["esm"],
    target: "node18",
    dts: false, // Skip DTS for test exports
    sourcemap: true,
    // Bundle workspace package content
    noExternal: [/^@tradeblocks\//],
  },
  // iv-solver-worker is NOT a tsup entry — tsup's multi-entry code-splitting
  // breaks the worker's self-containment and drops its side-effect message
  // handler. It is built as a standalone esbuild bundle (see the
  // build:iv-worker script in package.json), one flat file per output dir, so
  // the worker pool can spawn it as a sibling of the runtime that loads it.
]);
