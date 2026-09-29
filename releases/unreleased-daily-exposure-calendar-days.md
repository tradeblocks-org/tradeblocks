# Unreleased — daily exposure names calendar days

**Library export shape change.** In `@tradeblocks/lib`, `calculateDailyExposure` now returns calendar days as `YYYY-MM-DD`, for example `"2024-01-02"`. This changes the meaning of these strings:

- `DailyExposurePoint.date`, in `dailyExposure[]`.
- `PeakExposure.date`, for both `peakDailyExposure` and `peakDailyExposurePercent`.

They were ISO instants of the server's local midnight, such as `2024-01-02T00:00:00.000Z` in UTC or `2024-01-01T10:00:00.000Z` in UTC+14. A caller that parsed them as timestamps should now treat them as calendar days: compare the strings directly, or split them into year, month and day. Do not pass them to `new Date(...)`, which reads `2024-01-02` as UTC midnight, the evening of January 1 west of UTC. The type stays `string`. The MCP tools already reported `YYYY-MM-DD` and keep the same output; `get_statistics` `peakExposure` and `get_performance_charts` `daily_exposure` are unchanged in shape.

**Equity lookup.** `calculateDailyExposure` and `calculateExposureAtTradeOpen` now read each `equityCurve` point's `date` as a `YYYY-MM-DD` calendar day, which is what both the MCP tools and the web performance snapshot pass (see `unreleased-performance-snapshot-calendar-days.md`). When several points share a day, the last one is that day's equity. They used to take the first ten characters of the date's UTC text. **A caller that passes an ISO timestamp** (for example `"2024-01-02T00:00:00.000Z"`) no longer matches any day, so its exposure % comes out zero. Pass `YYYY-MM-DD` instead.

**Numbers that change on computers east of UTC, and on the web app.** On a computer east of UTC, an equity point at local midnight has a UTC date one day earlier, so each exposure day used the previous day's equity. The web app's Daily Exposure chart percentages and the `exposureOnOpen` percentages on enriched trades now divide by the same day's equity. In America/Los_Angeles, the snapshot's opening equity point (one second before the first close) sat on the wrong day, so the first exposure day could use the wrong equity there too. A computer in UTC gets the same numbers as before.

**Web cache.** The performance snapshot cache in IndexedDB is now stored under `performance_snapshot_v4_<blockId>` (see `unreleased-performance-snapshot-calendar-days.md`). A snapshot cached by an earlier release is not read, and the block's chart data is recalculated on the next visit. Old `performance_snapshot_v2_*` and `performance_snapshot_v3_*` entries stay in the browser database unread.

This note does not bump a version or publish a release.
