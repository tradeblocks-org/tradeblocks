#!/usr/bin/env node
/**
 * Attempts to acquire the analytics write lock once and reports the outcome, for
 * tests/integration/duckdb-idle-release.test.ts.
 *
 * The whole point of #445 is cross-process, so proving it needs a second process
 * that actually competes for the file. This is that process.
 *
 * Usage: node tradeblocks-mcp-write-probe.mjs <db-path>
 * Prints one line: `WRITE_OK` or `WRITE_BLOCKED <first line of error>`
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { DuckDBInstance } = require("@duckdb/node-api");

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("Usage: node tradeblocks-mcp-write-probe.mjs <db-path>\n");
  process.exit(1);
}

try {
  const instance = await DuckDBInstance.create(dbPath, {
    threads: "1",
    memory_limit: "256MB",
    enable_external_access: "true",
  });
  const connection = await instance.connect();
  // A real write, not just an open — an open that succeeds but cannot write would
  // be a false pass.
  await connection.run("CREATE TABLE IF NOT EXISTS write_probe_marker(n INTEGER)");
  await connection.run("INSERT INTO write_probe_marker VALUES (1)");
  connection.closeSync();
  instance.closeSync();
  process.stdout.write("WRITE_OK\n");
} catch (error) {
  const message = String(error?.message || error).split("\n")[0];
  process.stdout.write(`WRITE_BLOCKED ${message}\n`);
}
