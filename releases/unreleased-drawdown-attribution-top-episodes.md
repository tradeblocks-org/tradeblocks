# Unreleased — ranked drawdown attribution episodes

`drawdown_attribution` accepts optional `episodeCount` (integer 1..20), adding a ranked `episodes` list. `topN` still limits contributors per episode. The public `@tradeblocks/lib` export `buildRealizedDrawdownAttributionByCloseDate(trades, topN, episodeCount?)` exposes the same opt-in capability. Omission preserves the existing response exactly.

Episodes use closed-trade reported P/L in close-date/time order, not marked equity or daily NLV. Exact timestamp ties retain input order. Ranking is largest dollar depth first, then earlier peak trade. Recovery to or above the previous peak ends an episode; an unrecovered final episode is included with null recovery date. Equal peaks use the latest trade, and equal troughs retain the earliest trade. The initial seed precedes the first trade and uses its close date for display. Dollar drawdowns remain defined across zero; percentage depth follows the legacy zero convention for nonpositive peaks.

Every list entry carries its own peak/trough dates and equity, depth, percentage, recovery date and strategy attribution. List attribution uses only trades after the peak through the trough, so full-period P/L equals negative depth (within floating-point precision); contributor truncation does not change period totals. Legacy single-episode fields keep the inclusive-date attribution window for compatibility, so their P/L can differ from negative depth. The marked-account `drawdownEpisodesFromEquity` interface and behavior are unchanged.

This note does not bump a version or publish a release.
