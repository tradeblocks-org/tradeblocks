# Unreleased — web performance charts name calendar days

**Library export shape change.** In `@tradeblocks/lib`, `buildPerformanceSnapshot` and `processChartData` now return every trade and daily-log day in `SnapshotChartData` as a calendar day, `YYYY-MM-DD`. This changes the meaning of these strings:

- `equityCurve[].date` and `drawdownData[].date`.
- `returnDistributionDetails[].date`, `tradeSequence[].date`, `romTimeline[].date`, `rollingMetrics[].date`, `volatilityRegimes[].date`, `premiumEfficiency[].date` and `marginUtilization[].date`: the day the trade opened.
- `holdingPeriods[].dateOpened` and `holdingPeriods[].dateClosed`. `durationHours` is unchanged.

The same change applies to these other exports:

- `GroupedLegEntry.dateOpened`, from `deriveGroupedLegOutcomes` (the performance store's `groupedLegOutcomes`).
- `MarginTimeline.dates`, from `buildMarginTimeline`.
- `calculateDailyReturns()[].date`.
- The keys of `groupTradesByEntry` and `groupReportingTradesByEntry`, and so `GroupedLegEntry.id`, start with the calendar day, as in `2025-01-03|10:15:00|MEIC`.
- In the web chart exports, the MFE/MAE `Date` CSV column and the JSON `mfe-mae-scatter` `date` field, and the Assistant JSON export's `trades[].dateOpened`.

They were ISO timestamps of the computer's local midnight. On a computer in UTC+14, such as `Pacific/Kiritimati`, a trade opened on 2025-01-03 came out as `2025-01-02T10:00:00.000Z`, and the web charts plotted it on 2025-01-02. It now comes out as `2025-01-03` in every timezone. In UTC it was `2025-01-03T00:00:00.000Z`. The type stays `string`.

**How to read them.** Treat these values as calendar days: compare the strings directly, or split them into year, month and day. Do not pass them to `new Date("YYYY-MM-DD")`, which reads the day as UTC midnight, the evening before west of UTC. To get a local `Date`, use `parseISO` from `date-fns` or `new Date(year, month - 1, day)`.

**Equity curve.** Points used to carry synthetic timestamps a few seconds apart so that no two were equal. Each point is now dated by its trade's close day, so trades that close on the same day share a date. Point order, `tradeNumber`, `equity` and `highWaterMark` are unchanged, and no point is merged. The opening balance is dated the day before the first close. A block with open trades only dates its points by open day. A block with no trades has one point dated today. `calculateDailyExposure` and `calculateExposureAtTradeOpen` now read equity curve dates only as `YYYY-MM-DD` (see `unreleased-daily-exposure-calendar-days.md`).

**Numbers that change on the web app east of UTC.** The drawdown chart now keeps one end-of-day point per calendar day. On computers east or west of UTC, the opening balance used to fall on the same UTC day as the first close and was merged into it. The Margin Utilization table puts each trade in its opening month; before, a trade opened on the first of a month fell in the previous month east of UTC. The Trading Calendar's Sharpe, Sortino, max drawdown, CAGR and Calmar from a daily log now use exactly the logs dated inside the selected range. East of UTC, they used to drop the first day and add the day after the range. The Position Sizing margin chart dates each day by its calendar day.

**Numbers that change on computers in UTC+0 with summer time.** In `Europe/London`, `Europe/Dublin` or `Europe/Lisbon`, the Sunday when summer time begins and the Monday after it used to share one day key. Without a daily log, `PortfolioStatsCalculator` now counts them as two days. So do the MCP tools that report its `maxDrawdown` and `avgDailyPl`, such as `get_statistics`. That also applies to Monte Carlo daily resampling (`run_monte_carlo` with `resampleMethod: "daily"`) and to leg grouping. Each case needs trades on that Sunday. Other timezones get the same numbers as before, and no MCP tool output changes shape.

**Web cache.** The performance snapshot cache in IndexedDB is now stored under `performance_snapshot_v4_<blockId>`. A snapshot cached by an earlier release is not read, and the block's chart data is recalculated with calendar days on the next visit. Old `performance_snapshot_v3_*` entries stay in the browser database unread.

This note does not bump a version or publish a release.
