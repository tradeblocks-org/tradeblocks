# User daily dataset import

- Add import_daily_dataset, list_daily_datasets, delete_daily_dataset and list_analysis_fields.
- Store user values in analytics.duckdb datasets schema; never modify market data.
- Reuse Static Dataset CSV parsing and causal per-column timing, including sparse-series carry-forward.
- Profile filters resolve registered dataset columns. enrich_trades preserves custom fields and exposes dataset values with source and availability timestamps.
