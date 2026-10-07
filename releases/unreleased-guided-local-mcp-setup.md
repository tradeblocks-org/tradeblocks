# Unreleased — guided safe local MCP setup

Adds `tradeblocks-mcp setup` for Claude Desktop, Claude Code, Codex CLI and Gemini CLI. People select a client/data folder and explicitly approve the preview; agents use `--client`, `--folder`, `--yes` and `--json` for one structured result without prompts. A conflicting `tradeblocks` entry needs separate `--replace` permission. Equivalent entries are not rewritten and are still verified.

Setup uses official user-scope CLI registration commands or Desktop's documented per-OS JSON file. It refuses malformed/unreadable settings, preserves unrelated settings and existing environment secrets, and shows environment key names rather than values. Desktop updates are atomic and retain a backup; Claude Code replacement keeps a backup and restores it on a failed remove/add. The registered npx path is absolute, and fresh Desktop entries include Node/npm's PATH so GUI launches do not depend on a shell startup file.

Success requires a real MCP initialization and tool discovery against the read-back configured server subprocess, with a bounded timeout and shutdown. This is not a claim that the AI client connected: Desktop must be reopened and CLI clients need a new session. Verification failure is distinct from registration failure and returns non-zero even if configuration was written.

The packaged bin now enters through a small engine-checking bootstrap, before loading setup or the existing server module. This lets unsupported Node versions return actionable prerequisite guidance rather than failing while importing newer built-ins. The existing `server/index.js` server/host entry remains available.

Node/npm/client installation remains manual, with prerequisites documented for macOS, Windows and Linux before any npm command. No OO credentials, provider keys or optional Claude Code skills plugin are needed. Existing stdio/HTTP invocation, environment options and retained skills-instruction commands are unchanged. No version bump or publication is included; guided setup is not yet in published 3.11.0.
