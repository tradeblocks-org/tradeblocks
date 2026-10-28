import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeConnection,
  getConnection,
  getCurrentConnection,
  upgradeToReadWrite,
  openMarketOnlyConnection,
} from "../../../../src/db/connection.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";
import {
  resolveMarketDir,
  writeChainPartition,
  writeQuoteMinutesPartition,
} from "../../../../src/db/market-datasets.ts";
import { createMarketParquetViews } from "../../../../src/db/market-views.ts";

const OLD_DATE = "2026-01-05";
const OTHER_DATE = "2026-01-06";
const NEW_DATE = "2026-01-07";
const TICKER = "SPY260116C00600000";
const chainSelect = (date: string, strike = 600) =>
  `SELECT 'SPY' AS underlying, '${date}' AS date, '${TICKER}' AS ticker, 'call' AS contract_type, ${strike}::DOUBLE AS strike, '2026-01-16' AS expiration, 11 AS dte, 'american' AS exercise_style`;

let dataDir: string;
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.TRADEBLOCKS_PARQUET;
  dataDir = mkdtempSync(join(tmpdir(), "legacy-options-"));
});
afterEach(async () => {
  await closeConnection();
  jest.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedMode === undefined) delete process.env.TRADEBLOCKS_PARQUET;
  else process.env.TRADEBLOCKS_PARQUET = savedMode;
});

