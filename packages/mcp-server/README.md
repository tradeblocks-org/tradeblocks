# TradeBlocks MCP Server

Model Context Protocol (MCP) server for options trading analysis. Works with Claude Desktop, Claude Code, Codex CLI, Gemini CLI, ChatGPT, Google AI Studio, and any MCP-compatible client.

## Features

- **Comprehensive MCP tools** for trading analysis
- **SQL analytics layer** - `run_sql` for arbitrary queries, `describe_database` for schema discovery
- **Two transport modes**: stdio (CLI tools) and HTTP (web platforms)
- **Block-based data organization** - each folder is a trading strategy
- **DuckDB analytics** - statistics computed from DuckDB, no file caching needed
- **Flexible CSV detection** - auto-detects file types by column headers
- **Strategy profiles** - store and retrieve structured strategy metadata for targeted analysis

## Installation

### Option 1: MCPB Bundle (Claude Desktop - One Click)

Download the latest `.mcpb` file from [Releases](https://github.com/tradeblocks-org/tradeblocks/releases) and double-click to install.

The installer will prompt you to select your Trading Data Directory.

### Option 2: npx (All Platforms)

Run directly without installation:

```bash
# stdio mode (Claude Desktop, Claude Code, Codex CLI, Gemini CLI)
npx tradeblocks-mcp ~/Trading/backtests

# HTTP mode (ChatGPT, Google AI Studio, Julius AI)
npx tradeblocks-mcp --http ~/Trading/backtests
```

See [Configuration by Platform](#configuration-by-platform) below for platform-specific setup.

### Option 3: From Source

```bash
git clone https://github.com/tradeblocks-org/tradeblocks
cd tradeblocks
npm install
npm run build -w packages/mcp-server

# Run the server
node packages/mcp-server/server/index.js ~/Trading/backtests
```

## Quick Start

1. **Set up your data** - Create folders for each strategy with CSV files
2. **Connect your AI platform** - See [Configuration by Platform](#configuration-by-platform) below
3. **Start analyzing** - Ask your AI to "list my backtests" or "run a health check on iron-condor"

For detailed usage examples, see [../../docs/usage.md](../../docs/usage.md).

## Configuration by Platform

### Claude Desktop

| Platform | Config Location |
|----------|-----------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "tradeblocks": {
      "command": "npx",
      "args": ["tradeblocks-mcp", "/path/to/your/backtests"]
    }
  }
}
```

### Claude Code (CLI)

```bash
# Add the MCP server
claude mcp add tradeblocks -- npx tradeblocks-mcp ~/Trading/backtests

# Or with environment variable
export BLOCKS_DIRECTORY=~/Trading/backtests
claude mcp add tradeblocks -- npx tradeblocks-mcp
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.tradeblocks]
command = "npx"
args = ["tradeblocks-mcp", "/path/to/your/backtests"]
```

Or add via command line:

```bash
codex mcp add tradeblocks -- npx tradeblocks-mcp ~/Trading/backtests
```

See [Codex MCP documentation](https://developers.openai.com/codex/mcp/) for more options.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "tradeblocks": {
      "command": "npx",
      "args": ["tradeblocks-mcp", "/path/to/your/backtests"]
    }
  }
}
```

