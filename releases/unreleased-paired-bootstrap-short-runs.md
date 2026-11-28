# Paired bootstrap: the mean daily difference resamples days in short shared runs

`paired_bootstrap_comparison` resamples day-blocks inside runs of days that
both arms hold. A block could only start where it fit entirely inside one run,
so days in runs shorter than the block length were never drawn and days near
the ends of runs were drawn less often. The point estimate still counted every
shared day, so for `mean_daily_pnl` the interval was centred somewhere else and
could exclude its own point estimate, collapse to a single value, or report
"underpowered" for a block length that the data can carry (#622).

For `mean_daily_pnl`, every shared day now starts one block, and a block wraps
around within its own run. Blocks still never cross a day that only one arm
holds. Every shared day is in the same number of candidate blocks, so the
resampled mean equals the point estimate **in expectation**. That is the only
claim: it does not make every percentile interval symmetric around the point,
and it says nothing about medians or other nonlinear, path or selection
statistics. Wrapping joins the last day of a run to its first, and a run
shorter than the block repeats its days (a one-day run becomes one day
repeated). The comparison is "underpowered" when the shared days do not exceed
one block.

`median_daily_pnl`, `pairedPathBlockBootstrap`, the selection-adjusted lower
bound and the parameter-study selection keep the moving blocks they used
before and give the same results as before. The output gains a `blockScheme`
field (`circular-within-run` or `moving`). A block length longer than the
shared overlap returns the structured "underpowered" refusal instead of an
error.

Seeds: the same inputs and seed still give the same result. For
`mean_daily_pnl` with block lengths above one day, a given seed now gives a
different interval than before, because the set of blocks it draws from
changed; a one-day block gives the same interval as before. Rerun mean
comparisons whose shared days fall into short runs, such as strategies that
skip days.
