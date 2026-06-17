#!/usr/bin/env node
/**
 * Minimal DuckDB lock holder for orphan recovery testing.
 * Opens the DB in read-write mode and holds the lock until killed.
 *
 * Usage: node _lock-holder.mjs <path-to-analytics.duckdb>
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { DuckDBInstance } = require("@duckdb/node-api");

import fs from "fs";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("Usage: node _lock-holder.mjs <db-path>\n");
  process.exit(1);
}

const errFile = dbPath + ".test-err";

try {
  const instance = await DuckDBInstance.create(dbPath, {
    threads: "1",
    memory_limit: "64MB",
    enable_external_access: "false",
  });
  await instance.connect();

  // Signal that we're alive and holding the lock
  process.stderr.write(`Lock holder ready: PID=${process.pid} DB=${dbPath}\n`);

  // Keep the process alive indefinitely
  setInterval(() => {}, 60000);
} catch (e) {
  fs.writeFileSync(errFile, e.message || String(e));
  process.exit(1);
}
