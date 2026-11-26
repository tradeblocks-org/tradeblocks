/**
 * run_sql sandbox: the query runs on a DuckDB instance that cannot touch the
 * filesystem outside --data-root or the network, enforced by DuckDB's own
 * configuration (not by pattern-matching the SQL text).
 *
 * These tests drive the registered run_sql handler against a real database and
 * check effects, not just error strings: a loopback HTTP server counts requests
 * and a canary file outside the data root must never be read or created.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeConnection,
  getConnection,
  getConnectionMode,
  upgradeToReadWrite,
  downgradeToReadOnly,
} from "../../src/db/connection.ts";
import { registerSQLTools } from "../../src/tools/sql.ts";
import {
  assertReadOnlyStatements,
  openQuerySandbox,
  type QuerySandbox,
} from "../../src/db/query-sandbox.ts";
import type { ToolOutput } from "../../src/utils/output-formatter.ts";

type Handler = (args: Record<string, unknown>) => Promise<ToolOutput>;

let root: string;
let outside: string;
let handlers: Record<string, Handler>;
let http: Server;
let httpUrl: string;
let httpHits = 0;

beforeAll(async () => {
  http = createServer((_req, res) => {
    httpHits += 1;
    res.setHeader("content-type", "text/csv");
    res.end("x\n1\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(async () => {
  httpHits = 0;
  root = await mkdtemp(path.join(tmpdir(), "tb-sql-sandbox-"));
  outside = await mkdtemp(path.join(tmpdir(), "tb-sql-outside-"));
  await mkdir(path.join(root, "blocks"));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data", "ok.csv"), "x\n1\n2\n3\n");
  await writeFile(path.join(root, "data", "ok.json"), '[{"x":1},{"x":2}]');
  await writeFile(path.join(outside, "secret.csv"), "x\n41\n42\n");
  await writeFile(path.join(outside, "secret.json"), '[{"x":41}]');
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  await mkdir(`${root}-evil`);
  await writeFile(path.join(`${root}-evil`, "secret.csv"), "x\n41\n42\n");

  await getConnection(root);
  const conn = await upgradeToReadWrite(root);
  await conn.run(
    `COPY (SELECT 7 AS x) TO '${path.join(root, "data", "ok.parquet")}' (FORMAT parquet)`,
  );
  await conn.run(
    `COPY (SELECT 41 AS x) TO '${path.join(outside, "secret.parquet")}' (FORMAT parquet)`,
  );
  await downgradeToReadOnly(root);

  handlers = {};
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerSQLTools(server, root);
});

afterEach(async () => {
  await closeConnection();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(`${root}-evil`, { recursive: true, force: true });
});

async function sql(query: string, confirm = false) {
  return handlers.run_sql({ query, limit: 100, confirm });
}

function text(out: ToolOutput): string {
  return out.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

async function expectRefused(query: string, confirm = false) {
  const out = await sql(query, confirm);
  expect(out.isError).toBe(true);
  expect(out.structuredContent?.rows).toBeUndefined();
  return out;
}

describe("run_sql sandbox: reads outside --data-root are refused", () => {
  // The exact class reported: the auto-detecting readers were not path-gated.
  test.each([
    ["read_csv_auto", () => `SELECT count(*) FROM read_csv_auto('${outside}/secret.csv')`],
    ["read_csv", () => `SELECT count(*) FROM read_csv('${outside}/secret.csv')`],
    ["read_json_auto", () => `SELECT count(*) FROM read_json_auto('${outside}/secret.json')`],
    ["read_json", () => `SELECT count(*) FROM read_json('${outside}/secret.json')`],
    ["read_ndjson_auto", () => `SELECT count(*) FROM read_ndjson_auto('${outside}/secret.json')`],
    ["read_json_objects", () => `SELECT count(*) FROM read_json_objects('${outside}/secret.json')`],
    ["read_parquet", () => `SELECT count(*) FROM read_parquet('${outside}/secret.parquet')`],
    ["parquet_scan", () => `SELECT count(*) FROM parquet_scan('${outside}/secret.parquet')`],
    ["read_blob", () => `SELECT count(*) FROM read_blob('${outside}/secret.txt')`],
    ["read_text", () => `SELECT count(*) FROM read_text('${outside}/secret.txt')`],
    ["glob", () => `SELECT count(*) FROM glob('${outside}/*')`],
    ["sniff_csv", () => `SELECT * FROM sniff_csv('${outside}/secret.csv')`],
    [
      "parquet_metadata",
      () => `SELECT count(*) FROM parquet_metadata('${outside}/secret.parquet')`,
    ],
    ["replacement scan of a path literal", () => `SELECT count(*) FROM '${outside}/secret.csv'`],
    [
      "replacement scan inside a subquery/CTE",
      () => `WITH a AS (SELECT * FROM '${outside}/secret.csv') SELECT count(*) FROM a`,
    ],
    [
      "path traversal out of the data root",
      () =>
        `SELECT count(*) FROM read_csv_auto('${root}/data/../../${path.basename(outside)}/secret.csv')`,
    ],
    [
      "sibling directory sharing the data-root prefix",
      () => `SELECT count(*) FROM read_csv_auto('${root}-evil/secret.csv')`,
    ],
    [
      "read through a function argument the text scanner cannot see",
      () => `SELECT count(*) FROM read_csv_auto(concat('${outside}', '/sec', 'ret.csv'))`,
    ],
    [
      "read through a scalar subquery path",
      () => `SELECT count(*) FROM read_csv_auto((SELECT '${outside}/secret.csv'))`,
    ],
  ])("%s", async (_name, build) => {
    const out = await expectRefused(build());
    expect(text(out)).not.toMatch(/\b4[12]\b/);
  });

  test("outside canary content never appears in any refusal", async () => {
    const out = await sql(`SELECT * FROM read_csv_auto('${outside}/secret.csv')`);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain("top secret");
  });
});

describe("run_sql sandbox: no network", () => {
  test.each([
    ["read_csv_auto over http", () => `SELECT count(*) FROM read_csv_auto('${httpUrl}/a.csv')`],
    ["read_csv over http", () => `SELECT count(*) FROM read_csv('${httpUrl}/a.csv')`],
    ["read_json_auto over http", () => `SELECT count(*) FROM read_json_auto('${httpUrl}/a.json')`],
    ["read_parquet over http", () => `SELECT count(*) FROM read_parquet('${httpUrl}/a.parquet')`],
    ["bare URL replacement scan", () => `SELECT count(*) FROM '${httpUrl}/a.csv'`],
    ["https replacement scan", () => `SELECT count(*) FROM 'https://127.0.0.1:1/a.csv'`],
    ["s3 URL", () => `SELECT count(*) FROM read_parquet('s3://bucket/key.parquet')`],
    ["glob over http", () => `SELECT count(*) FROM glob('${httpUrl}/*')`],
  ])("%s", async (_name, build) => {
    await expectRefused(build());
    expect(httpHits).toBe(0);
  });

  test("a URL via ATTACH does not connect", async () => {
    await expectRefused(`ATTACH '${httpUrl}/db.duckdb' AS remote`);
    expect(httpHits).toBe(0);
  });
});

describe("run_sql sandbox: statements that change files, catalogs or configuration", () => {
  test.each([
    ["COPY TO a file outside", () => `COPY (SELECT 1) TO '${outside}/exfil.csv'`],
    ["COPY TO a file inside", () => `COPY (SELECT 1) TO '${root}/data/exfil.csv'`],
    ["COPY FROM a file outside", () => `COPY trades.trade_data FROM '${outside}/secret.csv'`],
    ["EXPORT DATABASE", () => `EXPORT DATABASE '${outside}/export'`],
    ["ATTACH a local file", () => `ATTACH '${outside}/other.duckdb' AS other`],
    [
      "ATTACH a local file as READ_ONLY",
      () => `ATTACH '${root}/analytics.duckdb' AS dup (READ_ONLY)`,
    ],
    ["DETACH market", () => `DETACH market`],
    ["INSTALL an extension", () => `INSTALL httpfs`],
    ["LOAD an extension", () => `LOAD httpfs`],
    [
      "FORCE INSTALL from a custom repository",
      () => `FORCE INSTALL httpfs FROM 'http://127.0.0.1:1/'`,
    ],
    ["SET enable_external_access", () => `SET enable_external_access=true`],
    ["SET allowed_directories", () => `SET allowed_directories=['/']`],
    ["SET lock_configuration off", () => `SET lock_configuration=false`],
    ["SET autoinstall_known_extensions", () => `SET autoinstall_known_extensions=true`],
    ["RESET enable_external_access", () => `RESET enable_external_access`],
    ["PRAGMA enable_external_access", () => `PRAGMA enable_external_access=true`],
    [
      "CALL enable_logging to a caller-chosen path",
      () => `CALL enable_logging(storage='file', storage_config={'path': '${outside}/log'})`,
    ],
    ["SET hidden behind a leading statement", () => `SELECT 1; SET enable_external_access=true`],
    ["SET hidden behind a comment", () => `/* x */ SET enable_external_access=true`],
    [
      "multi-statement: unlock then read",
      () =>
        `SELECT 1; SET enable_external_access=true; SELECT count(*) FROM read_csv_auto('${outside}/secret.csv')`,
    ],
    ["lowercase set", () => `select 1;\nset enable_external_access = true`],
  ])("%s", async (_name, build) => {
    await expectRefused(build());
    await expect(stat(path.join(outside, "exfil.csv"))).rejects.toThrow();
    await expect(stat(path.join(root, "data", "exfil.csv"))).rejects.toThrow();
    await expect(stat(path.join(outside, "export"))).rejects.toThrow();
    await expect(stat(path.join(outside, "other.duckdb"))).rejects.toThrow();
  });

  test("a refused unlock attempt leaves the sandbox locked for the next query", async () => {
    await sql(`SELECT 1; SET enable_external_access=true`);
    await expectRefused(`SELECT count(*) FROM read_csv_auto('${outside}/secret.csv')`);
    expect(httpHits).toBe(0);
  });
});

describe("run_sql sandbox: confirm=true mutations are sandboxed too", () => {
  test("CREATE TABLE AS from an outside file is refused and creates nothing", async () => {
    const out = await sql(
      `CREATE TABLE trades.stolen AS SELECT * FROM read_csv_auto('${outside}/secret.csv')`,
      true,
    );
    expect(out.isError).toBe(true);
    const check = await sql(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'stolen'`,
    );
    expect(check.structuredContent?.rows).toEqual([{ n: 0 }]);
  });

  test("INSERT from a URL replacement scan is refused and makes no request", async () => {
    await sql(`CREATE TABLE trades.scratch (x BIGINT)`, true);
    const out = await sql(`INSERT INTO trades.scratch SELECT * FROM '${httpUrl}/a.csv'`, true);
    expect(out.isError).toBe(true);
    expect(httpHits).toBe(0);
  });

  test("DELETE preview does not run an outside read in its WHERE clause", async () => {
    await sql(`CREATE TABLE trades.scratch AS SELECT * FROM range(40, 45) t(x)`, true);
    const out = await sql(
      `DELETE FROM trades.scratch WHERE x IN (SELECT x FROM '${outside}/secret.csv')`,
    );
    // 41 and 42 are in the outside file and in the table: were the outside read
    // to run, the preview would report 2 affected rows.
    expect(out.structuredContent?.affectedRows).toBeUndefined();
    expect(text(out)).toMatch(/Could not preview/);
  });

  test("the lockdown is scoped to the statement: connection returns to read-only and unlocked for other tools", async () => {
    await sql(
      `CREATE TABLE trades.stolen AS SELECT * FROM read_csv_auto('${outside}/secret.csv')`,
      true,
    );
    expect(getConnectionMode()).toBe("read_only");
    // The server's own connection keeps its internal capabilities (local ATTACH,
    // reads of arbitrary source files for imports) once run_sql is done.
    const shared = await getConnection(root);
    const rows = (
      await shared.runAndReadAll(`SELECT count(*) AS n FROM read_csv_auto('${outside}/secret.csv')`)
    ).getRows();
    expect(Number(rows[0][0])).toBe(2);
  });

  test("a legitimate confirmed mutation still works and persists", async () => {
    const created = await sql(`CREATE TABLE trades.scratch AS SELECT 5 AS x`, true);
    expect(created.isError).not.toBe(true);
    const inserted = await sql(`INSERT INTO trades.scratch VALUES (6)`, true);
    expect(inserted.isError).not.toBe(true);
    const read = await sql(`SELECT sum(x) AS s FROM trades.scratch`);
    expect(read.structuredContent?.rows).toEqual([{ s: 11 }]);
    const deleted = await sql(`DELETE FROM trades.scratch WHERE x = 6`, true);
    expect(deleted.isError).not.toBe(true);
    const after = await sql(`SELECT count(*) AS n FROM trades.scratch`);
    expect(after.structuredContent?.rows).toEqual([{ n: 1 }]);
  });
});

