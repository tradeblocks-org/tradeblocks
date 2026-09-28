# Unreleased — MCP prompts for Option Omega workflows

The MCP server now offers three prompts in stdio and HTTP, available as Claude Code commands when the server is configured as `tradeblocks`:

- `/tradeblocks:bring-in-oo-backtest`: bring a saved OO backtest's trades into a TradeBlocks block.
- `/tradeblocks:is-this-optimum-real`: compare the optimizer's best cell with a stable-region candidate using two scratch backtests and TradeBlocks robustness tools.
- `/tradeblocks:stress-oo-portfolio`: stress a portfolio's trade log as a block.

With the optional `tradeblocks-skills` plugin, the first two workflows use its capture skill. Otherwise, users export CSV from OO to a path readable by the TradeBlocks server and import it with `import_csv`. The prompts do not transcribe OO data through the model or call OO from TradeBlocks. Server instructions now explain the division of work and block/SQL discovery. MCP initialize reports the installed `tradeblocks-mcp` package version rather than a stale hard-coded version. Existing tools and package exports are unchanged; this note does not bump a version or publish a release.
