# Paired bootstrap: days in short shared runs are resampled again

`paired_bootstrap_comparison` resamples day-blocks inside runs of days that
both arms hold. A block could only start where it fit entirely inside one run,
so days in runs shorter than the block length were never drawn and days near
the ends of runs were drawn less often. The point estimate still counted every
shared day, so the interval was centred somewhere else and could exclude its
own point estimate, collapse to a single value, or report "underpowered" for a
block length that the data can carry (#622).

Every shared day now starts one block, and a block wraps around within its own
run. Blocks still never cross a day that only one arm holds. Every shared day
carries equal weight, so the interval is centred on the point estimate. The
same change applies to the paired-path bootstrap and to the selection-adjusted
lower bound, which use the same blocks. A comparison is "underpowered" when the
shared days do not exceed one block. Tool inputs and outputs keep their shape;
`candidateBlocks` in the selection-adjusted diagnostics now counts one block per
shared day. Intervals from blocks longer than one day change; rerun comparisons
whose shared days fall into short runs, such as strategies that skip days.
