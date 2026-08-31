# Getting Started

TradeBlocks has two components: an **MCP server** for AI-assisted portfolio analysis, and a **web dashboard** for visual exploration. Most users only need the MCP server.

---

## MCP Server

The MCP server provides 60+ tools for portfolio analysis, trade replay, exit trigger testing, and market data management. Connect it to Claude, ChatGPT, Gemini, or any MCP-compatible AI client.

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
- **Writes need the whole database.** A tool that writes — a data import, a market
  refresh, a sync — needs exclusive access, which it cannot get while another copy
  is reading. It retries for a few seconds and then reports that another server
  holds the database. **Leaving the other session idle does not help** — a copy
  keeps the database open for as long as it runs, so the other server has to exit.
  Quit it, then run the tool again.

If a copy has genuinely wedged and is holding the lock forever, set
`DUCKDB_LOCK_RECOVERY` to `true` in the server's `env` block for one run. That
permits the starting server to terminate the holder. Leave it unset otherwise: the
holder is normally somebody's working session, and terminating it makes each restart
shut down the previous one.

### Environment Variables

| Variable               | Required | Description                                                                                                    |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `DUCKDB_OPEN_WAIT_MS`  | No       | How long to wait for another copy to finish starting before giving up (default: `15000`)                       |
| `DUCKDB_LOCK_RECOVERY` | No       | Set to `true` to let a starting server terminate a live lock holder (default: off; orphans are always cleared) |

---

## Next Steps

- [Market Data Guide](market-data.md) — importing and enriching market data
- [MCP Tools Reference](mcp-tools.md) — complete tool listing by category
- [Architecture](architecture.md) — how TradeBlocks works under the hood
