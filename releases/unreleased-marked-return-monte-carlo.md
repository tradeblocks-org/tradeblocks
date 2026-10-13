# Unreleased — Marked-return Monte Carlo

`run_monte_carlo` adds opt-in `resampleMethod: "marked-daily"` for stationary-block bootstrapping of an imported portfolio daily log. It reuses the `get_statistics` daily-log formula, `dailyPl / (netLiquidity - dailyPl)` (zero for a nonpositive denominator), rather than reconstructing returns from trades. Deposits and withdrawals are not independently adjusted; their effect remains in reported NLV. Missing or short logs, strategy filters, iid resampling, one-lot normalization and explicit trade-derived worst-case injection are refused, never replaced with trade P/L.

Marked results declare the replayable seed, effective mean block length, observation horizon and decimal units, with per-path maximum-drawdown p50/p95/p99 and horizon-return p5/p50/p95/p99 quantiles. Existing methods, defaults and seeded responses are unchanged.

The public library exports `dailyLogReturns`, shared by portfolio statistics and the MCP tool. `runMonteCarloSimulation` no longer requires ten trades when an explicit `precomputedReturns` percentage series is provided; it still requires five pool observations, including when the supplied series is empty. Trade-based input retains its ten-trade guard. Existing valid precomputed-series consumers retain their sampler and seeded results; the library now also accepts series backed by fewer than ten trades.
