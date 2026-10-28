# Filter-curve selection and admission clarity

- `filter_curve` accepts opt-in `minKeptFraction` (greater than zero, at most one). Best-threshold selection and every month-block permutation retain at least that share of the field-covered trade/day population after pre-filters and day aggregation. `keptShareFloor` reports the requested fraction, resolved minimum count, covered count and excluded candidate count. Descriptive threshold rows and sweet spots are unchanged; omission preserves existing selection behavior.
- If the floor leaves no eligible threshold, `bestThreshold` is null and requested permutation returns `no_eligible_threshold` without a p-value. Unavailable results continue to count conservatively in the Holm family.
- Work-limit refusals now include `maxIterationsThatFit`, the largest iteration count satisfying both existing admission limits for the unchanged request, or null with `iterationsFitReason` when even one iteration cannot fit. Estimator coefficients and limits are unchanged; day-unit admission continues to count entry days, not trades.
- Metadata wording change: `objectiveMetadata.maxDrawdownPercentBasis` and the MAR definition now explicitly identify capital at the start of the analyzed window, including prior P&L when `startDate` is set, rather than implying the block's initial capital. `startingCapitalSource` identifies daily-log or observed trade-funds evidence when available. No drawdown figure, capital resolution, CAGR or MAR calculation changed.

Addresses tradeblocks#586 items 1, 2 (fitting-iteration guidance) and 4.
