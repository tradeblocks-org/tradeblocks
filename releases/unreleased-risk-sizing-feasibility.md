# Unreleased — Risk sizing feasibility policy

The public `@tradeblocks/lib` `sizeBookAtEqualStandaloneRisk` helper accepts an optional deterministic, non-mutating `feasible` policy with the same verdicts as `searchBookAtDrawdown`: `true`, `false`, or `{ ok: false, reason }`. It enforces that policy on both standalone reference candidates and common-factor book candidates, so a caller can require at least one contract at every retained entry. Standalone policies must exempt members declared removed. Invalid verdicts throw rather than appearing feasible.

When supplied, the result adds per-stage `feasibilityRejections` counts and reason frequencies. A missing feasible reference or book reports `not attained within domain` with the existing explicit domains and bounds, never an infeasible fallback. Without the option, serialized output is unchanged. Both replay `ignoredBuyingPower` hypotheses pass through unchanged; callers can compare separate fits or check an alternate replay in their policy. No checkpoint option or `feasibleId` is added to this helper.

The CPC-only two-stage selection, fixed contract caps, standalone-risk labels and absence of an exact final parity claim remain unchanged. This is an opt-in library capability, not a new sizing method or MCP tool.
