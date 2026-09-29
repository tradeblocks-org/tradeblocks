# MCP Tools Reference

TradeBlocks MCP server tools organized by category.

## Block Management

| Tool                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `list_blocks`             | List all portfolio blocks with summary statistics               |
| `get_block_info`          | Detailed info for a specific block                              |
| `get_statistics`          | Portfolio performance metrics (Sharpe, Sortino, drawdown, etc.) |
| `run_sql`                 | Query individual trades in `trades.trade_data`                  |
| `get_strategy_comparison` | Compare strategies within a single block                        |
| `compare_blocks`          | Side-by-side comparison across multiple blocks                  |
| `block_diff`              | Diff statistics between two blocks                              |

## Performance Analysis

| Tool                         | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `get_performance_charts`     | Chart data: equity curve, drawdown, monthly returns (16+ types) |
| `get_period_returns`         | Returns aggregated by period (daily, weekly, monthly)           |
| `compare_backtest_to_actual` | Backtest vs live trade comparison with slippage analysis        |

## Trade Replay

| Tool           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay_trade` | Replay trades with minute-level P&L path, MFE/MAE, and per-leg greeks. Uses cached bars from `market.intraday`; fetches from Massive.com on cache miss. Quote sanity: opening-rotation quotes (before 09:32 ET) and quotes with a zero or missing bid or ask are dropped and the previous mark is carried forward; the path starts at the trade's entry time (`time_opened`, or `open_time` in hypothetical mode). Three output formats: `full`, `sampled` (default), `summary`. |

## Exit Trigger Analysis

| Tool                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze_exit_triggers` | Evaluate 14 trigger types against a trade's replay path. Shows first-to-fire trigger with P&L comparison against actual exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `decompose_greeks`      | Decompose P&L into delta, gamma, theta, vega, charm, vanna, and residual by full revaluation along an ordered path (time, then vol, then spot): the vol move is priced at the step's new time to expiry, so on short-dated legs crossing a night or weekend the vega decay stays in vega instead of cancelling against the residual, and the residual is model error only. Automatic numerical fallback when the model-based residual exceeds 80% of the gross attribution flow (the sum of absolute factor totals, residual included) — measured against gross flow rather than net P&L so a legitimate multi-day step on a hedged position does not trip the fallback. Per-leg-group vega attribution for calendar strategies. |
| `batch_exit_analysis`   | Test exit policies across entire blocks. Returns aggregate stats (win rate, Sharpe, Sortino, profit factor, drawdown, streaks) with per-trigger attribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

All exit tools use cached bars from `market.intraday` — no Massive.com subscription required if bars are pre-loaded.

## Greek Attribution

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get_greeks_attribution` | Decompose a block's P/L into Greek contributions |

## Live Options

| Tool                  | Description                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_option_snapshot` | Live option chain with greeks, IV, and open interest from Massive.com. BS greeks fallback for contracts with empty greeks. Requires `MASSIVE_API_KEY`. |

## Market Data Import

| Tool                   | Description                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `import_market_csv`    | Import OHLCV data from a local CSV file with column mapping                                        |
| `import_from_database` | Import from an external DuckDB database via SQL query                                              |
| `import_flat_file`     | Import a local Parquet or CSV flat file for a specific ticker and timespan                         |
| `fetch_bars`           | Fetch daily or intraday OHLCV bars from the configured provider and write to Parquet               |
| `fetch_quotes`         | Fetch option minute quotes from the configured provider and write to Parquet                       |
| `fetch_chain`          | Fetch option chain snapshot for an underlying on a given date                                      |
| `compute_vix_context`  | Compute cross-ticker VIX regime fields (Vol_Regime, Term_Structure_State, etc.) for a date range   |
| `refresh_market_data`  | Composite daily refresh: fetch bars for all tickers, auto-fire VIX context, return coverage report |
| `enrich_market_data`   | Run enrichment pipeline to compute derived indicators                                              |
| `purge_market_table`   | Delete all data from a market table for re-import                                                  |

See [Market Data Guide](market-data.md) for import examples, ticker formats, and enrichment details.

## Underlying Registry

| Tool                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `register_underlying`   | Add or update an underlying-to-roots mapping   |
| `unregister_underlying` | Remove a user-added underlying mapping         |
| `list_underlyings`      | List bundled and user-added ticker mappings    |
| `resolve_root`          | Explain how a symbol resolves to a ticker root |

## Market Analysis

