# Usage Guide

## Quick Start

### 1. Set Up Your Data

Create a folder for your trading data:

```bash
mkdir -p ~/Trading/backtests
```

Each strategy is a "block" — a folder containing:

- `tradelog.csv` (required) — your trade records
- `dailylog.csv` (optional) — daily portfolio values
- `reportinglog.csv` (optional) — actual/live trades for backtest comparison

### 2. Start the Server

```bash
# With npx (recommended)
npx tradeblocks-mcp ~/Trading/backtests

# Or if installed globally
tradeblocks-mcp ~/Trading/backtests
```

### 3. Connect Your AI Assistant

The server communicates via stdio and works with any MCP-compatible client:

**Desktop/CLI Apps:**

- **Claude Desktop** — add to `claude_desktop_config.json`
- **Claude Code** — `claude mcp add tradeblocks -- npx tradeblocks-mcp ~/backtests`
- **Codex CLI** — add to `~/.codex/config.toml`
- **Gemini CLI** — add to `~/.gemini/settings.json`

**Web Platforms** (requires HTTP mode + public URL):

- **ChatGPT** — Developer Mode with remote URL
- **Google AI Studio** — Native MCP support
- **Julius AI** — Native MCP support

See the [MCP Server README](../packages/mcp-server/README.md) for platform-specific configuration, or the [Web Platforms Guide](web-platforms.md) for web platform setup.

For environment variables and Massive.com API key setup, see [Getting Started](getting-started.md).

---

## Bring in an Option Omega Backtest

Install and configure both the TradeBlocks MCP server and Option Omega's MCP server; Option Omega runs
the backtest, while TradeBlocks analyzes imported results. TradeBlocks does not read OO backtests
directly on the server.

