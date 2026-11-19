# Paired comparison: count days without a position as flat days

`paired_bootstrap_comparison` compares two arms only on days both hold a
position, on a grid made of their trade open and close dates. For a
filtered strategy against its unfiltered version, the days the filter skips
drop out, so the comparison cannot show the filter's effect.

Two optional inputs change that. `unobservedDays: "zero"` counts a grid day
without a position as a flat day with 0 P&L while the strategy was running. `grid: "xnys"` builds the grid from every NYSE
session between the compared strategies' first and last trade date (2013-2030),
plus any trade date that is not a session. With the default settings (both
omitted, or passed as `"exclude"` and `"trades"`) the tool behaves and responds
exactly as before; a non-default setting of either adds `unobservedDays`,
`grid` and `dayGridMethodology` to the response, and with `grid: "xnys"`
`attributionMethodology` describes the XNYS session calendar.

A day without a position is a real 0 P&L day only while the strategy was
running. The optional `coverage: { A: { from, through }, B: { from, through } }`
input (calendar dates, inclusive, only with `unobservedDays: "zero"`) states
those dates per strategy, clipped to `dateRange`. An arm gets 0 P&L days only
inside its own coverage, only days inside both coverages are compared, and a
trade outside its strategy's coverage is refused. With `grid: "xnys"` the
sessions also span the coverage windows. A strategy that is in the block but
has no trades in the range can be compared as an all-flat arm when its
coverage is given.

Without `coverage`, `"zero"` uses the common held window: the later first open
to the earlier last close of the two strategies. Neither arm gets 0 P&L days
before it started or after it stopped trading; flat days at the edges drop out.

Under `"zero"` the response adds `coverage` (the windows used),
`coverageSource` (`"caller"` or `"heldWindow"`) and, for the held window,
`flatWindowTrimmed: { trimmed, from, through, droppedDays }`;
`dayGridMethodology` names the coverage used. The power floor counts the
compared grid days after this rule.

A strategy that is not in the block is now refused with "Strategy "…" is not in
this block."; one that is in the block but has no trades in the selected range
with "Strategy "…" has no trades in the selected date range." (both were "No
trades found for strategy …" before). Two strategies without trades in the
range are refused.
