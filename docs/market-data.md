# Market Data Guide

TradeBlocks supports multiple paths for importing market data: CSV files, the Massive.com API (default), and custom data providers. All paths write to the same DuckDB tables and trigger the same enrichment pipeline.

## Published risk-free rates

DTB3 (annual percent for Sharpe and Sortino) and SOFR (annual percent for
options analytics) are key-free public FRED series, independent of the optional
market-data providers below. The daily GitHub Action publishes a complete
`rates.json` to the dedicated, unprotected `rates-data` branch. Its default URL
is `https://raw.githubusercontent.com/tradeblocks-org/tradeblocks/rates-data/rates.json`.
Each publication includes `schemaVersion: 1`, `source`, ISO `fetchedAt`, and
`series.DTB3` / `series.SOFR`, each with `unit: "annual-percent"`, `firstDate`,
`lastDate`, and a chronologically ordered `rates` date-to-number map. Missing
FRED days are omitted, not represented with a zero or a forward-looking value.
Older published values must agree with the bundled history; invalid or
conflicting publications are rejected rather than silently changing metrics.

The browser requests this file on load by default and caches the last valid
copy in IndexedDB; the Performance Metrics screen shows the effective rate
date and allows opt-out, falling back to the bundled rates. The MCP server uses
the same validation and caches an atomic local copy under `market-meta` in its
data directory; on network failure it uses that copy or the bundle. Set
`TRADEBLOCKS_PUBLISHED_RATES=off` to keep the MCP server on the bundled rates
without any request. No key is needed for either path, and CSV-only analysis
remains available offline. A
live published observation updates risk-free lookups and date-based canonical
rate slices without changing the identities of older unchanged slices.

The publication check is `node scripts/rates.mjs check --json`; status
`current` exits 0, `behind` exits 1, and `unknown` exits 2. `--rates-url URL`
supports a local copy. A reviewed release updates both bundled histories with
`node scripts/rates.mjs seed`, and release automation rejects a bundle more
than 10 calendar days behind the published file.

## Data Provider Architecture

TradeBlocks uses a provider abstraction for external API calls. The active provider is selected via the `MARKET_DATA_PROVIDER` environment variable (default: `"massive"`).

| Provider              | Env Var     | Credentials                                                               | Status                    |
| --------------------- | ----------- | ------------------------------------------------------------------------- | ------------------------- |
| Massive.com (Polygon) | `massive`   | `MASSIVE_API_KEY`                                                         | Shipped                   |
| ThetaData MDDS        | `thetadata` | `THETADATA_EMAIL` + `THETADATA_PASSWORD`, or `THETADATA_CREDENTIALS_FILE` | Direct MDDS/gRPC provider |

All providers implement the same `MarketDataProvider` interface and normalize responses to the same `BarRow` and `OptionContract` types. Downstream tools (replay, exit analysis, enrichment) work identically regardless of provider.

### Building a Custom Provider

Provider integrations are optional and must not change the CSV-only experience. Keep credentials in
environment variables and read them when a handler runs so tests can replace them safely. Never
accept an API key as an MCP tool argument, because tool arguments can be retained in client history.

The built-in Massive.com provider uses Node's native `fetch`, `AbortSignal.timeout()`, and Zod
validation. Do not add an HTTP client or provider SDK unless the provider requires behavior that the
platform APIs cannot supply. Parse and validate a complete response before writing rows so upstream
schema drift fails without partial data. Tests should spy on `globalThis.fetch`, restore mocks after
each case, and construct responses with the platform `Response` class.

Missing credentials should produce a clear tool error instead of an unhandled exception.

To add a new data provider:

