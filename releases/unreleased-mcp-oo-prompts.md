# Unreleased — MCP prompts for Option Omega workflows

The MCP server now offers four prompts in stdio and HTTP. In Claude Code, with the server configured as `tradeblocks`, they appear in the `/` menu as `/tradeblocks:<prompt> (MCP)` and run when typed as `/mcp__tradeblocks__<prompt>`:

- `bring-in-oo-backtest`: bring a saved OO backtest's trades into a TradeBlocks block.
- `is-this-optimum-real`: with the plugin, guide two separately verified OO scratch runs into one trade-only comparison block under distinct strategies; test both arms and their paired best-minus-centre difference, stating its selection and overlap limits.
- `stress-oo-portfolio`: stress a portfolio's trade log as a block.
- `live-vs-oo`: compare live trades from a reporting log with an OO reference backtest's block, using the existing `compare_backtest_to_actual`, `analyze_discrepancies`, `analyze_slippage_trends` and `analyze_live_alignment` tools. The reporting-log CSV goes in the same block folder as the OO trade log; the prompt names the OO reference (a scratch run's `runId`, or a saved backtest's ID and capture date).

With the optional `tradeblocks-skills` plugin, the import prompt uses `/tradeblocks:oo-capture` and the optimum prompt points to `/tradeblocks:is-this-optimum-real`. Without it, users export each run's CSV from OO into a separate block at a server-readable path; only tests against zero run, not a paired difference. The prompts do not transcribe OO data through the model or call OO from TradeBlocks. Server instructions explain the division of work and block/SQL discovery. MCP initialize reports the installed `tradeblocks-mcp` package version rather than a stale hard-coded version. Existing tools and package exports are unchanged; this note does not bump a version or publish a release.
