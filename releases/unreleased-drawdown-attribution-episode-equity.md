# Unreleased — drawdown_attribution reports the selected episode's own peak and trough

**Bug fix: `drawdown_attribution` peak and trough equity.** `drawdownPeriod.peakEquity` and `troughEquity` now describe the episode the tool selected. Before, they came from the highest equity reached anywhere in the trade log. When the worst drawdown was followed by a later new high, those fields disagreed with the episode's `peakDate`, `troughDate`, `maxDrawdown` and `maxDrawdownPct`. Episode selection, the dates, the drawdown amount and percentage, and the strategy attribution are unchanged.

**The selection rule is now documented.** The tool picks the episode with the largest **dollar** drawdown on closed-trade equity. That equity is built from each trade's reported P/L, in close-date order. It is not the episode with the largest percentage drawdown, and it is not taken from the daily NLV log.

**Library consumers:** `buildRealizedDrawdownAttributionByCloseDate` in `@tradeblocks/lib` returns the same shape, with the corrected `peakEquity` and `troughEquity`.

This note does not bump a version or publish a release.
