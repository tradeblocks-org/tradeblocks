# Predictive rank correlation

`find_predictive_fields` accepts optional `method: "pearson" | "spearman" | "kendall"`.
Spearman detects monotone nonlinear relationships; Kendall uses the shared tie-adjusted
tau-b implementation. Rankings use the chosen coefficient. Explicit requests report
`method`; omission preserves Pearson and the existing response shape. Dataset values
still use the shared causal resolver and optional `maxMissedSessions` limit.
