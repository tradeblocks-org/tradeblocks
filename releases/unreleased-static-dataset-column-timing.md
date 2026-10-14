# Unreleased — Static Dataset column timing

New web imports declare open/close timing for every column (default close). Date-only close values become available on the following calendar day at 00:00 ET, so they cannot enter same-day trades. Date-only open columns require a known-by time (ET); timestamped rows remain as-of. Nearest-before carries the last available observation across non-trading days and missing data without a freshness limit.

Existing IndexedDB datasets retain their numbers and load as `legacy-same-day`, with a visible warning and an explicit Set column timing action. Because old imports did not preserve source precision, setting timing requires choosing dates-only or timestamped rows; mixed-precision legacy files must be re-imported. No stored user values are rewritten.

Same-day, nearest-after and nearest match modes remain available only for legacy datasets with their lookahead warning. Declared datasets always resolve causally; the web app disables strategy selection and explains the rule.

Shared lib exports `validateDatasetTiming`, `getDatasetValueAvailableAt`, `resolveDatasetColumnAtTime`, and `updateStaticDatasetTiming`. Resolver inputs are immutable snapshots. The explicit column resolver refuses unknown columns; the existing `getMatchedFieldValue` interface retains its null result for unknown fields or unavailable observations. Declared datasets always use causal availability regardless of stored match strategy. Blank cells are not observations.

Aggregate MCP analyses now expose compact per-field dataset age summaries (attachment count, median/max Eastern calendar-day age, and count older than three days). This adds visibility without a freshness limit or changing calls that use no dataset field.

Daily-log custom fields remain a same-day join without timing metadata and can leak close-derived values; use timed Static Datasets for causal analysis. Market enrichment partitions and package versions are unchanged.
