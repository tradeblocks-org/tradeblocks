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
- **Claude Desktop** — install the .mcpb bundle or add to `claude_desktop_config.json`
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

"Here's my iron condor strategy settings" *(attach screenshot of your backtest parameters)*

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
- Date Opened, Time Opened
- Date Closed, Time Closed
- P/L (gross profit/loss)
- Strategy name
- Symbol (or Legs)

Optional columns:
- No. of Contracts
- Premium
- Max Profit, Max Loss (for MFE/MAE analysis)
- Opening/Closing Commissions + Fees

Example:
```csv
Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Legs,No. of Contracts,Premium
2024-01-02,09:35:00,2024-01-02,15:30:00,200,Iron Condor,SPX 4800P/4750P,1,250
2024-01-03,09:35:00,2024-01-03,15:45:00,250,Iron Condor,SPX 4820P/4770P,1,275
```

### Daily Log (dailylog.csv)

Required columns:
- Date
- Net Liquidity (or "Portfolio Value", "Value", "Equity")

Optional columns:
- P/L (daily profit/loss)
- Drawdown %
- Current Funds, Trading Funds

Example:
```csv
Date,Net Liquidity,P/L,Drawdown %
2024-01-02,10200,200,0.00
2024-01-03,10450,250,0.00
2024-01-04,10300,-150,1.44
```

### Reporting Log (reportinglog.csv)

For backtest vs actual comparison. Required columns:
- Date Opened
- Strategy
- P/L
- No. of Contracts

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
- Trade log needs: P/L, Date Opened, Date Closed
- Daily log needs: Date, Net Liquidity (or Portfolio Value)

---

## Related Documentation

- [Getting Started](getting-started.md) — installation, env vars, Massive.com API setup
- [MCP Tools Reference](mcp-tools.md) — complete tool listing by category
- [Market Data Guide](market-data.md) — import paths, enrichment, schema reference
- [Web Platforms Guide](web-platforms.md) — connect to ChatGPT, Google AI Studio, Julius
