# Unreleased — same-curve Calmar ratio

**Behaviour change to existing `calmarRatio` output.** For unfiltered blocks with a daily log, Calmar now divides CAGR measured from the first to last daily `netLiquidity` over the log's own span by the daily log's maximum absolute `drawdownPct`. Previously it divided trade-based CAGR by daily-log drawdown, mixing two curves. The statistics output now includes `calculationMethodology.calmar.basis`: `daily_log_marked_curve` for these blocks and `realized_trade_equity` for trade-only or strategy/ticker-filtered results.

Trade-only and filtered Calmar results are unchanged. The existing `cagr` and `maxDrawdown` values and meanings are unchanged. If marked CAGR cannot be computed or drawdown is zero, Calmar is unavailable rather than mixing curves. This note does not bump a version or publish a release.
