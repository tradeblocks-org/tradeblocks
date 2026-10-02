import { describe, it, expect, jest } from "@jest/globals";
import { createMarketStores } from "tradeblocks-mcp/market/stores";
import type { QuoteRow } from "tradeblocks-mcp/market/stores/types";
import { quoteParquetCanonicalProjection } from "tradeblocks-mcp/utils/quote-parquet-projection";
import { writeQuoteMinutesPartition } from "tradeblocks-mcp/db/market-datasets";
import { createMarketParquetViews } from "tradeblocks-mcp/db/market-views";
import { join } from "node:path";
import { QuoteStore } from "tradeblocks-mcp/market/stores";
import { buildStoreFixture } from "../../../fixtures/market-stores/build-fixture.ts";

const ticker = "SPXW250110C05000000";
const quote: QuoteRow = {
  occ_ticker: ticker,
  timestamp: "2025-01-06 09:35",
  bid: 1,
  ask: 2,
  source: "nbbo",
  delta: 0.5,
  gamma: 0.125,
  theta: -0.25,
  vega: 0.25,
  iv: 0.5,
  greeks_source: "computed",
  greeks_revision: 5,
  rate_type: "fixture",
  rate_value: 0.0625,
  gamma_source: "computed",
};
const trimmed = {
  ...quote,
  delta: null,
  gamma: null,
  theta: null,
  vega: null,
  iv: null,
  greeks_source: null,
  greeks_revision: null,
  rate_type: null,
  rate_value: null,
  gamma_source: null,
};

