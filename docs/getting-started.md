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

## Next Steps

- [Market Data Guide](market-data.md) — importing and enriching market data
- [MCP Tools Reference](mcp-tools.md) — complete tool listing by category
- [Architecture](architecture.md) — how TradeBlocks works under the hood
