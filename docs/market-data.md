# Market Data Guide

TradeBlocks supports multiple paths for importing market data: CSV files, the Massive.com API (default), and custom data providers. All paths write to the same DuckDB tables and trigger the same enrichment pipeline.

## Data Provider Architecture

TradeBlocks uses a provider abstraction for external API calls. The active provider is selected via the `MARKET_DATA_PROVIDER` environment variable (default: `"massive"`).

| Provider | Env Var | Credentials | Status |
|----------|---------|-------------|--------|
| Massive.com (Polygon) | `massive` | `MASSIVE_API_KEY` | Shipped |
| ThetaData MDDS | `thetadata` | `THETADATA_EMAIL` + `THETADATA_PASSWORD`, or `THETADATA_CREDENTIALS_FILE` | Direct MDDS/gRPC provider |

All providers implement the same `MarketDataProvider` interface and normalize responses to the same `BarRow` and `OptionContract` types. Downstream tools (replay, exit analysis, enrichment) work identically regardless of provider.

### Building a Custom Provider

To add a new data provider:

1. **Create the adapter** at `packages/mcp-server/src/utils/providers/<name>.ts`

   Implement the `MarketDataProvider` interface from `market-provider.ts`:

   ```typescript
   import type {
     MarketDataProvider, BarRow, FetchBarsOptions,
     FetchSnapshotOptions, FetchSnapshotResult,
   } from "../market-provider.js";

   export class MyProvider implements MarketDataProvider {
     readonly name = "myprovider";

     async fetchBars(options: FetchBarsOptions): Promise<BarRow[]> {
       // Fetch OHLCV bars from your API
       // Return normalized BarRow[] with:
       //   date: "YYYY-MM-DD" Eastern Time
       //   open, high, low, close, volume: numbers
       //   ticker: plain format (no provider-specific prefix)
       //   time: "HH:MM" ET (only for intraday bars)
     }

     async fetchOptionSnapshot(options: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
       // Fetch option chain snapshot from your API
       // Return OptionContract[] with greeks, quotes, OI
       // Use computeLegGreeks() from black-scholes.ts as BS fallback
       //   when your API doesn't provide greeks
     }
   }
   ```

2. **Register in the factory** — add a `case` to `getProvider()` in `market-provider.ts`:

   ```typescript
   import { MyProvider } from "./providers/myprovider.js";
   // ...
   case "myprovider":
     _cached = new MyProvider();
     break;
   ```

3. **Configure** — set the env var in `.mcp.json`:

   ```json
   {
     "env": {
       "MARKET_DATA_PROVIDER": "myprovider",
       "MY_PROVIDER_API_KEY": "your_key"
     }
   }
   ```

4. **Test** — write unit tests in `tests/unit/providers/<name>.test.ts`. Mock `globalThis.fetch` with `jest.spyOn(globalThis, "fetch")` per project conventions.

**Key contract rules:**
- `BarRow.date` must be `"YYYY-MM-DD"` in Eastern Time — convert at the adapter boundary
- `BarRow.time` must be `"HH:MM"` 24-hour ET for intraday bars
- `BarRow.ticker` must be plain storage format (no provider-specific prefixes)
- Read your API key at call site (inside the method), not at module load time
- Handle pagination, rate limits, and auth errors inside the adapter
- Use Zod schemas to validate API responses before mapping to `BarRow`

## CSV Import

### import_market_csv

Import OHLCV data from a local CSV file into DuckDB.

**Parameters:**
- `file_path` — path to the CSV file (use `~` for home directory)
- `ticker` — symbol identifier (e.g., `SPX`, `VIX`, `SPY`)
- `target_table` — destination: `"daily"`, `"context"`, or `"intraday"`
- `column_mapping` — maps CSV headers to schema columns

**Example: Daily bars**
```json
{
  "file_path": "~/exports/spx-daily.csv",
  "ticker": "SPX",
  "target_table": "daily",
  "column_mapping": {
    "Date": "date",
    "Open": "open",
    "High": "high",
    "Low": "low",
    "Close": "close"
  }
}
```

