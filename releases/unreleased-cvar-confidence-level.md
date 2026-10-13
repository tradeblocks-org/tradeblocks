# Unreleased — Configurable CVaR confidence

The public `@tradeblocks/lib` calculation `cvarFromReturns(returns, confidence = 0.95)` now accepts an optional confidence level, such as `0.90` or `0.99`. Omitting it preserves the existing 95% result exactly. Results remain signed decimal returns: the estimator linearly interpolates the `(1 - confidence)` percentile cutoff and averages all discrete observations at or below it, including ties, without fractional weighting.

Confidence must be finite and strictly between 0 and 1. Invalid values (including NaN and infinities) throw a `RangeError` naming the value, even for an empty series. Empty input still returns `undefined` with valid confidence; a single observation returns that observation. Existing callers, MCP tools, and other risk estimators are unchanged.
