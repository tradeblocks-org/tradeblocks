/**
 * Deterministic contract fixtures for ChainStore contract tests.
 *
 * `ContractRow` field shape from `src/utils/chain-loader.ts:117-126` — all fields
 * required, `contract_type` is `"call" | "put"`.
 */
import type { ContractRow } from "../../../src/market/stores/types.ts";

/**
 * Build 3 option contracts for the given underlying + date:
 *  - ATM call at strike 5000
 *  - ATM put  at strike 5000
 *  - ITM call at strike 4900
 */
export function makeContracts(underlying: string, date: string): ContractRow[] {
  const yymmdd = date.replace(/-/g, "").slice(2); // "2025-01-06" → "250106"
  return [
    {
      underlying,
      date,
      ticker: `${underlying}W${yymmdd}C05000000`,
      contract_type: "call",
      strike: 5000,
      expiration: date,
      dte: 0,
      exercise_style: "E",
    },
    {
      underlying,
      date,
      ticker: `${underlying}W${yymmdd}P05000000`,
      contract_type: "put",
      strike: 5000,
      expiration: date,
      dte: 0,
      exercise_style: "E",
    },
    {
      underlying,
      date,
      ticker: `${underlying}W${yymmdd}C04900000`,
      contract_type: "call",
      strike: 4900,
      expiration: date,
      dte: 0,
      exercise_style: "E",
    },
  ];
}
