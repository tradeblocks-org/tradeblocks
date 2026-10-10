# TradeBlocks Developer Guide

This document explains how TradeBlocks is structured and how to work effectively inside the codebase. Pair it with the top-level `README.md` for quick-start instructions.

## Environment & Tooling

- **Runtime:** Node.js 24 (see `.node-version`).
- **Package manager:** npm (lockfile committed). Husky installs git hooks via `npm install`.
- **Type system:** TypeScript with `strict` mode.
- **Linting:** ESLint 10 + Next.js rules (`npm run lint`).
- **Formatting:** Prettier (`npm run format` to write, `npm run format:check` to verify).
- **Testing:** Jest 30 with `ts-jest` and `fake-indexeddb` to emulate browser storage.

Upgrade `react`, `react-dom`, `@types/react` and `@types/react-dom` together, and update the
React type `overrides` in `package.json` with them. React requires `react` and `react-dom` at the
exact same version.

The flat lint configuration registers only the Next.js, React Hooks and
TypeScript rule modules it uses. No `react/*` rules are enabled; do not import
the unused `eslint-plugin-react` module (its peer range does not support ESLint 10).

### First-Time Setup

1. `npm install`
2. `npm run dev`
3. Visit `http://localhost:3000` → you will be redirected to `/blocks`.
4. Create your first block and upload a trade CSV (sample: `IC_Trades.csv`).

> Resetting locally stored data: open your browser dev tools → **Application** tab → clear IndexedDB storage and `localStorage` key `tradeblocks-active-block-id`.

## Application Architecture

### High-Level Flow

1. **Block creation** – Users import CSV files through `/blocks` using `BlockDialog`.
2. **Parsing** – Files are parsed via `packages/lib/processing/csv-parser.ts`, converted into domain models in `packages/lib/models/*`.
3. **Storage** – Raw rows live in IndexedDB (`packages/lib/db/`). Metadata (names, timestamps, counts) persists alongside references to stored records.
4. **State management** – Zustand stores (`packages/lib/stores/`) expose application state to React components. Active block selection is cached in `localStorage` for reload persistence.
5. **Calculations** – Portfolio statistics, drawdowns, and Monte Carlo inputs are computed inside `packages/lib/calculations/*`, primarily `portfolio-stats.ts`.
6. **Presentation** – App Router routes under `app/(platform)/` render dashboard experiences powered by the stores and calculations.

### Routing & Layout

- `app/page.tsx` redirects to `/blocks`.
- `app/(platform)/layout.tsx` wires the persistent sidebar (`components/app-sidebar.tsx`) and header.
- Primary screens:
  - `/blocks` – block CRUD + activation (see `app/(platform)/blocks/page.tsx`).
  - `/block-stats` – overview cards and summary metrics.
  - `/performance-blocks` – strategy filters, equity curve charts, and performance tables.
  - `/position-sizing` – Kelly calculations and sizing guidance.
  - `/risk-simulator` – Monte Carlo simulator (see audit in `RISK_SIMULATOR_AUDIT.md`).
  - `/correlation-matrix` – cross-strategy correlation heatmap with configurable method, alignment (shared days vs zero-fill), return normalization (raw, margin, notional), and date basis (opened vs closed trades).

### State & Persistence

- **Zustand stores**
  - `packages/lib/stores/block-store.ts` – block metadata, activation, CRUD, recalculation.
  - `packages/lib/stores/performance-store.ts` – derived performance datasets and caching.
  - Additional feature-specific stores live alongside their modules.
- **IndexedDB adapters**
  - `packages/lib/db/index.ts` centralizes database initialization.
  - `packages/lib/db/trade-store.ts`, `packages/lib/db/daily-log-store.ts`, etc. manage raw data collections.
- **Data references** – `ProcessedBlock` keeps keys to related data for lazy retrieval (`packages/lib/models/block.ts`). When you fetch a block, load trades/daily logs explicitly via the store helpers.

### Calculations & Utilities

- `packages/lib/calculations/portfolio-stats.ts` – Computes win rates, drawdowns, expectancy, and normalized metrics. Sharpe uses sample standard deviation (N-1), annualizes daily excess returns by 252, and defaults to historical FRED DTB3 rates. `AnalysisConfig.riskFreeRateAnnualPct` can supply a fixed annual percentage instead.
- `packages/lib/calculations/risk/` – Monte Carlo simulation helpers powering the risk simulator.
- `packages/lib/processing/trade-processor.ts` & `daily-log-processor.ts` – Convert raw CSV strings into typed models, handling alias headers and data validation (`packages/lib/models/validators.ts`).
- `packages/lib/utils/date.ts`, `packages/lib/utils/number.ts` – Reusable formatting helpers.