describe.each([false, true])("quote projection parquetMode=%s", (parquetMode) => {
  it("preserves default quotes and replaces unselected Greeks and provenance with null without reading them", async () => {
    const fixture = await buildStoreFixture({ parquetMode });
    try {
      const store = createMarketStores(fixture.ctx).quote;
      await store.writeQuotes("SPX", "2025-01-06", [quote]);
      const wanted = new Map([["2025-01-06", new Set([ticker])]]);
      expect(await store.readQuotesBulk(wanted, "09:35", "09:35")).toEqual(
        new Map([[ticker, [quote]]]),
      );
      const spy = jest.spyOn(fixture.ctx.conn, "runAndReadAll");
      expect(await store.readQuotesBulk(wanted, "09:35", "09:35", [])).toEqual(
        new Map([[ticker, [trimmed]]]),
      );
      expect(await store.readQuotes([ticker], "2025-01-06", "2025-01-06", [])).toEqual(
        new Map([[ticker, [trimmed]]]),
      );
      const selects = spy.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /SELECT[\s\S]*?FROM[\s\S]*? AS q/.test(sql));
      expect(selects).toHaveLength(2);
      for (const sql of selects) {
        const selectList = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM"));
        expect(selectList).not.toMatch(
          /q\.(delta|gamma|theta|vega|iv|greeks_source|greeks_revision|rate_type|rate_value|gamma_source)\b/,
        );
      }
      spy.mockRestore();
      const subset = { ...quote, gamma: null, theta: null, vega: null };
      expect(await store.readQuotesBulk(wanted, "09:35", "09:35", ["delta", "iv"])).toEqual(
        new Map([[ticker, [subset]]]),
      );
      expect(await store.readQuotes([ticker], "2025-01-06", "2025-01-06", ["delta", "iv"])).toEqual(
        new Map([[ticker, [subset]]]),
      );
      await expect(
        store.readQuotesBulk(wanted, "09:35", "09:35", ["rho"] as never),
      ).rejects.toThrow(/Unknown greek "rho"/);
      // Exercise the inherited fallback against the real adapter.
      expect(
        await QuoteStore.prototype.readQuotesBulk.call(store, wanted, "09:35", "09:35", []),
      ).toEqual(new Map([[ticker, [trimmed]]]));
    } finally {
      fixture.cleanup();
    }
  });

  it("reads mixed DATE/VARCHAR and legacy partitions with exact pairs and inclusive time bounds in both projections", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const otherTicker = "SPXW250110P05000000";
      const files: string[] = [];
      for (const [date, dateType] of [
        ["2025-01-06", "DATE"],
        ["2025-01-07", "VARCHAR"],
      ]) {
        await writeQuoteMinutesPartition(fixture.ctx.conn, {
          dataDir: fixture.ctx.dataDir,
          underlying: "SPX",
          date,
          selectQuery: `SELECT 'SPX' AS underlying, CAST('${date}' AS ${dateType}) AS date,
            ticker, time, 1.0 AS bid, 2.0 AS ask, 'nbbo' AS source,
            0.5 AS delta, 0.125 AS gamma, -0.25 AS theta, 0.25 AS vega, 0.5 AS iv,
            'computed' AS greeks_source, 5 AS greeks_revision, 'fixture' AS rate_type,
            0.0625 AS rate_value, 'computed' AS gamma_source
            FROM (VALUES ('${ticker}'), ('${otherTicker}')) AS tickers(ticker)
            CROSS JOIN (VALUES ('09:34'), ('09:35'), ('09:36'), ('09:37')) AS times(time)`,
        });
        files.push(
          join(
            fixture.ctx.dataDir,
            "market",
            "option_quote_minutes",
            "underlying=SPX",
            `date=${date}`,
            "data.parquet",
          ),
        );
      }
      await writeQuoteMinutesPartition(fixture.ctx.conn, {
        dataDir: fixture.ctx.dataDir,
        underlying: "SPX",
        date: "2025-01-08",
        selectQuery: `SELECT 'SPX' AS underlying, '2025-01-08' AS date, '${ticker}' AS ticker,
          '09:35' AS time, 3.0 AS bid, 4.0 AS ask`,
      });
      // Prove the fixtures really contain different physical date types, not just names.
      for (const [index, type] of ["DATE", "VARCHAR"].entries()) {
        const reader = await fixture.ctx.conn.runAndReadAll(
          `DESCRIBE SELECT * FROM read_parquet('${files[index].replace(/'/g, "''")}', hive_partitioning=false)`,
        );
        expect(reader.getRows().find((row) => row[0] === "date")?.[1]).toBe(type);
      }
      if (!parquetMode) await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);
      const store = createMarketStores({ ...fixture.ctx, parquetMode }).quote;
      const wanted = new Map([
        ["2025-01-06", new Set([ticker])],
        ["2025-01-07", new Set([otherTicker])],
        ["2025-01-08", new Set([ticker])],
      ]);
      for (const needed of [undefined, []] as const) {
        const template = needed === undefined ? quote : trimmed;
        const expected = new Map([
          [
            ticker,
            [
              { ...template, timestamp: "2025-01-06 09:35" },
              { ...template, timestamp: "2025-01-06 09:36" },
              { ...trimmed, timestamp: "2025-01-08 09:35", bid: 3, ask: 4, source: null },
            ],
          ],
          [
            otherTicker,
            [
              { ...template, occ_ticker: otherTicker, timestamp: "2025-01-07 09:35" },
              { ...template, occ_ticker: otherTicker, timestamp: "2025-01-07 09:36" },
            ],
          ],
        ]);
        expect(await store.readQuotesBulk(wanted, "09:35", "09:36", needed)).toEqual(expected);
        expect(await store.readQuotes([ticker], "2025-01-06", "2025-01-07", needed)).toEqual(
          new Map([
            [
              ticker,
              ["2025-01-06", "2025-01-07"].flatMap((date) =>
                ["09:34", "09:35", "09:36", "09:37"].map((time) => ({
                  ...template,
                  timestamp: `${date} ${time}`,
                })),
              ),
            ],
          ]),
        );
      }
    } finally {
      fixture.cleanup();
    }
  });
});

it("keeps the default canonical SQL identical and its no-Greeks row positions stable", async () => {
  const columns = new Set([
    "underlying",
    "date",
    "ticker",
    "time",
    "bid",
    "ask",
    "mid",
    "last_updated_ns",
    "source",
    "delta",
    "gamma",
    "theta",
    "vega",
    "iv",
    "greeks_source",
    "greeks_revision",
    "rate_type",
    "rate_value",
    "gamma_source",
  ]);
  const historic = [...columns].map((name) => `q.${name} AS ${name}`).join(",\n              ");
  expect(quoteParquetCanonicalProjection(columns)).toBe(historic);
  const projection = quoteParquetCanonicalProjection(columns, "q", []);
  expect(projection).not.toMatch(
    /q\.(delta|gamma|theta|vega|iv|greeks_source|greeks_revision|rate_type|rate_value|gamma_source)\b/,
  );
  const fixture = await buildStoreFixture({ parquetMode: false });
  try {
    const reader = await fixture.ctx.conn.runAndReadAll(
      `SELECT ${projection} FROM market.option_quote_minutes AS q`,
    );
    expect(reader.columnNames()).toEqual([...columns]);
  } finally {
    fixture.cleanup();
  }
});
