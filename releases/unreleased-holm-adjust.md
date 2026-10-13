# Unreleased — Holm family-wise adjustment

The public `@tradeblocks/lib` entrypoint now exports the pure calculation
`holmAdjust(pValues: readonly number[]): number[]`. It applies Holm's step-down
family-wise adjustment to a caller-declared family of raw p-values, returning
results in input order with stable ties, a running maximum and a cap at one.
The input is never mutated; empty families return an empty array. Non-finite
p-values (including NaN) and values outside `[0, 1]` throw a `RangeError` naming
the invalid index.

Families can span separate `pairedPathBlockBootstrap` calls. The caller remains
responsible for family membership and explicit handling of unavailable p-values.
Bootstrap p-value computation, existing outputs and MCP tools are unchanged;
there is no new bootstrap option or market-data dependency.