#### Realized trade calculations

`@tradeblocks/lib` exports the realized-trade calculations in
`packages/lib/calculations/realized-performance.ts`. The public names ending in
`ByCloseDate` group by `dateClosed` (falling back to `dateOpened` for unclosed
rows), unlike the opening-date cohorts of `segmentByPeriod`. The MCP performance
charts and period-returns tool use these same functions. The monthly dollar
matrix fills all months in represented years with zero; the monthly percentage
matrix compounds closed P/L against reconstructed starting capital (and uses
$100,000 if that capital cannot be derived). Neither is a marked account return.
`buildRealizedPeriodReturnsByCloseDate(trades, period)` returns sorted daily,
weekly or monthly buckets and totals, with reported, gross, commissions and
basis-aware net P/L kept separate. The weekly key retains the calendar year
of the close date and its ISO week number. The drawdown-attribution export uses
reported trade P/L, whereas the realized equity curve uses fee-aware net P/L;
these existing views should not be conflated with marked-account drawdown.

The same public entrypoint exports `STRESS_SCENARIOS` and
`buildRealizedStressScenarios`, which scores the supplied historical or custom
intervals from trades closed within each interval (with opening-date fallback).
`buildRealizedStrategySimilarity` combines the existing correlation and tail
calculations with **entry-day** overlap; its pairs are trade-based, not
simultaneous marked-account losses. Neither result models intratrade exposure
or market prices.

#### Dated account-equity and field calculations

`@tradeblocks/lib` exports `drawdownEpisodesFromEquity`,
`drawdownDurationFromEquity`, and `calendarReturnsFromEquity` for an ordered
daily `{ date: "YYYY-MM-DD", equity: number }[]` account series. Dates are
Eastern calendar keys, not UTC instants; inputs require positive finite equity.
Drawdown durations count underwater observations (not elapsed calendar days),
and the recovery observation is excluded. Calendar returns use the prior
period's closing equity as the next period's starting balance; the first
partial period starts at its first observation. These marked-account measures
must not be confused with realized-trade performance.

`fieldStatisticsFromValues` and `rankPredictiveTradeFields` provide the
numeric field-distribution and single-trade-tape correlation calculations used
by the MCP field tools. The latter accepts enriched trades (including optional
custom fields); missing/non-numeric values are excluded pairwise.
`singleTapeWalkForwardByTrades` runs sizing and strategy-weight parameter
sweeps using `WalkForwardAnalyzer` over one realized trade tape. It is not a
marked-account or multi-tape portfolio simulation.

The lib's walk-forward period endpoints are calendar-day keys, and the MCP
response reports them unchanged as `YYYY-MM-DD`. Runtime timestamps elsewhere
in the computation remain instants.

#### Offline book replay and drawdown-budget search

`@tradeblocks/lib` exports `replayBook(BookReplayInput)` and
`searchBookAtDrawdown(DrawdownBudgetSearchInput)`. Both are pure calculations:
they make no provider calls, read no profiles and add no market-data requirement.
The replay accepts net dollars and buying power **per strategy contract**, an
explicit session axis, member sizing rules and simultaneous member ordering.
It sizes whole contracts from closed funds at each entry, closes before opens at
an identical timestamp, and admits margin-respected groups by clipping quantity
to available buying power. Allocation, fixed count and capital-per-contract
sizing are distinct declarations; active capital-per-contract sizing requires
`ignoreMarginRequirements: false` but bypasses buying-power admission by its
sizing semantics. It still reserves buying power for later ordinary entries.
Normalize a capped ignore-margin fill to an explicit fixed-count rule; zero
allocation is not a substitute for removal.

All member declarations are required: `sizing`, `removed`,
`ignoreMarginRequirements`, `maxContractsPerTrade`, `maxAllocationAmount`,
`minimumOne`, and `maxOpenTrades`. Null caps are uncapped; null concurrency means
the rule is unavailable, not inferred. Minimum-one raises the requested quantity
before hard caps and admission, so it cannot override those limits or insolvency.
`reservationMode` selects one reservation retained until the last child closes
(`sharedEntryGroup`) or summed child reservations released separately
(`sumChildren`). `sharedEntryGroupBuyingPower: "equalPackageMaximum"` declares
verified equal-package buying power; shared groups with unequal child buying
power are refused. Supply unambiguous `entryGroupId`s within each member and
`simultaneousOrder` containing every member exactly once. Times are zero-padded
`HH:mm:ss` with optional fractional seconds; dates are market-calendar keys,
not timestamps. Every in-window entry and close must lie on the supplied axis.
An endpoint close beyond that axis remains open; no terminal mark is invented.

