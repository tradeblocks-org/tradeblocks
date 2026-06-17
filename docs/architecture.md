# Architecture

## Overview

TradeBlocks is an options trading analytics platform with two main components:

- **Next.js 15 Web Dashboard** — visual performance analysis with equity curves, drawdowns, and Monte Carlo simulation
- **MCP Server** — tools for AI-assisted analysis via Claude, ChatGPT, Codex, Gemini, and other MCP clients

## Data Flow

```
1. Import
   CSV upload (web) ──────────────> IndexedDB (client-side)
   CSV files (MCP) ────────────────> DuckDB (server-side)
   Massive.com API (MCP) ──────────> DuckDB (server-side)

2. Storage
   IndexedDB ── client-side trades, daily logs, block metadata
   DuckDB ───── server-side analytics, market data, strategy profiles

3. Enrichment (automatic after import)
   Tier 1: Raw OHLCV ──> ~20 technical indicators (RSI, ATR, etc.)
   Tier 2: VIX tickers ─> IVR/IVP per tenor + Vol_Regime, Term_Structure
   Tier 3: Intraday ────> timing fields (High_Time, Reversal_Type, etc.)

4. Analysis
   MCP tools for statistics, replay, greeks, exit triggers, profiling, SQL
```

## DuckDB Schema

### analytics.duckdb (trades database)

| Table | Purpose |
|-------|---------|
| `trades.trade_data` | Individual trade records synced from CSV |
| `trades.reporting_data` | Reported/live trades for backtest vs actual comparison |
| `trades._sync_metadata` | Block sync state tracking |
| `profiles.strategy_profiles` | Strategy profile storage (structure, filters, exits, regimes) |

### market.duckdb (market database)

| Table | Purpose |
|-------|---------|
| `market.daily` | Daily OHLCV + enriched indicators + VIX ivr/ivp, keyed by `ticker, date` |
| `market.date_context` | Cross-ticker derived fields (Vol_Regime, Term_Structure_State, Trend_Direction), keyed by `date` |
| `market.intraday` | Minute/hourly bars + cached option bars from replay, keyed by `ticker, date, time` |
| `market.option_chain` | Contract-universe snapshots by underlying/date/ticker |
| `market.option_quote_minutes` | Dense option quote cache by `ticker, date, time` |
| `market._sync_metadata` | Import tracking, enrichment watermarks, migration state |

VIX tenors (VIX, VIX9D, VIX3M, etc.) are stored as regular ticker rows in `market.daily` with `ivr` and `ivp` columns. The enrichment pipeline discovers them dynamically.

See [Market Data Guide](market-data.md) for the full enrichment field reference and import instructions.

## Key Patterns

### Block-Based Organization

Each trading strategy is a "block" — a directory containing CSV files (tradelog, dailylog, reportinglog). Blocks are the primary unit of analysis across both the web dashboard and MCP server.

### Lookahead-Free Analytics

Close-derived fields (RSI, VIX_Close, Vol_Regime, and ~35 others) are only known after market close. When joining trades with market data, `buildLookaheadFreeQuery()` applies `LAG()` to these fields so analysis uses only information available at the time of trade entry. Open-known fields (Gap_Pct, VIX_Open, Prior_Close) and static fields (Day_of_Week, Month, Is_Opex) are safe to use same-day.

### Cache-First Bar Loading

Trade replay and exit trigger tools read from `market.intraday` cache before calling the Massive.com API. After the first fetch, bars are persisted locally. This means Massive.com is only needed for the initial data load — all subsequent analysis is local.

### MCP Tool Pattern

All tools follow a consistent pattern:
1. **Zod schema** defines input validation
2. **Sync middleware** ensures DuckDB data is current
3. **Handler function** executes business logic
4. **createToolOutput** formats the response

### Eastern Time Throughout

All dates are US market dates in Eastern Time. Trade dates from CSVs are calendar dates (local midnight Date objects, compared via YYYY-MM-DD strings). Market data timestamps from APIs are Unix milliseconds converted to ET via `toLocaleDateString("en-CA", { timeZone: "America/New_York" })`. These two approaches must not be mixed. See `CLAUDE.md` for detailed date handling rules.

## Strategy Profiles

Strategy profiles capture structured metadata about trading strategies:

- **Structure**: structure_type (e.g., iron_condor, put_spread), legs, greeks bias
- **Entry**: entry_filters (VIX range, DTE, gap conditions, etc.)
- **Exit**: exit_rules (profit targets, stop losses, time-based)
- **Context**: expected_regimes, thesis, notes

Profiles are stored in `profiles.strategy_profiles` (DuckDB) and enable structure-aware analysis tools: `analyze_structure_fit`, `validate_entry_filters`, `portfolio_structure_map`.

## Project Structure

```
tradeblocks/
  app/                    # Next.js 15 app router
  components/             # React components (shadcn/ui + Plotly charts)
  packages/
    lib/                  # Core business logic (@tradeblocks/lib)
    mcp-server/           # MCP server (npm: tradeblocks-mcp)
    agent-skills/         # AI agent skill definitions
  docs/                   # Documentation (single source of truth)
  releases/               # Release notes per version
  tests/                  # Jest test suites
```

For Claude Code-specific instructions and detailed implementation rules, see the project `CLAUDE.md` files.