| Tool                         | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `analyze_regime_performance` | Analyze P&L by market regime (VIX levels, term structure, trend) |
| `suggest_filters`            | Suggest entry filters based on losing trade analysis             |
| `calculate_orb`              | Opening range breakout analysis from intraday bars               |
| `enrich_trades`              | Add market context to trades (lookahead-free temporal joins)     |
| `find_predictive_fields`     | Identify which market fields predict trade outcomes              |
| `filter_curve`               | Equity curve with/without a candidate market filter applied      |
| `get_field_statistics`       | Distribution statistics for any market or trade field            |

## Strategy Profiles

| Tool                   | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `profile_strategy`     | Create or update a strategy profile with structured metadata |
| `get_strategy_profile` | Retrieve a stored strategy profile                           |
| `list_profiles`        | List all strategy profiles (optionally filtered by block)    |
| `delete_profile`       | Delete a strategy profile                                    |

## Profile Analysis

| Tool                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `analyze_structure_fit`    | Analyze strategy performance by regime/condition dimensions |
| `validate_entry_filters`   | Test each entry filter's contribution to edge               |
| `portfolio_structure_map`  | Regime x structure coverage matrix across all strategies    |
| `suggest_strategy_matches` | Find strategies that match specific market conditions       |

## Advanced Analysis

| Tool                          | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `run_monte_carlo`             | Monte Carlo simulation with confidence intervals             |
| `run_walk_forward`            | Walk-forward analysis to detect overfitting                  |
| `get_correlation_matrix`      | Strategy correlation matrix (Kendall, Spearman, Pearson)     |
| `get_tail_risk`               | Tail dependence and copula-based risk analysis               |
| `get_position_sizing`         | Kelly criterion position sizing guidance                     |
| `regime_allocation_advisor`   | Regime-based allocation recommendations                      |
| `stress_test`                 | Stress test portfolio against historical scenarios           |
| `marginal_contribution`       | Marginal contribution of a strategy to portfolio risk/return |
| `what_if_scaling`             | What-if analysis for position sizing changes                 |
| `paired_bootstrap_comparison` | Paired bootstrap intervals for two strategy runs             |

## Edge Decay

| Tool                               | Description                                          |
| ---------------------------------- | ---------------------------------------------------- |
| `analyze_edge_decay`               | Detect strategy performance decay over time          |
| `analyze_period_metrics`           | Performance by time period (quarterly, yearly)       |
| `analyze_rolling_metrics`          | Rolling window performance metrics                   |
| `analyze_regime_comparison`        | Compare performance across market regime transitions |
| `analyze_walk_forward_degradation` | Walk-forward degradation analysis                    |

Walk-forward windows are inclusive US Eastern calendar-day ranges. Both
`run_walk_forward` and `analyze_walk_forward_degradation` evaluate only complete
IS+OOS windows ending on or before the last trade date. A trailing window whose
OOS end exceeds that date is not evaluated; when this occurs, the tools return
`skippedWindows` alongside `periods` with the planned `inSampleStart`, `inSampleEnd`,
`outOfSampleStart`, `outOfSampleEnd`, `reason: "truncated_oos_window"`, and
`detail` naming the last trade date. Degradation entries also include
`periodIndex`. The run tool's skipped dates retain its legacy
`YYYY-MM-DDT00:00:00.000Z` format; degradation dates are `YYYY-MM-DD`.
The existing `stats.skippedPeriods` or `dataQuality.skippedPeriods` includes
these truncated windows as well as any windows skipped for insufficient trades.

## Portfolio Health

| Tool                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `portfolio_health_check`  | Comprehensive health check across multiple dimensions           |
| `drawdown_attribution`    | Attribute drawdowns to specific strategies or market conditions |
| `strategy_similarity`     | Find similar strategies based on return patterns                |
| `analyze_discrepancies`   | Analyze discrepancies between backtest and live results         |
| `analyze_slippage_trends` | Track execution slippage over time                              |
| `analyze_live_alignment`  | Compare live execution against backtest expectations            |
| `get_reporting_log_stats` | Statistics on reported/live trade logs                          |

## SQL and Schema

| Tool                | Description                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `run_sql`           | Execute SQL against DuckDB. SELECT runs freely. DELETE/UPDATE require `confirm: true` with affected row preview. |
| `describe_database` | Schema discovery with table info, VIX tenor auto-discovery, and example queries                                  |

## Block Import