The result's `basis` is `offline_closed_equity`. `startingEquity` is the seed,
and `equity` contains one after-events closed-funds observation per session.
Drawdown episodes reuse the dated-equity calculator, including the starting
seed. Intraday nonpositive funds make the whole replay insolvent even if it
recovers before the daily observation: drawdown is then null and search refuses
to rank that path. Member summaries count entry groups and one quantity per
group, not one independently sized position per child. The census separates
ignored input rows, simulated-zero groups, executed child closes and endpoint
open positions. Ignored rows affect neither opportunities nor realized P/L.
`liquidityThresholdContracts` is an explicit count warning, not a fill-quality
estimate. Net per-contract P/L already includes fees, which are never deducted
again.

Optional `marks` is `{ mode: "child", values: [{ tradeId, date,
netOpenPlPerContract }] }` or `{ mode: "entryGroup", values: [{ memberId,
entryGroupId, date, netOpenPlPerContract }] }`. These are cumulative **net open**
P/L dollars per strategy contract, not incremental daily returns. A group mark
is the aggregate of its remaining children, applied once. Every admitted open
position needs a finite mark on every observed session; a gap throws a named
`missing_mark_coverage` error, never a zero or a carried-forward fill. Duplicate
keys and unknown identities are refused. `marked` adds a separate result with
`basis: "offline_marked_equity"`: closed funds plus quantity times each supplied
open mark, drawdown from the existing calculator, and explicit marked insolvency.
Sizing and realized return still use closed funds. Without marks, no marked
result is returned and replay behavior is unchanged. Ignored rows remain fully
excluded, including their open marks; callers whose producer marks ignored open
positions must disclose that discrepancy. Marks do not supply missing
opportunities or verify producer parity.

Search maximizes ending realized `returnPct` subject to drawdown at most
`targetDrawdownPct - calibrationMarginPct`: it uses the marked drawdown when
complete marks are supplied, otherwise the closed-equity drawdown, and reports
that risk basis. A nonpositive marked path is never ranked.
Declare bounds, initial vectors, descending or other finite `steps`, weight and
allocation decimal precision, and `maxEvaluations`. A zero weight means true
removal. Positive weights scale allocation, fixed counts, dollar caps and
whole-number contract caps; positive quantities rounding to zero are reported
separately. CPC division requires `weightScaling: "capitalPerContractInverse"`;
`"allocationAndContracts"` refuses CPC inputs. Each optimization records unique
normalized economic evaluations, `k`, budget/step termination, the best-observed
feasible vector and the near-optimal set and weight ranges. Ties retain the
first deterministic evaluation. The robust vector is the highest-return
evaluated feasible vector also meeting `robust.maxDrawdownPct`, including the
declared shrinkage grid; its return cost is in percentage points. No feasible
candidate, no robust candidate and unusable calibration produce named refusals,
never a least-bad winner. This bounded coordinate search does **not** certify a
global optimum.

`dropOne` reoptimizes with each member constrained to removal, with the same
per-optimization budget. Stability uses the existing seeded stationary-block
resampler on joint session indices. It transplants entry-day cohorts, preserving
intraday times and each child's source-session close offset, and extends an
artificial ordinal session axis until carried positions close. It does **not**
reconstruct source market paths, authentic holding-aware block boundaries,
unobserved attempted entries or open-position marks. Missing child-close offsets
make stability explicitly unavailable. Bootstrap and sensitivity panels report
every replicate's search, carried-row count, feasible-winner fraction,
member retention/top-region fractions and observed min/max weight intervals
(not confidence intervals). The top region begins at
`min + (max - min) * stability.topRegionFraction`; zero is never retained.
`totalEvaluations` includes the main search, drop-one searches and bootstrap
searches, while each nested `k` has its own declared budget.
Supplied marks are transplanted with the same entry-relative source-session
offsets. The transformed marks retain the source economics; this is not a
simulation of a different underlying market path.

Closed-equity screening cannot certify a marked drawdown budget. Supply a
separately assessed calibration margin and `calibrationUsable`; false returns
`calibration_unusable` with no winner or evaluations. A collection of executed
tapes is not a census of attempted opportunities: pooled alternative entries
can be mutually incompatible. Neither search nor resampling can resolve missing
eligibility rules. Validate shortlisted mixes independently before relying on
their economics or risk.

### UI Components

- `components/ui/` – shadcn/ui primitives configured with Tailwind CSS.
- `components/performance-charts/` – Plotly components (via react-plotly.js) for equity curves and strategy comparisons.
- `components/block-dialog.tsx`, `components/sidebar-active-blocks.tsx`, etc. orchestrate import flows and navigation.

