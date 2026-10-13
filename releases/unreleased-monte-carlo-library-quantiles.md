# Unreleased — Monte Carlo library drawdown quantiles

`@tradeblocks/lib` callers can opt in to `includeMaxDrawdownQuantiles: true` in `runMonteCarloSimulation` to receive top-level `maxDrawdownQuantiles` with p50, p95 and p99. Values are nonnegative decimal peak-to-trough depths (0.1 means 10%), interpolated linearly at rank `(N - 1) * p`. Omitting the option preserves the existing result shape, and `statistics` remains unchanged in either case.

The library now exports `pathQuantiles` for nonempty decimal path-value arrays, returning p5, p50, p95 and p99. It sorts a copy and never mutates the supplied array; an empty array throws `RangeError`. MCP `run_monte_carlo` marked-daily drawdown and horizon-return summaries use this one implementation, retaining their exact arithmetic and output shape. Seeded sampling and all other simulation outputs are unchanged; no market-data integration is required.
