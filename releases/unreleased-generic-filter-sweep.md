# Generic filter threshold sweeps

- suggest_filters accepts optional fields to sweep any registered numeric or categorical field using causal trade-entry values. Omit fields to retain existing defaults.
- filter_curve and suggest_filters share scale-preserving percentile threshold sweeps; small-valued series no longer collapse to two-decimal thresholds.
- Generic suggestions report field coverage and refuse unknown or entirely uncovered fields.
