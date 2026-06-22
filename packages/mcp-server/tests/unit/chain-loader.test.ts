/**
 * Unit tests for chain-loader.ts.
 *
 * The three-step cache-lifecycle fetch path was deleted (reads no longer
 * trigger provider fetches). The surviving public surface is the
 * pure-utility set: `filterChain` + `deduplicateContracts` + `ContractRow`.
 * The legacy `loadChain` / `loadChainsBulk` / `isChainSkip` cases are
 * removed; equivalent coverage of the new path lives in
 * `tests/integration/wave-b-chain-consumer-contract.test.ts`
 * (orchestrator now calls `stores.chain.readChain`).
 *
 * Original requirements covered: filter-by-DTE / contract_type;
 * historical skip semantics are superseded by the empty-array skip
 * signal asserted in wave-b-chain-consumer-contract.test.ts.
 */

import { filterChain, type ContractRow } from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// ContractRow builder
// ---------------------------------------------------------------------------

function makeRow(dte: number, type: "call" | "put" = "put", strike = 4500): ContractRow {
  return {
    underlying: "SPX",
    date: "2025-01-07",
    ticker: `SPX250117${type[0].toUpperCase()}0${strike}000`,
    contract_type: type,
    strike,
    expiration: "2025-01-17",
    dte,
    exercise_style: "european",
  };
}

// ---------------------------------------------------------------------------
// Tests: filterChain
// ---------------------------------------------------------------------------

describe("filterChain", () => {
  it("filters by DTE range and contract_type (CHAIN-03)", () => {
    // Each row needs a distinct (contract_type, strike, expiration) to avoid
    // deduplication by deduplicateContracts inside filterChain.
    const contracts = [
      makeRow(10, "put", 4400),
      makeRow(30, "put", 4500),
      makeRow(45, "put", 4600),
      makeRow(60, "put", 4700),
      makeRow(45, "call", 4600),
    ];

    const filtered = filterChain(contracts, { dte_min: 30, dte_max: 50, contract_type: "put" });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.contract_type === "put")).toBe(true);
    expect(filtered.every((c) => c.dte >= 30 && c.dte <= 50)).toBe(true);
  });

  it("returns all contracts with empty filter (no-op) (CHAIN-03)", () => {
    // Use distinct strikes so deduplicateContracts does not collapse any rows.
    const contracts = [
      makeRow(10, "put", 4400),
      makeRow(30, "call", 4500),
      makeRow(45, "put", 4600),
    ];

    const filtered = filterChain(contracts, {});

    expect(filtered).toHaveLength(3);
  });

  it("filters by contract_type only", () => {
    const contracts = [
      makeRow(10, "put", 4400),
      makeRow(30, "call", 4500),
      makeRow(45, "put", 4600),
    ];

    const filtered = filterChain(contracts, { contract_type: "put" });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.contract_type === "put")).toBe(true);
  });

  it("filters by DTE min only", () => {
    const contracts = [
      makeRow(10, "put", 4400),
      makeRow(30, "put", 4500),
      makeRow(45, "put", 4600),
    ];

    const filtered = filterChain(contracts, { dte_min: 30 });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.dte >= 30)).toBe(true);
  });
});
