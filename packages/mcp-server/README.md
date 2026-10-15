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

### Prerequisites (before using npm or npx)

Open a terminal (PowerShell on Windows) and run `node --version`, `npm --version`,
and `npx --version`. TradeBlocks' packaged server requires Node **18 or newer**;
Node **24 LTS** is recommended (and used for development). Your chosen client
may require a newer Node version, so Node 24 is the easiest shared choice.

If any command is missing, install Node **with npm**, then close and reopen the terminal:

| Platform | Install Node/npm                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | Use the macOS installer from [nodejs.org](https://nodejs.org/en/download), or `brew install node` if you already use Homebrew.                                                             |
| Windows  | Use the Windows installer from [nodejs.org](https://nodejs.org/en/download), or `winget install OpenJS.NodeJS.LTS`. Reopen PowerShell afterward.                                           |
| Linux    | Follow the Linux instructions at [nodejs.org](https://nodejs.org/en/download) for your distribution or version manager; choose Node 24 with npm rather than an older distribution package. |

Then repeat the three version checks. Install/open your chosen client separately:
[Claude Desktop](https://claude.ai/download),
[Claude Code](https://code.claude.com/docs/en/setup),
[Codex CLI](https://developers.openai.com/codex/cli/) (`npm install -g @openai/codex`),
or [Gemini CLI](https://geminicli.com/docs/get-started/installation/)
(`npm install -g @google/gemini-cli`). Setup does not install any of these.
Desktop's configuration directory must already exist; on Linux follow your Desktop
distribution's instructions. Local setup does not need OO, a provider key, or a skills plugin.

### Guided local setup

```bash
# Interactive: select a client and folder, review changes, explicitly approve
npx tradeblocks-mcp setup

# Agent/non-interactive: preview only (non-zero consent_required result)
npx tradeblocks-mcp setup --client codex --folder "/path/to/backtests" --json

# Apply the reviewed preview and verify
npx tradeblocks-mcp setup --client codex --folder "/path/to/backtests" --yes --json
```

Client choices are `claude-desktop`, `claude-code`, `codex`, and `gemini`.
Interactive setup shows all four clients numbered with detected/not-detected
markers and accepts a number or client name; it never selects one automatically.
Without `--json`, the preview and result are readable prose, including the
quoted launch command, verification, client action and next steps.
Folder paths are resolved to absolute paths, including paths with spaces. Setup
previews the exact file, entry and official user-scope registration command.
It can create a missing data folder only under the same consent. Without a TTY,
setup never prompts and requires `--client`, `--folder`, and `--yes` to write.
`--json` emits exactly one final result object on stdout; a redacted preview goes
to stderr before any write, even with `--yes`. Inspect `plannedChange` in a
preview run before approving it with `--yes`. Exit 0 means both registration
(or an equivalent existing entry) **and** MCP verification succeeded.

A differing `tradeblocks` entry needs separate replacement permission:
interactive setup asks separately, or agents add **both** `--replace` and
`--yes`. Replacement preserves existing `env` keys **and their values** and removes
other TradeBlocks-specific launch settings. Unknown entry fields (including URLs)
are conflicts, not equivalent stdio registrations. Gemini replacement refuses
environment values containing `=` before writing: its CLI truncates those values;
update the launch manually in its settings file while retaining the environment.
Previews show differing field names and environment key names, never existing
values or client diagnostics. Desktop updates preserve unrelated settings/servers,
use a same-directory temporary file and atomic rename, and back up existing files.
For all CLI clients, setup backs up an existing config before registration and
restores it if remove/add fails or read-back differs from the preview. The vendor
CLI may itself normalize or remove unrelated settings on successful registration
(Claude Code can drop unknown top-level keys); setup does not promise to undo a
successful vendor rewrite. The backup retains the original bytes. Backups may
contain secrets; protect them like the original and remove them when no longer needed.

Setup refuses unreadable or malformed configuration without rewriting it. This
includes Gemini settings with comments: repair/export strict JSON yourself
before using guided setup; manual configuration remains available below.
CLI registration uses `claude mcp add -s user`, `codex mcp add`, or
`gemini mcp add -s user`, not project-scope edits. Desktop uses the per-OS paths
below. The registered command uses the absolute `npx` found on your PATH.
For Desktop, setup also supplies Node/npm's directory in the server's `PATH`
when no existing server `PATH` is present, because a GUI may not inherit an
nvm shell's PATH. Moving/upgrading that Node installation can require setup
again; an existing server `PATH` is preserved, not overridden.

Verification starts the **read-back configured server subprocess**, performs MCP
`initialize` and `tools/list` with a 120-second timeout, and reports server
name/version and tool count. It does **not** prove that the AI client itself
connected. Restart/reopen Desktop or start a new CLI-client session afterward.
If verification fails, registration may already have succeeded: inspect the
result's `appliedChange`, fix the indicated prerequisites, and rerun.
The bounded two-minute window allows for a first npx launch downloading the
package and native DuckDB binaries. Setup explains that possibility before
verification starts.
The server's first npx launch may need network access to download TradeBlocks;
setup does not install clients, Node/npm, or change system settings.

For **Claude Code only**, the separate
[tradeblocks-skills plugin](https://github.com/tradeblocks-org/tradeblocks-skills)
is optional and is not installed by setup. Manual CSV import and core analysis
remain available without the plugin, OO, or market-data credentials.

### Option 1: npx (All Platforms)

Run directly without installation:

```bash
# stdio mode (Claude Desktop, Claude Code, Codex CLI, Gemini CLI)
npx tradeblocks-mcp ~/Trading/backtests

# HTTP mode (ChatGPT, Google AI Studio, Julius AI)
npx tradeblocks-mcp --http ~/Trading/backtests
```

For Claude Desktop, add the server to `claude_desktop_config.json` — see [Configuration by Platform](#configuration-by-platform) below for platform-specific setup.

### Option 2: From Source

```bash
git clone https://github.com/tradeblocks-org/tradeblocks
cd tradeblocks
npm install
npm run build -w packages/mcp-server

# Run the server
node packages/mcp-server/server/cli.js ~/Trading/backtests
```

## Quick Start

1. **Set up your data** - Create folders for each strategy with CSV files
2. **Connect your AI platform** - See [Configuration by Platform](#configuration-by-platform) below
3. **Start analyzing** - Ask your AI to "list my backtests" or "run a health check on iron-condor"

For detailed usage examples, see [../../docs/usage.md](../../docs/usage.md).

## Configuration by Platform

### Claude Desktop

| Platform | Config Location                                                   |
| -------- | ----------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux    | `~/.config/Claude/claude_desktop_config.json`                     |

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

| Mode  | Flag      | Use Case                      | Platforms                                          |
| ----- | --------- | ----------------------------- | -------------------------------------------------- |
| stdio | (default) | Local CLI tools               | Claude Desktop, Claude Code, Codex CLI, Gemini CLI |
| HTTP  | `--http`  | Web platforms, remote servers | ChatGPT, Google AI Studio, Julius AI               |

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

| Flag                  | Description                            | Default                     |
| --------------------- | -------------------------------------- | --------------------------- |
| `--http`              | Start HTTP server instead of stdio     | stdio                       |
| `--port <n>`          | HTTP server port                       | 3100                        |
| `--blocks-dir <path>` | Directory containing CSV block folders | same as data directory      |
| `--market-db <path>`  | Path to market.duckdb                  | `<directory>/market.duckdb` |
| `--no-auth`           | Disable authentication (HTTP mode)     | auth enabled                |

### Environment Variables

| Variable                 | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `BLOCKS_DIRECTORY`       | Default data directory if not specified as argument            |
| `TRADEBLOCKS_BLOCKS_DIR` | Directory for CSV block folders (overridden by `--blocks-dir`) |
| `MARKET_DB_PATH`         | Path to market.duckdb (overridden by `--market-db`)            |

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

For guided conversational workflows, install the agent skills from their standalone plugin,
[tradeblocks-skills](https://github.com/tradeblocks-org/tradeblocks-skills). In Claude Code:

```bash
/plugin marketplace add tradeblocks-org/tradeblocks-skills
/plugin install tradeblocks@tradeblocks-skills
```

The former `install-skills`, `check-skills`, and `uninstall-skills` commands now only print these
instructions.

Skills provide structured prompts for tasks like:

- Strategy health checks
- Walk-forward analysis interpretation
- Portfolio addition recommendations
- Correlation analysis

See the [tradeblocks-skills README](https://github.com/tradeblocks-org/tradeblocks-skills) for details.

## Prompts

The same MCP server exposes five prompts in stdio and HTTP. In Claude Code, when
the server is named `tradeblocks`, pick them from the `/` menu, where they appear
as `/tradeblocks:bring-in-oo-backtest (MCP)`, `/tradeblocks:is-this-optimum-real (MCP)`,
`/tradeblocks:stress-oo-portfolio (MCP)`, `/tradeblocks:live-vs-oo (MCP)` and
`/tradeblocks:allocate-oo-portfolio (MCP)`, or type
`/mcp__tradeblocks__bring-in-oo-backtest` (likewise for the others).
Other MCP clients can list and get these prompts through their prompt interface.
The server name is chosen by the user; these are not Option Omega tool prefixes.

Each prompt takes optional arguments, typed after the command in Claude Code in
this order, for example
`/mcp__tradeblocks__bring-in-oo-backtest <savedBacktestId> my-strategy`:
`bring-in-oo-backtest` and `stress-oo-portfolio` take `ooId` (an OO saved
backtest or portfolio ID, or a run's `runId`) and `block`; `is-this-optimum-real`
takes `optimizationId`; `live-vs-oo` takes `block`; `allocate-oo-portfolio`
takes `ooId` (saved portfolio ID or run ID) and `block`. Without arguments the
prompts work from the conversation.

| Prompt                  | Purpose                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bring-in-oo-backtest`  | Capture a backtest's trade log as a block, or import an OO-exported trade CSV.                                        |
| `is-this-optimum-real`  | Compare the optimizer's best cell with a stable-region candidate using scratch runs and TradeBlocks robustness tests. |
| `stress-oo-portfolio`   | Stress a portfolio's economic trades in an existing or imported block.                                                |
| `live-vs-oo`            | Compare live trades in a reporting log with an OO reference backtest's block.                                         |
| `allocate-oo-portfolio` | Check TradeBlocks allocation leads in OO shared-funds runs; never alter the saved source.                             |

TradeBlocks never calls Option Omega. With the `tradeblocks-skills` Claude Code
plugin installed, the import prompt uses `/tradeblocks:oo-capture`, and the
optimum prompt directs to `/tradeblocks:is-this-optimum-real`. That skill
captures each scratch run separately and combines verified trades under
distinct strategies in one trade-only comparison block for a paired
best-minus-centre test. This test covers jointly traded days, not the
optimizer's selection from the grid. Without the plugin,
`bring-in-oo-backtest` asks for OO's trade-log and daily-log CSVs and imports
both in one `import_csv` call with `dailyLogPath`, so the block carries OO's
marked daily curve; it says so when the daily log is missing. The optimum
prompt without the plugin has each run's trade-log CSV exported from OO and
imported into separate blocks: it runs tests against zero per block and states
that no paired difference ran. The CSV must
be readable by the TradeBlocks server; for Docker/HTTP, put it inside the
mounted server data directory. If unavailable, stop instead of rebuilding
CSV from model responses.

`allocate-oo-portfolio` and the read-only `stress-oo-portfolio` use
`/tradeblocks:oo-capture` for a saved portfolio only when the installed skill
describes saved-portfolio capture (older plugin versions do not); otherwise
they use an existing block, or import OO's portfolio trade-log CSV
with `import_csv` and optionally its whole-book daily log with `dailyLogPath`.
TradeBlocks' correlation, marginal, tail, what-if and health results are
trade-derived counterfactual proposals, never OO marked equity or OO headline
figures. The whole-book curve has no per-member marks. A candidate is OO-tested
only after `get_portfolio_status` reports complete and `get_portfolio_results`
is read; saving requires an explicit request and a new portfolio. OO's headline
and marked-equity figures remain OO's; TradeBlocks' realized trade statistics
do not replace marked-account drawdown.

`live-vs-oo` reads the reporting log from the OO reference block's own folder
(see below); put the CSV there instead of importing it as a separate block.

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
- P/L (Option Omega exports already include fees; `import_csv` defaults to
  `plBasis: "net_includes_fees"`. Use `"gross_before_fees"` only if fees still need deducting)
- Strategy (optional; the block ID is used when missing), Legs (or Symbol)
- No. of Contracts, Premium (optional; dollars per contract: `250` and `250.00` both mean $250)
- P/L % (optional; when numeric, report tools use Option Omega's value as the trade's `plPct`;
  otherwise `plPct` is P/L ÷ |Premium × No. of Contracts| × 100)

**dailylog.csv** - Daily portfolio values:

- Date
- Net Liquidity (or Portfolio Value, Value, Equity)
- P/L, Drawdown % (optional)

**Flexible Detection**: Files don't need standard names. The server detects CSV types by examining column headers (ISS-006).

## Available Tools

These tables show common tools; [MCP Tools Reference](../../docs/mcp-tools.md) lists every registered tool.

### Core Tools

| Tool                      | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `list_blocks`             | List all available blocks with summary stats          |
| `get_block_info`          | Detailed info for a specific block                    |
| `get_statistics`          | Performance metrics (Sharpe, Sortino, drawdown, etc.) |
| `get_strategy_comparison` | Compare strategies within a block                     |
| `compare_blocks`          | Compare statistics across multiple blocks             |

Trade-calendar dates in tool output are calendar days in `YYYY-MM-DD` form and name
the same day on every server timezone. That covers a trade's opened or closed day, a
daily-log day, and any range or window built from them, such as `dateRange`,
walk-forward windows, `peakExposure` dates, and `run_sql` DATE columns. Real instants,
such as `calculatedAt`, sync times, and market-feed timestamps, remain ISO timestamps.

### Analysis Tools

| Tool                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `run_walk_forward`       | Walk-forward analysis with configurable windows          |
| `run_monte_carlo`        | Monte Carlo simulation with worst-case scenarios         |
| `get_correlation_matrix` | Strategy correlation matrix (Kendall, Spearman, Pearson) |
| `get_tail_risk`          | Tail dependence and copula-based risk analysis           |
| `get_position_sizing`    | Kelly criterion position sizing                          |

### Performance Tools

| Tool                         | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `get_performance_charts`     | 16 chart types (equity, drawdown, distribution) |
| `get_period_returns`         | Returns aggregated by time period               |
| `compare_backtest_to_actual` | Backtest vs live performance comparison         |

### SQL Tools

| Tool                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `run_sql`           | Execute SQL queries against trades and market data   |
| `describe_database` | Schema discovery with table info and example queries |

### Market Data Tools

| Tool                         | Description                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `import_market_csv`          | Import market data CSV with column mapping                                          |
| `import_from_database`       | Import from external DuckDB databases                                               |
| `import_flat_file`           | Import a local Parquet or CSV flat file for a ticker/timespan                       |
| `fetch_bars`                 | Fetch daily or intraday OHLCV bars from configured provider                         |
| `fetch_quotes`               | Fetch option minute quotes from configured provider                                 |
| `fetch_chain`                | Fetch option chain snapshot for an underlying on a given date                       |
| `compute_vix_context`        | Compute cross-ticker VIX regime fields for a date range                             |
| `refresh_market_data`        | Composite daily refresh: fetch bars, auto-fire VIX context, return coverage report  |
| `enrich_market_data`         | Compute ~40 derived indicators from raw OHLCV                                       |
| `enrich_trades`              | Enrich trades with causal market/dataset values, provenance and custom fields       |
| `analyze_regime_performance` | Analyze P&L by presets or any registered field (numeric bins or categorical values) |
| `suggest_filters`            | Default market filters or optional fields with generic threshold/exclusion sweeps   |
| `calculate_orb`              | Opening range breakout analysis from intraday bars                                  |
| `import_daily_dataset`       | Import or replace a user Static Dataset with per-column timing                      |
| `list_daily_datasets`        | List user datasets, fields, timing and coverage                                     |
| `delete_daily_dataset`       | Remove a dataset and its registered fields                                          |
| `list_analysis_fields`       | Discover built-in and dataset fields at runtime                                     |

Since 4.1.0, user daily datasets use `<dataset>.<column>` field names in profile filters,
predictive reports, regime analysis and threshold sweeps. `import_daily_dataset` takes
`name`, exactly one of inline `content` or `csvPath` under the server's data root, and optional
`ticker`, `columnTiming` and `knownBy` (`HH:mm` ET). Re-import replaces the named dataset
atomically, without changing market data or requiring provider credentials. Date-only close
values are available the following calendar day at 00:00 ET; date-only open values require
`knownBy`; timestamped rows are as-of. Sparse columns carry forward their latest available
observation with no freshness cutoff by default. See the [dataset tools reference](../../docs/mcp-tools.md#market-analysis)
and [4.1.0 behavior changes](../../releases/v4.1.0.md#behavior-changes).

With Docker's default `-v ./data:/data` mount, put the CSV at
`./data/datasets/vrp.csv` on the host and pass `csvPath: "datasets/vrp.csv"` or
`"/data/datasets/vrp.csv"`; use the container path beneath the configured data root.
Close-column metadata shows `knownBy: null`; open columns retain the configured value.
Field-based `suggest_filters` retains all-trade `currentStats` and reports per-field
`fieldBaselines` (`count`, `totalPl`, `uncoveredCount`, `uncoveredTotalPl`).
Suggestions compare against those covered populations; `filter_curve.baseline`
reports the same covered and uncovered counts and P&L.

New in 4.4.0: [filter statistics](../../releases/v4.4.0.md) for asking whether a
chosen filter survives a full threshold search, with explicit assumptions and work caps.

`find_predictive_fields.method` selects `pearson` (default), `spearman`, or `kendall`
(tau-b with ties). Explicit requests name their method; omission preserves the Pearson
response. Ranking uses the chosen coefficient on the same causal entry-time values,
including `maxMissedSessions` refusals.
Kendall admits up to 75 million estimated pairs across fields, using each field's
valid field/target coverage after strategy/date filtering. It refuses by name
(`kendall_pair_work_limit`) before quadratic calculations. A 1,100-trade block with
100 fully covered fields passes (60,445,000 pairs); a 20,000-trade field is refused.
Pearson and Spearman retain their existing behavior.

`filter_curve` accepts either the existing `field` or up to 10 distinct `fields`.
Multi-field calls, an explicit `objective` (`totalPl` or `winRate`), or opt-in
`permutation: { iterations: 499, block: "month", seed: 42 }` add the best threshold
and per-year kept/removed stability. Permutation shuffles whole calendar-month outcome
blocks and reruns the complete threshold sweep, not just the selected threshold.
It reports add-one raw p-values and Holm-adjusted p-values across requested fields.
Single-field calls without these options retain their old outputs.
At least 30 covered trades and 8 observed months are required; refusals are named.
Iterations are capped at 499. Only permutation requests limit threshold and percentile
arrays to 100 entries, with a named `permutation_candidate_limit` refusal.
Without permutation, larger arrays retain their previous schema acceptance.
Sort-aware work admission caps permutation at 30 million units per field and
90 million per request, refusing the whole request before any sweeps. At 1,100 trades,
55 months, 499 iterations and default thresholds, the largest admitted family is
3 fully covered fields (87,751,152 estimated units); 4 fields exceed the cap.
Field, objective and mode choices across separate requests are outside the Holm family.
Monthly blocks retain within-month dependence, not cross-month dependence; block
exchangeability is an assumption. See [the full contract](../../docs/mcp-tools.md#filter-curve-significance-and-stability).

In 4.5.0, `unit: "day"` aggregates entry-date P&L before scoring and month
permutation; win rate counts profitable days. A field varying within a day is
refused as `day_field_varies`, with the varying dates. Cheap request/work admission
precedes causal field resolution and counts the chosen unit conservatively before
coverage. Omitted `unit` retains trade-mode outputs.
Day mode also offers `sharpe` (daily dollar P&L, rf=0, sample std, √252),
`mar` (calendar-day CAGR / drawdown fraction of observed starting capital), and
`maxDrawdown` (dollar drawdown reduction; smaller is better). Filtered dates are
flat. Trade units refuse these objectives; MAR additionally refuses missing capital.
`objectiveMetadata` documents definitions and undefined cases. This dollar-P&L
Sharpe intentionally differs from the capital-based portfolio return Sharpe.
`groupBy: "regime.label"` adds chosen-threshold `perGroup` rows in either unit,
with the same covered baseline/kept/removed shape as `perYear`. Numeric groups use
`bins` or shared regime-analysis quartiles; categorical groups use values.
Missing values form an explicit uncovered group, small groups stay flagged,
and within-day varying groups refuse as `day_group_varies`. Group values honor
the same causal availability and optional freshness limit.

`suggest_filters` defaults to `objective: "totalPl"`: only positive P&L improvements,
ranked by P&L improvement with win-rate gain as tie-breaker. `objective: "winRate"`
admits/ranks by win-rate gain with P&L tie-breaks. `minImprovementPct` (default 3
percentage points) applies only to `winRate`; it is ignored under `totalPl` and the
response notes this when supplied. Standalone and composite suggestions include
`tradesKept`, `keptFraction`, `tradesRemoved`, and `objective`. `confidence` means
sample-size support, not statistical confidence; keeping less than 20% caps it at
low and adds a low-retention warning. Composite metrics describe kept trades.

In 4.3.0, `minImprovementThreshold` is null under `totalPl` and numeric under
`winRate`. Shared support thresholds are high at 20 kept/10 removed, medium at
10 kept/5 removed, otherwise low, subject to the retention cap. This replaces
the fields path's former kept-only 100/30 thresholds. Composites use the selected
objective without the old >2-point standalone-relative gate. Their `improvement`
still means kept win-rate gain over the better standalone on the same covered
pool, not P&L or baseline-relative gain. See the [4.3.0 behavior changes](../../releases/v4.3.0.md#behavior-changes).

Dataset consumers accept optional `maxMissedSessions` (a nonnegative integer).
`datasetAge` preserves calendar-day ages and adds missed expected XNYS session ages:
close columns expect the prior session; open columns expect today's session only
at/after known-by ET (timestamped open rows without known-by use midnight for this
daily-session diagnostic, not for as-of matching). Friday close → Monday is 0 missed;
a missing Friday is 1, and holidays do not count. The calendar covers 2022–2030;
outside it, age is explicitly `unsupported`. With a limit set, stale/unsupported
values are refused and count as uncovered in field baselines. Without it, matching
is unchanged. `datasetWarnings` names stale/unsupported/refused counts;
`enrich_trades` includes session age in provenance and names `datasetRejections`.
Session summaries include refused candidates; calendar-day summaries count accepted
attachments only, returning null ages when none were accepted.

### Strategy Profile Tools

| Tool                      | Description                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `profile_strategy`        | Create or update a strategy profile with structured metadata |
| `get_strategy_profile`    | Retrieve a stored strategy profile                           |
| `list_profiles`           | List all strategy profiles (optionally filtered by block)    |
| `delete_profile`          | Delete a strategy profile                                    |
| `analyze_structure_fit`   | Analyze strategy performance by regime/condition dimensions  |
| `validate_entry_filters`  | Test each entry filter's contribution to edge                |
| `portfolio_structure_map` | Regime x structure coverage matrix across strategies         |

`validate_entry_filters` names unknown market fields with reasons in
`unresolvable_filters`, warnings, and its summary; they are excluded from ablation
so known filters remain analyzable. If all market filters are unknown, it returns
`error: "no_resolvable_filters"`. `analyze_structure_fit` reports the same exclusions
and keeps its remaining dimensions. Known fields with missing daily values retain
their existing missing-data treatment.

### Import Tools

| Tool         | Description                                              |
| ------------ | -------------------------------------------------------- |
| `import_csv` | Import a CSV file as a block from a server-readable path |

`import_csv` accepts `csvPath`, `blockName`, optional `csvType` (default `tradelog`),
optional `dailyLogPath` for a paired daily log, and `plBasis` (default
`net_includes_fees` for Option Omega exports; `gross_before_fees` when fee columns
still need deducting). Both paths must be readable by the server: local for stdio,
or inside its mounted data directory for Docker/HTTP. Paths can be absolute, use
`~`, or use filename-only search via `searchPaths` (default: Downloads, Desktop, Documents).
The pair creates one block with a stamped `tradelog.csv` and verbatim `dailylog.csv`.
A bad daily log rejects the whole import without creating a block. The usual
result fields describe the primary CSV; its `dateRange` holds the first and last
calendar dates (`YYYY-MM-DD`).
Paired results also include `dailyLog.recordCount` and `dailyLog.dateRange`
in the same calendar-date form. Unfiltered `get_statistics` uses daily-log drawdown;
strategy-filtered statistics use the trade log instead.

Before writing a block, `import_csv` refuses an invalid opened/closed trade or reporting
calendar date, missing or unparseable P/L, or missing/unparseable daily-log value. For
gross-before-fees trade imports, both commission values are also required. Errors
identify the CSV file line including the header; a rejected pair leaves no block.
Daily-log aliases load as net liquidity in imported and folder-discovered blocks;
folder loading drops a row with a missing/unparseable value rather than using zero.
`recordCount` counts loaded rows, and a missing Strategy in a trade log uses the
block ID in the receipt and in subsequent tools.

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run tests
npm test
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
- [Agent Skills](https://github.com/tradeblocks-org/tradeblocks-skills) - Conversational workflows for guided analysis
- [Market Data Guide](../../docs/market-data.md) - Import workflow, Massive API, and column mapping reference
- [Main Application](../../README.md) - Web-based UI for TradeBlocks