1. **Create the adapter** at `packages/mcp-server/src/utils/providers/<name>.ts`

   Implement the `MarketDataProvider` interface from `market-provider.ts`:

   ```typescript
   import type {
     MarketDataProvider,
     BarRow,
     FetchBarsOptions,
     FetchSnapshotOptions,
     FetchSnapshotResult,
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

## Point-in-time spot store reads

`SpotStore.readBars(ticker, from, to, upperEt?)` accepts an optional inclusive, minute-grained upper bound on the final calendar day. Both the canonical Parquet and DuckDB implementations apply it in the SQL read before rows reach the caller:

```typescript
await stores.spot.readBars("SPX", "2025-01-06", "2025-01-08", "2025-01-08T10:30");
```

This reads complete earlier days and the final day's observations through `10:30`, including that minute but excluding later rows. `upperEt` must be an Eastern wall-clock `YYYY-MM-DDTHH:mm` string whose date equals `to`; UTC suffixes, offsets, invalid clock values and mismatched dates refuse, including when the store has no data. Do not convert a market calendar date through a UTC `Date` to construct it.

Existing three-argument calls still return complete days unchanged. Daily aggregation remains a separate full-session read; this optional bound is for raw spot observations and also applies to VIX or other tickers stored through the same interface.

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

| Variable                         | Description                    |
| -------------------------------- | ------------------------------ |
| `THETADATA_MDDS_HOST`            | Override the MDDS host         |
| `THETADATA_MDDS_PORT`            | Override the MDDS port         |
| `THETADATA_MDDS_MAX_CONCURRENCY` | Limit concurrent MDDS requests |
| `THETADATA_MDDS_RETRY_ATTEMPTS`  | Override retry attempts        |
| `THETADATA_MDDS_RETRY_BASE_MS`   | Override retry base delay      |
| `THETADATA_MDDS_RETRY_MAX_MS`    | Override retry max delay       |

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

### Local market-data tools

Build the MCP package before running the market-data tools:

```bash
npm run build:mcp
```

`node tools/refresh-market-data.mjs --dry-run` prints the planned dates without
writing data. `node tools/market-data-coverage.mjs --json --lookback 30`
reports the last 30 trading sessions (exit 0 complete, 1 incomplete, 2 unknown).
Both tools use `TRADEBLOCKS_DATA_ROOT`, `TRADEBLOCKS_SPOT_TICKERS`, and
`TRADEBLOCKS_OPTION_UNDERLYINGS`. Coverage reports can be checked with
`node tools/market-data-coverage.mjs --validate <report.json>`. Missing or stale
MCP dist fails with a build instruction; the tools never build it themselves.

### import_flat_file

Import a local Parquet or CSV flat file for a specific ticker and timespan. Useful for bulk loading pre-downloaded data.

**Parameters:**

- `file_path` — path to local file
- `ticker` — plain ticker symbol
- `timespan` — `"1d"` or `"1m"`

### Ticker Formats

| Type   | Plain Ticker       | API Format           | Storage Format     |
| ------ | ------------------ | -------------------- | ------------------ |
| Stock  | SPY                | SPY                  | SPY                |
| Index  | VIX                | I:VIX                | VIX                |
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

| Old call                                                                                | New call                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `import_from_api { target_table: "daily", ticker: "SPX", from, to }`                    | `fetch_bars { tickers: ["SPX"], timespan: "1d", from, to }`                                                                |
| `import_from_api { target_table: "intraday", ticker: "SPX", timespan: "1m", from, to }` | `fetch_bars { tickers: ["SPX"], timespan: "1m", from, to }`                                                                |
| `import_from_api { target_table: "date_context", from, to }`                            | `fetch_bars { tickers: ["VIX","VIX9D","VIX3M"], timespan: "1d", from, to }` followed by `compute_vix_context { from, to }` |

## Computed option-Greeks method

`greeks_source = 'computed'` identifies local model outputs, not provider-native
Greeks. Interpret it together with `greeks_revision`, `rate_type`, `rate_value`,
and `gamma_source`; a revision number alone is not proof of a method when a
store has been modified by another writer. `greeks_source = 'massive'` or
`'thetadata'` remains provider-native even when an independently computed gamma
has `gamma_source = 'computed_sofr_q0'`.

### Revisions written by TradeBlocks

| Revision | Rate `r` (annual decimal)              | Dividend yield `q` | Provenance and differences                                                                                                                                                  |
| -------- | -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Fixed `0.045`                          | `0.015`            | Legacy writer; no rate/gamma provenance fields.                                                                                                                             |
| 2        | Quote-date SOFR percent divided by 100 | `0`                | Rate-convention change; still no rate/gamma provenance fields.                                                                                                              |
| 3        | Stored `rate_value`                    | `0`                | `rate_type = 'sofr'`, `gamma_source = 'computed_sofr_q0'`; otherwise revision 2's calculation.                                                                              |
| 5        | Stored `rate_value`                    | `0`                | ThetaData quote-mid writer; `rate_type = 'sofr'`, `gamma_source = 'computed_thetadata_quote_mid_sofr_q0'`. **Stored vega incorrectly equals the calculation's vega × 100.** |
| 6        | Stored `rate_value`                    | `0`                | Same ThetaData method as 5, but stored vega is corrected to the calculation's vega, without × 100.                                                                          |

Revision 4 has no writer in the public TradeBlocks history. Do not assign it
revision 3's or 5's recipe. Revision 5 was introduced in commit `c43e02ea`;
`0780c1e6` changed that writer to revision 6 and corrected its vega scaling.
The current generic quote ingestor writes revision 3.

Revisions 1–2 never wrote the provenance triple. A complete computed row with
a null revision is promoted on read to 3 **only** when `rate_type = 'sofr'`,
`rate_value` is finite, and `gamma_source = 'computed_sofr_q0'`.
Bare null-revision rows remain ambiguous between 1 and 2 and are not reported
as revision 3. Missing provenance cannot be reconstructed merely by reading
the current rate table.

### Inputs and model recovery

The generic quote writer uses option price `(bid + ask) / 2`, through its
`getMid` callback; it does not use last trade or prefer the stored `mid`.
A zero on one side is included in that arithmetic, not replaced by the other
side. Both zero gives a nonpositive price and no computed result. This callback
expects numeric sides and has no missing-side fallback: `undefined`/NaN makes
the midpoint NaN; JavaScript `null` would coerce to zero if supplied outside
that interface. The ThetaData revision-5/6 writer explicitly rejects null,
missing and non-finite bid/ask, and also uses their arithmetic midpoint (one
zero side is allowed if the midpoint is positive).
These computation rules are distinct from replay's quote-sanity filtering.

Use the matching chain row (same underlying, quote date and option ticker) for
strike, expiration and call/put type. Use the underlying's stored **spot-bar
open at the same Eastern calendar date and `HH:MM` minute**, not its close,
daily close, or a later minute. The historical lookup key
`buildUnderlyingPriceKey(date, time)` is `date + '|' + time.slice(0, 5)`;
the current single-date ingestor uses the equivalent minute-only map and
retains the first positive open for a repeated minute. Preserve the original
input datasets if they are subsequently repaired; a quote row does not embed
the spot price or contract metadata.

All the revisions above use
[`computeFractionalDte`](../packages/mcp-server/src/utils/option-time.ts):

```text
dayDiff = round((UTC_midnight(expiration) - UTC_midnight(quote_date)) / 86400000)
remainingMinutes = max(960 - (60 * hour + minute), 0)
dte = max(dayDiff + remainingMinutes / 1440, 0)
T = dte / 365
```

Dates and clock minutes are **US Eastern calendar keys**, not instants to
convert from UTC. UTC midnights only count calendar days; daylight-saving
transitions do not add/subtract an hour. Seconds are discarded. This assumes
16:00 ET expiry for every contract: it does **not** distinguish AM settlement
from PM settlement, trading-session duration, or holiday/early-close times.
After 16:00 the fractional term is zero; past expirations are clamped to zero.

The model is recovered exactly for these writers from stored quote date/time
and the matching chain expiration: calculate that DTE and apply
`BACHELIER_DTE_THRESHOLD = 0.1` days. **`dte < 0.1` uses Bachelier;
`dte >= 0.1` uses Black-Scholes**, including exactly 0.1. “0DTE” alone
does not identify the model. At minute precision, same-day 13:36 gives 0.1
(Black-Scholes), while 13:37 gives 143/1440 (Bachelier). No model column is
needed. An unknown writer, absent matching chain row, or changed original
inputs does not inherit this recoverability guarantee.

SOFR is the New York Fed overnight series distributed via FRED `SOFR`.
`getSofrRateByKey(quote_date)` returns annual **percent** for the exact
observation date when present, otherwise the latest prior observation;
before/after the available range it clamps to the earliest/latest observation.
There is no additional publication-day lag in this calculation.
`getEffectiveRateDate('SOFR')` is the **latest date of the active series**,
not the selected observation date for a historical row; the generic writer
uses it to invalidate its rate memoization when the published tail changes.
The input is percent / 100, stored as an annual **decimal** in `rate_value`
(e.g. 3.62% becomes `0.0362`). For replaying a provenance-bearing row, pass
its stored value directly: do not divide it by 100 again or replace it with
today's lookup. Revision 2 did not retain the actual rate; exact reproduction
requires the rate series available to that writer, especially at a stale tail.

### Calculation, solve and units

The executable recipe is
[`computeLegGreeks`](../packages/mcp-server/src/utils/black-scholes.ts)
`(optionPrice, underlyingOpen, strike, dte, 'C' or 'P', r, q)`.
It solves IV first, then evaluates that model's delta/gamma/theta/vega at
the solved IV. Both are European models with continuous rates/dividend yield;
the Bachelier forward is `S * exp((r - q) * T)` with discount `exp(-r * T)`.
Use the linked implementation's formulas and its Abramowitz–Stegun 26.2.17
normal-CDF approximation, rather than a different library's solver/CDF, for
storage-precision agreement.

- **Black-Scholes `solveIV`:** Newton–Raphson, initial sigma `0.3`,
  initial bisection bounds `[0.001, 5]`. Raw vega below `1e-10` triggers
  bisection (this branch calculates the midpoint before updating its bounds).
  A Newton candidate `<= 0` or `> 10` triggers bound update then bisection;
  otherwise it is accepted. Bounds are fallback state, not hard clipping.
- **Bachelier `solveNormalIV`:** Newton–Raphson, initial normal sigma
  `max(optionPrice / sqrt(T / (2 * pi)), 1)`, initial bisection bounds
  `[0.01, 50000]`. Raw vega below `1e-10`, or a Newton candidate `<= 0`
  or `> 100000`, triggers bound update then bisection.
- Both use at most **100 iterations**, accepting absolute model-price error
  **strictly below `1e-6`**. Nonpositive option price or `T` returns null IV;
  iteration exhaustion also returns null. There is no automatic retry in the
  other model. Failed IV yields all five outputs null; writers do not label
  an incomplete/non-finite result as a successful computed row.

Delta is per underlying-price unit; gamma is delta change per price unit.
Theta is option-price decay **per calendar day** (annual formula / 365).
Black-Scholes IV is annualized lognormal decimal volatility (`0.20` = 20%);
vega is price change for **0.01 absolute volatility** (one percentage point).
Bachelier IV is annualized **normal dollar volatility**, not lognormal percent.
Its vega is raw normal-vol sensitivity / 100: price change for **0.01 absolute
normal dollar-vol units**, not a relative 1% change in its IV. Revision 5's
stored vega is 100 times these values. Stored Greeks do not include contract
quantity or the option's ×100 contract multiplier.

The committed
[stored-row fixture](../packages/mcp-server/tests/unit/computed-greeks-stored-fixture.test.ts)
recomputes revision-3 Black-Scholes and Bachelier rows from stored inputs.
It allows relative error `2^-23` per Greek: the original Parquet Greek
columns are IEEE-754 binary32 `FLOAT` (rounding error at most `2^-24`
for these normal nonzero values), with one extra rounding margin.

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
- Per-leg greeks: delta, gamma, theta, vega, IV (Bachelier when fractional DTE < 0.1 days, otherwise Black-Scholes; see [computed option-Greeks method](#computed-option-greeks-method) for the model convention and stored-row provenance)
- Net position greeks: quantity-weighted sums
- Optional IVP from VIX data
- `close_at: "expiry"` to analyze holding through expiration

## Enrichment Pipeline

After imports, enrichment runs automatically (unless `skip_enrichment=true`). Run manually with `enrich_market_data`.

The interactive `enrich_market_data` call checks the requested ticker's full spot
history and fills unpublished sessions, even if a newer one-day refresh already
advanced its watermark. Its temporary working table reads only that ticker's
existing enriched slices; cross-ticker VIX context reads spot history separately.
`refresh_market_data` publishes the requested session only. A failed publication
does not advance the ticker's enrichment watermark.

### Tier 1: Technical Indicators

Written to `market.enriched` for the imported ticker. ~20 fields:

| Category     | Fields                                                           |
| ------------ | ---------------------------------------------------------------- |
| Momentum     | RSI_14                                                           |
| Volatility   | ATR_Pct, Realized_Vol_5D, Realized_Vol_20D                       |
| Trend        | Price_vs_EMA21_Pct, Price_vs_SMA50_Pct, Return_5D, Return_20D    |
| Price action | Gap_Pct, Prior_Close, Prior_Range_vs_ATR, Prev_Return_Pct        |
| Intraday     | Intraday_Range_Pct, Intraday_Return_Pct, Close_Position_In_Range |
| Structure    | Gap_Filled, Consecutive_Days                                     |
| Calendar     | Day_of_Week, Month, Is_Opex                                      |

### Tier 2: VIX Context

Runs when VIX-family spot tickers exist. Discovers VIX tickers from their daily bars.

**Per-ticker (written to `market.enriched`):**

| Field | Description                                                                    |
| ----- | ------------------------------------------------------------------------------ |
| ivr   | Implied Volatility Rank (252-day): position in min-max range (0-100)           |
| ivp   | Implied Volatility Percentile (252-day): % of days at or below current (0-100) |

**Cross-ticker derived (written to `market.enriched_context`):**

| Field                | Description                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Vol_Regime           | Volatility regime (1=very low <13, 2=low 13-16, 3=normal 16-20, 4=elevated 20-25, 5=high 25-30, 6=extreme >30) |
| Term_Structure_State | VIX term structure (-1=backwardation, 0=flat, 1=contango)                                                      |
| Trend_Direction      | Trend from 20-day return: up (>1%), down (<-1%), flat                                                          |
| VIX_Spike_Pct        | VIX spike from open to high as percentage                                                                      |
| VIX_Gap_Pct          | VIX overnight gap percentage                                                                                   |

### Tier 3: Intraday Timing

Uses `market.spot` minute bars for the ticker. Written to `market.enriched`:

| Field                  | Description                                |
| ---------------------- | ------------------------------------------ |
| High_Time              | Time of day high occurred                  |
| Low_Time               | Time of day low occurred                   |
| High_Before_Low        | Whether high occurred before low (1/0)     |
| Reversal_Type          | Intraday reversal classification           |
| Opening_Drive_Strength | Strength of the opening move               |
| Intraday_Realized_Vol  | Intraday realized volatility from bar data |

## Database Schema

| Table                         | Key                            | Purpose                                                              |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `market.spot`                 | `ticker, date, time`           | Raw intraday bars, including daily bars stamped at 09:30             |
| `market.spot_daily`           | `ticker, date`                 | Regular-hours daily OHLCV derived from spot bars                     |
| `market.enriched`             | `ticker, date`                 | Ticker indicators and VIX ivr/ivp                                    |
| `market.enriched_context`     | `date`                         | Cross-ticker derived fields (Vol_Regime, Term_Structure_State, etc.) |
| `market.option_chain`         | `underlying, date, ticker`     | Option contract-universe snapshots                                   |
| `market.option_quote_minutes` | `ticker, date, time`           | Dense option quote cache for replay/backtests                        |
| `market._sync_metadata`       | `source, ticker, target_table` | Import tracking                                                      |
