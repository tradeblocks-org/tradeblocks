import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";
import { TickerRegistry } from "../../../../src/market/tickers/registry.ts";

/**
 * ingestFlatFile is the LLM-driven import dispatcher. The LLM sniffs a file,
 * composes a SELECT mapping file columns → store canonical columns, and calls
 * with {filePath, datasetType, selectSql, partition}. These tests exercise the
 * dispatch layer and the security gates. Store-specific writeFromSelect tests
 * live alongside the concrete stores.
 */
describe("MarketIngestor.ingestFlatFile", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  let tickers: TickerRegistry;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-flatfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
    tickers = new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Build a tiny CSV the LLM could realistically point the tool at.
  function writeFixtureCsv(): string {
    const path = join(dataDir, "fixture.csv");
    writeFileSync(
      path,
      "t,d,hm,o,h,l,c\n" +
        "SPX,2026-01-05,09:30,4700.0,4710.0,4695.0,4705.0\n" +
        "SPX,2026-01-05,09:31,4705.0,4712.0,4703.0,4710.0\n",
    );
    return path;
  }

  describe("dispatch", () => {
    it("writes spot_bars rows through stores.spot.writeFromSelect", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });
      const filePath = writeFixtureCsv();

      const result = await ingestor.ingestFlatFile({
        filePath,
        datasetType: "spot_bars",
        selectSql:
          `SELECT t AS ticker, d AS date, hm AS time, o AS open, h AS high, l AS low, c AS close, ` +
          `NULL::DOUBLE AS bid, NULL::DOUBLE AS ask FROM read_csv('${filePath}', header=true)`,
        partition: { ticker: "SPX", date: "2026-01-05" },
      });

      expect(result.status).toBe("ok");
      expect(result.rowsWritten).toBe(2);

      const probe = await conn.runAndReadAll(
        `SELECT COUNT(*)::INTEGER FROM market.spot WHERE ticker = 'SPX' AND date = '2026-01-05'`,
      );
      expect(Number(probe.getRows()[0][0])).toBe(2);
    });

    it("rejects spot_bars without partition.ticker", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "SELECT 1",
        partition: { date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/partition\.ticker/);
    });

    it("rejects option_quotes without partition.underlying", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "option_quotes",
        selectSql: "SELECT 1",
        partition: { date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/partition\.underlying/);
    });

    it("rejects option_chain without partition.underlying", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "option_chain",
        selectSql: "SELECT 1",
        partition: { date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/partition\.underlying/);
    });

    it("rejects missing partition.date", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "SELECT 1",
        partition: { ticker: "SPX" } as unknown as { date: string; ticker: string },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/partition\.date/);
    });
  });

  describe("security", () => {
    it("blocks COPY TO in select_sql", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "COPY foo TO '/etc/evil'",
        partition: { ticker: "SPX", date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/COPY/);
    });

    it("blocks ATTACH in select_sql", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "ATTACH '/tmp/other.db'",
        partition: { ticker: "SPX", date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
      expect(result.error).toMatch(/ATTACH/);
    });

    it("rejects non-SELECT select_sql", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "DROP TABLE foo",
        partition: { ticker: "SPX", date: "2026-01-05" },
      });

      expect(result.status).toBe("error");
    });
  });

  describe("dry_run", () => {
    it("returns skipped without writing", async () => {
      const stores = createMarketStores({ conn, dataDir, parquetMode: false, tickers });
      const ingestor = new MarketIngestor({ stores, dataRoot: dataDir });

      const result = await ingestor.ingestFlatFile({
        filePath: "/tmp/unused.csv",
        datasetType: "spot_bars",
        selectSql: "SELECT 1",
        partition: { ticker: "SPX", date: "2026-01-05" },
        dryRun: true,
      });

      expect(result.status).toBe("skipped");
      expect(result.rowsWritten).toBe(0);

      const probe = await conn.runAndReadAll(
        `SELECT COUNT(*)::INTEGER FROM market.spot`,
      );
      expect(Number(probe.getRows()[0][0])).toBe(0);
    });
  });
});
