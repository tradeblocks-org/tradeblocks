# Filter curves: entry-day units and large-request admission

- `filter_curve` accepts `unit: "day"` to sum reported P&L by entry calendar date before threshold scoring, yearly breakdowns and whole-month permutation. Win rate counts profitable days. Omitting `unit` preserves trade-mode results.
- Within-day varying values, including mixed covered/uncovered entries, produce `day_field_varies` with the varying dates.
- Candidate and conservative chosen-unit work admission now precede field enrichment. Oversized permutations refuse by name rather than resolving every trade first.
- Static Dataset matching reuses immutable Eastern-time formatters instead of constructing them repeatedly per trade. Availability, freshness, DST handling and provenance are unchanged.

On a real-DuckDB fixture of 24,200 trades (2,200 days × 11 entries), a daily open-known dataset and 99 seeded month permutations, baseline calls spent roughly 5–8 seconds in dataset matching and another 1.5–2.7 seconds in age summaries, then refused work only after enrichment. The new day path completes the permutation rather than incorrectly charging 24,200 independent observations. Timings are machine-dependent; computational limits remain named refusals, not a wall-clock guarantee.

After the fix, the same 24,200-trade fixture in day mode with 99 month permutations completed in about 1.2–1.3 seconds. Trade-mode work refusal took about 4 seconds on a cold first call, dominated by block loading before admission. These are local measurements, not universal wall-clock guarantees.
