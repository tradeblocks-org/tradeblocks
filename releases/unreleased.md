# Unreleased

## Historical XNYS calendar (additive library exports)

`@tradeblocks/lib` and its calculations entrypoint add
`isXnysSessionDateV2`, `enumerateXnysSessionsV2` and `isEarlyCloseSessionV2`, with
`XNYS_SESSION_CALENDAR_REVISION_V2`, `XNYS_SESSION_CALENDAR_SUPPORTED_FROM_V2`
and `XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH_V2`. This historical calendar covers
2013-01-01 through 2030-12-31 under `xnys-full-day-2013-2030-v2`.

It shares exchange rules with v1: Juneteenth closures begin in 2022; 2018-12-05
and 2025-01-09 are full-day mourning closures; early closes remain sessions.
Unsupported dates throw a `RangeError` naming the date, revision and bounds.

All existing unsuffixed calendar exports retain their behavior, 2022–2030
bounds, v1 revision and refusal text. Canonical market provenance, replay
attribution identity, generated snapshots and MCP interfaces are unchanged.
See [the library contract](../docs/development.md#bounded-xnys-calendars).
