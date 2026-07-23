# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TradeBlocks is a Next.js 15 application for analyzing options trading performance. It processes CSV exports of trade logs and daily portfolio logs to calculate comprehensive portfolio statistics, drawdowns, and performance metrics. The application uses IndexedDB for client-side storage of trading data.

## Development Commands

### Running the Application

- `npm run dev` - Start development server with Turbopack
- `npm run build` - Build production bundle with Turbopack
- `npm start` - Start production server

### Testing

- `npm test` - Run all tests with Jest
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate coverage report
- `npm run test:portfolio` - Run portfolio stats tests specifically

To run a single test file:

```bash
npm test -- path/to/test-file.test.ts
```

To run a specific test case:

```bash
npm test -- path/to/test-file.test.ts -t "test name pattern"
```

### Code Quality

- `npm run lint` - Run ESLint on the codebase

## Architecture

### Core Data Flow

1. **Data Import**: Users upload CSV files (trade logs and optional daily logs)
2. **Processing Pipeline**:
   - CSV parsing (`lib/processing/csv-parser.ts`)
   - Trade/daily log processing (`lib/processing/trade-processor.ts`, `lib/processing/daily-log-processor.ts`)
   - Data validation (`lib/models/validators.ts`)
3. **Storage**: Data stored in IndexedDB via store modules (`lib/db/`)
4. **Calculation**: Portfolio statistics calculated via `lib/calculations/portfolio-stats.ts`
5. **State Management**: Zustand stores (`lib/stores/`) manage UI state and coordinate data access

### Key Architectural Patterns

**Block-Based Organization**: Trading data is organized into "blocks" - each block represents a trading portfolio/strategy with:

- Trade log (required): Individual trade records
- Daily log (optional): Daily portfolio values for enhanced performance calculations
- Calculated statistics cached for performance

**Dual Storage Pattern**:

- Raw trade/daily log data → IndexedDB (via `lib/db/`)
- UI state & metadata → Zustand stores (via `lib/stores/`)
- This separation allows efficient data handling for large datasets

**Math.js for Statistical Calculations**: All statistics use `math.js` library to ensure consistency:

- Sharpe Ratio: Uses sample standard deviation (N-1) via `std(data, 'uncorrected')`
- Sortino Ratio: Uses standard downside deviation = sqrt((1/N) \* sum(min(excess_i, 0)^2)) where N = total observations. This is the RMS of negative excess returns from zero, NOT std() of only the negative returns.

### Directory Structure

- `app/` - Next.js 15 app router pages and layouts
  - `(platform)/` - Main application routes with sidebar layout
- `components/` - React components
  - `ui/` - shadcn/ui components (Radix UI primitives)
  - `performance-charts/` - Plotly-based performance visualizations (via react-plotly.js)
- `lib/` - Core business logic (framework-agnostic)
  - `models/` - TypeScript interfaces and types
  - `processing/` - CSV parsing and data processing
  - `calculations/` - Portfolio statistics calculations
  - `db/` - IndexedDB operations
  - `stores/` - Zustand state management
- `tests/` - Jest test suites
  - `unit/` - Unit tests for calculations and processing
  - `integration/` - Integration tests for data flow
  - `data/` - Mock data and test fixtures

### Critical Implementation Details

**Timezone Handling**: All dates and times are processed and displayed as **US Eastern Time** (America/New_York). This is critical because:

