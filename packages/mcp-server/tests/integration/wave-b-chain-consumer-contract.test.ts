/**
 * Chain-consumer contract tests.
 *
 * Exercises the migrated orchestrator chain-read path and the surviving
 * pure-utility surface of `utils/chain-loader.ts` after the surgical
 * deletion of `loadChain` / `loadChainsBulk` / `buildCachedChainQuery`
 * / `optionChainPartitionSource` and the chain-skip Result types.
 *
 * Scope:
 *   - chain-loader.ts: the three-step cache-lifecycle fetch path, the SQL
 *     builders, and the skip-result types are deleted. Pure utilities
 *     (`filterChain` / `deduplicateContracts`) are preserved, along with
 *     the `ContractRow` type alias and (transitionally) the
 *     `ChainLoadResult` interface.
 *   - quote-enricher.ts: `enrichQuotesForTickers` and
 *     `fetchExistingCoverage` are deleted. Pure planners
 *     (`shouldSkipEnrichment` / `buildEnrichmentPlan`) are preserved.
 *   - market-datasets.ts: `option_chain` and `option_quote_minutes` are
 *     dropped from `CanonicalPartitionedDataset` — the 3.0 layout is
 *     served via `DATASETS_V3` exclusively.
 *   - Per-date chain reads go through `stores.chain.readChain(...)`;
 *     empty array is the new skip signal replacing `isChainSkip`.
 *
 * Transitional surface still exported (`ChainLoadResult` interface; the
 * throw-stubs for `loadChain` / `loadChainsBulk`) is preserved so
 * downstream consumers continue to compile during the rewrite.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { buildStoreFixture, type FixtureHandle } from "../fixtures/market-stores/build-fixture.ts";
import { createMarketParquetViews } from "../../src/db/market-views.ts";
import { createMarketStores, type MarketStores, type ContractRow } from "../../src/test-exports.ts";

// Direct module import so the absence-of-symbols assertions can inspect
// the live module shape (faster than a shell grep, runs in CI).
import * as chainLoader from "../../src/utils/chain-loader.ts";
import * as quoteEnricher from "../../src/utils/quote-enricher.ts";

function makeContractRow(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    underlying: "SPX",
    date: "2025-01-02",
    ticker: "SPXW250117C05000000",
    contract_type: "call",
    strike: 5000,
    expiration: "2025-01-17",
    dte: 15,
    exercise_style: "european",
    ...overrides,
  };
}

describe("backtest/orchestrator.ts — per-date chain read via ChainStore", () => {
  let fixture: FixtureHandle;
  let stores: MarketStores;

  beforeEach(async () => {
    fixture = await buildStoreFixture({ parquetMode: true });
    stores = createMarketStores(fixture.ctx);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns ContractRow[] from readChain for a seeded (underlying, date)", async () => {
    const seed: ContractRow[] = [
      makeContractRow({ ticker: "SPXW250117C05000000", strike: 5000, contract_type: "call" }),
      makeContractRow({ ticker: "SPXW250117P05000000", strike: 5000, contract_type: "put" }),
      makeContractRow({ ticker: "SPXW250117C05100000", strike: 5100, contract_type: "call" }),
    ];
    await stores.chain.writeChain("SPX", "2025-01-02", seed);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const contracts = await stores.chain.readChain("SPX", "2025-01-02");
    expect(contracts.length).toBe(seed.length);
    // Verify contract shape matches the legacy ContractRow contract.
    for (const c of contracts) {
      expect(c.underlying).toBe("SPX");
      expect(c.date).toBe("2025-01-02");
      expect(typeof c.ticker).toBe("string");
      expect(["call", "put"]).toContain(c.contract_type);
      expect(typeof c.strike).toBe("number");
      expect(typeof c.expiration).toBe("string");
    }
  });

  it("returns empty array for a missing date — orchestrator's new skip signal", async () => {
    // Seed only 2025-01-02. Read 2025-01-06 → empty array (= skip in the
    // post-Phase-4 orchestrator; replaces the legacy isChainSkip check).
    await stores.chain.writeChain("SPX", "2025-01-02", [makeContractRow()]);
    await createMarketParquetViews(fixture.ctx.conn, fixture.ctx.dataDir);

    const missing = await stores.chain.readChain("SPX", "2025-01-06");
    expect(missing).toEqual([]);
    expect(missing.length).toBe(0);
  });
});

describe("filterChain + deduplicateContracts — pure utilities survive deletion", () => {
  it("filterChain narrows by DTE range and contract type", () => {
    // Each row uses a distinct (contract_type, strike, expiration) so the internal
    // deduplicateContracts step preserves all four — we are testing filtering, not dedup.
    const contracts: ContractRow[] = [
      makeContractRow({
        ticker: "A",
        contract_type: "call",
        strike: 5000,
        expiration: "2025-01-12",
        dte: 10,
      }),
      makeContractRow({
        ticker: "B",
        contract_type: "put",
        strike: 5100,
        expiration: "2025-02-01",
        dte: 30,
      }),
      makeContractRow({
        ticker: "C",
        contract_type: "call",
        strike: 5200,
        expiration: "2025-02-16",
        dte: 45,
      }),
      makeContractRow({
        ticker: "D",
        contract_type: "call",
        strike: 5300,
        expiration: "2025-03-03",
        dte: 60,
      }),
    ];

    const callsBetween20And50 = chainLoader.filterChain(contracts, {
      contract_type: "call",
      dte_min: 20,
      dte_max: 50,
    });
    expect(callsBetween20And50.map((c) => c.ticker)).toEqual(["C"]);

    const allPuts = chainLoader.filterChain(contracts, { contract_type: "put" });
    expect(allPuts.map((c) => c.ticker)).toEqual(["B"]);

    const wideOpen = chainLoader.filterChain(contracts, {});
    expect(wideOpen.length).toBe(4);
  });

  it("filterChain dedupes SPX/SPXW collisions in favor of SPXW", () => {
    // Two contracts share (call, 5000, 2025-01-17) — one SPX, one SPXW.
    // filterChain calls deduplicateContracts internally; SPXW must win.
    const contracts: ContractRow[] = [
      makeContractRow({
        ticker: "SPX250117C05000000",
        strike: 5000,
        expiration: "2025-01-17",
        contract_type: "call",
      }),
      makeContractRow({
        ticker: "SPXW250117C05000000",
        strike: 5000,
        expiration: "2025-01-17",
        contract_type: "call",
      }),
    ];
    const out = chainLoader.filterChain(contracts, { contract_type: "call" });
    expect(out.length).toBe(1);
    expect(out[0].ticker).toBe("SPXW250117C05000000");
  });
});

describe("chain-loader + quote-enricher — exported API shape after surgical deletion", () => {
  it("chain-loader: pure utilities + ContractRow type still exported", () => {
    expect(typeof chainLoader.filterChain).toBe("function");
    // ContractRow is a type-only export (erased at runtime); we verify the
    // value-side wasn't accidentally added.
    expect((chainLoader as unknown as Record<string, unknown>).ContractRow).toBeUndefined();
  });

  it("chain-loader: SQL builders + cache-lifecycle internals are deleted", () => {
    // The three-step cache lifecycle is gone — reads never trigger provider
    // fetches. The SQL builders and partition-source helpers that backed the
    // deleted cache reads are also gone.
    expect(
      (chainLoader as unknown as Record<string, unknown>).buildCachedChainQuery,
    ).toBeUndefined();
    expect(
      (chainLoader as unknown as Record<string, unknown>).optionChainPartitionSource,
    ).toBeUndefined();
    expect((chainLoader as unknown as Record<string, unknown>).chainColumnsSql).toBeUndefined();
    expect((chainLoader as unknown as Record<string, unknown>).chainRowFromSql).toBeUndefined();
  });

  it("chain-loader: loadChain / loadChainsBulk are throw-stubs", async () => {
    // The fetch implementations are gone. The named exports survive
    // transitionally so downstream consumers continue to compile. Calling
    // them at runtime must throw with a marker pointing at the replacement
    // API (stores.chain.readChain).
    const loadChain = (chainLoader as unknown as Record<string, unknown>).loadChain;
    const loadChainsBulk = (chainLoader as unknown as Record<string, unknown>).loadChainsBulk;

    for (const [name, fn] of [
      ["loadChain", loadChain],
      ["loadChainsBulk", loadChainsBulk],
    ] as const) {
      expect(typeof fn).toBe("function");
      let caught: unknown = null;
      try {
        const out = (fn as (...a: unknown[]) => unknown)("SPX", "2025-01-02", {}, {});
        if (out instanceof Promise) await out;
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      // Message must point readers at the replacement API.
      expect(String((caught as Error).message)).toContain("stores.chain.readChain");
      // Sanity: the message names the symbol so future grep-walkers can find it.
      expect(String((caught as Error).message)).toContain(
        name === "loadChain" ? "loadChain" : "loadChainsBulk",
      );
    }
  });

  it("chain-loader: skip-result type guards are deleted (orchestrator switched to empty-array signal)", () => {
    expect((chainLoader as unknown as Record<string, unknown>).isChainSkip).toBeUndefined();
  });

  it("quote-enricher: pure helpers + EnrichmentPlanInput type still exported", () => {
    expect(typeof quoteEnricher.shouldSkipEnrichment).toBe("function");
    expect(typeof quoteEnricher.buildEnrichmentPlan).toBe("function");

    // shouldSkipEnrichment is a pure threshold check — verify behavior unchanged.
    expect(quoteEnricher.shouldSkipEnrichment(100, 70)).toBe(true);
    expect(quoteEnricher.shouldSkipEnrichment(50, 70)).toBe(false);
    expect(quoteEnricher.shouldSkipEnrichment(200)).toBe(true);
    expect(quoteEnricher.shouldSkipEnrichment(199)).toBe(false);
  });

  it("quote-enricher: fetch loop is deleted (or stubbed to throw)", async () => {
    // Either the function is fully gone OR it survives as a throw-stub. The
    // contract is "no provider fetch happens here". A throw-stub satisfies
    // that and keeps any remaining callers type-checking until they are
    // rewritten to use `backfillQuotes(stores, ...)`.
    const stub = (quoteEnricher as unknown as Record<string, unknown>).enrichQuotesForTickers;
    if (typeof stub === "function") {
      // Stub variant: must throw with a marker pointing at the replacement
      // API so any accidental call is loud and traceable. Call with an arg
      // shape that satisfies whatever defensive guards the stub may have so
      // it reaches the throw.
      const fn = stub as (...args: unknown[]) => Promise<unknown> | unknown;
      let caught: unknown = null;
      try {
        const out = fn(["X"], "2025-01-02", "2025-01-02", {}, ".");
        if (out instanceof Promise) await out;
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      // The message must mention the replacement API so future readers can
      // find it.
      expect(String((caught as Error).message)).toContain("backfillQuotes");
    } else {
      expect(stub).toBeUndefined();
    }

    // fetchExistingCoverage was a private helper of enrichQuotesForTickers —
    // it should be gone in either case.
    expect(
      (quoteEnricher as unknown as Record<string, unknown>).fetchExistingCoverage,
    ).toBeUndefined();
  });

  it("buildEnrichmentPlan: pure planner returns deterministic output", () => {
    const plan = quoteEnricher.buildEnrichmentPlan({
      tickers: [{ ticker: "SPXW250117C05000000", fromDate: "2025-01-02", toDate: "2025-01-03" }],
      existingCoverage: new Map([["SPXW250117C05000000:2025-01-02", 250]]),
      providerSupportsQuotes: true,
    });
    // 2025-01-02 is dense (250 >= 200) → skipped.
    // 2025-01-03 is missing → in plan.
    expect(plan.length).toBe(1);
    expect(plan[0].ticker).toBe("SPXW250117C05000000");
    expect(plan[0].date).toBe("2025-01-03");
    expect(plan[0].existingBarCount).toBe(0);
  });

  it("buildEnrichmentPlan: returns empty when provider unsupported", () => {
    const plan = quoteEnricher.buildEnrichmentPlan({
      tickers: [{ ticker: "X", fromDate: "2025-01-02", toDate: "2025-01-02" }],
      existingCoverage: new Map(),
      providerSupportsQuotes: false,
    });
    expect(plan).toEqual([]);
  });
});
