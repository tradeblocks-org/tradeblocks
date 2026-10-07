# Getting Started

TradeBlocks has two components: an **MCP server** for AI-assisted portfolio analysis, and a **web dashboard** for visual exploration. Most users only need the MCP server.

---

## MCP Server

The MCP server provides 60+ tools for portfolio analysis, trade replay, exit trigger testing, and market data management. Connect it to Claude, ChatGPT, Gemini, or any MCP-compatible AI client.

### Prerequisites: no Node installed yet?

Before any `npx` command, open a terminal (PowerShell on Windows) and check:

```bash
node --version
npm --version
npx --version
```

The packaged MCP server requires Node 18+, and **Node 24 LTS** is recommended
for the server and current CLI clients. If a command is missing:

- **macOS:** install Node with npm using the [official macOS installer](https://nodejs.org/en/download),
  or `brew install node` if Homebrew is already installed.
- **Windows:** use the [official Windows installer](https://nodejs.org/en/download),
  or run `winget install OpenJS.NodeJS.LTS`.
- **Linux:** use the [official Linux instructions](https://nodejs.org/en/download)
  for your distribution or version manager, selecting Node 24 with npm.

Close and reopen your terminal, then repeat the checks. Install your AI client
separately: [Claude Desktop](https://claude.ai/download),
[Claude Code](https://code.claude.com/docs/en/setup),
[Codex CLI](https://developers.openai.com/codex/cli/) (`npm install -g @openai/codex`),
or [Gemini CLI](https://geminicli.com/docs/get-started/installation/)
(`npm install -g @google/gemini-cli`). Desktop must have been opened at least
once with its configuration directory present. No OO or market-data credentials
are required for local setup or CSV import.

### Guided local setup (unreleased)

The source build now includes:

```bash
# People: pick a client/folder, see the preview, explicitly consent
npx tradeblocks-mcp setup

# Agents: preview without writing (non-zero consent_required result)
npx tradeblocks-mcp setup --client claude-code --folder "/path/to/backtests" --json

# Apply after reviewing the preview
npx tradeblocks-mcp setup --client claude-code --folder "/path/to/backtests" --yes --json
```

**Not yet published in 3.11.0:** until release, [build from source](../packages/mcp-server/README.md#option-2-from-source)
and use `node packages/mcp-server/server/index.js setup` instead of
`npx tradeblocks-mcp setup`. The configured server launch is still
`npx -y tradeblocks-mcp <absolute-folder>`.

Choose `claude-desktop`, `claude-code`, `codex`, or `gemini`. Setup never installs
software or prompts in JSON/non-TTY mode. It preserves other servers/settings,
refuses malformed configuration, and requires separate `--replace` plus `--yes`
to replace a conflicting entry while preserving its environment secrets.
`--json` returns one final object on stdout with the planned/applied changes,
verification, client action and next steps; the redacted preview goes to stderr
before any write. A successful exit proves the configured server
answered MCP initialization and tool discovery, **not that your client connected**:
restart/reopen Desktop or start a new CLI-client session to load it.

See the [guided setup details](../packages/mcp-server/README.md#guided-local-setup)
for backups, supported config paths, GUI PATH handling and verification failures.
The separate `tradeblocks-skills` plugin is optional for Claude Code only;
setup does not install it, and core CSV analysis needs neither the plugin nor OO.
Manual setup remains supported:

### Quick Start

```bash
# Run directly with npx
npx tradeblocks-mcp ~/Trading/backtests

# Or add to Claude Code
claude mcp add tradeblocks -- npx tradeblocks-mcp ~/Trading/backtests
```

Point it at a folder containing your Option Omega backtest exports (tradelog.csv, dailylog.csv, etc.). Files are auto-detected by column headers, not filenames.

See [packages/mcp-server/README.md](../packages/mcp-server/README.md) for platform-specific configuration (Claude Desktop, Codex CLI, Gemini CLI, ChatGPT, Google AI Studio).

### Docker

```bash
docker pull ghcr.io/tradeblocks-org/tradeblocks-mcp:latest
docker run -v ~/Trading/backtests:/data ghcr.io/tradeblocks-org/tradeblocks-mcp /data
```

### Environment Variables

| Variable              | Required | Description                                                                                                                                             |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MASSIVE_API_KEY`     | No       | Massive.com API key for automated market data import and trade replay bar fetching. All tools work without it using locally cached data or CSV imports. |
| `MARKET_DB_PATH`      | No       | Override market database file path (default: `<backtests-folder>/market.duckdb`)                                                                        |
| `DUCKDB_THREADS`      | No       | Limit DuckDB thread count for resource-constrained environments                                                                                         |
| `DUCKDB_MEMORY_LIMIT` | No       | Limit DuckDB memory usage (e.g., `512MB`)                                                                                                               |

### Massive.com API (Optional)

Massive.com adds automated market data import and on-demand option bar fetching for trade replay. It is not required — CSV import and locally cached bar data work without it.

1. Get an API key from [massive.com](https://massive.com)
2. Set the environment variable:
   ```bash
   export MASSIVE_API_KEY=your_key_here
   ```
   Or add to your Claude Desktop MCP server config:
   ```json
   {
     "mcpServers": {
       "tradeblocks": {
         "command": "npx",
         "args": ["tradeblocks-mcp", "~/Trading/backtests"],
         "env": {
           "MASSIVE_API_KEY": "your_key_here"
         }
       }
     }
   }
   ```
3. Use `fetch_bars` for daily OHLCV or intraday bars, `compute_vix_context` for VIX regime fields, or `refresh_market_data` for a combined daily refresh
4. Replay tools fetch option bars on cache miss automatically

See [Market Data Guide](market-data.md) for full details on import paths, ticker formats, and enrichment.

---

## Web Dashboard

The web dashboard is a Next.js app for visual portfolio exploration — equity curves, drawdown charts, monthly returns, and 16+ chart types. It uses IndexedDB for client-side storage and does not require the MCP server.

### Prerequisites

- **Node.js 22+**
- **npm**

### Setup

```bash
git clone https://github.com/tradeblocks-org/tradeblocks.git
cd tradeblocks
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the dashboard.

### Your First Data Import

1. Navigate to **Blocks** and create a new block
2. Upload a `tradelog.csv` file (from [Option Omega](https://optionomega.com/) or compatible format)
3. Optionally upload a `dailylog.csv` for enhanced drawdown calculations
4. View your portfolio statistics, equity curve, and performance metrics

### Environment Variables

| Variable               | Required | Description                                                      |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `TRADEBLOCKS_DATA_DIR` | No       | Override default data directory (default: `~/Trading/backtests`) |

---

## Running More Than One Copy of the Server

Some clients start more than one copy of the MCP server against the same data
directory. Claude Desktop does this: one copy serves the desktop app, and a second
serves Cowork and Code sessions.

That is supported. The analytics database allows any number of readers at once, so
the copies coexist. Two details are worth knowing:

- **Startup is briefly exclusive.** Each copy takes the database's write lock for a
  moment to create its tables, and during that moment no other copy can open the
  file. A copy that starts while another is doing this waits for it to finish and
  then opens read-only. You may see a line like `Another tradeblocks-mcp server
holds …; opened READ_ONLY`. Nothing is wrong.
- **Writes need the whole database, briefly.** A tool that writes — a data import, a
  market refresh, a sync — needs exclusive access, which it cannot have while another
  copy is reading. Copies let go of the database a few seconds after they stop being
  used, so an idle copy is not in the way and a write simply waits its turn. You only
  see a failure if another copy stays busy longer than the write is willing to wait;
  run the tool again once that copy has finished.

If a copy has genuinely wedged and is holding the lock forever, set
`DUCKDB_LOCK_RECOVERY` to `true` in the server's `env` block for one run. That
permits the starting server to terminate the holder. Leave it unset otherwise: the
holder is normally somebody's working session, and terminating it makes each restart
shut down the previous one.

### Environment Variables

| Variable                    | Required | Description                                                                                                                              |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DUCKDB_OPEN_WAIT_MS`       | No       | How long to wait for another copy to finish starting before giving up (default: `15000`)                                                 |
| `DUCKDB_IDLE_RELEASE_MS`    | No       | How long a copy keeps the database open after it stops being used (default: `3000`). Raising it makes writes in other copies wait longer |
| `DUCKDB_WRITE_LOCK_RETRIES` | No       | One-second attempts a write makes before giving up (default: `10`). Keep it above another copy's release time                            |
| `DUCKDB_LOCK_RECOVERY`      | No       | Set to `true` to let a starting server terminate a live lock holder (default: off; orphans are always cleared)                           |

---

## Next Steps

- [Market Data Guide](market-data.md) — importing and enriching market data
- [MCP Tools Reference](mcp-tools.md) — complete tool listing by category
- [Architecture](architecture.md) — how TradeBlocks works under the hood
