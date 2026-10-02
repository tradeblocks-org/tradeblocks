# Unreleased — inclusive point-in-time spot reads

**Additive programmatic API.** `SpotStore.readBars(ticker, from, to, upperEt?)` now accepts an optional inclusive upper Eastern timestamp on the final day, in `YYYY-MM-DDTHH:mm` form. Both canonical Parquet and DuckDB reads apply the date/time predicate in SQL before rows materialize in JavaScript, rather than loading later observations and filtering them afterward.

For example, `readBars("SPX", "2025-01-06", "2025-01-08", "2025-01-08T10:30")` retains complete earlier days and final-day observations up to and including `10:30`. The bound must match the final date; invalid clock values, UTC suffixes, offsets and mismatched dates refuse even without data. The same interface covers VIX and other spot tickers.

Existing three-argument calls and full-session daily aggregation are unchanged. No provider credentials or network calls are introduced. This note does not publish a release or bump a package version. See [Market Data](../docs/market-data.md#point-in-time-spot-store-reads).
