/**
 * Canonical sample-date fixture for enrichment verification.
 *
 * This is the committed reference list the verification path consumes. It
 * was generated once by running:
 *
 *   selectVerificationSampleDates('2022-01-01', '2026-04-17', 20260418, 9)
 *
 * and pasted verbatim below. The verification path re-runs the selector to
 * produce a fresh list and then compares against this constant — any drift
 * here would mean the PRNG implementation (or one of the hardcoded
 * known/structural date sets) changed, which is a real regression that
 * requires operator ACK before proceeding.
 *
 * Regenerate via:
 *
 *   node -e "const m=require('./packages/mcp-server/dist/utils/sample-date-selector.js');
 *            console.log(JSON.stringify(m.selectVerificationSampleDates('2022-01-01', '2026-04-17'), null, 2))"
 *
 * and paste the result back here.
 */
import type { SampleDate } from "../../src/utils/sample-date-selector.ts";

export const PHASE_5_SAMPLE_DATES: SampleDate[] = [
  {
    date: "2022-01-03",
    category: "structural",
    note: "First trading day of 2022 (earliest data)",
  },
  { date: "2022-01-11", category: "random" },
  { date: "2022-08-08", category: "random" },
  { date: "2022-08-18", category: "random" },
  { date: "2023-10-25", category: "random" },
  {
    date: "2024-03-28",
    category: "known_event",
    note: "Q1 end-of-quarter roll",
  },
  { date: "2024-04-05", category: "random" },
  { date: "2024-06-26", category: "random" },
  {
    date: "2024-07-03",
    category: "structural",
    note: "Day before July 4 (early close)",
  },
  {
    date: "2024-08-05",
    category: "known_event",
    note: "VIX spike, ~65% gap, Japan carry unwind",
  },
  {
    date: "2024-09-18",
    category: "known_event",
    note: "FOMC — 50bps cut, trend reversal",
  },
  {
    date: "2024-11-15",
    category: "known_event",
    note: "November OPEX Friday",
  },
  {
    date: "2024-11-27",
    category: "structural",
    note: "Day before Thanksgiving",
  },
  {
    date: "2024-12-18",
    category: "known_event",
    note: "FOMC decision day, VIX Spike 80%+",
  },
  { date: "2025-01-08", category: "random" },
  {
    date: "2025-04-08",
    category: "known_event",
    note: "Tariff shock, VIX Spike 30%+, SPX down",
  },
  { date: "2026-02-03", category: "random" },
  { date: "2026-04-17", category: "random" },
];
