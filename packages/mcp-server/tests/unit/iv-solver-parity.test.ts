/**
 * iv-solver-parity.test.ts
 *
 * The load-bearing gate for the parallel IV-solve change: the parallel path
 * MUST produce greeks byte-identical to the single-threaded inline path.
 *
 * Two input sources, both required to pass:
 *   1. A real already-written option-quote parquet day (illiquid wings,
 *      penny mids, near-expiry, the full strike grid). Skipped automatically
 *      when the local data root is absent (CI), exercised locally.
 *   2. A synthetic edge-case set (zero/penny mids, deep OTM, near-expiry,
 *      both rights) that always runs.
 *
 * Parity is asserted greek-by-greek with a 1e-9 tolerance (the spec gate).
 * Because both paths run the identical `computeLegGreeks`, the realistic
 * expectation is exact equality; 1e-9 is the contractual ceiling.
 */

import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  applyQuoteGreeks,
  applyQuoteGreeksParallel,
  IvSolverPool,
} from "../../src/test-exports.ts";
import type {
  QuoteGreeksContractMeta,
} from "../../src/utils/option-quote-greeks.ts";

const TOLERANCE = 1e-9;

interface ParityRow {
  occ_ticker: string;
  timestamp: string; // "YYYY-MM-DD HH:MM"
  bid: number;
  ask: number;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
  greeks_source?: string | null;
  greeks_revision?: number | null;
  rate_type?: string | null;
  rate_value?: number | null;
  gamma_source?: string | null;
}

interface Fixture {
  rows: ParityRow[];
  contractByTicker: Map<string, QuoteGreeksContractMeta>;
  underlyingByTime: Map<string, number>;
}

function freshRows(rows: ParityRow[]): ParityRow[] {
  // Clone so the two apply passes don't see each other's writes, and strip any
  // pre-existing greeks so mode "auto" always recomputes (the path we test).
  return rows.map((r) => ({
    occ_ticker: r.occ_ticker,
    timestamp: r.timestamp,
    bid: r.bid,
    ask: r.ask,
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
  }));
}

function applyParams(rows: ParityRow[], fx: Fixture) {
  return {
    rows,
    getDate: (row: ParityRow) => row.timestamp.slice(0, 10),
    getTime: (row: ParityRow) => row.timestamp.slice(11, 16),
    getMid: (row: ParityRow) => (row.bid + row.ask) / 2,
    getContractMeta: (row: ParityRow) => fx.contractByTicker.get(row.occ_ticker),
    getUnderlyingPrice: (_date: string, time: string) => fx.underlyingByTime.get(time),
    mode: "auto" as const,
  };
}

function assertRowParity(a: ParityRow, b: ParityRow): void {
  // Provenance must be identical (string / int fields — exact).
  expect(b.greeks_source).toBe(a.greeks_source);
  expect(b.greeks_revision).toBe(a.greeks_revision);
  expect(b.rate_type).toBe(a.rate_type);
  expect(b.gamma_source).toBe(a.gamma_source);
  expect(b.rate_value ?? null).toBe(a.rate_value ?? null);

  for (const key of ["delta", "gamma", "theta", "vega", "iv"] as const) {
    const av = a[key] ?? null;
    const bv = b[key] ?? null;
    if (av === null || bv === null) {
      expect(bv).toBe(av);
    } else {
      // Same code, same inputs → expected exact. 1e-9 is the contractual gate.
      expect(Math.abs(bv - av)).toBeLessThanOrEqual(TOLERANCE);
    }
  }
}

async function runParity(fx: Fixture): Promise<{ computed: number; total: number }> {
  const inlineRows = freshRows(fx.rows);
  const parallelRows = freshRows(fx.rows);

  const inlineStats = applyQuoteGreeks(applyParams(inlineRows, fx));

  // Force the worker path (threshold 0, >1 worker) so we test parallelism, not
  // the inline-degrade branch.
  const pool = new IvSolverPool({ inlineThreshold: 0, maxWorkers: 4 });
  try {
    const parallelStats = await applyQuoteGreeksParallel({
      ...applyParams(parallelRows, fx),
      pool,
    });

    // Stats must match exactly.
    expect(parallelStats).toEqual(inlineStats);

    for (let i = 0; i < inlineRows.length; i++) {
      assertRowParity(inlineRows[i], parallelRows[i]);
    }
    return { computed: inlineStats.computedRows, total: inlineRows.length };
  } finally {
    await pool.destroy();
  }
}

