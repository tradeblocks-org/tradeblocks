# Unreleased — OO portfolio allocation-loop MCP prompt

- `allocate-oo-portfolio` is a new stdio and HTTP MCP prompt. It proposes allocations from a TradeBlocks block with distinct OO portfolio member strategies, then checks each candidate against shared starting funds via OO `run_portfolio`, `get_portfolio_status` and `get_portfolio_results`. It never changes the saved portfolio; saving a candidate requires an explicit request and a new portfolio.
- Where the installed `oo-capture` describes saved-portfolio capture, it can supply the saved portfolio's strategy-labelled trades and whole-book daily curve; older plugin versions capture only saved backtests and runs. Elsewhere, OO's CSV export plus `import_csv` works, with optional `dailyLogPath`. Trade-derived counterfactuals and OO's marked-equity headline figures remain separately labelled.
- `stress-oo-portfolio` no longer says portfolio capture is unavailable; it uses that capture under the same condition and keeps the CSV path.

Existing tool names, prompt names and arguments are unchanged. This note does not bump a version or publish a release.
