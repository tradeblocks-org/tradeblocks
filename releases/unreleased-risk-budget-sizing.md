# Unreleased — Risk-budget sizing helpers

The public `@tradeblocks/lib` calculations now export `sizeBookAtEqualStandaloneRisk`, `bookExpectedShortfallContributions`, and `nominalCapitalPerContractFromPercentagePoints`. They compose the existing offline replay, fixed-cap drawdown search and confidence estimator without changing existing exports, replay defaults or MCP tools. No provider credentials are required.

Sizing is CPC-only for the caller's all-CPC books. It fits a common standalone marked-drawdown or loss-positive decimal ES target over explicit finite member-weight domains, then selects one common book factor over an explicit finite domain. It preserves fixed contract caps and whole quantities, reports reference/final standalone risks and target residuals, book budget attainment, cap counterfactuals and zero groups. A common factor does not promise exact standalone equality; failure is labelled “not attained within domain,” not global infeasibility.

Book ES contribution is a fixed-position decomposition on the book's own discrete tail days and prior book equity, including starting funds on day one. All cutoff ties are included, with no fractional weighting. Negative offsetting contributions remain negative and the reconciliation residual is reported. This is not sensitivity to replay CPC or weights; no contribution-based retuning is provided.

Nominal percent-to-CPC conversion takes percentage points (2 means 2%) and the median of a caller-selected per-contract buying-power row set. It is descriptive, not an allocation-admission or actual-exposure equivalence. See the Developer Guide for the interface and units.