describe("run_sql sandbox: legitimate reads keep working", () => {
  test("trades and market catalogs are queryable", async () => {
    const trades = await sql(`SELECT count(*) AS n FROM trades.trade_data`);
    expect(trades.isError).not.toBe(true);
    const market = await sql(`SELECT count(*) AS n FROM market._sync_metadata`);
    expect(market.isError).not.toBe(true);
    const joined = await sql(
      `SELECT count(*) AS n FROM trades.trade_data t LEFT JOIN market._sync_metadata m ON true`,
    );
    expect(joined.isError).not.toBe(true);
    const info = await sql(
      `SELECT table_schema FROM information_schema.tables WHERE table_name = 'trade_data'`,
    );
    expect(info.structuredContent?.rows).toEqual([{ table_schema: "trades" }]);
  });

  test("pure SQL, CTEs, generators and macros-free functions work", async () => {
    const out = await sql(
      `WITH s AS (SELECT * FROM range(5) t(i)) SELECT sum(i) AS s, count(*) AS n FROM s`,
    );
    expect(out.structuredContent?.rows).toEqual([{ s: 10, n: 5 }]);
  });

  test.each([
    ["read_csv", () => `SELECT count(*) AS n FROM read_csv('${root}/data/ok.csv')`, 3],
    ["read_csv_auto", () => `SELECT count(*) AS n FROM read_csv_auto('${root}/data/ok.csv')`, 3],
    ["read_json_auto", () => `SELECT count(*) AS n FROM read_json_auto('${root}/data/ok.json')`, 2],
    ["read_parquet", () => `SELECT count(*) AS n FROM read_parquet('${root}/data/ok.parquet')`, 1],
    ["glob in root", () => `SELECT count(*) AS n FROM glob('${root}/data/*.csv')`, 1],
    ["replacement scan in root", () => `SELECT count(*) AS n FROM '${root}/data/ok.csv'`, 3],
    [
      "read_csv glob in root",
      () => `SELECT count(*) AS n FROM read_csv_auto('${root}/data/*.csv')`,
      3,
    ],
  ])("in-root %s is allowed", async (_name, build, expected) => {
    const out = await sql(build());
    expect(out.isError).not.toBe(true);
    expect(out.structuredContent?.rows).toEqual([{ n: expected }]);
  });

  test("a query result is not affected by the number of calls (sandbox is released each time)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const out = await sql(`SELECT ${i} AS i`);
      expect(out.structuredContent?.rows).toEqual([{ i }]);
    }
    expect(await readFile(path.join(root, "data", "ok.csv"), "utf8")).toContain("1");
  });

  test("the shared server connection still reads outside files (import tools depend on it)", async () => {
    await sql(`SELECT 1`);
    const shared = await getConnection(root);
    const rows = (
      await shared.runAndReadAll(`SELECT count(*) FROM read_csv_auto('${outside}/secret.csv')`)
    ).getRows();
    expect(Number(rows[0][0])).toBe(2);
  });
});

