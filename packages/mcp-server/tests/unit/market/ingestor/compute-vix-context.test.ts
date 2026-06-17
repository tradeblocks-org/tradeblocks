import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MarketIngestor } from "../../../../src/market/ingestor/index.ts";
import { createMarketStores } from "../../../../src/market/stores/index.ts";
import { ensureMarketDataTables } from "../../../../src/db/market-schemas.ts";

describe("MarketIngestor.computeVixContext", () => {
  let dataDir: string;
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `ingestor-vix-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMarketDataTables(conn);
  });

  afterEach(() => {
    try { instance.closeSync(); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("delegates to EnrichedStore.computeContext and returns result", async () => {
    let captured: { from: string; to: string } | null = null;
    const stores = createMarketStores({ conn, dataDir, parquetMode: false });
    stores.enriched.computeContext = async (from: string, to: string) => {
      captured = { from, to };
    };
    const ingestor = new MarketIngestor({
      stores,
      dataRoot: dataDir,
      providerFactory: () => { throw new Error("should not call provider"); },
    });

    const result = await ingestor.computeVixContext({
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(captured).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(result.status).toBe("ok");
  });
});
