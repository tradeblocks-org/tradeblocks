# Architecture

## Overview

TradeBlocks is an options trading analytics platform with two main components:

- **Next.js Web Dashboard** — visual performance analysis with equity curves, drawdowns, and Monte Carlo simulation
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

| Table                        | Purpose                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `trades.trade_data`          | Individual trade records synced from CSV                      |
| `trades.reporting_data`      | Reported/live trades for backtest vs actual comparison        |
| `trades._sync_metadata`      | Block sync state tracking                                     |
| `profiles.strategy_profiles` | Strategy profile storage (structure, filters, exits, regimes) |

### market.duckdb (market database)

| Table                         | Purpose                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `market.spot`                 | Raw minute OHLCV bars                                                          |
| `market.spot_daily`           | Regular-hours daily OHLCV derived from `market.spot`                           |
| `market.enriched`             | Ticker-keyed indicators such as RSI, ATR, and VIX ivr/ivp                      |
| `market.enriched_context`     | Cross-ticker fields such as volatility regime and term-structure state         |
| `market.option_chain`         | Contract-universe snapshots by underlying, date, and ticker                    |
| `market.option_quote_minutes` | Dense option quotes keyed by ticker, date, and time                            |
| `market._sync_metadata`       | Import tracking, enrichment watermarks, and other mutable synchronization data |

VIX tenors (VIX, VIX9D, VIX3M, etc.) are stored as regular ticker rows in `market.enriched` with
`ivr` and `ivp` columns. The enrichment pipeline discovers them dynamically.

See [Market Data Guide](market-data.md) for the full enrichment field reference and import instructions.

## Key Patterns

### Block-Based Organization

Each trading strategy is a "block" — a directory containing CSV files (tradelog, dailylog, reportinglog). Blocks are the primary unit of analysis across both the web dashboard and MCP server.

### Lookahead-Free Analytics

Close-derived fields (RSI, VIX_Close, Vol_Regime, and ~35 others) are only known after market close. When joining trades with market data, `buildLookaheadFreeQuery()` applies `LAG()` to these fields so analysis uses only information available at the time of trade entry. Open-known fields (Gap_Pct, VIX_Open, Prior_Close) and static fields (Day_of_Week, Month, Is_Opex) are safe to use same-day.

### Cache-First Bar Loading

Trade replay and exit trigger tools read cached bars from `market.spot` before calling the configured
provider. After the first fetch, bars are persisted locally, so subsequent analysis uses the cache.

### MCP Tool Pattern

All tools follow a consistent pattern:

1. **Zod schema** defines input validation
2. **Sync middleware** ensures DuckDB data is current
3. **Handler function** executes business logic
4. **createToolOutput** formats the response

### Eastern Time Throughout

All dates are US market dates in Eastern Time. Trade dates from CSVs are calendar dates (local
midnight Date objects, compared via YYYY-MM-DD strings). Market data timestamps from APIs are Unix
milliseconds converted to ET via
`toLocaleDateString("en-CA", { timeZone: "America/New_York" })`. These two approaches must not be
mixed.

Trade-log dates parsed by `parseDatePreservingCalendarDay()` are calendar values temporarily held
in a `Date`, not absolute instants. Read them with `getFullYear()`, `getMonth()`, and `getDate()`, or
compare their `YYYY-MM-DD` strings with `filterByDateRange()`, `toCalendarDateStr()`, or
`formatTradeDate()`. Extract a calendar date from a longer string before parsing it. Do not create a
comparison boundary with `new Date("YYYY-MM-DD")`, apply an explicit time zone with
`toLocaleDateString()`, or call `toISOString()` on these values: all three can shift the trading day.

Market-feed timestamps are real instants. Convert those timestamps to `America/New_York` to obtain
the trading date. The recurring error is to apply that conversion to a local-midnight calendar
value, which can turn it into the previous Eastern day on a UTC host.