// ---------------------------------------------------------------------------
// Synthetic edge-case fixture (always runs)
// ---------------------------------------------------------------------------

function syntheticFixture(): Fixture {
  const date = "2024-03-15";
  const expiration = "2024-03-15"; // same-day → near-expiry / Bachelier territory
  const farExp = "2024-06-21";
  const rows: ParityRow[] = [];
  const contractByTicker = new Map<string, QuoteGreeksContractMeta>();
  const underlyingByTime = new Map<string, number>();
  const S = 5150.25;

  let idx = 0;
  const add = (
    time: string,
    bid: number,
    ask: number,
    strike: number,
    type: "call" | "put",
    expiration: string,
  ) => {
    const ticker = `SYN${idx++}`;
    rows.push({ occ_ticker: ticker, timestamp: `${date} ${time}`, bid, ask });
    contractByTicker.set(ticker, { contract_type: type, strike, expiration });
    underlyingByTime.set(time, S);
  };

  // Normal ATM/ITM/OTM across both rights, far expiry (Black-Scholes path).
  add("09:35", 40.0, 41.0, 5150, "call", farExp);
  add("09:35", 38.0, 39.0, 5150, "put", farExp);
  add("09:35", 120.0, 121.0, 5000, "call", farExp); // deep ITM call
  add("09:35", 2.0, 2.2, 5400, "call", farExp); // deep OTM call
  add("09:35", 1.5, 1.7, 4900, "put", farExp); // deep OTM put
  // Penny mids / wide illiquid wing.
  add("09:36", 0.01, 0.05, 5600, "call", farExp);
  add("09:36", 0.0, 0.05, 5800, "call", farExp); // zero bid (mid = 0.025)
  add("09:36", 0.05, 0.10, 4500, "put", farExp);
  // Near-expiry (same day) → Bachelier branch.
  add("15:30", 5.0, 5.5, 5150, "call", expiration);
  add("15:30", 4.0, 4.5, 5150, "put", expiration);
  add("15:59", 0.05, 0.15, 5150, "call", expiration); // minutes to expiry
  // Math-fail rows: zero mid, negative-DTE (expired), strike <= 0.
  add("09:37", 0.0, 0.0, 5150, "call", farExp); // mid = 0 → math fail
  add("09:37", 1.0, 1.2, 5150, "call", "2024-03-01"); // expired → dte clamps to 0 → math fail
  // Missing-underlying row (time has no spot).
  rows.push({ occ_ticker: "SYN_NOUL", timestamp: `${date} 09:38`, bid: 1, ask: 2 });
  contractByTicker.set("SYN_NOUL", { contract_type: "call", strike: 5150, expiration: farExp });
  // Missing-contract row.
  rows.push({ occ_ticker: "SYN_NOMETA", timestamp: `${date} 09:35`, bid: 1, ask: 2 });

  return { rows, contractByTicker, underlyingByTime };
}