| Tool                | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `import_csv`        | Import a CSV as a new block; optionally pair trade + daily logs |
| `get_backtest_help` | Help with backtest data formats and troubleshooting             |

`import_csv` accepts `csvPath`, `blockName`, optional `csvType` (`tradelog` by
default), optional `dailyLogPath` for a paired daily log, and `plBasis`
(`net_includes_fees` by default for Option Omega exports; `gross_before_fees`
when P/L has not yet deducted commissions and fees). Both paths must be
readable by the server: local paths for stdio, or paths inside the server's
mounted data directory for Docker/HTTP. Paths accept absolute values, `~`,
or filename-only lookup in `searchPaths` (default: Downloads, Desktop, Documents).
Before creating a block, `import_csv` refuses a trade or reporting row with an
impossible opened/closed calendar date or a missing or unparseable P/L;
gross-before-fees trade rows also need numeric commission fields. Paired daily
logs require `Date` and a numeric `Net Liquidity` (or `Portfolio Value`,
`Value`, `Equity`); `P/L` and `Drawdown %` are optional. A trade log's `P/L %`
column is optional too: a numeric cell becomes the trade's `plPct` in report
tools, and a blank or unparseable cell falls back to the computed value without
refusing the row. Errors name the CSV
file line (the header is line 1). Any refused row, in either file, refuses the
entire import without creating a block. The result's `recordCount` counts the
rows actually loaded from the primary CSV, and its `strategies` use the block
ID when the CSV has no Strategy column, matching `get_block_info`. `dateRange`
holds the first and last calendar dates (`YYYY-MM-DD`). Paired imports
additionally return `dailyLog.recordCount` and `dailyLog.dateRange` in the same
calendar-date form. Unfiltered `get_statistics` uses the daily-log portfolio
drawdown; strategy-filtered statistics remain trade-based.
Unfiltered `get_statistics` with a daily log computes `calmarRatio` from marked
first-to-last net-liquidity CAGR divided by the daily log's maximum absolute
drawdown percentage. Without a daily log, or with a strategy/ticker filter, it
uses trade CAGR divided by trade-equity drawdown. The result labels the basis
as `calculationMethodology.calmar.basis` (`daily_log_marked_curve` or
`realized_trade_equity`); `cagr` remains trade-based and `maxDrawdown` retains
its current source independently. `compare_blocks` carries the same value per
block as `calmarBasis` whenever `calmarRatio` is among its requested metrics.

---

For usage examples and common workflows, see the [Usage Guide](usage.md).

## Prompts

The MCP server also lists five prompts in stdio and HTTP. In Claude Code, with
the server configured under the name `tradeblocks`, the `/` menu lists them as
`/tradeblocks:bring-in-oo-backtest (MCP)`, `/tradeblocks:is-this-optimum-real (MCP)`,
`/tradeblocks:stress-oo-portfolio (MCP)`, `/tradeblocks:live-vs-oo (MCP)` and
`/tradeblocks:allocate-oo-portfolio (MCP)`; typed, they run as
`/mcp__tradeblocks__bring-in-oo-backtest` and so on. Other MCP clients use
`prompts/list` and `prompts/get`. These prompts guide analysis, not server-side
calls to Option Omega. The OO server name is chosen by the user.

Each prompt takes optional arguments, passed after the command in Claude Code
(space-separated, in this order) or as named `prompts/get` arguments elsewhere.
Without them the prompt works from the conversation, as before.

