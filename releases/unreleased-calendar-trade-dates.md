# Unreleased — every MCP tool reports trade dates as calendar dates

**Behaviour change to existing MCP tool output.** Trade-calendar dates in tool output are now calendar dates as `YYYY-MM-DD`, for example `{ "start": "2024-01-02", "end": "2024-03-28" }`. This covers a trade's opened or closed day, a daily-log day, and any range or window built from them. The day is the same on every server timezone. `import_csv` already used this form. These tools changed shape:

- `list_blocks`: `blocks[].dateRange.start` and `.end` were `2024-01-02T00:00:00.000Z`.
- `get_block_info`: `dateRange.start` and `.end` were ISO timestamps of the server's local midnight, such as `2024-01-02T06:00:00.000Z`. On a server east of UTC they named the day before the date in the file (local 2024-01-02 in UTC+14 became `2024-01-01T10:00:00.000Z`).
- `get_reporting_log_stats`: `dateRange.start` and `.end`, the same way as `get_block_info`.
- `get_statistics`: `peakExposure.byDollars.date` and `peakExposure.byPercent.date` were ISO timestamps of the server's local midnight, with the same previous-day error east of UTC.
- `run_walk_forward`: `periods[]` and `skippedWindows[]` `inSampleStart`, `inSampleEnd`, `outOfSampleStart` and `outOfSampleEnd` were `2024-01-02T00:00:00.000Z`.
- `get_tail_risk`: `dateRange.start` and `.end` were ISO timestamps, and named the previous day east of UTC.
- `run_sql`: DATE columns, such as `trades.trade_data.date_opened` and `date_closed`, were returned as objects like `{ "days": 19724 }`.

These tools kept the `YYYY-MM-DD` shape but reported the wrong day on some servers. On a server east of UTC, `paired_bootstrap_comparison` reported `overlapWindow` one day early. On the same servers, `marginal_contribution` reported `calculationMethodology.baseline.returns.dateRange` one day early, and `what_if_scaling` did the same for the `returns.dateRange` of each methodology arm. On a server that observes daylight saving time, such as America/Los_Angeles, `analyze_walk_forward_degradation` could label `periods[].window` and `skippedWindows[]` dates one day early once a window crossed the autumn clock change, and select its trades by those days. `analyze_edge_decay` showed the same windows in `signals.walkForward.detail.periods`.

**Numbers that change on servers east of UTC.** When a Sharpe or Sortino ratio is computed from trades rather than a daily log, each trade's P/L was attributed to the previous calendar day. That moved returns onto weekends and changed the risk-free rate day. Those ratios now use the trade's own day. `get_statistics` `peakExposure.byPercent.exposurePercent` now divides by the same day's equity instead of the next day's. The web app's trade-based Sharpe and Sortino ratios get the same correction on computers east of UTC.

Clients that parse these fields as timestamps should read them as calendar dates instead. Real instants are unchanged: `calculatedAt`, sync times and market-feed timestamps are still ISO timestamps. Inputs, stored block files and every other field stay the same. This note does not bump a version or publish a release.