- Trading data originates from US markets operating on Eastern Time
- CSVs contain dates/times in Eastern Time format
- When parsing dates, preserve the calendar date as-is (don't convert to UTC)
- When displaying times, show Eastern Time (with DST awareness)
- Use `toLocaleDateString('en-US')` or manual string extraction instead of `.toISOString()` which converts to UTC
- Static datasets in `tests/data/` explicitly handle Eastern Time with DST awareness

**Date Comparison Rules (MCP Server)**: There are **two kinds of dates** in the MCP server, and they require different handling:

1. **Calendar dates from CSVs** (trade-log exports): These are Eastern Time trading dates like "2025-01-07" parsed via `parseDatePreservingCalendarDay()` → `new Date(year, month, day)`. The Date is created at **local midnight**, NOT Eastern midnight. The calendar date "7" is just temporarily stored inside a Date object — it's not a real timestamp. To read it back, you MUST use the same local-timezone methods (`getFullYear`/`getMonth`/`getDate`), which always return the original calendar date regardless of server timezone. This works because the write path (constructor) and read path (getters) both use local timezone — they're symmetric and cancel out.

2. **Absolute timestamps** (TradingView Unix epoch in market CSVs): These ARE real UTC instants representing a specific moment in time. To get the correct Eastern trading date, you MUST convert to ET via `toLocaleDateString("en-CA", { timeZone: "America/New_York" })`. This is the one place ET conversion is correct.

**The critical mistake** is mixing these two: creating a Date at local midnight (type 1) but then reading it with ET timezone conversion (type 2). On a UTC server, local midnight = 19:00 ET the previous day → off by one.

Rules for type 1 (trade dates from CSVs):

- **DO**: Use string comparison on YYYY-MM-DD for date range filtering. Use `filterByDateRange()` from `tools/shared/filters.ts` or `toCalendarDateStr()` / `formatTradeDate()`.
- **DO**: Extract calendar date from strings via regex (`/^(\d{4})-(\d{2})-(\d{2})/`) before parsing to Date.
- **DO**: Use local date components (`getFullYear()`, `getMonth()`, `getDate()`) when you need YYYY-MM-DD from a Date that came from `parseDatePreservingCalendarDay`.
- **DON'T**: Use `new Date("YYYY-MM-DD")` for comparison boundaries — this creates UTC midnight, not local midnight, causing mismatch with trade dates.
- **DON'T**: Use `toLocaleDateString()` with explicit `timeZone` on these dates — this re-interprets the local-midnight date in a different timezone and can shift it by a day.
- **DON'T**: Use `.toISOString().split("T")[0]` on these dates — this converts to UTC first and can shift the calendar date.

**Market Data Lookahead Rules (MCP Server)**: When joining trades with market data, `buildLookaheadFreeQuery()` from `utils/field-timing.ts` JOINs `market.enriched` (ticker-keyed indicators), `market.spot_daily` (RTH-aggregated OHLCV derived from `market.spot`), and `market.enriched_context` (cross-ticker regime fields) before applying `LAG()`. Close-derived fields (38 fields including `RSI_14`, `VIX_Close`, `Vol_Regime`, `BB_Width`, `Opening_Drive_Strength`) are only known after market close and MUST use `LAG()` to get the prior trading day's value. Open-known fields (10 fields: `Gap_Pct`, `VIX_Open`, `VIX_RTH_Open`, `Prior_Close`, `Prior_Range_vs_ATR`, etc.) and static fields (3: `Day_of_Week`, `Month`, `Is_Opex`) are safe to use same-day. See `utils/schema-metadata.ts` for the authoritative field classification.

**Date Handling**: Trades use separate `dateOpened` (Date object) and `timeOpened` (string) fields. When processing CSVs, parse dates carefully and maintain consistency with legacy format.

**Trade P&L Calculations**:

- Always separate gross P&L (`trade.pl`) from commissions (`openingCommissionsFees` + `closingCommissionsFees`)
- Net P&L = gross P&L - total commissions
- Strategy filtering MUST use trade-based calculations only (not daily logs) since daily logs represent full portfolio performance

**Drawdown Calculations**:

- Uses daily logs when available for more accurate drawdowns
- Falls back to trade-based equity curve when daily logs are missing
- Portfolio value tracks cumulative returns over time
- See `lib/calculations/portfolio-stats.ts` for implementation

**IndexedDB Data References**: The `ProcessedBlock` interface uses `dataReferences` to store keys for related data in IndexedDB. When working with blocks, always load associated trades/daily logs separately.

**Risk-Free Rate Data**: Historical Treasury rates are stored in `lib/data/treasury-rates.ts`. See the file header for update instructions. To update with new rates:

1. Fetch CSV from FRED: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd=START_DATE&coed=END_DATE`
2. Add entries in format `"YYYY-MM-DD": X.XX,`
3. Run tests: `npm test -- tests/unit/risk-free-rate.test.ts`

### MCP Server Considerations

**Design principle — the LLM is the intelligence layer.** When designing MCP tools, push sniffing, classification, and config decisions UP to the caller instead of hardcoding them into a dispatch matrix. The LLM has `describe_database`, `run_sql` with path-gated `read_parquet`/`read_csv`/`read_json`, and schema context — it can inspect any file, match it to a target store, and supply a transforming SELECT. Tools should accept that config (e.g., `{file_path, dataset_type, select_sql, partition}`) rather than bake in per-provider or per-format parsers.

Symptoms you're building in the wrong place:

- Adding a "format registry" or per-format parser class to the server
- Dispatching by `(provider, asset_class, dataset)` tuples
- Sniffing file schemas inside a tool handler
- Growing a `switch` on provider names inside shared code

Symptoms you're in the right place:

- Tool signatures accept a typed config from the caller
- Stores expose a single mode-aware write primitive (`writeX` or `writeFromSelect`) and nothing more
- Providers own fetch/download only; everything after the bytes hit disk is provider-agnostic
- Adding a new format or dataset needs zero server-code changes when the LLM can compose a SELECT

This principle applies to flat-file ingestion, CSV import, enrichment configuration, and any future "take arbitrary input and route to the right place" surface.

---

When adding new metrics, calculations, or chart data to the UI, **consider whether it should also be exposed via the MCP server** (`packages/mcp-server/`). The MCP server allows Claude to programmatically access portfolio data and statistics.

**Key MCP tools to consider updating:**

- `get_statistics` (in `src/tools/blocks.ts`) - Add new summary metrics here (e.g., peak exposure alongside max drawdown)
- `get_performance_charts` (in `src/tools/performance.ts`) - Add new chart data types here (e.g., daily_exposure alongside equity_curve)

**When to add to MCP:**

- New summary statistics that would be useful for AI analysis
- New time series data that could answer user questions
- New risk metrics or portfolio health indicators

**MCP server structure:**

- `src/tools/blocks.ts` - Core stats, block listing, comparisons
- `src/tools/performance.ts` - Chart data, period returns, backtest vs actual
- `src/tools/analysis.ts` - Monte Carlo, walk-forward, correlations
- `src/tools/reports.ts` - Custom queries, field statistics
- `src/tools/market-data.ts` - Market regime analysis, filter suggestions, ORB calculation, trade enrichment
- `src/tools/market-imports.ts` - import_market_csv, import_from_database
- `src/tools/market-enrichment.ts` - enrich_market_data
- `src/tools/market-ingestor.ts` - fetch_bars, fetch_quotes, fetch_chain, import_flat_file, compute_vix_context, refresh_market_data
- `src/tools/profiles.ts` - Strategy profile CRUD (profile_strategy, get_strategy_profile, list_profiles, delete_profile)
- `src/tools/profile-analysis.ts` - Structure-aware analysis (analyze_structure_fit, validate_entry_filters, portfolio_structure_map)

### Using MCP Tools

**Primary dev path — Claude Code's native MCP tool-use.** The tradeblocks MCP server loads from `.mcp.json` at session start, so tools are available directly inside Claude Code as `mcp__tradeblocks__<tool_name>`. After `npm run build` in `packages/mcp-server/`, type `/reload` in Claude Code to restart the session and pick up the rebuilt server — the wrapper shell function (`clp`) catches the SIGHUP exit and relaunches with `--continue` to preserve conversation history. Zero tokens consumed by the restart. This replaces the prior `mcptools`-from-Bash pattern — Claude Code renders MCP resource content (e.g., `run_sql` result rows) natively, and the session persists across rebuilds.

**Secondary path — shell scripting via MCP Inspector `--cli`.** For bulk ops invoked from harness scripts (CI, `/tmp/bulk-fill.mjs`-style one-offs). Run via `npx` — no install, just invoke it. The official `@modelcontextprotocol/inspector` package reads our `.mcp.json` directly (env block and all) via `--config` + `--server`, and returns the **raw MCP envelope** as JSON on stdout so downstream `jq` can extract fields.

**Avoid the alternatives** — both have silent-failure bugs that bit us:

- `f/mcptools` deadlocks on any ~30s+ response (stdio-chunking bug in `mark3labs/mcp-go`)
- `philschmid/mcp-cli`'s daemon mode drops responses >8KB, and its text formatter silently drops `resource` content blocks (so `run_sql` rows never render)

**Example — query row count:**

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  --config /path/to/tradeblocks/.mcp.json --server tradeblocks \
  --method tools/call --tool-name run_sql \
  --tool-arg 'query=SELECT COUNT(*) AS n FROM market.option_quote_minutes'
```

The response is JSON with two content blocks — `type:"text"` (summary) and `type:"resource"` (JSON rows). Pipe through `jq -r '.content[] | select(.type=="resource").resource.text | fromjson'` to get the row payload.

**Example — bulk ingestion:**

```bash
MCP_SERVER_REQUEST_TIMEOUT=3600000 npx --yes @modelcontextprotocol/inspector --cli \
  --config /path/to/tradeblocks/.mcp.json --server tradeblocks \
  --method tools/call --tool-name fetch_quotes \
  --tool-arg 'underlyings=["SPX"]' --tool-arg 'from=2026-04-15' --tool-arg 'to=2026-04-17'
```

The default request timeout is 5 minutes; bump it via `MCP_SERVER_REQUEST_TIMEOUT` (ms) for multi-day fetches.

**DuckDB lock contention caveat:** running Inspector against the tradeblocks server while another session-level tradeblocks MCP is live can contend for the same DuckDB lock. Prefer the primary path (`mcp__tradeblocks__*`) while inside Claude Code; reserve Inspector for standalone shell scripts running outside an active session.

The v3.0 market views are: `market.spot` (raw minute OHLCV bars), `market.spot_daily` (RTH-aggregated daily OHLCV derived from `market.spot`), `market.enriched` (per-ticker computed indicators like `RSI_14`, `VIX_Close`, `ivr`), `market.enriched_context` (cross-ticker regime fields like `Vol_Regime`, `Term_Structure_State`), `market.option_chain` (contract universe snapshots), `market.option_quote_minutes` (dense per-minute option quotes), and `market._sync_metadata` (coverage tracking).

**Example — list tools + tool schema:**

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  --config /path/to/tradeblocks/.mcp.json --server tradeblocks \
  --method tools/list
```

**Key tools:** `list_blocks`, `get_statistics`, `get_performance_charts`, `run_sql`, `describe_database`, `run_monte_carlo`, `compare_backtest_to_actual`, `analyze_regime_performance`, `suggest_filters`, `enrich_trades`, `fetch_bars`, `fetch_quotes`, `fetch_chain`, `import_flat_file`, `compute_vix_context`, `refresh_market_data`

**After changing MCP server source code:** Run `npm run build` in `packages/mcp-server/`. If working inside Claude Code (primary path), type `/reload` to restart with `--continue`. If calling from Inspector (secondary path), no restart needed — each `npx` call spawns a fresh server automatically.

**MANDATORY after implementation work on the MCP server:** Build AND run a live Inspector smoke before reporting completion. Unit tests cover isolated code paths; only a real MCP server startup against a populated data root catches lifecycle issues that fixture-based tests miss (e.g., pre-existing DuckDB state, DROP VIEW vs DROP TABLE type mismatches, connection setup ordering, view registration over real Parquet directories). Minimum smoke:

```bash
cd <repo-root>/packages/mcp-server && npm run build && \
  npx --yes @modelcontextprotocol/inspector --cli \
    --config /path/to/tradeblocks/.mcp.json --server tradeblocks \
    --method tools/list 2>&1 | head -30
```

**Data directory location:** The DuckDB files (`market.duckdb`, `analytics.duckdb`, `backtests.duckdb`) live under `$DATA_ROOT/database/`. The server config in `.mcp.json` already points at this path (and at `--data-root $DATA_ROOT`, which contains sibling folders `blocks/`, `market/`, `market-meta/`, `strategies/`). Don't need to re-specify these on the command line — Inspector reads them from the `--config` file.

**PROVIDER TESTING:** The configured market data provider is selected via the `MARKET_DATA_PROVIDER` env var. Verification gates that exercise provider-capability paths (fetch_bars, fetch_quotes, fetch_chain ingest orchestration) should run against each provider you intend to support — a migration that works for one provider but breaks another ships a regression. Reads never trigger provider calls, so that gate is provider-agnostic and one run suffices.

```bash
MARKET_DATA_PROVIDER=<provider> npx --yes @modelcontextprotocol/inspector --cli \
  --config /path/to/tradeblocks/.mcp.json --server tradeblocks \
  --method tools/call --tool-name fetch_bars \
  --tool-arg 'tickers=["SPX"]' --tool-arg 'timespan=1d' \
  --tool-arg 'from=2024-01-01' --tool-arg 'to=2024-01-31'
```

If the server fails to start or init times out, fix the issue BEFORE declaring any work complete. "Tests pass" is not equivalent to "server starts."

**DuckDB connection model:** The server opens read-write for initialization (schema/view creation), then downgrades to read-only. Write tools call `upgradeToReadWrite()` on demand. This means concurrent read access (tests, other scripts) works while the server is idle.

**Market data access:**

- Market data served from Parquet views registered by shared `db/market-views.ts` (`createMarketParquetViews()`) when `~/tradeblocks-data/market/` directory exists
- View surface: `market.spot` / `market.spot_daily` / `market.enriched` / `market.enriched_context` / `market.option_chain` / `market.option_quote_minutes`
- Falls back to physical DuckDB tables (same names) when Parquet files are absent (public repo behavior)
- Mutable metadata table (`_sync_metadata`) is always a physical DuckDB table

**Provider-native ingestor tools (Plan A/B):**

- `fetch_bars { tickers, timespan, from, to }` — fetch daily or intraday OHLCV bars from the configured provider and write to Parquet
- `fetch_quotes { tickers, from, to }` — fetch option minute quotes and write to Parquet
- `fetch_chain { underlying, date }` — fetch option chain snapshot and write to Parquet
- `import_flat_file { file_path, dataset_type, select_sql, partition }` — dispatch any DuckDB-readable file (parquet, csv, jsonl, gz) to a target market store (`spot_bars` / `option_quotes` / `option_chain`) via an LLM-composed SELECT. Workflow: run_sql to sniff the file, describe_database for the target shape, compose a bridging SELECT, then call import_flat_file. See `releases/v3.0.md` for details.
- `compute_vix_context { from, to }` — compute cross-ticker VIX regime fields (Vol_Regime, Term_Structure_State, etc.) for a date range
- `refresh_market_data { tickers, from, to }` — composite daily-refresh: calls fetch_bars for all tickers, then auto-fires compute_vix_context when VIX-family tickers are present, and returns a coverage report. Use this for routine end-of-day data updates.

### Trading Calendar Data Model

The Trading Calendar feature compares **backtest** (theoretical) results against **actual** (reported/live) trades. **CRITICAL**: The variable names map as follows:

| Term in UI   | Model Type       | CSV Source        | Variable Names                 | Description                                         |
| ------------ | ---------------- | ----------------- | ------------------------------ | --------------------------------------------------- |
| **Backtest** | `Trade`          | `tradelog.csv`    | `backtestTrades`, `backtestPl` | Theoretical results, typically **more contracts**   |
| **Actual**   | `ReportingTrade` | `strategylog.csv` | `actualTrades`, `actualPl`     | Live/reported trades, typically **fewer contracts** |

**Scaling Modes** (for comparing P&L fairly):

- `raw`: Show P&L values as-is, no adjustment
- `perContract`: Divide each P&L by its contract count for per-lot comparison
- `toReported`: Scale **backtest DOWN** to match actual contract counts

**Scaling Logic for `toReported`**:

```typescript
// Backtest has MORE contracts, actual has FEWER
// Scale factor < 1 to scale DOWN
const scaleFactor = actualContracts / btContracts; // e.g., 1/10 = 0.1
const scaledBacktestPl = backtestPl * scaleFactor; // Scales DOWN
const actualPl = actualPl; // Stays as-is (this is the reference)
```

**Key files**:

- `lib/models/trade.ts` - `Trade` interface (backtest)
- `lib/models/reporting-trade.ts` - `ReportingTrade` interface (actual)
- `lib/stores/trading-calendar-store.ts` - State management and scaling
- `lib/services/calendar-data.ts` - `scaleStrategyComparison()` function

## Testing Strategy

Tests use `fake-indexeddb` for IndexedDB simulation. When writing tests:

- Import `tests/setup.ts` is configured automatically via Jest setup
- Use mock data from `tests/data/` when possible
- Portfolio stats tests validate consistency
- Always test edge cases: empty datasets, single trade, missing daily logs

## Path Aliases

TypeScript is configured with path aliases for clean imports:

```typescript
// Library imports use the workspace package
import { Trade, PortfolioStatsCalculator } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";

// Component imports use root-relative paths
import { Button } from "@/components/ui/button";
```

The `@tradeblocks/lib` workspace package (in `packages/lib/`) exports all models, calculations, processing, db, and utility functions. Stores are exported separately from `@tradeblocks/lib/stores`.

## UI Component Library

Uses shadcn/ui components built on Radix UI primitives with Tailwind CSS. Components are in `components/ui/` and follow the shadcn pattern (copy-paste, not npm installed).

## Charting

All performance charts use **Plotly** via `react-plotly.js`, NOT Recharts. Charts follow a consistent pattern:

1. **Use `ChartWrapper`** (`components/performance-charts/chart-wrapper.tsx`) - provides consistent Card styling, theme support, tooltips, and Plotly configuration
2. **Import types from plotly.js**: `import type { Layout, PlotData } from 'plotly.js'`
3. **Build traces in useMemo** with proper typing: `const traces: Partial<PlotData>[] = [...]`
4. **Pass to ChartWrapper**: `<ChartWrapper title="..." data={traces} layout={layout} />`

Common Plotly features used:

- Stacked areas: `stackgroup: "one"`, `groupnorm: "percent"`
- Fill to zero: `fill: 'tozeroy'`
- Custom hover: `hovertemplate: '...<extra></extra>'`

## Form Input Patterns

**Number inputs with validation**: When creating number inputs that users need to edit freely (delete and retype), use a two-state pattern:

```typescript
const [value, setValue] = useState<number>(10)           // Actual validated value
const [inputValue, setInputValue] = useState<string>("10") // String for input display

const handleBlur = () => {
  const val = parseInt(inputValue, 10)
  if (!isNaN(val) && val >= min && val <= max) {
    setValue(val)
    setInputValue(String(val))
  } else {
    setInputValue(String(value)) // Revert to last valid value
  }
}

<Input
  type="number"
  value={inputValue}
  onChange={(e) => setInputValue(e.target.value)}
  onBlur={handleBlur}
  onKeyDown={(e) => e.key === "Enter" && handleBlur()}
/>
```

This pattern allows users to delete the entire value and type a new number, with validation only on blur or Enter.

## State Management

Zustand stores manage:

- **block-store**: Active block selection, block metadata, statistics
- **performance-store**: Filtered performance data, chart data caching

IndexedDB stores (via `lib/db/`) handle persistence of:

- Blocks metadata
- Trade records (can be thousands per block)
- Daily log entries
- Cached calculations

**When starting work on a Next.js project, ALWAYS call the `init` tool from
next-devtools-mcp FIRST to set up proper context and establish documentation
requirements. Do this automatically without being asked.**

## Testing Requirements

**Every new utility module with pure logic MUST have unit tests.** This includes:

- Parsing functions, filtering functions, builders (e.g., `intraday-timing.ts`, `field-timing.ts`)
- Calculation helpers, data transformers, validators
- Any exported function that takes inputs and returns outputs without side effects

Tests go in the matching test directory (e.g., `packages/mcp-server/tests/unit/` for MCP utils, `tests/unit/` for lib). If the module needs to be imported from `dist/`, add its exports to `src/test-exports.ts`.

Any implementation plan MUST include a test task for each new utility module. If a plan creates a utility file with exported pure functions but no test task, flag it during planning.

After implementation work, always run `npm run typecheck` before the final commit.
