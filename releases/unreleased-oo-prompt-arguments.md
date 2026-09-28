# Unreleased — OO prompts take arguments, name the right OO tools and import the daily log

- The four Option Omega prompts take optional arguments: `bring-in-oo-backtest` and `stress-oo-portfolio` take `ooId` and `block`, `is-this-optimum-real` takes `optimizationId`, and `live-vs-oo` takes `block`. In Claude Code they follow the command, for example `/mcp__tradeblocks__bring-in-oo-backtest <savedBacktestId> my-strategy`. Calls without arguments, including a `prompts/get` with no `arguments` field, render the prompts as before.
- `bring-in-oo-backtest` and `stress-oo-portfolio` quote a saved backtest's or portfolio's OO headline figures from `get_saved_backtest` or `get_saved_portfolio`, and use `get_backtest_results` or `get_portfolio_results` only with a finished run's `runId`. An `ooId` is tried as a saved ID first.
- Without the `tradeblocks-skills` plugin, `bring-in-oo-backtest` asks for OO's daily-log export as well as the trade log and imports both with one `import_csv` call using `dailyLogPath`, so the block carries OO's marked daily curve. With only a trade log it says the block has no OO marked daily curve.

Existing tools are unchanged. This note does not bump a version or publish a release.