In Claude Code, install the [tradeblocks-skills plugin](https://github.com/tradeblocks-org/tradeblocks-skills):

```text
/plugin marketplace add tradeblocks-org/tradeblocks-skills
/plugin install tradeblocks@tradeblocks-skills
```

Use `/tradeblocks:oo-capture` to capture a saved backtest or run from the OO MCP server,
verify its complete trade log and, when available, marked daily equity curve, then import
the verified CSVs into a TradeBlocks block. The registered TradeBlocks prompt
`bring-in-oo-backtest` can guide this journey; it does not call OO on the server.

In other MCP clients, export a trade-log CSV from OO, and optionally its daily-log CSV,
then call `import_csv` on the TradeBlocks server:

```text
import_csv { "csvPath": "/data/tradelog.csv", "blockName": "My OO Backtest",
             "dailyLogPath": "/data/dailylog.csv", "plBasis": "net_includes_fees" }
```

Omit `dailyLogPath` if there is no daily log. OO trade P/L already includes fees, so
`net_includes_fees` is the default; use `gross_before_fees` only for CSVs whose P/L
has not yet deducted commissions and fees. The CSV paths must be readable by the
TradeBlocks server: local filesystem paths for stdio, or paths inside its mounted
data directory for Docker/HTTP. Verify the block with `get_block_info` and
`get_statistics`; keep OO's marked-account headline distinct from trade-realized
statistics when no marked daily curve was imported.

---

## Common Workflows

### Health Check a Strategy

"Run a health check on my iron-condor strategy"

Your AI assistant will:

1. `list_blocks` — find available blocks
2. `get_statistics` — get performance metrics
3. `run_walk_forward` — check for overfitting
4. `get_tail_risk` — assess worst-case scenarios

### Compare Two Strategies

"Compare my spy-puts strategy against qqq-calls"

Your AI assistant will:

1. Load both blocks
2. `get_statistics` on each
3. `get_correlation_matrix` between them
4. Present side-by-side comparison

### Profile a Strategy from a Screenshot

"Here's my iron condor strategy settings" _(attach screenshot of your backtest parameters)_

Your AI assistant will:

1. Read the screenshot to extract structure type, greeks bias, entry filters, exit rules, legs
2. `profile_strategy` — store the structured profile linked to your block
3. Confirm what was saved and highlight anything it couldn't extract

Once profiled, your assistant remembers the strategy across sessions:

- "How does this strategy perform in different VIX regimes?" → `analyze_structure_fit`
- "Are my entry filters actually helping?" → `validate_entry_filters`
- "Where are my portfolio blind spots?" → `portfolio_structure_map`

### Replay a Trade

"Replay trade #5 from my iron-condor block"

Your AI assistant will:

1. `replay_trade` with `block_id` + `trade_index` — fetches minute-level option bars (from cache or Massive.com)
2. Return P&L path with MFE/MAE, per-leg greeks, and net position greeks
3. Optionally: `analyze_exit_triggers` — evaluate exit rules against the replay
4. Optionally: `decompose_greeks` — break down P&L into delta, gamma, theta, vega contributions

### Test Exit Policies Across a Block

"Test a 50% profit target with a 100% stop loss across my iron-condor block"

Your AI assistant will:

1. `batch_exit_analysis` — replay matching trades, evaluate the candidate policy
2. Return aggregate stats (win rate, Sharpe, profit factor, drawdown) comparable to `get_statistics`
3. Per-trigger attribution showing which trigger is doing the heavy lifting

### Explore with SQL

"What's the best day of week to enter trades?"

Your AI assistant will:

1. `describe_database` — discover available tables and columns
2. `run_sql` — query trades grouped by day of week
3. Present findings with overfitting warnings

Example SQL with normalized VIX JOINs:

```sql
-- Trades by VIX regime (lookahead-free)
WITH joined AS (
  SELECT d.ticker, d.date, cd.Vol_Regime
  FROM market.daily d
  LEFT JOIN market.date_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *, LAG(Vol_Regime) OVER (PARTITION BY ticker ORDER BY date) AS prev_Vol_Regime
  FROM joined
)
SELECT
  CASE prev_Vol_Regime
    WHEN 1 THEN 'Very Low' WHEN 2 THEN 'Low' WHEN 3 THEN 'Normal'
    WHEN 4 THEN 'Elevated' WHEN 5 THEN 'High' WHEN 6 THEN 'Extreme'
  END as vix_regime,
  COUNT(*) as trades,
  ROUND(100.0 * SUM(CASE WHEN t.pl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
FROM trades.trade_data t
JOIN lagged m ON CAST(t.date_opened AS VARCHAR) = m.date
WHERE t.block_id = 'my-strategy' AND m.prev_Vol_Regime IS NOT NULL
GROUP BY prev_Vol_Regime ORDER BY prev_Vol_Regime
```

---

## CSV Format

### Trade Log (tradelog.csv)

Required columns:

- Date Opened
- P/L (Option Omega exports are already net of fees; `import_csv` defaults to
  `plBasis: "net_includes_fees"`. Use `"gross_before_fees"` only if fees still need deducting)

Optional columns:

- Time Opened, Date Closed, Time Closed
- Strategy, Symbol (or Legs)
- No. of Contracts
- Premium (dollars per contract; `250` and `250.00` both mean $250 per lot)
- P/L % (Option Omega's P/L as a percent of premium, e.g. `97.9`; when present and numeric, report
  tools use it as the trade's `plPct`. A missing column or a blank or unparseable cell falls back to
  P/L ÷ |Premium × No. of Contracts| × 100 and never refuses the import)
- Opening/Closing Commissions + Fees (both required for `gross_before_fees`)
- Funds at Close (optional; if absent, `get_statistics` and the realized
  `get_performance_charts` equity curve use the first daily log's Net Liquidity
  minus P/L when both are supplied and usable, otherwise assume $100,000.
  `calculationMethodology.initialCapital.source` and
  `equityCurveCapitalSource` distinguish `daily_log`, `assumed_default`, and
  `observed_trade_funds`. The chart remains trade-realized, not daily marked equity.)

Example:

```csv
Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,No. of Contracts,Premium
2024-01-02,09:35:00,2024-01-02,15:30:00,200,Iron Condor,SPX 4800P/4750P,1,250
2024-01-03,09:35:00,2024-01-03,15:45:00,250,Iron Condor,SPX 4820P/4770P,1,275
```

`import_csv` refuses a trade or reporting row with an invalid opened/closed calendar date or an
unparseable P/L (including a missing value), reporting the CSV file line including the header.
For gross-before-fees trade logs, opening and closing commission values are also required.
The entire import is refused before creating a block, including when a daily log is paired.
The import receipt counts loaded trades and uses the same strategy names as the loaded block.

### Daily Log (dailylog.csv)

Required columns:

- Date
- Net Liquidity (the MCP server also reads Portfolio Value, Value or Equity; the web importer
  needs Net Liquidity)

Optional columns:

- P/L (daily profit/loss; supply it with Net Liquidity to derive starting
  capital from a paired daily log)
- Drawdown %
- Current Funds, Trading Funds

Example:

```csv
Date,Net Liquidity,P/L,Drawdown %
2024-01-02,10200,200,0.00
2024-01-03,10450,250,0.00
2024-01-04,10300,-150,1.44
```

The value must be numeric in every daily-log row. `import_csv` refuses a missing or
unparseable value with the CSV file line; folder loading skips that row rather than using zero.

### Reporting Log (reportinglog.csv)

For backtest vs actual comparison. Required columns:

- Date Opened (or `date_opened`)
- P/L (or `pl`)

Strategy and No. of Contracts are optional for the OO reporting-log format.

Example:

```csv
Date Opened,Time Opened,Strategy,Legs,No. of Contracts,P/L
2024-01-02,09:35:00,Iron Condor,SPX 4800P/4750P,1,180
2024-01-03,09:35:00,Iron Condor,SPX 4820P/4770P,1,225
```

### Flexible CSV Detection

The server detects CSV types by column headers, not filenames:

- `my-strategy-export.csv` will work if it has the expected columns
- Files are auto-detected as tradelog, dailylog, or reportinglog on each load

---

## Troubleshooting

### "Block not found"

1. Check folder exists in your backtests directory
2. Ensure it contains a valid CSV (tradelog.csv or detected by content)
3. Run `list_blocks` to see what's available

### "No trades after filtering"

The date range or strategy filter may be too restrictive. Try without filters first.

### CSV not detected

Ensure your CSV has the expected columns:

- Trade log needs: P/L, Date Opened
- Daily log needs: Date, Net Liquidity (or Portfolio Value, Value, Equity)

---

## Related Documentation

- [Getting Started](getting-started.md) — installation, env vars, Massive.com API setup
- [MCP Tools Reference](mcp-tools.md) — complete tool listing by category
- [Market Data Guide](market-data.md) — import paths, enrichment, schema reference
- [Web Platforms Guide](web-platforms.md) — connect to ChatGPT, Google AI Studio, Julius
