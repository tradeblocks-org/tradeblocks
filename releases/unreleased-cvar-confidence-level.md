# Unreleased — Configurable CVaR confidence

New public `@tradeblocks/lib` calculation: `cvarFromReturnsAtConfidence(returns, confidence)`. It computes CVaR at any confidence level, for example `0.90` or `0.99`.

It uses the same estimator as `cvarFromReturns`:

- results are signed decimal returns;
- the `(1 - confidence)` percentile cutoff is linearly interpolated;
- the result is the plain average of every observation at or below that cutoff, including ties, with no fractional weighting.

`confidence` must be finite and strictly between 0 and 1. Any other value, including NaN and infinities, throws a `RangeError` that names the value. This applies even to an empty series.

With a valid confidence, an empty series returns `undefined`, and a single observation returns that observation.

`cvarFromReturns(returns)` is unchanged. It still takes one argument, returns the same 95% result bit for bit, and still works as a point-free callback, as in `series.map(cvarFromReturns)`. Existing MCP tools and the other risk estimators are also unchanged.

**Enterprise Console:** Console pins this module's file hash in its estimator-ownership guard, so its re-vendor must update that pin.
