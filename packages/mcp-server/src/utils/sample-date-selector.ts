/**
 * sample-date-selector.ts — deterministic sample-date generator for
 * enrichment-rebuild verification.
 *
 * Produces a reproducible list of ~15–20 dates (sized for fast verification
 * runs across the supported tickers). The same seed always yields the same
 * sample so re-runs of the verification harness produce comparable drift
 * reports.
 *
 * Pattern: known-event dates + structural calendar-edge dates + N
 * pseudo-random weekday draws from a Mulberry32 PRNG.
 *
 * Pure module — no filesystem, no DuckDB, no provider imports. Safe to import
 * from unit tests, operator scripts, and verification harnesses alike.
 */

/**
 * One sample-date entry. `category` tags its origin so the verification report
 * can group failures by kind (e.g., "2 known_event failures, 0 random").
 */
export interface SampleDate {
  date: string; // YYYY-MM-DD
  category: "known_event" | "structural" | "random";
  note?: string;
}

/**
 * PRNG seed. Pinned to a fixed integer so every invocation of
 * `selectVerificationSampleDates` with default args yields the committed
 * fixture.
 */
export const PHASE_5_FIXTURE_SEED = 20260418;

/**
 * Known-event dates — always included in the sample regardless of seed.
 * Each is a real high-volatility or calendar-significant trading day used
 * to stress the enrichment math.
 */
export const PHASE_5_KNOWN_EVENTS: SampleDate[] = [
  { date: "2024-08-05", category: "known_event", note: "VIX spike, ~65% gap, Japan carry unwind" },
  { date: "2025-04-08", category: "known_event", note: "Tariff shock, VIX Spike 30%+, SPX down" },
  { date: "2024-12-18", category: "known_event", note: "FOMC decision day, VIX Spike 80%+" },
  { date: "2024-11-15", category: "known_event", note: "November OPEX Friday" },
  { date: "2024-03-28", category: "known_event", note: "Q1 end-of-quarter roll" },
  { date: "2024-09-18", category: "known_event", note: "FOMC — 50bps cut, trend reversal" },
];

/**
 * Structural dates — calendar-edge dates always included to exercise first-day,
 * mid-year, and holiday-adjacent enrichment paths.
 */
export const PHASE_5_STRUCTURAL_DATES: SampleDate[] = [
  { date: "2022-01-03", category: "structural", note: "First trading day of 2022 (earliest data)" },
  { date: "2024-07-03", category: "structural", note: "Day before July 4 (early close)" },
  { date: "2024-11-27", category: "structural", note: "Day before Thanksgiving" },
];

/**
 * Mulberry32 PRNG — deterministic, 32-bit state. Small, fast, and repeatable
 * across Node versions. Reference: https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Enumerate weekday dates (Mon–Fri) in [fromDate, toDate] inclusive.
 * UTC-safe — iterates via Date arithmetic with noon-UTC anchors to avoid DST
 * edge cases.
 */
function enumerateWeekdays(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const d = new Date(fromDate + "T12:00:00Z");
  const end = new Date(toDate + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Deterministic sample-date selector.
 *
 * Returns a merged and date-sorted list of:
 *   - All PHASE_5_KNOWN_EVENTS (6 entries)
 *   - All PHASE_5_STRUCTURAL_DATES (3 entries)
 *   - `randomCount` pseudo-random weekdays from [fromDate, toDate] that are
 *     NOT already in the known/structural sets
 *
 * Same `(fromDate, toDate, seed, randomCount)` → same output, always.
 *
 * @param fromDate - inclusive lower bound, default 2022-01-01
 * @param toDate - inclusive upper bound, typically "yesterday" at call time
 * @param seed - Mulberry32 PRNG seed, default PHASE_5_FIXTURE_SEED
 * @param randomCount - number of random dates to draw (default 9 → total ~18)
 */
export function selectVerificationSampleDates(
  fromDate: string = "2022-01-01",
  toDate: string = new Date().toISOString().slice(0, 10),
  seed: number = PHASE_5_FIXTURE_SEED,
  randomCount: number = 9,
): SampleDate[] {
  const prng = mulberry32(seed);

  // Build candidate pool: weekdays in [fromDate, toDate] minus already-selected dates.
  const selectedSet = new Set<string>([
    ...PHASE_5_KNOWN_EVENTS.map((s) => s.date),
    ...PHASE_5_STRUCTURAL_DATES.map((s) => s.date),
  ]);
  const candidates = enumerateWeekdays(fromDate, toDate).filter(
    (d) => !selectedSet.has(d),
  );

  const random: SampleDate[] = [];
  const pool = [...candidates];
  for (let i = 0; i < randomCount && pool.length > 0; i++) {
    const idx = Math.floor(prng() * pool.length);
    random.push({ date: pool.splice(idx, 1)[0], category: "random" });
  }

  return [...PHASE_5_KNOWN_EVENTS, ...PHASE_5_STRUCTURAL_DATES, ...random].sort(
    (a, b) => a.date.localeCompare(b.date),
  );
}