async function seedLegacy() {
  const db = await DuckDBInstance.create(join(dataDir, "market.duckdb"));
  const conn = await db.connect();
  try {
    // Shipped v2.3.0 shape: underlying is present; no Greek columns.
    await conn.run(`CREATE TABLE option_chain (
      underlying VARCHAR NOT NULL, date VARCHAR NOT NULL, ticker VARCHAR NOT NULL,
      contract_type VARCHAR NOT NULL, strike DOUBLE NOT NULL, expiration VARCHAR NOT NULL,
      dte INTEGER, exercise_style VARCHAR, PRIMARY KEY (underlying, date, ticker)
    )`);
    await conn.run(
      `INSERT INTO option_chain ${chainSelect(OLD_DATE)} UNION ALL ${chainSelect(OTHER_DATE)}`,
    );
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

function stores(parquetMode: boolean) {
  return createMarketStores({
    get conn() {
      return getCurrentConnection();
    },
    dataDir,
    parquetMode,
    tickers: new TickerRegistry([{ underlying: "SPY", roots: ["SPY"] }]),
  });
}

describe.each([false, true])("legacy chain storage parquetMode=%s", (parquetMode) => {
  it("preserves old and new rows through startup, option writes and reconnect", async () => {
    if (parquetMode) process.env.TRADEBLOCKS_PARQUET = "true";
    else delete process.env.TRADEBLOCKS_PARQUET;
    await seedLegacy();
    await getConnection(dataDir);
    const market = stores(parquetMode);
    await upgradeToReadWrite(dataDir);
    await market.chain.writeFromSelect(
      { underlying: "SPY", date: NEW_DATE },
      chainSelect(NEW_DATE),
    );
    for (const reconnect of [false, true]) {
      if (reconnect) {
        await closeConnection();
        await getConnection(dataDir);
      }
      for (const date of [OLD_DATE, OTHER_DATE, NEW_DATE]) {
        expect(await market.chain.readChain("SPY", date)).toEqual([
          expect.objectContaining({ ticker: TICKER, strike: 600, date }),
        ]);
      }
      expect(
        (
          await getCurrentConnection().runAndReadAll("SELECT count(*) FROM market.option_chain")
        ).getRows(),
      ).toEqual([[3n]]);
    }
  });
});

it("migrates legacy chains on the market-only read-write connection path", async () => {
  await seedLegacy();
  const handle = await openMarketOnlyConnection(dataDir);
  try {
    expect(
      (
        await handle.conn.runAndReadAll(
          "SELECT CAST(date AS VARCHAR), ticker FROM market.option_chain ORDER BY date",
        )
      ).getRows(),
    ).toEqual([
      [OLD_DATE, TICKER],
      [OTHER_DATE, TICKER],
    ]);
  } finally {
    await handle.close();
  }
});

it("retains an overlapping legacy table by name and publishes its nonoverlapping dates", async () => {
  await seedLegacy();
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await writeChainPartition(conn, {
      dataDir,
      underlying: "SPY",
      date: OLD_DATE,
      selectQuery: chainSelect(OLD_DATE, 601),
    });
  } finally {
    conn.closeSync();
    db.closeSync();
  }
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  await getConnection(dataDir);
  const retained = await getCurrentConnection().runAndReadAll(
    "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'market' AND table_type = 'BASE TABLE' AND table_name LIKE 'option_chain_legacy_retained_%'",
  );
  const names = retained.getRows().map((row) => String(row[0]));
  expect(names).toHaveLength(1);
  const name = names[0];
  expect(
    (await getCurrentConnection().runAndReadAll(`SELECT count(*) FROM market."${name}"`)).getRows(),
  ).toEqual([[2n]]);
  expect(errors.mock.calls.some((call) => String(call[0]).includes(`market.${name}`))).toBe(true);
  expect((await stores(false).chain.readChain("SPY", OLD_DATE))[0].strike).toBe(601);
  expect((await stores(false).chain.readChain("SPY", OTHER_DATE))[0].strike).toBe(600);
  await closeConnection();
  errors.mockClear();
  await getConnection(dataDir);
  expect(errors.mock.calls.some((call) => String(call[0]).includes("legacy_retained"))).toBe(false);
});

it("retains a nonstandard quote table without inventing a schema migration", async () => {
  const db = await DuckDBInstance.create(join(dataDir, "market.duckdb"));
  const conn = await db.connect();
  await conn.run("CREATE TABLE option_quote_minutes AS SELECT 'saved data' AS custom_value");
  conn.closeSync();
  db.closeSync();
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  await getConnection(dataDir);
  const retained = await getCurrentConnection().runAndReadAll(
    "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'market' AND table_name LIKE 'option_quote_minutes_legacy_retained_%'",
  );
  expect(retained.getRows()).toHaveLength(1);
  const name = String(retained.getRows()[0][0]);
  expect(
    (await getCurrentConnection().runAndReadAll(`SELECT * FROM market."${name}"`)).getRows(),
  ).toEqual([["saved data"]]);
  expect(errors.mock.calls.some((call) => String(call[0]).includes(`market.${name}`))).toBe(true);
});

it("retains a legacy chain table whose partition cannot be published instead of failing startup", async () => {
  await seedLegacy();
  const db = await DuckDBInstance.create(join(dataDir, "market.duckdb"));
  const conn = await db.connect();
  await conn.run(`INSERT INTO option_chain ${chainSelect("not-a-date")}`);
  conn.closeSync();
  db.closeSync();
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  await getConnection(dataDir);
  const retained = await getCurrentConnection().runAndReadAll(
    "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'market' AND table_name LIKE 'option_chain_legacy_retained_%'",
  );
  expect(retained.getRows()).toHaveLength(1);
  const name = String(retained.getRows()[0][0]);
  expect(
    (await getCurrentConnection().runAndReadAll(`SELECT count(*) FROM market."${name}"`)).getRows(),
  ).toEqual([[3n]]);
  expect(errors.mock.calls.some((call) => String(call[0]).includes(`market.${name}`))).toBe(true);
  expect((await stores(false).chain.readChain("SPY", OLD_DATE))[0].strike).toBe(600);
});

it("retains a legacy chain table beside date-only chain partitions instead of mixing layouts", async () => {
  await seedLegacy();
  const chainDir = join(resolveMarketDir(dataDir), "option_chain");
  mkdirSync(join(chainDir, `date=${NEW_DATE}`), { recursive: true });
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  await conn.run(
    `COPY (SELECT * EXCLUDE (date) FROM (${chainSelect(NEW_DATE)})) TO '${join(chainDir, `date=${NEW_DATE}`, "data.parquet")}' (FORMAT PARQUET)`,
  );
  conn.closeSync();
  db.closeSync();
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  await getConnection(dataDir);
  const retained = await getCurrentConnection().runAndReadAll(
    "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'market' AND table_name LIKE 'option_chain_legacy_retained_%'",
  );
  expect(retained.getRows()).toHaveLength(1);
  const name = String(retained.getRows()[0][0]);
  expect(
    (await getCurrentConnection().runAndReadAll(`SELECT count(*) FROM market."${name}"`)).getRows(),
  ).toEqual([[2n]]);
  expect(readdirSync(chainDir)).toEqual([`date=${NEW_DATE}`]);
  expect(errors.mock.calls.some((call) => String(call[0]).includes(`market.${name}`))).toBe(true);
});

it.each([
  ["option_chain", "ATTACH ':memory:' AS market"],
  ["option_quote_minutes", "ATTACH ':memory:' AS market"],
  ["option_chain", "CREATE SCHEMA market"],
  ["option_quote_minutes", "CREATE SCHEMA market"],
])("refuses direct view overlay instead of dropping populated %s (%s)", async (dataset, setup) => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run(setup);
    await conn.run(`CREATE TABLE market.${dataset} AS SELECT 'saved data' AS custom_value`);
    const publisher = await DuckDBInstance.create(":memory:");
    const writer = await publisher.connect();
    try {
      if (dataset === "option_chain") {
        await writeChainPartition(writer, {
          dataDir,
          underlying: "SPY",
          date: OLD_DATE,
          selectQuery: chainSelect(OLD_DATE),
        });
      } else {
        await writeQuoteMinutesPartition(writer, {
          dataDir,
          underlying: "SPY",
          date: OLD_DATE,
          selectQuery: `SELECT 'SPY' AS underlying, '${OLD_DATE}' AS date, '${TICKER}' AS ticker, '09:30' AS time, 2.0 AS bid, 2.5 AS ask`,
        });
      }
    } finally {
      writer.closeSync();
      publisher.closeSync();
    }
    await expect(createMarketParquetViews(conn, dataDir)).rejects.toThrow(
      /legacy.*option|option.*migrat/i,
    );
    expect((await conn.runAndReadAll(`SELECT * FROM market.${dataset}`)).getRows()).toEqual([
      ["saved data"],
    ]);
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});
