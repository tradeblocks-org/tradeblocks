# Unreleased — Dated book member disable and reinstatement

The public `@tradeblocks/lib` `replayBook` calculation accepts `{ effectiveDate, disabled: true }` in a member's `sizingSchedule`. Disabled dates admit no new groups. Sizing and caps are optional and ignored while disabled; a later active entry (with `disabled` omitted or `false`) reinstates the member using its complete sizing and caps. Fixed member-level `removed` still applies.

Held positions keep their admitted quantities and buying-power reservations, continue to be marked and attributed to their real member, and close normally. Disabling does not force an exit or reset concurrency. Member summaries and census add `disabledGroups` only when a disabled entry is supplied; disabled groups are not counted as `zeroGroups`. Mark-only ignored-position census uses the same distinction. Without disabled state, output is unchanged.

This remains a library-only option: MCP tool arguments are unchanged. Drawdown-budget search and equal-standalone-risk sizing continue to refuse schedules.
