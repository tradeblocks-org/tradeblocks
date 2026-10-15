# MCP Tools Reference

TradeBlocks MCP server tools organized by category.

Every tool refuses an argument it does not declare. The call returns an error, for example
`Input validation error: Invalid arguments for tool import_csv: Unrecognized key: "ooCurvePath"`,
and the tool does not run. Each tool's `tools/list` input schema sets `additionalProperties: false`.
A client that sends an option this server version does not support therefore sees the mismatch
instead of a success with the option ignored. Only top-level arguments are checked this way;
a nested value keeps its own rules, such as the free-form `keyMetrics` of `profile_strategy`.
Prompts refuse an undeclared argument in the same way.

## Block Management

| Tool                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `list_blocks`             | List all portfolio blocks with summary statistics               |
| `get_block_info`          | Detailed info for a specific block                              |
| `get_statistics`          | Portfolio performance metrics (Sharpe, Sortino, drawdown, etc.) |
| `run_sql`                 | Query individual trades in `trades.trade_data`                  |
| `get_strategy_comparison` | Compare strategies within a single block                        |
| `compare_blocks`          | Side-by-side comparison across multiple blocks                  |
| `block_diff`              | Diff statistics between two blocks                              |

Trade-calendar dates in tool output are calendar days in `YYYY-MM-DD` form and name
the same day on every server timezone. That covers a trade's opened or closed day, a
daily-log day, and any range or window built from them, such as `dateRange`,
walk-forward windows, `peakExposure` dates, and `run_sql` DATE columns. Real instants,
such as `calculatedAt`, sync times, and market-feed timestamps, remain ISO timestamps.

## Performance Analysis

| Tool                         | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `get_performance_charts`     | Chart data: equity curve, drawdown, monthly returns (16+ types) |
| `get_period_returns`         | Returns aggregated by period (daily, weekly, monthly)           |
| `compare_backtest_to_actual` | Backtest vs live trade comparison with slippage analysis        |

## Trade Replay

| Tool           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay_trade` | Replay trades with minute-level P&L path, MFE/MAE, and per-leg greeks. Reads option-leg quotes via QuoteStore and underlying bars via SpotStore (cache only); backfill missing data explicitly with the data-pipeline tools. Quote sanity: opening-rotation quotes (before 09:32 ET) and quotes with a zero or missing bid or ask are dropped and the previous mark is carried forward; the path starts at the trade's entry time (`time_opened`, or `open_time` in hypothetical mode). Three output formats: `full`, `sampled` (default), `summary`. |

For `replay_trade`'s computed model and units, see the
[computed option-Greeks method](market-data.md#computed-option-greeks-method).
Replay calculations are not themselves a stored quote's revision/provenance.

The separate offline `@tradeblocks/lib` calculation `replayBook` now accepts an
optional per-member `sizingSchedule` (see
[offline book replay](development.md#offline-book-replay-and-drawdown-budget-search)).
Each active effective-date entry supplies complete sizing and caps; selection
uses the entry date inclusively, with the base declaration before the first date.
`{ effectiveDate, disabled: true }` blocks new entries; sizing/caps are optional
and ignored while disabled. A later active entry reinstates its complete sizing.
Held positions keep their quantities and reservations and close normally, with
no forced exit. Disabled groups have additive `disabledGroups` counters rather
than being folded into `zeroGroups`. Concurrency and marked attribution stay
per real member in one continuous ledger. This is not an
argument to `replay_trade` or any MCP tool; their interfaces are unchanged.

## Exit Trigger Analysis

| Tool                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze_exit_triggers` | Evaluate 14 trigger types against a trade's replay path. Shows first-to-fire trigger with P&L comparison against actual exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `decompose_greeks`      | Decompose P&L into delta, gamma, theta, vega, charm, vanna, and residual by full revaluation along an ordered path (time, then vol, then spot): the vol move is priced at the step's new time to expiry, so on short-dated legs crossing a night or weekend the vega decay stays in vega instead of cancelling against the residual, and the residual is model error only. Automatic numerical fallback when the model-based residual exceeds 80% of the gross attribution flow (the sum of absolute factor totals, residual included) — measured against gross flow rather than net P&L so a legitimate multi-day step on a hedged position does not trip the fallback. Per-leg-group vega attribution for calendar strategies. |
| `batch_exit_analysis`   | Screen exit policies on a sample of up to 200 trades using cached quotes. Returns aggregate statistics with per-trigger attribution; trades with missing data are skipped. Confirm a surviving exit policy in a native Option Omega backtest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

All exit tools read cached option-leg quotes via QuoteStore and underlying bars via SpotStore only — no provider subscription is required if data is pre-loaded. Missing data must be backfilled explicitly with the data-pipeline tools.

