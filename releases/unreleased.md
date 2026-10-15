# Unreleased

## Opt-in Option Omega replay method v3

- `calculateOoReplayAttributionV3` is a separate export with the same input shape
  as `calculateOoReplayAttribution`, returning `OoReplayAttributionV3`. The existing
  attribution export retains its v2 input and return type. `cumulativeReplayTradeMark`
  selects v3 with `parameters.method_id: "oo-replay-method/v3"`. Open marks deduct the caller's
  explicit `entry_slippage` and `entry_slippage_source: "entrySlippage"` rather
  than prepaying exit slippage. Missing entry cost or provenance is
  `missing_strategy_cost`; explicit null or zero means zero. Mixed-ratio
  positions still require an aggregate package count.
- Existing attribution calls retain byte-identical v2 output, including stored
  parameters, even when the new entry-cost fields are supplied. Unknown mark
  method IDs throw `RangeError`; the v2 attribution export also refuses an
  untyped caller's method ID other than v2.
  v3 stores `open_mark_slippage_basis: "entry_slippage"` and the entry provenance.
  Native net profit at close (zero for ignored rows), fees, rounding, mark times,
  calendar and quote provenance remain unchanged.
- The measured scope is SPX Friday 5/3 CD and TSLA RDC, one-lot, over 2024,
  not a universal vendor rule. v2 is correct only when entry slippage equals
  exit slippage, including its legacy entry fallback. With entry 0.07 and exit
  0.20, v3 adds $13 per open package contract, reverses the mark difference on
  close, and leaves the telescoped closed profit unchanged.

This is additive library functionality for the next minor release, recorded here
alongside other unreleased library additions; no package version is bumped ahead
of release preparation. It adds no MCP tool, provider dependency or I/O. See the
[developer guide](../docs/development.md#option-omega-attribution-open-mark-cost-basis).

## Optional replay floors and closed-order streaks

- `BookSizingScheduleEntry.minimumOne?: boolean` overrides the member's minimum-one floor for that schedule window. Omission uses `BookMember.minimumOne`; the next entry does not inherit the previous override. Disabled entries accept but ignore the option. Caps, admission and held quantities are unchanged. Ordinary replay, prepared replay and entry audit facts agree.
- `calculateStreakDistributions` and `calculateRunsTest` accept optional `StreakOptions`: `dateBasis: "opened" | "closed"` defaults to `"opened"`, and `breakeven: "nonwin" | "neither"` defaults to `"nonwin"`. Defaults retain existing behavior and result shapes, including standalone runs tests preserving caller order.
- Closed basis orders by close calendar day, close time (missing first), then original input order for ties. Unclosed trades are excluded and counted in optional `excludedMissingClose` on `StreakDistribution` and available `RunsTestResult` values. An insufficient runs test still returns `undefined`; the distribution always exposes the closed-basis count.
- With `breakeven: "neither"`, zero P/L breaks a win or loss streak without counting as either. The binary runs test omits zeros from its sample.

These additive library options add no provider requirement, MCP schema change or Option Omega call. See the [developer guide](../docs/development.md#streak-ordering-and-strict-losses) for ordering and census semantics.

## Native split-adjusted trade normalization

- Added the pure `normalizeSplitAdjustedRows(rows, actions)` calculation, exported from `@tradeblocks/lib` and its calculations entrypoint. A declared ticker, effective date and ratio determine each adjusted row's entry quantity, native net P/L and buying power per entry contract, plus an `adjusted_rows` projection from the same matches.
- Native rounded profit is preserved without premium reconstruction or re-rounding. Unknown or multiply matched adjusted rows, invalid declarations/quantities and unadjusted held-across contradictions produce named refusals; unadjusted siblings remain unscaled. An omitted `wasAdjusted` flag means false, and book-level actions unused by an individual tape are allowed.
- No provider, file access, replay-kernel change or extra fee deduction is introduced. See the [developer guide](../docs/development.md#offline-book-replay-and-drawdown-budget-search) for calendar-date matching and the complete result contract.
