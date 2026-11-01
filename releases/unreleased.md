# Unreleased

## Behavior changes

### Missing trade tickers are an explicit SPX assumption

Market-joined tools now return a warning when a trade has no usable ticker and its
market context falls back to SPX. The warning names the assumption, counts affected
trades (not unique ticker/date keys), and asks for an `Underlying` or supported ticker
column. It appears even when SPX data exists and the join succeeds. Existing warnings
are retained; the portfolio health check uses its existing warning flags.

We warn rather than refuse because native Option Omega CSV exports can omit the ticker
column. Refusal would break existing public users of those exports. This is an additive
output change with no tool input schema change, no new configuration, and no provider
credential requirement. Explicit SPX and TSLA trades do not produce the warning, and
trade P/L, fee basis, counts and strategies are unchanged.

`Underlying` already imports by header name on both the loaded-trade and synced-ticker
paths. A producer-shaped TSLA capture now has an import regression covering both.
Previously captured non-SPX blocks without this column need a repaired CSV with verified
per-trade underlyings or a fresh export, then re-import; this change cannot infer or
repair their missing values automatically.
