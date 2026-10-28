# Replay: SPX weeklies, named missing-quote errors, and explicit legs after idle

Fixed three `replay_trade` defects reported in tradeblocks#585. They also
affected `analyze_exit_triggers`, `decompose_greeks`, `batch_exit_analysis`,
and `get_greeks_attribution`, which all run the same replay.

**SPX trades now replay against SPXW quotes.** Option Omega tradelogs record
the underlying as `SPX`, so tradelog replay built `SPX…` option tickers. SPX
weekly and daily contracts are PM-settled and listed as `SPXW`, and quotes are
stored under that name, so these trades found no quotes. When an `SPX`-root
leg on a weekly or daily expiration has no `SPX` quotes, replay now uses the
`SPXW` contract for that expiration. The leg's `occTicker` in the output shows
`SPXW`. This applies to tradelog mode and to explicit legs.

The `SPX` root itself lists only the AM-settled monthly contract (the third
Friday, or the Thursday before it when that Friday is an exchange holiday).
That is a different contract from the PM-settled `SPXW` expiring the same day,
so replay never substitutes one for the other. On a monthly expiration with no
`SPX` quotes, replay returns an error that names the `SPXW` contract. To replay
the PM-settled contract on that date, use explicit legs with `ticker: "SPXW"`.
`NDX` and `RUT` legs still match only their exact root.

**Missing quotes now return a named error instead of zeros.** Previously, a
replay with no usable quotes for any leg returned an empty path with MFE, MAE
and P&L all 0 and no warning. This happened even when only one leg among
several was missing. A failed quote read did the same. Those calls now return
an error. It names each affected leg's OCC ticker and the reason: no cached
rows, rows without a positive bid and ask from 09:32 ET, or no quote at or
after the trade's entry time. A failed quote read returns the database error.

- `analyze_exit_triggers` and `decompose_greeks` return the same error. They no
  longer report "No P&L data available" or a zero decomposition.
- `batch_exit_analysis` lists such trades under `skippedTrades` with the
  message, and leaves them out of the aggregate.
- `get_greeks_attribution` counts them in `trades_skipped`. Before, it counted
  them as decomposed trades with zero factors: their actual P&L entered
  `total_pnl` with no matching mark change, so it all landed in
  `execution_edge`. On blocks with missing quotes, `total_pnl`,
  `mark_total_pnl` and `execution_edge` now exclude those trades.

Callers that treated an empty `pnlPath` as "no data" should handle the error
instead.

**Explicit-leg replay works after the server goes idle.** Replays with `legs`
failed with "No active DuckDB connection" once the server had been idle for
about 3 seconds and had released its database handle. They now reopen the
handle the way tradelog replay does, and the handle is still released when
idle.

Replays that already succeeded, including every replay with `SPXW` legs,
return the same fields and values in all output formats.