Lucide v1 provides interface icons, not brand icons. Use the existing
`@tabler/icons-react` dependency for brand marks such as the footer's GitHub icon.

Plotly v4 and react-plotly.js provide bundled types; chart traces use `Data`
directly. Chart Studio's `showLink` was removed with the feature and has no
replacement. Overlay axes explicitly keep `tickmode: "auto"`. Every Plotly
render uses `components/plotly-config.ts`, directly or through ChartWrapper,
to keep a 300 ms double-click delay and hide the v4 default cloud-upload button.
Charts and trading data remain local.

## CSV Schema Reference

### Trade Logs

- The web importer requires the full Option Omega header set in `REQUIRED_TRADE_COLUMNS`
  (`packages/lib/models/trade.ts`). MCP `import_csv` requires only `Date Opened` and `P/L`
  (`packages/mcp-server/src/utils/block-loader.ts`). Key columns:
  - `Date Opened`, `Time Opened`, `Legs`, `P/L`, `Strategy`
  - Option Omega `P/L` already includes commission and fees. The web importer stamps
    `plBasis: "net_includes_fees"`; MCP `import_csv` takes a `plBasis` input that defaults to
    `net_includes_fees`; use `gross_before_fees` only when P/L has not yet deducted fees.
  - `Opening Commissions + Fees`, `Closing Commissions + Fees` (MCP `import_csv` requires both
    with `gross_before_fees`)
  - `Premium` is dollars per contract (one lot): `250` and `250.00` both mean $250.
  - `P/L %` is optional in both importers. A numeric cell becomes `Trade.plPct` (a percent: `97.9`
    means 97.9%), and enrichment uses it as the trade's `plPct`/`premiumEfficiency` instead of
    recomputing. A missing column or a blank or unparseable cell leaves `plPct` computed as
    `pl / |premium × numContracts| × 100`. `netPlPct` is always computed.
  - Ratio columns such as `Opening Short/Long Ratio` are optional but supported.
- Aliases in `TRADE_COLUMN_ALIASES` normalize variants (e.g., `Opening comms & fees`).

### Daily Logs (optional)

- The web importer requires `REQUIRED_DAILY_LOG_COLUMNS` (`packages/lib/models/daily-log.ts`):
  `Date`, `Net Liquidity`, `Current Funds`, `Trading Funds`, `P/L`, `P/L %`, `Drawdown %`.
- MCP `import_csv` requires only `Date` and a numeric `Net Liquidity` for a paired daily log
  (`packages/mcp-server/src/utils/block-loader.ts`); the other columns are optional. The MCP
  server also reads `Portfolio Value`, `Value` or `Equity` as net liquidity; the web importer
  does not.
- When absent, drawdown calculations fall back to trade-based equity curves.

## Testing

- Global Jest setup lives in `tests/setup.ts` (auto-configured via `jest.config.js`).
- `fake-indexeddb` simulates browser storage for stores/calculations.
- Focused suites:
  - `tests/unit/` – pure functions (parsers, calculators, utils).
  - `tests/integration/` – multi-module flows (e.g., block ingestion to stats).
  - `tests/data/` – fixture CSV rows.
- Useful scripts:
  - `npm test -- path/to/file.test.ts`
  - `npm test -- path/to/file.test.ts -t "test case name"`
- Coverage reports output to `coverage/` via `npm run test:coverage`.

The root Jest suite (`npm test`) covers `@tradeblocks/lib` and the frontend; run
the MCP suite separately with `npm run test:mcp` after `npm run build:mcp`.
Public CI runs both suites, with the root suite in the required `Frontend
(Next.js)` check. The release workflow runs both before publishing; Docker
tags are pushed only after the version's npm package is published, not on
every source push.

## Development Tips

- Use the `.planning/` directory for task breakdowns if you want structured TODOs (optional).
- Tailwind CSS configuration lives in `tailwind.config.ts` produced via `@tailwindcss/postcss` (Tailwind v4). Check `app/globals.css` for design tokens.
- Components expect the `@/*` alias (configured in `tsconfig.json`)—prefer it over relative paths.
- When debugging IndexedDB, the store names mirror file names (e.g., `tradeblocks-trades`); inspect them via browser dev tools.
- `npm run build` uses Turbopack; large third-party imports (Plotly) can impact bundle size, so keep an eye on analytics when adding dependencies.

## Useful Links

