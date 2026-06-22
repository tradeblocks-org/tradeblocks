# TradeBlocks

Options trading analytics platform with a web dashboard and AI-powered analysis via MCP (Model Context Protocol).

[Web App](https://tradeblocks.io) | [npm](https://www.npmjs.com/package/tradeblocks-mcp) | [Docker Hub](https://hub.docker.com/r/romeo345/tradeblocks-mcp) | [Buy Me a Coffee](https://www.buymeacoffee.com/davidromeo)

## Repository Structure

```
tradeblocks/
├── app/                      # Next.js web application
├── components/               # React components (shadcn/ui + Plotly charts)
├── tests/                    # Jest test suites
├── docs/                     # Documentation
│   └── development.md        # Architecture and local dev guide
└── packages/
    ├── lib/                  # Core business logic (@tradeblocks/lib)
    ├── mcp-server/           # MCP server (npm: tradeblocks-mcp)
    └── agent-skills/         # AI agent skill definitions
```

## Quick Start

### Development Setup

```bash
git clone https://github.com/tradeblocks-org/tradeblocks.git
cd tradeblocks
npm install
npm run dev              # Web dashboard at http://localhost:3000
```

### MCP Server

```bash
# Run directly with npx
npx tradeblocks-mcp ~/Trading/backtests

# Or from source
npm run build -w packages/mcp-server
node packages/mcp-server/server/index.js ~/Trading/backtests
```

### Testing

```bash
npm test                 # All tests
npm test -- path/to/file.test.ts    # Single file
npm run test:coverage    # Coverage report
```

## Documentation

| Guide                                           | Description                          |
| ----------------------------------------------- | ------------------------------------ |
| [Getting Started](docs/getting-started.md)      | Installation, env vars, first import |
| [Market Data](docs/market-data.md)              | CSV import, Massive API, enrichment  |
| [MCP Tools](docs/mcp-tools.md)                  | Complete tool reference by category  |
| [Architecture](docs/architecture.md)            | Data flow, schemas, key patterns     |
| [Development Guide](docs/development.md)        | Contributing, local dev setup        |
| [MCP Server](packages/mcp-server/README.md)     | Installation, platform configuration |
| [Usage Guide](docs/usage.md)                    | Tool reference, example workflows    |
| [Agent Skills](packages/agent-skills/README.md) | Guided conversational analysis       |

## Data Format

Both the web dashboard and MCP server accept CSV exports from platforms like [Option Omega](https://optionomega.com/). Each block contains:

- `tradelog.csv` (required) - Trade history with P/L, dates, strategy name
- `dailylog.csv` (optional) - Daily portfolio values for enhanced drawdown calculations
- `reportinglog.csv` (optional) - Actual/reported trades for backtest vs live comparison

Files are auto-detected by column headers, not filenames. See [Usage Guide](docs/usage.md) for format details.

## Features Overview

### Web Dashboard

- Performance dashboards with equity curves, drawdowns, monthly returns
- Risk tooling: Monte Carlo simulator, position sizing, correlation analysis
- Block-based organization for multiple strategies
- Client-side storage (IndexedDB) - data stays on your machine

### MCP Server

- Tools for statistics, simulations, walk-forward analysis, and SQL queries
- SQL analytics layer (`run_sql` + `describe_database`) for flexible data exploration
- Massive.com API integration for automated market data import
- Market data import and enrichment (`import_market_csv` + `enrich_market_data`)
- Trade replay with MFE/MAE analysis using historical option minute bars
- Lookahead-free trade enrichment with market context (VIX regimes, intraday timing)
- Works with Claude Desktop, Claude Code, Codex CLI, Gemini CLI, ChatGPT, Google AI Studio
- Agent skills for guided strategy health checks and portfolio recommendations

## Contributing

1. Create a feature branch
2. Update or add tests when behavior changes
3. Run `npm run lint` and `npm test` before opening a pull request

## License

MIT