**Example: Intraday bars from TradingView**
```json
{
  "file_path": "~/exports/spx-5min.csv",
  "ticker": "SPX",
  "target_table": "intraday",
  "column_mapping": {
    "time": "date",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close"
  }
}
```

For TradingView intraday exports, the `time` column is a Unix timestamp encoding both date and time. Map it to `"date"` and the HH:MM Eastern Time will be extracted automatically.

**Example: VIX daily bars**
```json
{
  "file_path": "~/exports/vix-daily.csv",
  "ticker": "VIX",
  "target_table": "daily",
  "column_mapping": {
    "time": "date",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close"
  }
}
```

VIX tenors (VIX, VIX9D, VIX3M, etc.) are imported as regular ticker rows in `market.daily`. Import each tenor separately with its own ticker.

Use `dry_run: true` to validate the import without writing data.

### import_from_database

Import data from an external DuckDB file via SQL query. Reference tables using the `ext_import_source` alias:

```json
{
  "db_path": "~/other-data/market.duckdb",
  "ticker": "SPX",
  "target_table": "daily",
  "query": "SELECT date, open, high, low, close FROM ext_import_source.main.daily_prices WHERE ticker = 'SPX'"
}
```

## Provider-Native API Import

### Setup

See [Getting Started](getting-started.md#massivecom-api-optional) for Massive.com API key configuration.

The active provider is selected via `MARKET_DATA_PROVIDER` env var (default: `massive`). Massive.com reads `MASSIVE_API_KEY`.

For ThetaData, set `MARKET_DATA_PROVIDER=thetadata`. The provider connects directly to ThetaData MDDS over gRPC; it does not use ThetaTerminal, a local JVM, or the ThetaData REST terminal service.

Configure MDDS credentials with either:

```bash
export THETADATA_EMAIL="you@example.com"
export THETADATA_PASSWORD="your-password"
```

Or place credentials in a file and point TradeBlocks at it:

```bash
export THETADATA_CREDENTIALS_FILE="/path/to/thetadata-creds.txt"
```

The credentials file format is:

```text
you@example.com
your-password
```

Do not commit credentials or put secrets directly in checked-in service files.

Advanced ThetaData MDDS settings are optional:

| Variable | Description |
|----------|-------------|
| `THETADATA_MDDS_HOST` | Override the MDDS host |
| `THETADATA_MDDS_PORT` | Override the MDDS port |
| `THETADATA_MDDS_MAX_CONCURRENCY` | Limit concurrent MDDS requests |
| `THETADATA_MDDS_RETRY_ATTEMPTS` | Override retry attempts |
| `THETADATA_MDDS_RETRY_BASE_MS` | Override retry base delay |
| `THETADATA_MDDS_RETRY_MAX_MS` | Override retry max delay |

ThetaTerminal-specific settings from the old terminal/REST path no longer apply to `MARKET_DATA_PROVIDER=thetadata`, including `THETADATA_BASE_URL`, `THETADATA_HOME`, `THETADATA_JAR`, `THETADATA_CREDS_FILE`, `THETADATA_SKIP_AUTO_START`, and terminal auto-start flags. `THETADATA_MDDS_CLIENT_TYPE=terminal` is only the MDDS client identity string and does not mean TradeBlocks launches or depends on ThetaTerminal.

ThetaData MDDS supports daily and intraday bars (stocks, indices), option minute quotes, contract lists, and first-order greeks. The option snapshot tool is not yet wired to MDDS — use Massive.com for `fetch_chain` until the MDDS snapshot endpoint lands.

### fetch_bars

Fetch daily or intraday OHLCV bars from the configured provider and write directly to Parquet. Both Massive.com and ThetaData MDDS support this tool; the MDDS path uses stock and index OHLC/EOD endpoints.

**Parameters:**
- `tickers` — array of plain ticker symbols (e.g., `["SPX", "VIX", "SPY"]`)
- `from` — start date (`YYYY-MM-DD`)
- `to` — end date (`YYYY-MM-DD`)
- `timespan` — bar size: `"1d"` (daily), `"1m"`, `"5m"`, `"15m"`, `"1h"` (default: `"1d"`)

**Daily OHLCV import:**
```json
{ "tickers": ["SPX"], "timespan": "1d", "from": "2024-01-01", "to": "2024-12-31" }
```

**Intraday minute bars:**
```json
{ "tickers": ["SPX"], "timespan": "1m", "from": "2024-06-01", "to": "2024-06-30" }
```

**Fetch VIX tenors (for VIX context):**
```json
{ "tickers": ["VIX", "VIX9D", "VIX3M"], "timespan": "1d", "from": "2024-01-01", "to": "2024-12-31" }
```

### fetch_quotes

Fetch option minute quotes from the configured provider and write to Parquet.

**Parameters:**
- `tickers` — array of OCC option tickers (e.g., `["SPY250117C00470000"]`)
- `from` — start date (`YYYY-MM-DD`)
- `to` — end date (`YYYY-MM-DD`)

### fetch_chain

Fetch an option chain snapshot for an underlying on a given date.

**Parameters:**
- `underlying` — root symbol (e.g., `"SPX"`)
- `date` — snapshot date (`YYYY-MM-DD`)

ThetaData MDDS supports contract-list retrieval for this path. Full option snapshot support remains unavailable until the MDDS snapshot endpoint is wired.

### compute_vix_context

Compute cross-ticker VIX regime fields for a date range. Run this after fetching VIX-family tickers via `fetch_bars`.

**Parameters:**
- `from` — start date (`YYYY-MM-DD`)
- `to` — end date (`YYYY-MM-DD`)

Writes to `market.enriched_context`: `Vol_Regime`, `Term_Structure_State`, `Trend_Direction`, `VIX_Spike_Pct`, `VIX_Gap_Pct`.

### refresh_market_data

Composite daily-refresh tool. Calls `fetch_bars` for all specified tickers, then automatically fires `compute_vix_context` when VIX-family tickers are included, and returns a coverage report.

**Parameters:**
- `tickers` — array of tickers to refresh
- `from` — start date (`YYYY-MM-DD`)
- `to` — end date (`YYYY-MM-DD`)

Use this for routine end-of-day data updates instead of calling `fetch_bars` + `compute_vix_context` separately.

### import_flat_file

Import a local Parquet or CSV flat file for a specific ticker and timespan. Useful for bulk loading pre-downloaded data.

**Parameters:**
- `file_path` — path to local file
- `ticker` — plain ticker symbol
- `timespan` — `"1d"` or `"1m"`

### Ticker Formats

| Type | Plain Ticker | API Format | Storage Format |
|------|-------------|------------|----------------|
| Stock | SPY | SPY | SPY |
| Index | VIX | I:VIX | VIX |
| Option | SPY250117C00470000 | O:SPY250117C00470000 | SPY250117C00470000 |

Provider adapters automatically add and remove `I:` and `O:` prefixes. Always use plain tickers in tool calls.

### OCC Option Ticker Format

Options use the OCC standardized format: `{ROOT}{YYMMDD}{C|P}{STRIKE*1000 padded to 8 digits}`

Examples:
- SPY Jan 17, 2025 $470 Call: `SPY250117C00470000`
- SPX Dec 19, 2025 $4500 Put: `SPX251219P04500000`
- QQQ Mar 21, 2025 $450.50 Call: `QQQ250321C00450500`

## Migration from `import_from_api`

`import_from_api` has been replaced by provider-native tools. The mapping:

| Old call | New call |
|---|---|
| `import_from_api { target_table: "daily", ticker: "SPX", from, to }` | `fetch_bars { tickers: ["SPX"], timespan: "1d", from, to }` |
| `import_from_api { target_table: "intraday", ticker: "SPX", timespan: "1m", from, to }` | `fetch_bars { tickers: ["SPX"], timespan: "1m", from, to }` |
| `import_from_api { target_table: "date_context", from, to }` | `fetch_bars { tickers: ["VIX","VIX9D","VIX3M"], timespan: "1d", from, to }` followed by `compute_vix_context { from, to }` |

## Trade Replay

### replay_trade

Replay historical trades using minute-level option bars for P&L analysis with greeks.

**Data source:** Reads from `market.intraday` cache first. On cache miss, fetches from the configured data provider (default: Massive.com). Bars are persisted after fetch — subsequent replays are instant. You can also pre-load bars via `import_market_csv` with intraday data.

**Two modes:**
- **Hypothetical** — provide explicit legs with strikes, expiry, entry prices
- **Tradelog** — provide `block_id` + `trade_index` to replay from existing data

**Output includes:**
- Minute-by-minute P&L path (three formats: `full`, `sampled` default ~25 points, `summary`)
- MFE (max favorable excursion) and MAE (max adverse excursion)
- Per-leg greeks: delta, gamma, theta, vega, IV (Black-Scholes or Bachelier for 0DTE)
- Net position greeks: quantity-weighted sums
- Optional IVP from VIX data
- `close_at: "expiry"` to analyze holding through expiration

## Enrichment Pipeline

After imports, enrichment runs automatically (unless `skip_enrichment=true`). Run manually with `enrich_market_data`.

### Tier 1: Technical Indicators

Written to `market.daily` for the imported ticker. ~20 fields:

| Category | Fields |
|----------|--------|
| Momentum | RSI_14 |
| Volatility | ATR_Pct, Realized_Vol_5D, Realized_Vol_20D |
| Trend | Price_vs_EMA21_Pct, Price_vs_SMA50_Pct, Return_5D, Return_20D |
| Price action | Gap_Pct, Prior_Close, Prior_Range_vs_ATR, Prev_Return_Pct |
| Intraday | Intraday_Range_Pct, Intraday_Return_Pct, Close_Position_In_Range |
| Structure | Gap_Filled, Consecutive_Days |
| Calendar | Day_of_Week, Month, Is_Opex |

### Tier 2: VIX Context

Runs when VIX-family tickers exist in `market.daily`. Discovers tickers dynamically (`SELECT DISTINCT ticker WHERE ticker LIKE 'VIX%'`).

**Per-ticker (written to `market.daily`):**

| Field | Description |
|-------|-------------|
| ivr | Implied Volatility Rank (252-day): position in min-max range (0-100) |
| ivp | Implied Volatility Percentile (252-day): % of days at or below current (0-100) |

**Cross-ticker derived (written to `market.date_context`):**

| Field | Description |
|-------|-------------|
| Vol_Regime | Volatility regime (1=very low <13, 2=low 13-16, 3=normal 16-20, 4=elevated 20-25, 5=high 25-30, 6=extreme >30) |
| Term_Structure_State | VIX term structure (-1=backwardation, 0=flat, 1=contango) |
| Trend_Direction | Trend from 20-day return: up (>1%), down (<-1%), flat |
| VIX_Spike_Pct | VIX spike from open to high as percentage |
| VIX_Gap_Pct | VIX overnight gap percentage |

### Tier 3: Intraday Timing

Runs when `market.intraday` has bars for the ticker. Written to `market.daily`:

| Field | Description |
|-------|-------------|
| High_Time | Time of day high occurred |
| Low_Time | Time of day low occurred |
| High_Before_Low | Whether high occurred before low (1/0) |
| Reversal_Type | Intraday reversal classification |
| Opening_Drive_Strength | Strength of the opening move |
| Intraday_Realized_Vol | Intraday realized volatility from bar data |

## Database Schema

| Table | Key | Purpose |
|-------|-----|---------|
| `market.daily` | `ticker, date` | Daily OHLCV + Tier 1 indicators + VIX ivr/ivp |
| `market.date_context` | `date` | Cross-ticker derived fields (Vol_Regime, Term_Structure_State, etc.) |
| `market.intraday` | `ticker, date, time` | Minute/hourly bars, including cached option bars from replay |
| `market.option_chain` | `underlying, date, ticker` | Option contract-universe snapshots |
| `market.option_quote_minutes` | `ticker, date, time` | Dense option quote cache for replay/backtests |
| `market._sync_metadata` | `source, ticker, target_table` | Import tracking and enrichment watermarks |