- [Next.js App Router Docs](https://nextjs.org/docs) – base framework.
- [Zustand](https://docs.pmnd.rs/zustand/getting-started/introduction) – state management used across stores.
- [Math.js](https://mathjs.org/docs/reference/functions.html) – statistics helpers used for parity with the Python implementation.

For questions or larger architectural changes, start with an architecture sketch in `plans/` or open a discussion referencing the relevant modules above.

## AI-Assisted Development

The root `AGENTS.md` gives AI coding assistants a concise repository orientation, and `CLAUDE.md`
imports it with the single line `@AGENTS.md`. Both are generated from `docs/ai-assistant-entry.md`;
after changing the source, run `node scripts/generate-agent-entry-files.mjs` and commit both files.

Keep durable implementation guidance in `docs/` and link to it from the entry source instead of
duplicating it there.

### MCP Server Integration

Claude Code can interact with TradeBlocks data via the MCP server:

```bash
# Add MCP server to Claude Code
claude mcp add tradeblocks -- npx tradeblocks-mcp ~/Trading/backtests
```

This enables analysis queries directly in the development workflow.

## Monorepo Structure

TradeBlocks uses npm workspaces to manage multiple packages:

```
tradeblocks/
├── package.json           # Root package with workspaces config
├── app/                   # Next.js web application (root)
├── components/
├── tests/
└── packages/
    ├── lib/               # Core business logic (@tradeblocks/lib)
    └── mcp-server/        # MCP server (npm: tradeblocks-mcp)
```

### Import Patterns

```typescript
// Library imports use the workspace package
import { Trade, PortfolioStatsCalculator } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";

// Component imports use root-relative paths
import { Button } from "@/components/ui/button";
```

### Running Workspace Commands

```bash
# Build the MCP server
npm run build -w packages/mcp-server

# Run MCP server tests
npm test -w packages/mcp-server

# Run all root-level tests
npm test
```

### Development Workflow

1. **Web app development**: Work from the repository root with `npm run dev`
2. **MCP server development**: Changes in `packages/mcp-server/src/` require rebuild with `npm run build -w packages/mcp-server`
3. **Agent skills**: Maintained in the standalone [tradeblocks-skills](https://github.com/tradeblocks-org/tradeblocks-skills) plugin, not in this repository

For MCP server development details, see [packages/mcp-server/README.md](../packages/mcp-server/README.md).

## Implementation Conventions

### Testing Requirements

Every new utility module containing pure logic needs unit tests. This includes parsers, filters,
builders, calculations, transformers, validators, and other exported input-to-output functions.
Place tests with the matching test area (`tests/unit/` for shared library code and
`packages/mcp-server/tests/unit/` for server utilities). If a server utility must be imported from
the compiled package in tests, expose it through `packages/mcp-server/src/test-exports.ts`.

Test empty input, single-record input, and missing optional data where applicable. Run
`npm run typecheck` before the final commit. It checks the app, `packages/lib` and
`packages/mcp-server`, and the required `Frontend (Next.js)` check runs it. `npm run verify` also
runs lint and formatting checks.

### UI and State Patterns

- Performance charts use Plotly through `react-plotly.js`, not Recharts. Build typed traces in
  `useMemo()` and render them with `components/performance-charts/chart-wrapper.tsx` for consistent
  styling, theming, tooltips, and configuration.
- Number inputs that users can clear and retype use separate string display state and validated
  numeric state. Validate on blur or Enter and restore the last valid value after invalid input.
- Zustand stores coordinate UI state and cached derived data. IndexedDB store modules own durable
  browser records; load referenced records explicitly when using a block.

### Published risk-free rates

DTB3 and SOFR are public, key-free FRED observations. The daily
`publish-rates.yml` job fetches both full series, validates their chronological
numeric histories against the prior publication and bundled observations, and
commits only `rates.json` to the unprotected `rates-data` branch. It does not
open a PR or write to `master`. Browser performance statistics and the MCP
server load that file by default, validate it before use, cache the last valid
copy (IndexedDB or local market metadata), and fall back to their bundled rates
when offline. Browser users can disable published rates in Performance Metrics;
the displayed effective date identifies the active rates. CSV import needs no
provider key and works without the endpoint. The library's bundled rates remain
available without network access.

Run `node scripts/rates.mjs check --json` to inspect publication against FRED
(`current`, `behind`, or `unknown`); `--rates-url URL` overrides the published
endpoint for local proof. An HTTP or parsing failure is `unknown` (exit 2), not
`current`. To prepare a reviewed release, run `node scripts/rates.mjs seed` to
update both bundled tables from the published file. Release workflows run
`node scripts/rates.mjs seed-check --max-lag-days 10` against that publication,
not against a live FRED check. Run the rate and market resolver tests after
seeding. See [Market Data](market-data.md) for the published file contract.
