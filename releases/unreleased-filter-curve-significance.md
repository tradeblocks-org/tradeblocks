# Filter-curve significance and stability

`filter_curve` adds opt-in multi-field comparisons (`fields`, at most 10), P&L or
win-rate objective ranking (`objective`), best-threshold per-year stability, and
selection-adjusted permutation. Existing single-field calls without new options
retain their output. Covered/uncovered baselines, causal dataset availability and
`maxMissedSessions` are unchanged.

`permutation: { iterations: 499, block: "month", seed: 42 }` shuffles whole
calendar-month outcome blocks and reruns every threshold and direction each draw.
Within-month order is retained; cross-month dependence is not. Exchangeable monthly
blocks are an assumption, not proof of a profitable filter. Add-one raw p-values and
Holm-adjusted p-values across the requested family are reported. Refused fields stay
in that family conservatively as p=1 without receiving fabricated p-values.

At least 30 covered trades and 8 observed months are needed. Iterations are capped
at 499, with threshold and percentile arrays capped at 100 entries. Sort-aware work
admission refuses the whole request before any sweeps above 30 million work units
per field or 60 million per request. Field, objective and mode choices across
separate requests are not part of the Holm family.
Low-sample years remain visible. See [the complete contract](../docs/mcp-tools.md#filter-curve-significance-and-stability).
