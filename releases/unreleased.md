# Unreleased

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