`decompose_greeks` uses the pricing models and volatility units described in the
[computed option-Greeks method](market-data.md#computed-option-greeks-method);
its attribution is distinct from cached quote-Greek provenance.

## Greek Attribution

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get_greeks_attribution` | Decompose a block's P/L into Greek contributions |

For model conventions and the distinction between computed and provider-native
Greeks, see the [computed option-Greeks method](market-data.md#computed-option-greeks-method).

## Live Options

| Tool                  | Description                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_option_snapshot` | Live option chain with greeks, IV, and open interest from Massive.com. BS greeks fallback for contracts with empty greeks. Requires `MASSIVE_API_KEY`. |

For `get_option_snapshot`, provider-native values and computed fallbacks must
be distinguished; see the
[computed option-Greeks method](market-data.md#computed-option-greeks-method).
Live fallback values do not imply that a revision-bearing quote was persisted.

## Market Data Import

| Tool                   | Description                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `import_market_csv`    | Import OHLCV data from a local CSV file with column mapping                                        |
| `import_from_database` | Import from an external DuckDB database via SQL query                                              |
| `import_flat_file`     | Import a local Parquet or CSV flat file for a specific ticker and timespan                         |
| `fetch_bars`           | Fetch daily or intraday OHLCV bars from the configured provider and write to Parquet               |
| `fetch_quotes`         | Fetch option minute quotes from the configured provider and write to Parquet                       |
| `fetch_chain`          | Fetch option chain snapshot for an underlying on a given date                                      |
| `compute_vix_context`  | Compute cross-ticker VIX regime fields (Vol_Regime, Term_Structure_State, etc.) for a date range   |
| `refresh_market_data`  | Composite daily refresh: fetch bars for all tickers, auto-fire VIX context, return coverage report |
| `enrich_market_data`   | Run enrichment pipeline to compute derived indicators                                              |
| `purge_market_table`   | Delete all data from a market table for re-import                                                  |

See [Market Data Guide](market-data.md) for import examples, ticker formats, and enrichment details.

For stored Greeks populated by `fetch_quotes`, see the
[computed option-Greeks method](market-data.md#computed-option-greeks-method).

Massive per-ticker `fetch_quotes` adds `requests[]` receipts with `ticker`,
`date`, `outcome` (`ok`, `empty`, `error`), `rows`, `pagesFetched`, and optional
`httpStatus`/`errorClass`. Failed ticker-dates are discarded before enrichment
or caching, never represented as empty success. Mixed successful/failed dates
return top-level `partial`; all failed dates return `error`; the summary also
declares failures. Existing successful values, arguments, and opt-in provider
configuration remain unchanged. Both NBBO and `synth_close` report receipts;
NBBO-skipped weekends emit no receipt and do not count as success.
`synth_close` retains one paginated range fetch, deriving per-date receipts
with a shared range page count; a failed range marks every date `error` and
discards all its rows. ThetaData output is unchanged.
See [per-request details](market-data.md#fetch_quotes).

## Underlying Registry

| Tool                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `register_underlying`   | Add or update an underlying-to-roots mapping   |
| `unregister_underlying` | Remove a user-added underlying mapping         |
| `list_underlyings`      | List bundled and user-added ticker mappings    |
| `resolve_root`          | Explain how a symbol resolves to a ticker root |

## Market Analysis

| Tool                         | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `analyze_regime_performance` | Analyze P&L by market regime (VIX levels, term structure, trend)       |
| `suggest_filters`            | Suggest entry filters based on losing trade analysis                   |
| `calculate_orb`              | Opening range breakout analysis from intraday bars                     |
| `enrich_trades`              | Add market context to trades (lookahead-free temporal joins)           |
| `find_predictive_fields`     | Identify which market fields predict trade outcomes                    |
| `filter_curve`               | Equity curve with/without a candidate market filter applied            |
| `get_field_statistics`       | Distribution statistics for market, trade or registered dataset fields |
| `import_daily_dataset`       | Import or replace a Static Dataset CSV with declared timing            |
| `list_daily_datasets`        | List datasets, fields, timing and coverage                             |
| `delete_daily_dataset`       | Delete a dataset and unregister its fields                             |
| `list_analysis_fields`       | Runtime catalog of built-in and dataset analysis fields                |

Market-filter analyses are screens on the supplied trade tape, not new backtest results.
Confirm a surviving filter by adding it to the Option Omega backtest and running it natively.
These local tools do not require an Option Omega connection.

Static Dataset CSVs use the same parser as the web app: timestamp first, then numeric or
categorical columns. `import_daily_dataset` takes `name`, exactly one of inline `content` or
`csvPath` under the data root, optional `ticker`, `columnTiming`, and `knownBy` (HH:mm ET).
For Docker's default `-v ./data:/data` mount, put the CSV at `./data/datasets/vrp.csv`
on the host and pass `csvPath: "datasets/vrp.csv"` or `"/data/datasets/vrp.csv"`.
Use the container path beneath the configured data root, not the host path.
Default timing is close. Date-only close values are available D+1 at 00:00 ET; date-only
open values require knownBy; timestamped values are as-of. All consumers select the latest
value available at or before trade entry, including sparse series. By default there is no
freshness limit. Values live only in analytics.duckdb's `datasets.dataset` and `datasets.value`, not
market tables or Parquet. Re-import atomically replaces a named dataset.
Field metadata reports `knownBy: null` for close columns; the dataset's stored known-by
continues to apply only to date-only open observations.
`enrich_trades` retains CSV `customFields` and returns `datasetFields` plus
`datasetProvenance` (source timestamp and available-at instant) so carry-forward age is visible.

Blank or whitespace-only cells are not observations: imports omit them and causal joins
carry forward the last real value. They do not change a numeric column into a categorical
column, and missing numeric values never become zero during filter evaluation.
When dataset fields participate in analysis, `datasetAge` keeps each field's attachment count,
median/max source-to-entry age in Eastern calendar days, and `olderThan3Days` count.
It also reports `sessionAgeStatus`, `medianAgeSessions`, `maxAgeSessions`,
`staleAttachments` (candidate attachments missing at least one expected session),
`unsupportedSessionAge` and `rejectedAttachments`. Session statistics include rejected
candidates; calendar-day statistics and `attachments` describe accepted values only
(ages are null if none were accepted). `datasetWarnings` names stale, unsupported and
refused fields and counts. Calls using no dataset fields retain their prior output shape.

Session age counts **missed expected XNYS sessions**, not distance between dates.
For close columns the expected source is the prior session: Friday close → Monday entry
is 0; a missing Friday is 1. Holidays do not count. For open columns, today's session is
expected only at/after known-by ET; before then the prior session is expected.
Timestamped observations remain as-of; open-column freshness uses the declared known-by
or midnight ET if omitted. This daily-session diagnostic does not infer intraday cadence.
This diagnostic retains the shared library's v1 XNYS calendar (2022–2030);
outside that range session age is explicitly `unsupported` (null aggregate ages),
never guessed from weekdays. The additive historical v2 library exports do not
change dataset session-age behavior.

`maxMissedSessions` is an optional nonnegative integer on `enrich_trades`,
`suggest_filters`, `analyze_regime_performance`, `filter_curve`, `find_predictive_fields`,
`get_field_statistics`, `analyze_structure_fit`, and `validate_entry_filters`.
It refuses a dataset attachment when missed sessions exceed the limit, or when session
age is unsupported. Rejected trades count as uncovered for that field, including its
baseline count/P&L; `enrich_trades.datasetRejections` names refused fields and provenance.
Omitting the limit preserves matching exactly. Built-in market fields are unaffected.
Datasets with undeclared (legacy) timing report session age `unsupported`, so any
`maxMissedSessions` limit refuses them. In practice these are legacy web datasets;
MCP imports always declare timing.

`find_predictive_fields` ranks registered numeric dataset fields and built-in market fields
alongside trade fields. `filter_curve` accepts these names directly (for example `signal.score`
or `RSI_14`); both use the same entry-time values as `enrich_trades`. Dataset fields with no
available value in the selected trades are refused explicitly.

`find_predictive_fields.method` accepts `pearson` (default), `spearman`, or `kendall`
(tie-adjusted Kendall tau-b). Ranking uses the selected coefficient. Explicit requests
report `method`; omission preserves the existing Pearson response shape. All methods
use the same covered entry-time pairs and honor `maxMissedSessions`.
Kendall is quadratic: the shared ranking module admits at most **75 million total
estimated pair comparisons**, summed as `n_f × (n_f - 1) / 2` across fields with at
least `minSamples` valid field/target pairs. Here `n_f` follows each field's causal
coverage after strategy/date filtering; constant fields are conservatively included
before variance screening. Admission precedes every quadratic correlation calculation.
Refusals report `status: "refused"`, `reason: "kendall_pair_work_limit"`,
`estimatedPairs`, `pairLimit`, covered `fieldCount`, and prefiltered `tradeCount`.
A 1,100-trade block with 100 fully covered fields needs 60,445,000 pairs and passes;
124 fully covered fields fit, while 125 exceed the cap. A 20,000-trade field alone
needs 199,990,000 pairs and is refused. Pearson and Spearman are unchanged.
`get_field_statistics` also accepts registered dataset columns and built-in market fields,
using these same causal values and dataset age summaries.

`suggest_filters.fields` optionally selects registered fields: numeric fields sweep percentile
thresholds; categorical fields test exclusions by value. Omitting fields preserves the existing
hand-authored defaults. Shared sweeps preserve numeric scale without two-decimal rounding.
The fields path keeps all-trade `currentStats` and reports `fieldBaselines` by field:
covered `count`/`totalPl` and `uncoveredCount`/`uncoveredTotalPl`.
`comparisonPopulation: "fieldBaselines"` identifies what suggestions compare against.
`filter_curve.baseline` reports the same covered and uncovered counts and P&L.

#### Filter-curve significance and stability

Available since 4.4.0; see the [release notes](../releases/v4.4.0.md) for the workflow
and interpretation limits.
The [4.5.0 release notes](../releases/v4.5.0.md) cover day units, daily risk,
group breakdowns and field-scoped resolution. Varchar market fields such as
`Trend_Direction` now produce categorical equality exclusions in explicit-field
`suggest_filters` and category segments in `analyze_regime_performance`, rather
than numeric bins; prior-session timing is unchanged.

Use either `field: "signal.score"` or `fields: ["signal.score", "other.score"]`
(up to 10 distinct fields). Single-field calls without new options retain the existing
response. `fields`, `objective`, or `permutation` opts into `bestThreshold` and `perYear`;
multi-field results live in `fields`, including named unavailable/uncovered entries.
Each field has its own covered baseline; dataset timing and `maxMissedSessions` are unchanged.

`unit: "day"` (4.5.0) sums reported P&L by entry calendar date before the
sweep, yearly rows, and whole-month permutation. Win rate then counts days with
positive summed P&L (`winRateBasis` in the response), not winning trades.
Every resolved field value, including missing values, must agree within each day;
otherwise `day_field_varies` refuses that field and lists the varying `days`.
Default `unit: "trade"` retains the existing output. Work admission runs before
field resolution, conservatively counting all selected trades or entry days before
field coverage; it never silently drops a field to fit the budget.
Field-named analysis resolves only requested filter/group fields through the same
availability rule. Unrelated registered datasets cannot inflate the work.
`get_field_statistics`, field-based `suggest_filters` and `analyze_regime_performance`,
and profile-based `validate_entry_filters` / `analyze_structure_fit` likewise resolve
only their named fields (including cross-field comparison operands). Exhaustive
`find_predictive_fields` still resolves the whole catalog; `enrich_trades` returns
all fields for its paginated trades (default 50, maximum 500).

With `unit: "day"`, `objective` also accepts `sharpe`, `mar`, and `maxDrawdown`.
They use the covered entry-date P&L curve, keeping filtered dates flat at zero.
Only covered entry dates are observations: intervening dates without covered entries
are not inserted. Sharpe uses √252 annualization; MAR retains calendar-span CAGR
at 365.25 days per year, not √252.
They refuse trade units as `objective_requires_day`.

- **Sharpe** is mean daily dollar P&L / sample standard deviation × √252, rf=0;
  zero variance or fewer than two observations gives 0, matching the shared
  simulation helper. This intentionally differs from portfolio return Sharpe,
  which uses historical Treasury rates: a risk-free dollar P&L deduction needs
  capital, while this measure does not.
- **MAR** is CAGR / maximum drawdown as a fraction of starting capital. CAGR uses
  the first through last covered entry dates and 365.25 calendar days per year,
  measured from calendar parts rather than elapsed local-midnight milliseconds
  so daylight-saving transitions do not add or subtract an hour from the span,
  matching the portfolio annualization convention. Capital comes from the existing
  daily-log/trade-funds resolver, never its assumed default; otherwise
  `mar_requires_capital` refuses. Zero drawdown, nonpositive ending capital, or no
  elapsed time yields a null MAR and `mar_undefined`; such candidates are shown
  but cannot rank, and no eligible MAR candidate gives a named refusal.
  In `perYear` and `perGroup` rows only, a covered subset spanning fewer than
  90 calendar days reports `mar: null`, `annualizedReturnPct: null`, and
  `marUnstable: true` on baseline, kept and removed statistics. The row also
  sets `marUnstable: true`, and its MAR objective delta is null. A span of exactly
  90 days is eligible. Whole-population ranking and permutation are unchanged.
- **maxDrawdown** reports the positive maximum decline of cumulative daily P&L,
  starting at zero, in dollars and percent of starting capital when observed.
  Its objective delta is **baseline drawdown minus kept drawdown**: smaller is
  better. The percent denominator is starting capital, not the rolling peak.

When `strategy` is supplied, portfolio daily logs are never a capital basis.
Following the performance-chart convention, capital is reconstructed only from
the strategy-filtered trades' observed funds evidence. Without that evidence,
MAR refuses as `mar_requires_capital` with
`capitalReason: "portfolio_capital_not_applicable_to_strategy"`.
Sharpe and dollar drawdown still work; drawdown percent is null with the same
`percentReason`, also reported as `objectiveMetadata.capitalReason`.
Without a strategy filter, daily-log evidence is restricted to the same `startDate`
and `endDate` window as the trades before resolving capital. The first daily log
inside that window supplies its starting capital when valid; absent evidence
falls back to the existing observed trade-funds policy, never a pre-window balance.

Response `objectiveMetadata` states these definitions. Every risk candidate shows
its objective delta against the covered baseline. Ranking shares the existing
P&L/win-rate tie-breaks and eligibility (keep and remove at least one observation).
Every permutation recomputes the baseline path and reruns the complete objective
sweep. Risk-path work adds `36nt` per sweep to admission, covering path construction
and risk statistics; Holm and the requested-field family are unchanged.

`groupBy: "regime.label"` (a built-in market or registered dataset field) adds
`perGroup` rows for the **same chosen threshold**, never independently optimized
thresholds per group. This opts into `totalPl` selection if no objective was given.
Rows have the `perYear` shape: covered baseline and its uncovered count/P&L,
kept/removed counts, P&L, win rate, objective delta and small-sample warning.
Groups partition every selected trade/day, including filter-uncovered observations.
Missing group values form a separate row with `group: null`, `groupValue: null`,
and `uncoveredGroup: true`; a real category named `"uncovered"` remains a string.

Numeric groups use increasing finite `bins` cut points or quartiles over the
selected unit's group-covered observations, sharing the exact
`analyze_regime_performance` binning. Intervals are lower-inclusive, upper-exclusive.
Categorical groups use their values, ordered lexically; numeric groups are ordered
by bucket, with the uncovered group last. Group values use the same causal resolver
and `maxMissedSessions` as filter values. Day groups must be constant, including
missingness, within each entry date: otherwise `day_group_varies` lists the dates
and group field. Unknown groups refuse as `group_field_unavailable`; bins without
`groupBy`, unordered cuts, or categorical-incompatible declarations refuse as
`group_bins_invalid`. Small groups are flagged, never omitted. `groupBy` does not
add another permutation search or change the Holm family.

`objective` is `totalPl` by default, or `winRate` (percentage-point gain). Best thresholds
rank P&L delta then win-rate gain, or win-rate gain then P&L delta, using the same ranking
module as `suggest_filters`. Only candidates keeping and removing at least one covered
trade are eligible. Unlike suggestions, the curve reports the best even if its delta
is negative: a fitted optimum is not a recommendation. Legacy `sweetSpots` remain
unchanged. Per-year rows partition entries by calendar year, including uncovered-only
years, and show covered baseline, kept/removed count, P&L and win rate, objective delta,
and uncovered counts/P&L. Fewer than 30 baseline, kept or removed entries is flagged,
not dropped. Values equal to the threshold are removed because comparisons are strict.

```json
{
  "blockId": "sample",
  "fields": ["custom.signal", "custom.noise"],
  "objective": "totalPl",
  "permutation": { "iterations": 499, "block": "month", "seed": 42 }
}
```

Permutation is opt-in and selection-adjusted: every draw reruns **all** requested
thresholds/directions and compares the best objective delta with the observed best.
Covered trades are stably ordered by entry date, then outcomes are grouped into
calendar-month blocks. Fisher–Yates shuffles whole blocks, preserving their internal
outcome order (and ties); the flattened outcomes are paired with the fixed field
series. This is simpler than week/holiday alignment and retains within-month serial
dependence even with unequal trade counts per month. Cross-month dependence is not
preserved; the exchangeability of monthly blocks is an assumption, not a causal claim.
The seeded 32-bit LCG makes identical requests deterministic.

The reported `pValue` uses `(exceedances + 1) / (iterations + 1)`, counting ties as
exceedances. `pValueHolm` uses the shared Holm implementation across **all requested
fields** (refused fields conservatively occupy p=1); one field reports no adjustment.
No p-value is fabricated for refusal. Named reasons include `too_few_covered_trades`
(under 30), `too_few_blocks` (under 8 observed months), `no_eligible_threshold`,
and `permutation_work_limit`. Iterations are capped at **499**. Only when permutation
is requested, `thresholds` and `percentileSteps` are limited to **100** entries each:
larger arrays produce the named `permutation_candidate_limit` refusal before any sweep.
Without permutation, these arrays retain their existing unrestricted schema acceptance.
Permutation admission estimates work before resolving fields, using the selected
trade/day count `n` (an upper bound on covered count), threshold/percentile count `t`
(conservative before deduplication), and iterations `r`:
`(r + 2) × (n × ceil(log2(max(2,n))) + 6nt + 3t × ceil(log2(max(2,2t))))`.
The estimate includes sorting the values and candidates on every sweep, filtering and
scoring both directions, plus the observed sweeps. Its limits are **30 million work
units per field** and **90 million per request**, summed across fields, so a wide
request cannot multiply the field allowance tenfold. These conservative computational
limits target a few seconds on ordinary trade logs, not a wall-clock guarantee.
At **1,100 trades, 55 months, 499 iterations and the seven default thresholds**,
the conservative estimate is **29,250,384 units per fully covered field**. The largest
admitted family at this size is **3 fields** (87,751,152 units); 4 fields require
117,001,536 and are refused. Threshold deduplication does not increase that allowance.
If either is exceeded the entire request is refused before any field sweep, with
`permutation_work_limit` (per field) or `permutation_request_work_limit` (request),
`estimatedWork`, `workLimit`, the requested permutation settings and per-field estimates.
No block count is calculated for admission refusals. Other refusals return requested
iterations, block, seed, block count and status.
These exploratory p-values adjust threshold/field selection within this request.
Choices of **field, objective and mode across separate requests are not part of the
Holm family**. Neither repeated exploration nor out-of-sample performance is adjusted.

`suggest_filters.objective` defaults to `totalPl`: admit only positive P&L improvements
and rank by P&L improvement (win-rate gain breaks ties). Use `winRate` to admit and rank
by win-rate gain, with P&L as the tie-breaker. `minImprovementPct` is a percentage-point
win-rate threshold only under `winRate` (default 3); it is ignored under `totalPl`.
The response names `objective`, `rankingRule`, and notes the ignored argument when supplied.
Each standalone/composite suggestion reports `tradesKept`, `keptFraction`, `tradesRemoved`,
and `objective`. The retained `confidence` key means sample-size support, not statistical
confidence: high requires at least 20 kept/10 removed, medium 10 kept/5 removed, otherwise low.
Keeping less than 20% of the covered pool always caps support at low and adds a
`Low retention` warning. Composite projections describe the retained complement of the
AND exclusion and use the same objective, not a separate standalone-relative gain gate.

Since 4.3.0, `minImprovementThreshold` is null under `totalPl`; under `winRate` it
reports the configured/default numeric threshold. The fields path previously
used kept-only support thresholds of 100 (high) and 30 (medium); it now uses the
shared kept/removed thresholds above. Composite `improvement` remains the
kept-trade win rate minus the better standalone kept-trade win rate, in percentage
points, with standalones evaluated on the same composite covered pool. It is not
P&L improvement or baseline-relative `winRateDelta`, and can be negative on an
admitted composite because the former >2-point gate is gone. See the
[4.3.0 behavior changes](../releases/v4.3.0.md#behavior-changes).

`analyze_regime_performance` accepts `field` instead of a preset `segmentBy`. Categorical
fields group by value. Numeric fields use `bins` as strictly increasing cut points, with
lower-inclusive/upper-exclusive intervals and unbounded tails; omitted bins use quartiles.
Existing preset calls retain their behavior. Unknown and entirely uncovered fields are named
and refused; partial coverage is reported.

## Strategy Profiles

| Tool                   | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `profile_strategy`     | Create or update a strategy profile with structured metadata |
| `get_strategy_profile` | Retrieve a stored strategy profile                           |
| `list_profiles`        | List all strategy profiles (optionally filtered by block)    |
| `delete_profile`       | Delete a strategy profile                                    |

## Profile Analysis

| Tool                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `analyze_structure_fit`    | Analyze strategy performance by regime/condition dimensions |
| `validate_entry_filters`   | Test each entry filter's contribution to edge               |
| `portfolio_structure_map`  | Regime x structure coverage matrix across all strategies    |
| `suggest_strategy_matches` | Find strategies that match specific market conditions       |

`validate_entry_filters` reports unknown market filter fields in `unresolvable_filters`
with a reason and excludes them from per-filter results and ablation. Remaining known
filters are still analyzed; if none are resolvable, it returns `error: "no_resolvable_filters"`
naming the fields. `analyze_structure_fit` reports the same exclusions while retaining
its known-field and fixed dimensions. Both tools include the exclusions in their summary
and warnings. A known field with a missing value on a date is not an unknown field:
`no_data_count` reports missing observations independently of the covered analysis pool.

Profile coverage is per field, not satisfied by an unrelated dataset value.
`validate_entry_filters` uses trades covered by every requested filter (including any
cross-field comparison operand) for its baselines, comparisons and ablations. Dataset-only
filters work without built-in market rows. Missing-market warnings always count absent
built-in market rows, even when dataset observations are available.
Bare close-derived comparison operands use `prev_*` values even when the joined record
also contains the raw same-day close; missing prior observations are not covered.
`analyze_structure_fit` groups each dimension only over observations for that dimension
and returns `dimension_baselines` for those covered pools; update hints compare against
the corresponding covered baseline. With no dataset dimension involved, `overall` retains
the existing market-row baseline. When dataset dimensions are used, that overall pool also
includes trades with observations for the selected dataset dimensions, never unrelated
dataset fields. Time-of-day uses valid trade times independently of market coverage.

## Advanced Analysis

| Tool                          | Description                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_monte_carlo`             | Monte Carlo simulation with confidence intervals                                                                                                                                                                                    |
| `run_walk_forward`            | Walk-forward analysis on one realized trade tape; sizing sweeps linearly rescale P&L, not shared funds or marked equity. Confirm a surviving fixed allocation with a native Option Omega Portfolio backtest.                        |
| `get_correlation_matrix`      | Strategy correlation matrix (Kendall, Spearman, Pearson)                                                                                                                                                                            |
| `get_tail_risk`               | Tail dependence and copula-based risk analysis                                                                                                                                                                                      |
| `get_position_sizing`         | Kelly criterion from realized trade outcomes as an allocation lead. Confirm the resulting fixed allocation with a native Option Omega Portfolio backtest.                                                                           |
| `regime_allocation_advisor`   | Regime-based allocation recommendations                                                                                                                                                                                             |
| `stress_test`                 | Historical stress statistics from closed-trade P&L (opening-date fallback when absent), not marked equity or intratrade exposure. Confirm marked-account stress against a native Option Omega Portfolio backtest and its daily log. |
| `marginal_contribution`       | Marginal contribution of a strategy to portfolio risk/return                                                                                                                                                                        |
| `what_if_scaling`             | Trade-derived sizing counterfactuals, not the shared-funds result of a native Option Omega Portfolio backtest. Confirm a surviving fixed allocation with that native backtest.                                                      |
| `paired_bootstrap_comparison` | Paired bootstrap intervals for two strategy runs                                                                                                                                                                                    |

### Monte Carlo input series and marked-account risk

`run_monte_carlo` defaults remain trade-based. Select `resampleMethod` explicitly
when interpreting account risk:

- `trades` (default): reported trade P/L dollars, sorted by **date opened**;
  optional `normalizeTo1Lot` divides each trade's P/L by its contract count.
- `daily`: sums those trade P/L dollars by **date opened**, keeping only dates
  with trades. These are opening-date cohorts, not daily marked-account P/L,
  and do not include idle days.
- `percentage`: reconstructs capital from the first trade's
  `fundsAtClose - pl` (or `historicalInitialCapital`), divides each opening-date
  ordered trade's P/L by running capital, and adds that P/L to capital before
  the next trade. Nonpositive capital yields zero returns for subsequent trades.
  It is a trade-cohort reconstruction, not imported daily NLV risk.
- `marked-daily` (opt-in): uses the imported **whole-portfolio daily log**, sorted
  by its calendar dates, including every provided row and idle day. It calls
  the same library `dailyLogReturns` calculation used by `get_statistics`:
  `dailyPl / (netLiquidity - dailyPl)` as a decimal, or zero when that denominator
  is nonpositive. No external-flow adjustment or adjacent-row reconstruction
  is performed. Deposits/withdrawals therefore affect the denominator through
  reported NLV; the `withdrawn` column is not separately added back or deducted.
  This is not a separately cash-flow-neutralized time-weighted return. With no
  external flows and consistent daily P/L, the denominator equals prior NLV,
  so the formula equals `NLV_t / NLV_(t-1) - 1`. The first row uses its reported
  P/L and NLV to infer the pre-observation balance rather than dropping that row.

Existing modes require at least ten trades and a pool of at least five samples.
They default to stationary-block resampling and support `resampleMode: "iid"`
and synthetic trade-loss injection. `marked-daily` requires at least five
daily-log samples after `resampleWindow`; missing/short logs return an error,
**never** a trade-P/L fallback. A daily-log row without a usable reported `P/L`
is refused rather than treated as a zero return. Strategy filters (including an explicitly
supplied `"all"`), one-lot normalization, `resampleMode: "iid"`, and explicit
`includeWorstCase: true` are refused. Marked mode uses stationary blocks and
disables trade-derived synthetic losses; both choices are declared in the
result. `includeWorstCase` defaults to false only for this mode.

`simulationLength` is the number of sampled observations, not elapsed calendar
days. When omitted it is the trade count for existing modes and the full daily-log
row count for marked mode; an explicit length retains the minimum of ten.
`resampleWindow` selects the most recent observations. Marked mode infers starting
capital from the first row's `netLiquidity - dailyPl`; supply a positive
`initialCapital` if that value is nonpositive. Annualization defaults to 252
observations/year for marked mode and can be overridden by `tradesPerYear`.
Percentage and marked paths compound their returns and clamp per-step losses at
-100% of current equity; use `ruinThresholdPct`/`probabilityOfRuin` for ruin risk.

Marked output contains:

- `parameters.randomSeed`: the supplied seed or a generated replayable seed;
- `parameters.meanBlockLength`: the effective requested or auto block length
  (auto is rounded cube root of the actual pool size);
- `markedReturns.source`, `returnDefinition`, `resampling`,
  `worstCaseInjection`, `horizon`, `horizonUnit: "daily_log_observations"`,
  and `units: "decimal_return"`;
- `markedReturns.maxDrawdownQuantiles`: p50, p95, p99 of each path's maximum
  peak-to-trough decline, expressed as positive decimal depths;
- `markedReturns.horizonReturnQuantiles`: p5, p50, p95, p99 of the compounded
  total return at the declared horizon (negative values are losses).

Quantiles interpolate linearly between sorted paths at rank `(N - 1) * p`.
These differ from the existing `percentileBands`, which contain terminal
**equity dollars**, not return or maximum-drawdown quantiles. Existing modes'
response shape, defaults and seeded results are unchanged.

The marked handler uses the library's `pathQuantiles` implementation for both
summaries. Library callers can request `includeMaxDrawdownQuantiles: true` in
`runMonteCarloSimulation` to receive top-level `maxDrawdownQuantiles` (p50, p95,
p99), with the same nonnegative decimal depths and interpolation. Omit the
option to preserve the complete existing result shape; `statistics` is unchanged
even when opted in. The MCP marked output shape and quantile arithmetic are unchanged.

### Marginal contribution: optional expected shortfall

`marginal_contribution` accepts `includeTailRisk: true` and optional
`tailConfidence` (default `0.95`). Without the opt-in, the response—including
its summary, Sharpe and Sortino values—remains unchanged.

The added `tailRisk` section reports `baseline` and `removedStrategyArms`,
each with `expectedShortfall`, `reason`, `observations` and `dateRange`.
Removed arms also identify `strategy` and `changeVsBaseline`. The arms follow
the existing `targetStrategy`, `topN` and marginal-Sharpe ordering.

This is **incremental (leave-one-out), non-additive** realized-trade analysis.
The changes do not sum to book ES. It is not Euler or marked-account attribution.
ES uses the public `cvarFromReturnsAtConfidence` estimator: an interpolated
lower-tail cutoff and the unweighted mean of observations at or below it.
Confidence must be finite and strictly between 0 and 1; invalid confidence
is surfaced as a tool error from the estimator.

All ES values are signed decimal returns, not positive loss magnitudes or
annualized percentages. Negative ES indicates tail losses.
`changeVsBaseline = removed arm ES - baseline ES`: a positive change means
**removing X reduces tail loss**.

The shared return path applies the same basis-aware net mapping as the ratio
calculations: gross-before-fees trades deduct opening and closing fees once,
and already-net trades retain their reported P/L without another fee deduction.

Each arm uses exactly its existing Sharpe/Sortino return series: close-date
realized net P/L (opening-date fallback), dense business days with weekend
trade dates retained, divided by that arm's prior reconstructed equity. All
arms start with the original portfolio's initial capital. **Each arm's extent
follows its own close dates**, not a shared padded window; observation counts
and first/last dates make the different extents explicit. These are raw returns,
not risk-free excess returns. An empty arm returns ES and change as `null`,
with a reason and no date range; a single observation is valid for this
estimator and is not replaced with zero.

## Edge Decay

| Tool                               | Description                                          |
| ---------------------------------- | ---------------------------------------------------- |
| `analyze_edge_decay`               | Detect strategy performance decay over time          |
| `analyze_period_metrics`           | Performance by time period (quarterly, yearly)       |
| `analyze_rolling_metrics`          | Rolling window performance metrics                   |
| `analyze_regime_comparison`        | Compare performance across market regime transitions |
| `analyze_walk_forward_degradation` | Walk-forward degradation analysis                    |

Walk-forward windows are inclusive US Eastern calendar-day ranges. Both
`run_walk_forward` and `analyze_walk_forward_degradation` evaluate only complete
IS+OOS windows ending on or before the last trade date. A trailing window whose
OOS end exceeds that date is not evaluated; when this occurs, the tools return
`skippedWindows` alongside `periods` with the planned `inSampleStart`, `inSampleEnd`,
`outOfSampleStart`, `outOfSampleEnd`, `reason: "truncated_oos_window"`, and
`detail` naming the last trade date. Degradation entries also include
`periodIndex`. Both tools report every window date as `YYYY-MM-DD`.
The existing `stats.skippedPeriods` or `dataQuality.skippedPeriods` includes
these truncated windows as well as any windows skipped for insufficient trades.

## Portfolio Health

| Tool                      | Description                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portfolio_health_check`  | Comprehensive health check across multiple dimensions                                                                                             |
| `drawdown_attribution`    | Per-strategy P/L attribution for the largest dollar drawdown on closed-trade equity (reported trade P/L, close-date order; not the daily NLV log) |
| `strategy_similarity`     | Find similar strategies based on return patterns                                                                                                  |
| `analyze_discrepancies`   | Analyze discrepancies between backtest and live results                                                                                           |
| `analyze_slippage_trends` | Track execution slippage over time                                                                                                                |
| `analyze_live_alignment`  | Compare live execution against backtest expectations                                                                                              |
| `get_reporting_log_stats` | Statistics on reported/live trade logs                                                                                                            |

`drawdown_attribution` optionally accepts `episodeCount` (integer 1..20) to add
an `episodes` list ranked by largest dollar depth, then earlier peak trade.
`topN` (default 5, integer 1..50) still limits strategy contributors **per episode**.
Equity uses reported trade P/L in close-date/time order; exact timestamp ties
retain input order. Recovery to or above the previous peak ends an episode;
the latest equal peak starts the next one. An unrecovered final episode is
included with `recoveryDate: null`. Equal troughs keep the earliest trough trade,
and attribution stops at that trade. Each list entry contains `drawdownPeriod`,
`periodStats`, and `attribution`; peak minus trough equals `maxDrawdown`, and
`maxDrawdownPct` is that depth divided by peak equity times 100 (zero for a
nonpositive peak, matching the legacy convention).

List attribution includes only trades **after** its peak trade through its
trough trade, even when both occur on one day. A peak at the initial seed
includes the first trade. `periodStats.totalPl` reconciles to negative depth;
contributors truncated by `topN` need not sum to that total. All strategies
participate before truncation. This is closed-trade equity, not marked equity
or daily NLV. With `episodeCount` omitted the response is unchanged: the legacy
single-episode fields retain their inclusive peak-to-trough **date** window,
which can include the peak trade and other same-day trades, so their attributed
P/L need not equal negative depth. Opting in adds the list without changing
those legacy fields. A no-drawdown result adds an empty list when opted in.

## SQL and Schema

| Tool                | Description                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `run_sql`           | Execute SQL against DuckDB. SELECT runs freely. DELETE/UPDATE require `confirm: true` with affected row preview. |
| `describe_database` | Schema discovery with table info, VIX tenor auto-discovery, and example queries                                  |

## Block Import

| Tool                | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `import_csv`        | Import a CSV as a new block; optionally pair trade + daily logs |
| `get_backtest_help` | Help with backtest data formats and troubleshooting             |

`import_csv` accepts `csvPath`, `blockName`, optional `csvType` (`tradelog` by
default), optional `dailyLogPath` for a paired daily log, and `plBasis`
(`net_includes_fees` by default for Option Omega exports; `gross_before_fees`
when P/L has not yet deducted commissions and fees). Both paths must be
readable by the server: local paths for stdio, or paths inside the server's
mounted data directory for Docker/HTTP. Paths accept absolute values, `~`,
or filename-only lookup in `searchPaths` (default: Downloads, Desktop, Documents).
Before creating a block, `import_csv` refuses a trade or reporting row with an
impossible opened/closed calendar date or a missing or unparseable P/L;
gross-before-fees trade rows also need numeric commission fields. Paired daily
logs require `Date` and a numeric `Net Liquidity` (or `Portfolio Value`,
`Value`, `Equity`); `P/L` and `Drawdown %` are optional. A trade log's `P/L %`
column is optional too: a numeric cell becomes the trade's `plPct` in report
tools, and a blank or unparseable cell falls back to the computed value without
refusing the row. Errors name the CSV
file line (the header is line 1). Any refused row, in either file, refuses the
entire import without creating a block. The result's `recordCount` counts the
rows actually loaded from the primary CSV, and its `strategies` use the block
ID when the CSV has no Strategy column, matching `get_block_info`. `dateRange`
holds the first and last calendar dates (`YYYY-MM-DD`). Paired imports
additionally return `dailyLog.recordCount` and `dailyLog.dateRange` in the same
calendar-date form. Unfiltered `get_statistics` uses the daily-log portfolio
drawdown; strategy-filtered statistics remain trade-based.
Unfiltered `get_statistics` with a daily log computes `calmarRatio` from marked
first-to-last net-liquidity CAGR divided by the daily log's maximum absolute
drawdown percentage. Without a daily log, or with a strategy/ticker filter, it
uses trade CAGR divided by trade-equity drawdown. The result labels the basis
as `calculationMethodology.calmar.basis` (`daily_log_marked_curve` or
`realized_trade_equity`); `cagr` remains trade-based and `maxDrawdown` retains
its current source independently. `compare_blocks` carries the same value per
block as `calmarBasis` whenever `calmarRatio` is among its requested metrics.

---

For usage examples and common workflows, see the [Usage Guide](usage.md).

## Prompts

The MCP server also lists five prompts in stdio and HTTP. In Claude Code, with
the server configured under the name `tradeblocks`, the `/` menu lists them as
`/tradeblocks:bring-in-oo-backtest (MCP)`, `/tradeblocks:is-this-optimum-real (MCP)`,
`/tradeblocks:stress-oo-portfolio (MCP)`, `/tradeblocks:live-vs-oo (MCP)` and
`/tradeblocks:allocate-oo-portfolio (MCP)`; typed, they run as
`/mcp__tradeblocks__bring-in-oo-backtest` and so on. Other MCP clients use
`prompts/list` and `prompts/get`. These prompts guide analysis, not server-side
calls to Option Omega. The OO server name is chosen by the user.

Each prompt takes optional arguments, passed after the command in Claude Code
(space-separated, in this order) or as named `prompts/get` arguments elsewhere.
Without them the prompt works from the conversation, as before.

| Prompt                  | Arguments                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `bring-in-oo-backtest`  | `ooId` (OO `savedBacktestId`, or a scratch run's `runId`), `block` (new block name)      |
| `is-this-optimum-real`  | `optimizationId` (OO optimization to evaluate)                                           |
| `stress-oo-portfolio`   | `ooId` (OO `savedPortfolioId`, or a portfolio run's `runId`), `block` (block ID or name) |
| `live-vs-oo`            | `block` (block ID of the OO reference backtest)                                          |
| `allocate-oo-portfolio` | `ooId` (OO saved portfolio ID or run ID), `block` (block ID or import name)              |

For example, `/mcp__tradeblocks__bring-in-oo-backtest <savedBacktestId> my-strategy`.
A saved backtest's or portfolio's own OO headline figures come from
`get_saved_backtest` or `get_saved_portfolio`; `get_backtest_results` and
`get_portfolio_results` are only for a finished run's `runId`.

| Prompt                  | Workflow                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bring-in-oo-backtest`  | Bring OO trades into a block; verify it with `get_block_info` and `get_statistics`.                                                                                                                |
| `is-this-optimum-real`  | Capture verified scratch runs, combine in a trade-only block and test both arms and their paired difference.                                                                                       |
| `stress-oo-portfolio`   | Analyze a portfolio's economic trades with portfolio risk tools.                                                                                                                                   |
| `live-vs-oo`            | Compare a reporting log's live trades with the OO reference block it sits in, using `compare_backtest_to_actual`, `analyze_discrepancies`, `analyze_slippage_trends` and `analyze_live_alignment`. |
| `allocate-oo-portfolio` | Propose allocations using a strategy-labelled portfolio block, then check each candidate with OO `run_portfolio` against shared funds; do not save the original portfolio.                         |

The `bring-in-oo-backtest` prompt uses the `tradeblocks-skills` plugin's
`/tradeblocks:oo-capture` when installed. Without it, `bring-in-oo-backtest`
asks for both OO's trade-log CSV and its daily-log CSV, saved at paths the
TradeBlocks server can read, and calls `import_csv` once with `dailyLogPath`,
so one block holds OO's trades and marked daily curve; with only a trade log it
says the block has no OO marked daily curve. The optimum prompt points plugin users
to `/tradeblocks:is-this-optimum-real`, which captures each run separately and
combines the verified trades into one comparison block; its paired result is
best minus centre on jointly traded days, not adjusted for grid selection.
Without the plugin, users export each scratch run's CSV from OO into separate
blocks: only per-block tests against zero run, not a paired difference. Export
to a path readable by the TradeBlocks server and import with `import_csv`.
In Docker/HTTP the CSV must be inside the server's mounted data directory.
If the server cannot read it, the workflow stops instead of re-typing OO's
responses. The read-only `stress-oo-portfolio` prompt can use the plugin's
saved-portfolio capture when the installed `oo-capture` supports it, or an
existing portfolio block or OO's exported trade log otherwise. OO's marked-account headlines and
TradeBlocks' realized-trade statistics must be labelled separately, especially
drawdown; OO profit already includes fees.

The `allocate-oo-portfolio` prompt takes optional `ooId` (saved portfolio ID,
or a scratch run ID) and `block` (block ID or import name) arguments; without
arguments it resolves the source from the conversation. When the installed
`/tradeblocks:oo-capture` describes saved-portfolio capture, it captures a saved
portfolio with distinct member strategy labels and its whole-book daily curve;
older plugin versions capture only saved backtests and runs. Otherwise use an
OO-exported portfolio trade-log CSV with `import_csv`, adding `dailyLogPath`
when the daily-log export is available. Both files must be server-readable.
TradeBlocks' correlation, marginal, tail, what-if and health analyses are
trade-derived counterfactual proposals, not OO's marked-account results.
Only a completed `run_portfolio` whose `get_portfolio_results` was read is
OO-tested. Saving a candidate requires an explicit request and a new portfolio;
the prompt never changes the saved source.

For `live-vs-oo`, save the reporting-log CSV inside the OO reference block's own
folder, beside its trade log; `import_csv` would make a separate block that the
comparison tools cannot pair.

## Developing MCP Tools

### Keep Decisions with the Caller

The language model is the intelligence layer for discovery and configuration. Prefer typed tool
inputs such as `{ file_path, dataset_type, select_sql, partition }` over server-side format
registries, provider matrices, schema sniffing, or growing provider switches. The caller can inspect
files with `run_sql`, discover target shapes with `describe_database`, and provide a transforming
query. Storage modules should expose a small mode-aware write primitive, while providers should stop
at fetching or downloading bytes. A new input format should require no server change when a caller
can express the conversion in SQL.

When adding a statistic or chart to the web application, consider whether AI analysis also needs it.
Summary metrics generally belong in `get_statistics`; time-series outputs generally belong in
`get_performance_charts`.

### Tool Inputs

Register each tool with `server.registerTool` and a Zod object `inputSchema`. That includes
tools added through a `TradeBlocksPlugin`. The server makes that object strict at
registration, so no tool needs `.strict()` of its own. A tool registered with any other input
schema, such as a raw shape, a union or no schema at all, is refused at startup with an error
naming the tool. So is a tool registered through the SDK's legacy `server.tool()`. A schema
replaced after registration, such as through the handle's `update({ paramsSchema })`, is not
made strict.

### Verification

After changing MCP server source:

1. Run `npm run build -w packages/mcp-server`.
2. Run the relevant unit and integration tests, including every configured provider whose
   capabilities the change affects. Read-only paths need one provider-independent run.
3. Start the built server through MCP Inspector and call `tools/list` against a representative data
   directory. A live start catches connection ordering, stale object types, and real Parquet view
   registration problems that fixtures can miss.

The server initializes in read-write mode, then returns to read-only operation. Write tools upgrade
the connection on demand. Market reads use Parquet-backed views when the configured market directory
exists and equivalent DuckDB tables otherwise; mutable sync metadata remains a table.
