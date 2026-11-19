# Paired comparison: the day grid comes from the two compared strategies only

`paired_bootstrap_comparison` built its trading-day grid from every trade in
the block, including strategies that are not part of the comparison. A day on
which only an unrelated strategy traded became a grid day that neither arm
held. Such a day breaks the arms' contiguous runs of jointly observed days, so
the day blocks the bootstrap draws from changed, and a trade held over it had
its P&L spread over more days. The same two strategies could therefore get a
different interval, a different derived block length, a different point
estimate for multi-day positions, or an `underpowered` refusal, depending only
on which other strategies were imported into the block.

The grid now comes from the trades of the compared strategies (arm A, and arm B
when given). The result no longer depends on the rest of the block. Comparing
two strategies in a block that holds only them gives the same result as
before. In a block with other strategies, intervals, block lengths and, for
multi-day positions, point estimates can change: rerun comparisons that were
made in shared blocks. Tool inputs and outputs keep their shape;
`attributionMethodology` now says the trading days come from the compared
strategies' trades.