| Prompt                  | Arguments                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `bring-in-oo-backtest`  | `ooId` (OO `savedBacktestId`, or a scratch run's `runId`), `block` (new block name)      |
| `is-this-optimum-real`  | `optimizationId` (OO optimization to evaluate)                                           |
| `stress-oo-portfolio`   | `ooId` (OO `savedPortfolioId`, or a portfolio run's `runId`), `block` (block ID or name) |
| `live-vs-oo`            | `block` (block ID of the OO reference backtest)                                          |
| `allocate-oo-portfolio` | `ooId` (OO saved portfolio ID or run ID), `block` (block ID or import name)              |

For example, `/mcp__tradeblocks__bring-in-oo-backtest <savedBacktestId> my-strategy`.
A saved backtest's or portfolio's own OO headline figures come from
`get_saved_backtest` or `get_saved_portfolio`; `get_backtest_results` and
`get_portfolio_results` are only for a finished run's `runId`.

| Prompt                  | Workflow                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bring-in-oo-backtest`  | Bring OO trades into a block; verify it with `get_block_info` and `get_statistics`.                                                                                                                |
| `is-this-optimum-real`  | Capture verified scratch runs, combine in a trade-only block and test both arms and their paired difference.                                                                                       |
| `stress-oo-portfolio`   | Analyze a portfolio's economic trades with portfolio risk tools.                                                                                                                                   |
| `live-vs-oo`            | Compare a reporting log's live trades with the OO reference block it sits in, using `compare_backtest_to_actual`, `analyze_discrepancies`, `analyze_slippage_trends` and `analyze_live_alignment`. |
| `allocate-oo-portfolio` | Propose allocations using a strategy-labelled portfolio block, then check each candidate with OO `run_portfolio` against shared funds; do not save the original portfolio.                         |

The `bring-in-oo-backtest` prompt uses the `tradeblocks-skills` plugin's
`/tradeblocks:oo-capture` when installed. Without it, `bring-in-oo-backtest`
asks for both OO's trade-log CSV and its daily-log CSV, saved at paths the
TradeBlocks server can read, and calls `import_csv` once with `dailyLogPath`,
so one block holds OO's trades and marked daily curve; with only a trade log it
says the block has no OO marked daily curve. The optimum prompt points plugin users
to `/tradeblocks:is-this-optimum-real`, which captures each run separately and
combines the verified trades into one comparison block; its paired result is
best minus centre on jointly traded days, not adjusted for grid selection.
Without the plugin, users export each scratch run's CSV from OO into separate
blocks: only per-block tests against zero run, not a paired difference. Export
to a path readable by the TradeBlocks server and import with `import_csv`.
In Docker/HTTP the CSV must be inside the server's mounted data directory.
If the server cannot read it, the workflow stops instead of re-typing OO's
responses. The read-only `stress-oo-portfolio` prompt can use the plugin's
saved-portfolio capture when the installed `oo-capture` supports it, or an
existing portfolio block or OO's exported trade log otherwise. OO's marked-account headlines and
TradeBlocks' realized-trade statistics must be labelled separately, especially
drawdown; OO profit already includes fees.

The `allocate-oo-portfolio` prompt takes optional `ooId` (saved portfolio ID,
or a scratch run ID) and `block` (block ID or import name) arguments; without
arguments it resolves the source from the conversation. When the installed
`/tradeblocks:oo-capture` describes saved-portfolio capture, it captures a saved
portfolio with distinct member strategy labels and its whole-book daily curve;
older plugin versions capture only saved backtests and runs. Otherwise use an
OO-exported portfolio trade-log CSV with `import_csv`, adding `dailyLogPath`
when the daily-log export is available. Both files must be server-readable.
TradeBlocks' correlation, marginal, tail, what-if and health analyses are
trade-derived counterfactual proposals, not OO's marked-account results.
Only a completed `run_portfolio` whose `get_portfolio_results` was read is
OO-tested. Saving a candidate requires an explicit request and a new portfolio;
the prompt never changes the saved source.

For `live-vs-oo`, save the reporting-log CSV inside the OO reference block's own
folder, beside its trade log; `import_csv` would make a separate block that the
comparison tools cannot pair.

## Developing MCP Tools

### Keep Decisions with the Caller

The language model is the intelligence layer for discovery and configuration. Prefer typed tool
inputs such as `{ file_path, dataset_type, select_sql, partition }` over server-side format
registries, provider matrices, schema sniffing, or growing provider switches. The caller can inspect
files with `run_sql`, discover target shapes with `describe_database`, and provide a transforming
query. Storage modules should expose a small mode-aware write primitive, while providers should stop
at fetching or downloading bytes. A new input format should require no server change when a caller
can express the conversion in SQL.

When adding a statistic or chart to the web application, consider whether AI analysis also needs it.
Summary metrics generally belong in `get_statistics`; time-series outputs generally belong in
`get_performance_charts`.

### Verification

After changing MCP server source:

1. Run `npm run build -w packages/mcp-server`.
2. Run the relevant unit and integration tests, including every configured provider whose
   capabilities the change affects. Read-only paths need one provider-independent run.
3. Start the built server through MCP Inspector and call `tools/list` against a representative data
   directory. A live start catches connection ordering, stale object types, and real Parquet view
   registration problems that fixtures can miss.

The server initializes in read-write mode, then returns to read-only operation. Write tools upgrade
the connection on demand. Market reads use Parquet-backed views when the configured market directory
exists and equivalent DuckDB tables otherwise; mutable sync metadata remains a table.
