/**
 * Unit tests for the Market Data 3.0 store interface layer.
 *
 * Covers:
 *  1. Abstract-class shape (concrete stub subclass compiles + instantiates;
 *     bare abstract class is @ts-expect-error at compile time)
 *  2. All four store classes exported from the barrel
 *  3. createMarketStores factory returns real concrete instances that extend
 *     the four abstract bases (Phase 2 upgrade — Pitfall 6 resolution)
 *  4. StoreContext shape is locked to the 4 D-03 fields (conn, dataDir, parquetMode, tickers)
 *  5. Static boundary: src/market/ must not import anything from src/backtest/
 *     (shared-code-no-private-import rule; T-1-04 mitigation)
 */
import { describe, it, expect } from "@jest/globals";
import { execSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import {
  SpotStore,
  EnrichedStore,
  ChainStore,
  QuoteStore,
  createMarketStores,
  getMarketStoresAuthority,
  ParquetSpotStore,
  DuckdbSpotStore,
  ParquetEnrichedStore,
  DuckdbEnrichedStore,
  ParquetChainStore,
  DuckdbChainStore,
  ParquetQuoteStore,
  DuckdbQuoteStore,
  ParquetOiDailyStore,
} from "../../../../src/test-exports.ts";
import type {
  StoreContext,
  MarketStores,
  MarketStoreBarRow,
  CoverageReport,
} from "../../../../src/test-exports.ts";
import { buildStoreFixture } from "../../../fixtures/market-stores/build-fixture.ts";

// Helper: a bare-minimum concrete subclass — proves the abstract contract is satisfiable.
class StubSpotStore extends SpotStore {
  async writeBars(_t: string, _d: string, _b: MarketStoreBarRow[]): Promise<void> {
    return;
  }
  async readBars(_t: string, _f: string, _to: string): Promise<MarketStoreBarRow[]> {
    return [];
  }
  async readDailyBars(_t: string, _f: string, _to: string): Promise<MarketStoreBarRow[]> {
    return [];
  }
  async getCoverage(_t: string, _f: string, _to: string): Promise<CoverageReport> {
    return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
  }
}

describe("SpotStore abstract shape", () => {
  it("is abstract: concrete subclass can instantiate; abstract cannot", () => {
    // @ts-expect-error — instantiating an abstract class is a TS error
    const _attempt = new SpotStore({} as StoreContext);
    void _attempt; // silence unused-var lint; the compile error above is the assertion
    const stub = new StubSpotStore({} as StoreContext);
    expect(stub).toBeInstanceOf(SpotStore);
  });

  it("declares the four locked methods from spec §Store Interfaces", () => {
    // Concrete subclass's own methods show up on its prototype.
    const methodNames = Object.getOwnPropertyNames(StubSpotStore.prototype);
    expect(methodNames).toEqual(
      expect.arrayContaining(["writeBars", "readBars", "readDailyBars", "getCoverage"]),
    );
  });
});

describe("EnrichedStore / ChainStore / QuoteStore abstract shape", () => {
  it("exports all four store classes", () => {
    expect(SpotStore).toBeDefined();
    expect(EnrichedStore).toBeDefined();
    expect(ChainStore).toBeDefined();
    expect(QuoteStore).toBeDefined();
  });

  it("every exported store class has a constructor (type: function)", () => {
    expect(typeof SpotStore).toBe("function");
    expect(typeof EnrichedStore).toBe("function");
    expect(typeof ChainStore).toBe("function");
    expect(typeof QuoteStore).toBe("function");
  });
});

describe("createMarketStores factory (Pitfall 6 resolution — real DuckDB fixture)", () => {
  it("brands only factory-created bundles with their resolved root and backend", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const stores = createMarketStores(fixture.ctx);
      expect(getMarketStoresAuthority(stores)).toEqual({
        dataRoot: path.resolve(fixture.ctx.dataDir),
        parquetMode: true,
      });
      expect(Object.isFrozen(stores)).toBe(true);
      for (const store of Object.values(stores)) expect(Object.isFrozen(store)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(stores.spot, "readBars")).toMatchObject({
        writable: false,
        configurable: false,
      });
      expect(() =>
        Object.defineProperty(stores.spot, "readBars", {
          value: async () => [{ close: 9_999 }],
        }),
      ).toThrow();
      expect(getMarketStoresAuthority(stores)).toEqual({
        dataRoot: path.resolve(fixture.ctx.dataDir),
        parquetMode: true,
      });
      expect(getMarketStoresAuthority({ ...stores })).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("returns real instances extending each abstract base (DuckDB backend)", async () => {
    const fixture = await buildStoreFixture({ parquetMode: false });
    try {
      const stores: MarketStores = createMarketStores(fixture.ctx);
      expect(Object.keys(stores).sort()).toEqual(["chain", "enriched", "oiDaily", "quote", "spot"]);
      expect(stores.spot).toBeInstanceOf(SpotStore);
      expect(stores.enriched).toBeInstanceOf(EnrichedStore);
      expect(stores.chain).toBeInstanceOf(ChainStore);
      expect(stores.quote).toBeInstanceOf(QuoteStore);
      expect(stores.oiDaily).toBeInstanceOf(ParquetOiDailyStore);
      // Ensure the placeholder is gone — none of these should be null.
      expect(stores.spot).not.toBeNull();
      expect(stores.enriched).not.toBeNull();
      expect(stores.chain).not.toBeNull();
      expect(stores.quote).not.toBeNull();
      expect(stores.oiDaily).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("picks DuckDB backend concretes when parquetMode=false (D-03)", async () => {
    const fixture = await buildStoreFixture({ parquetMode: false });
    try {
      const stores = createMarketStores(fixture.ctx);
      expect(stores.spot).toBeInstanceOf(DuckdbSpotStore);
      expect(stores.enriched).toBeInstanceOf(DuckdbEnrichedStore);
      expect(stores.chain).toBeInstanceOf(DuckdbChainStore);
      expect(stores.quote).toBeInstanceOf(DuckdbQuoteStore);
    } finally {
      fixture.cleanup();
    }
  });

  it("picks Parquet backend concretes when parquetMode=true (D-03)", async () => {
    const fixture = await buildStoreFixture({ parquetMode: true });
    try {
      const stores = createMarketStores(fixture.ctx);
      expect(stores.spot).toBeInstanceOf(ParquetSpotStore);
      expect(stores.enriched).toBeInstanceOf(ParquetEnrichedStore);
      expect(stores.chain).toBeInstanceOf(ParquetChainStore);
      expect(stores.quote).toBeInstanceOf(ParquetQuoteStore);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("StoreContext shape (D-03 locked to 4 fields)", () => {
  it("a concrete StoreContext literal has exactly conn, dataDir, parquetMode, tickers", () => {
    const ctx: StoreContext = {
      conn: null as unknown as StoreContext["conn"],
      dataDir: "/tmp",
      parquetMode: false,
      tickers: null as unknown as StoreContext["tickers"],
    };
    expect(Object.keys(ctx).sort()).toEqual(["conn", "dataDir", "parquetMode", "tickers"]);
  });
});

describe("shared-code-no-private-import static check (T-1-04)", () => {
  it("src/market/ contains zero imports from src/backtest/", () => {
    // Walk up from tests/unit/market/stores/ to the mcp-server package root,
    // then scan src/market/ for any import reaching into src/backtest/.
    // This mirrors the structure of tests/unit/parquet-writer.test.ts.
    const here = path.dirname(new URL(import.meta.url).pathname);
    // here = .../packages/mcp-server/tests/unit/market/stores
    const pkgRoot = path.resolve(here, "..", "..", "..", "..");
    const marketDir = path.join(pkgRoot, "src", "market");
    // Skip check if the directory does not exist (defensive; should always exist).
    if (!existsSync(marketDir)) {
      throw new Error(`src/market/ missing at ${marketDir}`);
    }
    const result = execSync(`grep -rE "from ['\\\"]\\.{1,}/.*backtest/" "${marketDir}" || true`, {
      encoding: "utf8",
    });
    expect(result.trim()).toBe("");
  });
});
