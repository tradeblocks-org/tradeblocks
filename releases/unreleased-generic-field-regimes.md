# Generic field regimes

- analyze_regime_performance accepts any registered field besides its existing presets.
- Numeric fields use explicit cut-point bins or quantile bins; categorical fields group by value.
- Values use the same causal trade-entry resolver as predictive and enrichment tools. Partial coverage is reported; unknown or uncovered fields are refused by name.
- Existing preset calls remain unchanged.
