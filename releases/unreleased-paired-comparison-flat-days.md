# Paired comparison: count days without a position as flat days

`paired_bootstrap_comparison` compares two arms only on days both hold a
position, on a grid made of their trade open and close dates. For a
filtered strategy against its unfiltered version, the days the filter skips
drop out, so the comparison cannot show the filter's effect.

Two optional inputs change that. `unobservedDays: "zero"` counts a grid day
without a position as a flat day with 0 P&L, from the first to the last day
either arm holds a position. `grid: "xnys"` builds the grid from every NYSE
session between the compared strategies' first and last trade date (2013-2030),
plus any trade date that is not a session. With the default settings (both
omitted, or passed as `"exclude"` and `"trades"`) the tool behaves and responds
exactly as before; a non-default setting of either adds `unobservedDays`,
`grid` and `dayGridMethodology` to the response, and with `grid: "xnys"`
`attributionMethodology` describes the XNYS session calendar.
