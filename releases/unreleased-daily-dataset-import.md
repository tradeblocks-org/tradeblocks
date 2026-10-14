# User daily dataset import

- Add import_daily_dataset, list_daily_datasets, delete_daily_dataset and list_analysis_fields.
- Store user values in analytics.duckdb datasets schema; never modify market data.
- Reuse Static Dataset CSV parsing and causal per-column timing, including sparse-series carry-forward.
- Profile filters resolve registered dataset columns. enrich_trades preserves custom fields and exposes dataset values with source and availability timestamps.
- Profile coverage is per analysis field: unrelated dataset values cannot inflate built-in baselines or hide missing-market warnings. Dataset-only filters remain usable without market rows.
- Entry-filter comparisons and ablations share the fully covered filter pool; structure-fit dimensions expose their own covered baselines and use those for update hints.
- `analyze_structure_fit`'s `time_of_day` dimension now covers every trade with a valid entry time, including trades without a built-in market row; it needs no market data. Results can change for books with partial market coverage.
- Fix a pre-existing lookahead bug in bare close-derived comparison operands: same-day values were preferred on master before this work. validate_entry_filters results (and other cross-field filter consumers) can change because those operands now use prior-day values, and missing prior observations stay unavailable.
