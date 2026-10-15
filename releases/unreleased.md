# Unreleased

## Optional replay floors and closed-order streaks

- `BookSizingScheduleEntry.minimumOne?: boolean` overrides the member's minimum-one floor for that schedule window. Omission uses `BookMember.minimumOne`; the next entry does not inherit the previous override. Disabled entries accept but ignore the option. Caps, admission and held quantities are unchanged. Ordinary replay, prepared replay and entry audit facts agree.
- `calculateStreakDistributions` and `calculateRunsTest` accept optional `StreakOptions`: `dateBasis: "opened" | "closed"` defaults to `"opened"`, and `breakeven: "nonwin" | "neither"` defaults to `"nonwin"`. Defaults retain existing behavior and result shapes, including standalone runs tests preserving caller order.
- Closed basis orders by close calendar day, close time (missing first), then original input order for ties. Unclosed trades are excluded and counted in optional `excludedMissingClose` on `StreakDistribution` and available `RunsTestResult` values. An insufficient runs test still returns `undefined`; the distribution always exposes the closed-basis count.
- With `breakeven: "neither"`, zero P/L breaks a win or loss streak without counting as either. The binary runs test omits zeros from its sample.

These additive library options add no provider requirement, MCP schema change or Option Omega call. See the [developer guide](../docs/development.md#streak-ordering-and-strict-losses) for ordering and census semantics.