describe("IV solver parity — synthetic edge cases", () => {
  test("parallel path matches inline path byte-for-byte (1e-9)", async () => {
    const fx = syntheticFixture();
    const { computed, total } = await runParity(fx);
    expect(total).toBeGreaterThan(10);
    expect(computed).toBeGreaterThan(5);
  });

  test("concurrent solves against one shared pool stay correct (single-flight)", async () => {
    // Many overlapping batches dispatched at once against ONE pool. The pool's
    // single-flight gate must keep each parallel solve's worker bookkeeping
    // correct; results must match a single inline solve of the same jobs.
    const pool = new IvSolverPool({ inlineThreshold: 0, maxWorkers: 4 });
    try {
      const makeJobs = (seed: number) =>
        Array.from({ length: 6000 }, (_, i) => ({
          optionPrice: 30 + ((i + seed) % 40),
          underlyingPrice: 5150,
          strike: 5000 + ((i + seed) % 300),
          dte: 5 + ((i + seed) % 60),
          type: ((i + seed) % 2 === 0 ? "C" : "P") as "C" | "P",
          riskFreeRate: 0.045,
          dividendYield: 0,
        }));
      const inlinePool = new IvSolverPool({ maxWorkers: 1 });
      try {
        const batches = [0, 1, 2, 3, 4, 5, 6, 7].map(makeJobs);
        const parallel = await Promise.all(batches.map((j) => pool.solve(j)));
        for (let b = 0; b < batches.length; b++) {
          const reference = await inlinePool.solve(batches[b]);
          for (let i = 0; i < reference.length; i++) {
            expect(parallel[b][i].ok).toBe(reference[i].ok);
            if (reference[i].ok) {
              for (const k of ["delta", "gamma", "theta", "vega", "iv"] as const) {
                expect(parallel[b][i][k]).toBe(reference[i][k]);
              }
            }
          }
        }
      } finally {
        await inlinePool.destroy();
      }
    } finally {
      await pool.destroy();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Real parquet-day fixture (runs locally; skips when data root absent)
// ---------------------------------------------------------------------------

const DATA_ROOT = process.env.TRADEBLOCKS_PARITY_DATA_ROOT
  ?? "/home/romeo/tradeblocks-data/market";
const PARITY_DATE = process.env.TRADEBLOCKS_PARITY_DATE ?? "2024-03-15";
const QUOTE_PARQUET = `${DATA_ROOT}/option_quote_minutes/underlying=SPX/date=${PARITY_DATE}/data.parquet`;
const CHAIN_GLOB = `${DATA_ROOT}/option_chain/underlying=SPX/date=${PARITY_DATE}/*.parquet`;
const SPOT_PARQUET = `${DATA_ROOT}/spot/ticker=SPX/date=${PARITY_DATE}/data.parquet`;

const hasRealData = existsSync(QUOTE_PARQUET) && existsSync(SPOT_PARQUET);
const describeReal = hasRealData ? describe : describe.skip;

async function loadRealFixture(): Promise<Fixture> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const sq = (p: string) => p.replace(/'/g, "''");

  // Cap the row count so the test stays fast but still spans the strike grid
  // including illiquid wings. Ordered by ticker+time for determinism.
  const quoteReader = await conn.runAndReadAll(
    `SELECT ticker, date, time, bid, ask
       FROM read_parquet('${sq(QUOTE_PARQUET)}')
      ORDER BY ticker, time
      LIMIT 60000`,
  );
  const chainReader = await conn.runAndReadAll(
    `SELECT ticker, contract_type, strike, expiration
       FROM read_parquet('${sq(CHAIN_GLOB)}')`,
  );
  const spotReader = await conn.runAndReadAll(
    `SELECT time, open FROM read_parquet('${sq(SPOT_PARQUET)}')`,
  );

  const contractByTicker = new Map<string, QuoteGreeksContractMeta>();
  for (const c of chainReader.getRowObjects()) {
    contractByTicker.set(String(c.ticker), {
      contract_type: String(c.contract_type) === "call" ? "call" : "put",
      strike: Number(c.strike),
      expiration: String(c.expiration),
    });
  }

  const underlyingByTime = new Map<string, number>();
  for (const s of spotReader.getRowObjects()) {
    const time = String(s.time).slice(0, 5);
    const open = Number(s.open);
    if (!underlyingByTime.has(time) && open > 0) underlyingByTime.set(time, open);
  }

  const rows: ParityRow[] = [];
  for (const q of quoteReader.getRowObjects()) {
    const time = String(q.time).slice(0, 5);
    rows.push({
      occ_ticker: String(q.ticker),
      timestamp: `${PARITY_DATE} ${time}`,
      bid: Number(q.bid),
      ask: Number(q.ask),
    });
  }

  return { rows, contractByTicker, underlyingByTime };
}

describeReal("IV solver parity — real parquet day", () => {
  test(`parallel path matches inline path byte-for-byte (1e-9) on ${PARITY_DATE}`, async () => {
    const fx = await loadRealFixture();
    expect(fx.rows.length).toBeGreaterThan(1000);
    const { computed } = await runParity(fx);
    // The day should produce a substantial number of solved rows; if zero,
    // the fixture join failed and the parity assertion is vacuous.
    expect(computed).toBeGreaterThan(500);
  }, 120_000);
});
