# Predictive rank correlation

`find_predictive_fields` accepts optional `method: "pearson" | "spearman" | "kendall"`.
Spearman detects monotone nonlinear relationships; Kendall uses the shared tie-adjusted
tau-b implementation. Rankings use the chosen coefficient. Explicit requests report
`method`; omission preserves Pearson and the existing response shape. Dataset values
still use the shared causal resolver and optional `maxMissedSessions` limit.

Kendall admits up to 75 million estimated pair comparisons across fields, using
field/target coverage and counting only fields meeting `minSamples`. The shared
ranking module throws the exported `KendallPairWorkLimitError` before quadratic
calculations; MCP reports `kendall_pair_work_limit` and the budget metadata.
A 1,100-trade block with 100 fully covered fields passes (60,445,000 pairs);
a 20,000-trade field is refused. Pearson and Spearman behavior is unchanged.
