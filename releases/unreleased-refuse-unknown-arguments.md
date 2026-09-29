# Unreleased — tools and prompts refuse arguments they do not declare

**Behaviour change to the input contract of every MCP tool and prompt.** Before this change, a tool dropped any top-level argument it did not declare and ran as if the argument had never been sent. It now refuses the call: `Input validation error: Invalid arguments for tool <name>: Unrecognized keys: "a", "b"`. The error names every undeclared key, and the tool does not run. For example, `import_csv` refuses an option it does not have and creates no block. Each tool's `tools/list` input schema now sets `additionalProperties: false`. Any of the five workflow prompts likewise refuses an argument it does not declare. Omitted and empty prompt arguments still render the prompt.

Callers that send only declared arguments are unaffected. A client or script that used to send extra keys, even harmless ones, now gets this error and should send only the arguments in the running server's schema. The main aim is to make version skew visible, for example a newer `tradeblocks-skills` plugin sending an option to an older server. This protects only servers that include this change. An older server still drops unknown arguments, so the plugin keeps checking the running server's schema before it relies on an option such as `dailyLogPath`.

Only top-level arguments are checked. A nested value keeps its own rules, such as the free-form `keyMetrics` of `profile_strategy`. A `TradeBlocksPlugin` tool must be registered with `registerTool` and a Zod object `inputSchema`, which the server makes strict. A plugin tool registered with a raw shape, a union or no schema is refused at startup, naming the tool.

This note does not bump a version or publish a release.
