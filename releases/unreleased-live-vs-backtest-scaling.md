# Unreleased — live-vs-backtest comparisons scale each figure once

Two corrections to the live-versus-backtest comparisons under `scaling: "toReported"`. Both change existing output values.

**Behaviour change to `analyze_live_alignment` (and `analyzeLiveAlignment` in `@tradeblocks/lib`).** Under `toReported`, the per-strategy `backtestPerContract` and `perContractGap` scaled the backtest P/L twice. They took the backtest P/L already scaled to the reported contract count and divided it again by the backtest contract count. Each per-contract figure is now that side's own P/L divided by its own contract count, so it is the same in every scaling mode. For example, a $1,000 backtest trade on 10 contracts matched to a $190 live trade on 2 contracts now reports $100 backtest per contract, $95 actual per contract, and a gap of −$5. Previously it reported $20 backtest per contract and a gap of +$75. `efficiency`, direction agreement, the totals, and the `raw` and `perContract` outputs are unchanged.

**Behaviour change to `compare_backtest_to_actual`.** Under `toReported` with `matchedOnly: false`, `summary.totalBacktestPl`, `totalActualPl`, `totalSlippage` and `avgSlippagePercent` are now computed from matched rows only, which is what `matchedOnly: true` already did. Previously these totals added unmatched backtest rows at their own contract size to matched rows scaled to the reported size, and added unmatched live P/L to the actual side. As a result, `totalSlippage` mixed two scales and was not execution slippage.

Unmatched rows still appear in `comparisons` and `groups`, and their P/L is still reported separately in `summary.unmatchedBacktestPl`, `summary.unmatchedActualPl` and `unmatchedSummary`, each row at its own contract size. The summary `note` and the tool description state this basis. `groups[].totalSlippage` and `avgSlippage` already covered only matched rows and are unchanged. Under `raw` and `perContract`, every row shares one scale, and totals with `matchedOnly: false` still include unmatched rows as before.

Inputs, other tools, and the web app are unchanged. This note does not bump a version or publish a release.