/**
 * The run_sql handler also screens the SQL text, which would mask a regression
 * in the DuckDB-level lockdown. These tests skip the text screen and run each
 * vector straight on the sandbox instance, so only DuckDB's own settings can
 * stop them.
 */
describe("sandbox instance enforces the lockdown by itself (no SQL-text screening)", () => {
  let sandbox: QuerySandbox;
  beforeEach(async () => {
    sandbox = await openQuerySandbox(root, root);
  });
  afterEach(() => {
    sandbox.close();
  });

  async function run(query: string) {
    const result = await sandbox.conn.runAndReadAll(query);
    return result.getRows();
  }

  const outsideQueries: Array<[string, () => string]> = [
    ["read_csv_auto", () => `SELECT * FROM read_csv_auto('${outside}/secret.csv')`],
    ["read_csv", () => `SELECT * FROM read_csv('${outside}/secret.csv')`],
    ["read_json_auto", () => `SELECT * FROM read_json_auto('${outside}/secret.json')`],
    ["read_ndjson_auto", () => `SELECT * FROM read_ndjson_auto('${outside}/secret.json')`],
    ["read_json_objects", () => `SELECT * FROM read_json_objects('${outside}/secret.json')`],
    ["read_parquet", () => `SELECT * FROM read_parquet('${outside}/secret.parquet')`],
    ["parquet_scan", () => `SELECT * FROM parquet_scan('${outside}/secret.parquet')`],
    ["parquet_metadata", () => `SELECT * FROM parquet_metadata('${outside}/secret.parquet')`],
    ["read_blob", () => `SELECT * FROM read_blob('${outside}/secret.txt')`],
    ["read_text", () => `SELECT * FROM read_text('${outside}/secret.txt')`],
    ["glob", () => `SELECT * FROM glob('${outside}/*')`],
    ["sniff_csv", () => `SELECT * FROM sniff_csv('${outside}/secret.csv')`],
    ["replacement scan", () => `SELECT * FROM '${outside}/secret.csv'`],
    ["computed path", () => `SELECT * FROM read_csv_auto(concat('${outside}', '/secret.csv'))`],
    [
      "traversal",
      () =>
        `SELECT * FROM read_csv_auto('${root}/data/../../${path.basename(outside)}/secret.csv')`,
    ],
    ["prefix sibling", () => `SELECT * FROM read_csv_auto('${root}-evil/secret.csv')`],
    ["COPY to outside", () => `COPY (SELECT 1) TO '${outside}/exfil.csv'`],
    ["ATTACH outside file", () => `ATTACH '${outside}/o.duckdb' AS o`],
    ["EXPORT DATABASE", () => `EXPORT DATABASE '${outside}/export'`],
    ["http read_csv_auto", () => `SELECT * FROM read_csv_auto('${httpUrl}/a.csv')`],
    ["http replacement scan", () => `SELECT * FROM '${httpUrl}/a.csv'`],
    ["http glob", () => `SELECT * FROM glob('${httpUrl}/*')`],
    ["INSTALL", () => `INSTALL httpfs`],
    ["LOAD", () => `LOAD httpfs`],
    ["LOAD via path", () => `LOAD '${outside}/evil.duckdb_extension'`],
    ["SET enable_external_access", () => `SET enable_external_access=true`],
    ["SET allowed_directories", () => `SET allowed_directories=['/']`],
    ["SET lock_configuration", () => `SET lock_configuration=false`],
    ["SET autoload_known_extensions", () => `SET autoload_known_extensions=true`],
    ["SET temp_directory", () => `SET temp_directory='${outside}/tmp'`],
    ["SET home_directory", () => `SET home_directory='${outside}'`],
    ["RESET", () => `RESET enable_external_access`],
  ];

  test.each(outsideQueries)("%s is refused by DuckDB", async (_name, build) => {
    await expect(run(build())).rejects.toThrow();
    expect(httpHits).toBe(0);
    await expect(stat(path.join(outside, "exfil.csv"))).rejects.toThrow();
    await expect(stat(path.join(root, "data", "exfil.csv"))).rejects.toThrow();
    await expect(stat(path.join(outside, "export"))).rejects.toThrow();
    await expect(stat(path.join(outside, "o.duckdb"))).rejects.toThrow();
  });

  // DuckDB's allow-list permits writes under the data root as well as reads, so
  // the read path refuses non-read statements before running anything.
  test.each([
    ["COPY into the data root", () => `COPY (SELECT 1) TO '${root}/data/exfil.csv' (FORMAT csv)`],
    ["EXPLAIN ANALYZE COPY", () => `EXPLAIN ANALYZE COPY (SELECT 1) TO '${root}/data/exfil.csv'`],
    ["EXPORT DATABASE into the data root", () => `EXPORT DATABASE '${root}/data/export'`],
    ["ATTACH creating a database in the data root", () => `ATTACH '${root}/data/new.duckdb' AS n`],
    [
      "CALL enable_logging into the data root",
      () => `CALL enable_logging(storage='file', storage_config={'path': '${root}/data/log'})`,
    ],
    ["CREATE TABLE", () => `CREATE TABLE t AS SELECT 1`],
    ["SET after a SELECT", () => `SELECT 1; SET threads=1`],
    [
      "COPY hidden in a second statement",
      () => `SELECT 1; /* c */ COPY (SELECT 1) TO '${root}/data/exfil.csv'`,
    ],
  ])("%s is refused before it runs", async (_name, build) => {
    await expect(assertReadOnlyStatements(sandbox.conn, build())).rejects.toThrow(/not allowed/);
    await expect(stat(path.join(root, "data", "exfil.csv"))).rejects.toThrow();
    await expect(stat(path.join(root, "data", "export"))).rejects.toThrow();
    await expect(stat(path.join(root, "data", "new.duckdb"))).rejects.toThrow();
    await expect(stat(path.join(root, "data", "log"))).rejects.toThrow();
  });

  test.each([
    `SELECT 1`,
    `WITH a AS (SELECT 1 x) SELECT * FROM a`,
    `FROM trades.trade_data`,
    `DESCRIBE trades.trade_data`,
    `SHOW TABLES`,
    `EXPLAIN SELECT 1`,
    `PRAGMA table_info('trades.trade_data')`,
    `CALL pragma_table_info('trades.trade_data')`,
    `(SELECT 1) UNION ALL (SELECT 2)`,
    `SELECT 1; SELECT 2`,
    `-- note\nSELECT 1`,
    `SELECT 'a;b' AS s`,
  ])("read statement is accepted: %s", async (query) => {
    await expect(assertReadOnlyStatements(sandbox.conn, query)).resolves.toBeUndefined();
  });

  test("the lockdown cannot be undone and the configuration is as expected", async () => {
    await expect(run(`SET enable_external_access=true`)).rejects.toThrow();
    const settings = await run(
      `SELECT name, value FROM duckdb_settings() WHERE name IN ('enable_external_access', 'lock_configuration', 'autoinstall_known_extensions', 'autoload_known_extensions', 'allow_community_extensions') ORDER BY name`,
    );
    expect(Object.fromEntries(settings.map((r) => [String(r[0]), String(r[1])]))).toEqual({
      allow_community_extensions: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      enable_external_access: "false",
      lock_configuration: "true",
    });
  });

  test("stored data is read-only through the sandbox", async () => {
    await expect(run(`CREATE TABLE trades.nope (x INT)`)).rejects.toThrow();
    await expect(run(`DELETE FROM trades.trade_data`)).rejects.toThrow();
    await expect(
      run(`INSERT INTO market._sync_metadata SELECT * FROM market._sync_metadata`),
    ).rejects.toThrow();
  });

  test("in-root reads and the attached catalogs work", async () => {
    expect(await run(`SELECT count(*) FROM read_csv_auto('${root}/data/ok.csv')`)).toEqual([[3n]]);
    expect(await run(`SELECT count(*) FROM '${root}/data/ok.csv'`)).toEqual([[3n]]);
    expect(await run(`SELECT count(*) FROM read_json_auto('${root}/data/ok.json')`)).toEqual([
      [2n],
    ]);
    expect(await run(`SELECT count(*) FROM read_parquet('${root}/data/ok.parquet')`)).toEqual([
      [1n],
    ]);
    expect(await run(`SELECT count(*) FROM glob('${root}/data/*')`)).toEqual([[3n]]);
    await run(`SELECT count(*) FROM trades.trade_data`);
    await run(`SELECT count(*) FROM market._sync_metadata`);
  });
});