See [Gemini CLI MCP documentation](https://geminicli.com/docs/tools/mcp-server/) for more options.

### Web Platforms (ChatGPT, Google AI Studio, Julius)

Web AI platforms require HTTP transport with a publicly reachable URL:

```bash
tradeblocks-mcp --http ~/Trading/backtests
```

Then expose port 3100 however you prefer (ngrok, Cloudflare Tunnel, reverse proxy, Docker on a server, etc.) and add the URL (`https://your-host/mcp`) to your platform's MCP settings.

See [Web Platforms Guide](../../docs/web-platforms.md) for platform-specific setup, or [Docker Deployment](#docker-deployment) for running on a remote server.

## Transport Modes

| Mode | Flag | Use Case | Platforms |
|------|------|----------|-----------|
| stdio | (default) | Local CLI tools | Claude Desktop, Claude Code, Codex CLI, Gemini CLI |
| HTTP | `--http` | Web platforms, remote servers | ChatGPT, Google AI Studio, Julius AI |

```bash
# stdio mode (default)
tradeblocks-mcp ~/backtests

# HTTP mode
tradeblocks-mcp --http ~/backtests
tradeblocks-mcp --http --port 8080 ~/backtests

# Separate CSV blocks from DuckDB storage
tradeblocks-mcp --directory ./data --blocks-dir ~/backtests
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--http` | Start HTTP server instead of stdio | stdio |
| `--port <n>` | HTTP server port | 3100 |
| `--blocks-dir <path>` | Directory containing CSV block folders | same as data directory |
| `--market-db <path>` | Path to market.duckdb | `<directory>/market.duckdb` |
| `--no-auth` | Disable authentication (HTTP mode) | auth enabled |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BLOCKS_DIRECTORY` | Default data directory if not specified as argument |
| `TRADEBLOCKS_BLOCKS_DIR` | Directory for CSV block folders (overridden by `--blocks-dir`) |
| `MARKET_DB_PATH` | Path to market.duckdb (overridden by `--market-db`) |

### ThetaData MDDS Credentials

Set `MARKET_DATA_PROVIDER=thetadata` to use the direct ThetaData MDDS/gRPC provider. It connects to MDDS directly; ThetaTerminal, a local JVM, and terminal auto-start settings are not used.

Configure credentials with either:

```bash
THETADATA_EMAIL=you@example.com
THETADATA_PASSWORD=your-password
```

Or use `THETADATA_CREDENTIALS_FILE` with the email on line 1 and password on line 2:

```text
you@example.com
your-password
```

Optional advanced MDDS settings include `THETADATA_MDDS_HOST`, `THETADATA_MDDS_PORT`, `THETADATA_MDDS_MAX_CONCURRENCY`, and retry tuning env vars. Do not commit credentials or put secrets directly in checked-in service files.

## Docker Deployment

Run the MCP server in a container for remote/server deployments.

### Pre-built image (recommended)

```bash
docker run -d -p 3100:3100 -v ./data:/data --env-file .env romeo345/tradeblocks-mcp:latest
```

Or with docker compose, set the image in `docker-compose.yml`:
```yaml
services:
  tradeblocks:
    image: romeo345/tradeblocks-mcp:latest
```

### Build from source

```bash
cd packages/mcp-server
npm run build                # build on host (resolves workspace deps)
docker build -t tradeblocks-mcp .
docker compose up -d
```

Place your block folders (each containing CSV files) in the `data/` directory, or use `--blocks-dir` to point at a separate folder. The container runs in HTTP mode on port 3100 by default. See [Authentication](#authentication) below for configuring credentials.

Connect any MCP client to `http://<your-host>:3100/mcp`. How you expose this endpoint (reverse proxy, tunnel, VPN, etc.) is up to you.

## Authentication

HTTP mode includes **OAuth 2.1 with PKCE** authentication, enabled by default. MCP clients that support OAuth (Claude, ChatGPT, etc.) handle the flow automatically — users see a login prompt on first connection.

### Setup

Copy `.env.example` to `.env` and configure:

```env
# Required for HTTP mode
TRADEBLOCKS_USERNAME=admin
TRADEBLOCKS_PASSWORD=changeme
TRADEBLOCKS_JWT_SECRET=           # generate with: openssl rand -hex 32

# Optional
TRADEBLOCKS_PORT=3100             # HTTP port (default: 3100)
TRADEBLOCKS_JWT_EXPIRY=24h        # Token lifetime (default: 24h)
TRADEBLOCKS_ISSUER_URL=           # Public URL when behind a reverse proxy (e.g. https://mcp.yourdomain.com)

# DuckDB tuning
DUCKDB_THREADS=2
DUCKDB_MEMORY_LIMIT=512MB
```

### Disabling Auth

If the server is behind a reverse proxy or tunnel that already handles authentication:

```bash
tradeblocks-mcp --http --no-auth ~/backtests
```

Or set `TRADEBLOCKS_NO_AUTH=true` in `.env`.

## Agent Skills

For guided conversational workflows, install the bundled agent skills:

```bash
# Install skills to Claude Code
tradeblocks-mcp install-skills

# Install to other platforms
tradeblocks-mcp install-skills --platform codex
tradeblocks-mcp install-skills --platform gemini

# Check installation status
tradeblocks-mcp check-skills

# Remove skills
tradeblocks-mcp uninstall-skills
```

Skills provide structured prompts for tasks like:
- Strategy health checks
- Walk-forward analysis interpretation
- Portfolio addition recommendations
- Correlation analysis

See [Agent Skills README](../agent-skills/README.md) for details.

## Block Directory Structure

Each folder in your blocks directory represents a trading strategy:

```
backtests/
  SPX-Iron-Condor/
    tradelog.csv      # Required - trade history
    dailylog.csv      # Optional - daily portfolio values
    reportinglog.csv  # Optional - live/reported trades
  NDX-Put-Spread/
    my-export.csv     # Works! Auto-detected by columns
    ...
```

### CSV Formats

**tradelog.csv** - Trade records with these key columns:
- Date Opened, Time Opened, Date Closed, Time Closed
- P/L (gross profit/loss)
- Strategy, Legs (or Symbol)
- No. of Contracts, Premium (optional)

**dailylog.csv** - Daily portfolio values:
- Date
- Net Liquidity (or Portfolio Value, Equity)
- P/L, Drawdown % (optional)

**Flexible Detection**: Files don't need standard names. The server detects CSV types by examining column headers (ISS-006).

## Available Tools

### Core Tools
| Tool | Description |
|------|-------------|
| `list_blocks` | List all available blocks with summary stats |
| `get_block_info` | Detailed info for a specific block |
| `get_statistics` | Performance metrics (Sharpe, Sortino, drawdown, etc.) |
| `get_strategy_comparison` | Compare strategies within a block |
| `compare_blocks` | Compare statistics across multiple blocks |

### Analysis Tools
| Tool | Description |
|------|-------------|
| `run_walk_forward` | Walk-forward analysis with configurable windows |
| `run_monte_carlo` | Monte Carlo simulation with worst-case scenarios |
| `get_correlation_matrix` | Strategy correlation matrix (Kendall, Spearman, Pearson) |
| `get_tail_risk` | Tail dependence and copula-based risk analysis |
| `get_position_sizing` | Kelly criterion position sizing |

### Performance Tools
| Tool | Description |
|------|-------------|
| `get_performance_charts` | 16 chart types (equity, drawdown, distribution) |
| `get_period_returns` | Returns aggregated by time period |
| `compare_backtest_to_actual` | Backtest vs live performance comparison |

### SQL Tools
| Tool | Description |
|------|-------------|
| `run_sql` | Execute SQL queries against trades and market data |
| `describe_database` | Schema discovery with table info and example queries |

### Market Data Tools
| Tool | Description |
|------|-------------|
| `import_market_csv` | Import market data CSV with column mapping |
| `import_from_database` | Import from external DuckDB databases |
| `import_flat_file` | Import a local Parquet or CSV flat file for a ticker/timespan |
| `fetch_bars` | Fetch daily or intraday OHLCV bars from configured provider |
| `fetch_quotes` | Fetch option minute quotes from configured provider |
| `fetch_chain` | Fetch option chain snapshot for an underlying on a given date |
| `compute_vix_context` | Compute cross-ticker VIX regime fields for a date range |
| `refresh_market_data` | Composite daily refresh: fetch bars, auto-fire VIX context, return coverage report |
| `enrich_market_data` | Compute ~40 derived indicators from raw OHLCV |
| `enrich_trades` | Enrich trades with market context (lookahead-free) |
| `analyze_regime_performance` | Analyze P&L by market regime |
| `suggest_filters` | Suggest trade filters based on market conditions |
| `calculate_orb` | Opening range breakout analysis from intraday bars |

### Strategy Profile Tools
| Tool | Description |
|------|-------------|
| `profile_strategy` | Create or update a strategy profile with structured metadata |
| `get_strategy_profile` | Retrieve a stored strategy profile |
| `list_profiles` | List all strategy profiles (optionally filtered by block) |
| `delete_profile` | Delete a strategy profile |
| `analyze_structure_fit` | Analyze strategy performance by regime/condition dimensions |
| `validate_entry_filters` | Test each entry filter's contribution to edge |
| `portfolio_structure_map` | Regime x structure coverage matrix across strategies |

### Import Tools
| Tool | Description |
|------|-------------|
| `import_csv` | Import a CSV file as a new block *(CLI only - not available in Claude Desktop)* |

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Pack MCPB bundle
npm run mcpb:pack
```

## Market Data (Optional)

For market context (VIX regimes, intraday timing, gap analysis), import market data using MCP tools:

**From a data provider (Massive.com default, or ThetaData):**
1. **Fetch bars** via `fetch_bars { tickers, timespan, from, to }` — writes directly to Parquet
2. **Fetch VIX context** via `fetch_bars` for VIX/VIX9D/VIX3M then `compute_vix_context`
3. **Or use** `refresh_market_data` for a combined daily refresh in one call

**From TradingView CSV exports:**
1. **Export** from TradingView (any chart: SPX daily, VIX daily, SPX 5-min, etc.)
2. **Import** via `import_market_csv` with a column mapping or `import_flat_file` for Parquet
3. **Enrich** via `enrich_market_data` to compute ~40 derived indicators

No Pine Scripts needed — TradingView exports raw OHLCV natively.

Market data lives in a separate `market.duckdb` (configurable via `MARKET_DB_PATH` or `--market-db`). Canonical v3.0 datasets:
- `market.spot` — Raw per-minute OHLCV bars, ticker-first layout (keyed by `ticker, date, time`)
- `market.spot_daily` — RTH-aggregated daily OHLCV view derived from `market.spot` (keyed by `ticker, date`)
- `market.enriched` — Per-ticker computed enrichment indicators and calendar fields; OHLCV is NOT stored here (join `market.spot_daily` for OHLCV — keyed by `ticker, date`)
- `market.enriched_context` — Cross-ticker derived regime context (keyed by `date`)
- `market.option_chain` — Contract universe snapshots by date
- `market.option_quote_minutes` — Dense option quote cache by minute

See the [Market Data Guide](../../docs/market-data.md) for import examples, ticker formats, and column mapping reference.

## Related

- [Usage Guide](../../docs/usage.md) - Detailed usage examples and workflows
- [Web Platforms Guide](../../docs/web-platforms.md) - Connect to ChatGPT, Google AI Studio, Julius
- [Agent Skills](../agent-skills/README.md) - Conversational workflows for guided analysis
- [Market Data Guide](../../docs/market-data.md) - Import workflow, Massive API, and column mapping reference
- [Main Application](../../README.md) - Web-based UI for TradeBlocks
