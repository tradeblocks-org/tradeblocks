# Unreleased — MCP help and tool references name real tools

`import_csv`'s `nextSteps` now point to registered tools (`get_block_info`, `run_sql`, `run_monte_carlo`) instead of `get_block_details`, `get_trades` and `run_analysis`, which the server does not provide. The VIX-context hint now names `fetch_bars` or `import_market_csv`, then `enrich_market_data` and `compute_vix_context`, instead of the removed `import_from_api`. `import_csv`'s description no longer says it needs local filesystem access: its paths must be readable by the server, locally for stdio or inside the mounted data directory for Docker/HTTP.

`tradeblocks-mcp --help` now says that `install-skills`, `uninstall-skills` and `check-skills` print the tradeblocks-skills plugin installation instructions and exit, which is what they have done since skills moved to the plugin; it no longer lists `--platform` or `--force`. The commands themselves are unchanged.

The MCP Tools Reference lists every registered tool, the CSV-format documentation describes `plBasis` (default `net_includes_fees` for Option Omega exports), the required columns and dollar-form premiums, and the Usage Guide gains a section on bringing in an Option Omega backtest. Tool inputs and package exports are unchanged. This note does not bump a version or publish a release.
