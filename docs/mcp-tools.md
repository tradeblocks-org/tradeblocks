# MCP Tools Reference

TradeBlocks MCP server tools organized by category.

## Block Management

| Tool | Description |
|------|-------------|
| `list_blocks` | List all portfolio blocks with summary statistics |
| `get_block_info` | Detailed info for a specific block |
| `get_statistics` | Portfolio performance metrics (Sharpe, Sortino, drawdown, etc.) |
| `get_trades` | Individual trade records with optional filtering |
| `get_strategy_comparison` | Compare strategies within a single block |
| `compare_blocks` | Side-by-side comparison across multiple blocks |
| `block_diff` | Diff statistics between two blocks |

## Performance Analysis

| Tool | Description |
|------|-------------|
| `get_performance_charts` | Chart data: equity curve, drawdown, monthly returns (16+ types) |
| `get_period_returns` | Returns aggregated by period (daily, weekly, monthly) |
| `compare_backtest_to_actual` | Backtest vs live trade comparison with slippage analysis |

## Trade Replay

| Tool | Description |
|------|-------------|
| `replay_trade` | Replay trades with minute-level P&L path, MFE/MAE, and per-leg greeks. Uses cached bars from `market.intraday`; fetches from Massive.com on cache miss. Three output formats: `full`, `sampled` (default), `summary`. |

## Exit Trigger Analysis

| Tool | Description |
|------|-------------|
| `analyze_exit_triggers` | Evaluate 14 trigger types against a trade's replay path. Shows first-to-fire trigger with P&L comparison against actual exit. |
| `decompose_greeks` | Decompose P&L into delta, gamma, theta, vega, charm, vanna, and residual. Automatic numerical fallback when model-based residual exceeds 80%. Per-leg-group vega attribution for calendar strategies. |
| `batch_exit_analysis` | Test exit policies across entire blocks. Returns aggregate stats (win rate, Sharpe, Sortino, profit factor, drawdown, streaks) with per-trigger attribution. |

All exit tools use cached bars from `market.intraday` — no Massive.com subscription required if bars are pre-loaded.

## Live Options

| Tool | Description |
|------|-------------|
| `get_option_snapshot` | Live option chain with greeks, IV, and open interest from Massive.com. BS greeks fallback for contracts with empty greeks. Requires `MASSIVE_API_KEY`. |

## Market Data Import

| Tool | Description |
|------|-------------|
| `import_market_csv` | Import OHLCV data from a local CSV file with column mapping |
| `import_from_database` | Import from an external DuckDB database via SQL query |
| `import_flat_file` | Import a local Parquet or CSV flat file for a specific ticker and timespan |
| `fetch_bars` | Fetch daily or intraday OHLCV bars from the configured provider and write to Parquet |
| `fetch_quotes` | Fetch option minute quotes from the configured provider and write to Parquet |
| `fetch_chain` | Fetch option chain snapshot for an underlying on a given date |
| `compute_vix_context` | Compute cross-ticker VIX regime fields (Vol_Regime, Term_Structure_State, etc.) for a date range |
| `refresh_market_data` | Composite daily refresh: fetch bars for all tickers, auto-fire VIX context, return coverage report |
| `enrich_market_data` | Run enrichment pipeline to compute derived indicators |
| `purge_market_table` | Delete all data from a market table for re-import |

See [Market Data Guide](market-data.md) for import examples, ticker formats, and enrichment details.

## Market Analysis

| Tool | Description |
|------|-------------|
| `analyze_regime_performance` | Analyze P&L by market regime (VIX levels, term structure, trend) |
| `suggest_filters` | Suggest entry filters based on losing trade analysis |
| `calculate_orb` | Opening range breakout analysis from intraday bars |
| `enrich_trades` | Add market context to trades (lookahead-free temporal joins) |
| `find_predictive_fields` | Identify which market fields predict trade outcomes |
| `filter_curve` | Equity curve with/without a candidate market filter applied |
| `get_field_statistics` | Distribution statistics for any market or trade field |

## Strategy Profiles

| Tool | Description |
|------|-------------|
| `profile_strategy` | Create or update a strategy profile with structured metadata |
| `get_strategy_profile` | Retrieve a stored strategy profile |
| `list_profiles` | List all strategy profiles (optionally filtered by block) |
| `delete_profile` | Delete a strategy profile |

## Profile Analysis

| Tool | Description |
|------|-------------|
| `analyze_structure_fit` | Analyze strategy performance by regime/condition dimensions |
| `validate_entry_filters` | Test each entry filter's contribution to edge |
| `portfolio_structure_map` | Regime x structure coverage matrix across all strategies |
| `suggest_strategy_matches` | Find strategies that match specific market conditions |

## Advanced Analysis

| Tool | Description |
|------|-------------|
| `run_monte_carlo` | Monte Carlo simulation with confidence intervals |
| `run_walk_forward` | Walk-forward analysis to detect overfitting |
| `get_correlation_matrix` | Strategy correlation matrix (Kendall, Spearman, Pearson) |
| `get_tail_risk` | Tail dependence and copula-based risk analysis |
| `get_position_sizing` | Kelly criterion position sizing guidance |
| `regime_allocation_advisor` | Regime-based allocation recommendations |
| `stress_test` | Stress test portfolio against historical scenarios |
| `marginal_contribution` | Marginal contribution of a strategy to portfolio risk/return |
| `what_if_scaling` | What-if analysis for position sizing changes |

## Edge Decay

| Tool | Description |
|------|-------------|
| `analyze_edge_decay` | Detect strategy performance decay over time |
| `analyze_period_metrics` | Performance by time period (quarterly, yearly) |
| `analyze_rolling_metrics` | Rolling window performance metrics |
| `analyze_regime_comparison` | Compare performance across market regime transitions |
| `analyze_walk_forward_degradation` | Walk-forward degradation analysis |

## Portfolio Health

| Tool | Description |
|------|-------------|
| `portfolio_health_check` | Comprehensive health check across multiple dimensions |
| `drawdown_attribution` | Attribute drawdowns to specific strategies or market conditions |
| `strategy_similarity` | Find similar strategies based on return patterns |
| `analyze_discrepancies` | Analyze discrepancies between backtest and live results |
| `analyze_slippage_trends` | Track execution slippage over time |
| `analyze_live_alignment` | Compare live execution against backtest expectations |
| `get_reporting_log_stats` | Statistics on reported/live trade logs |

## SQL and Schema

| Tool | Description |
|------|-------------|
| `run_sql` | Execute SQL against DuckDB. SELECT runs freely. DELETE/UPDATE require `confirm: true` with affected row preview. |
| `describe_database` | Schema discovery with table info, VIX tenor auto-discovery, and example queries |

## Block Import

| Tool | Description |
|------|-------------|
| `import_csv` | Import a CSV file as a new block *(CLI only — not available in Claude Desktop)* |
| `get_backtest_help` | Help with backtest data formats and troubleshooting |

---

For usage examples and common workflows, see the [Usage Guide](usage.md).