`import_csv` checks every trade/reporting opened and populated closed date as a
calendar day before creating a block; impossible days are refused, not rolled
forward by the local `Date` constructor. A CSV date with a time or zone suffix
(`2024-01-02T00:00:00Z`) is loaded by its `YYYY-MM-DD` prefix as that calendar
day, never as an instant. The required P/L and paired daily-log
value cells must parse as numbers (gross-before-fees trade imports also require
numeric opening/closing commissions). Folder-discovered trade rows and DuckDB
sync retain their existing acceptance rules. Folder daily-log rows read Net
Liquidity, Portfolio Value, Value or Equity; a missing or unparseable value
drops the row rather than manufacturing zero.

### Portfolio Calculation Invariants

- Keep the P&L basis explicit and commissions available separately. When `trade.pl` is declared as
  gross, net P&L is gross P&L minus opening and closing commissions. Option Omega imports declare a
  net basis, so their fees must not be deducted a second time.
- `Trade.premium` and the trade-log `Premium` column are dollars per contract (one lot),
  independent of decimal-point spelling. Position premium is its absolute value times
  the contract count (missing or non-positive counts use one). Reporting-log
  `ReportingTrade.initialPremium` is instead the signed opening price in dollars
  per share of one contract (positive credit, negative debit). OO `Initial Premium`
  is already a quote; TAT `TotalPremium` is position dollars and is divided by
  `Qty × 100` at ingestion. Position premium dollars are
  `abs(initialPremium) × 100 × numContracts`; actual Calendar Premium Capture is
  reported P/L divided by that amount, times 100. Legacy browser reporting
  rows without a confirmed quote unit cannot contribute a Premium Capture value;
  rows with a matching saved OO source `Initial Premium` cell retain their
  verifiable quote provenance.
- A trade's P/L % is the source's own `P/L %` cell (`Trade.plPct`) when the trade log carries a
  numeric one; otherwise it is `pl / (|premium| × numContracts) × 100`. Enrichment and the MCP report
  helpers resolve `plPct` (and its alias `premiumEfficiency`) this way; `netPlPct` is always
  computed from net P&L, so where the source's cell differs from the recomputation the two differ
  for reasons other than fees. Combined leg groups carry the source value for a single-row group
  only; a multi-row group computes it from the combined P/L and premium. The MCP server also keeps
  the raw column as `custom.P/L %`.
- Strategy filtering uses trades, not daily logs. Daily logs represent the full portfolio and cannot
  be attributed safely to one strategy.
- Drawdown calculations use daily logs when present and otherwise fall back to a trade-based equity
  curve.
- `calmarRatio` divides CAGR by maximum drawdown from the **same curve**: first-to-last
  `netLiquidity` over the daily log's own span and maximum absolute `drawdownPct` for
  unfiltered blocks with a daily log; otherwise trade CAGR and trade-equity drawdown.
  `cagr` remains trade-based and `maxDrawdown` keeps its existing source. The
  `calculationMethodology.calmar.basis` label identifies the Calmar curve.
- Sharpe calculations use sample standard deviation and daily excess returns. Sortino uses the root
  mean square of negative excess returns over all observations, rather than the standard deviation
  of only the negative subset.
- `ProcessedBlock` stores references to related IndexedDB records. Load trades and daily logs through
  the store helpers instead of treating them as embedded block fields.

### Trading Calendar Model

The Trading Calendar compares theoretical backtest trades from `tradelog.csv` (`Trade`,
`backtestTrades`, `backtestPl`) with reported trades from `strategylog.csv` (`ReportingTrade`,
`actualTrades`, `actualPl`). Backtests commonly use more contracts than reported execution.

The `raw` mode leaves both values unchanged. The `perContract` mode divides each side by its own
contract count. The `toReported` mode leaves reported P&L unchanged and scales backtest P&L by
`actualContracts / backtestContracts`, producing an apples-to-apples comparison at the reported
size. The implementation lives in `packages/lib/services/calendar-data.ts`; state and defaults live
in `packages/lib/stores/trading-calendar-store.ts`.

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
  docs/                   # Documentation (single source of truth)
  releases/               # Release notes per version
  tests/                  # Jest test suites
```

For concise repository orientation, see the root `CLAUDE.md` or `AGENTS.md`. Detailed implementation
rules remain in this documentation.
