# Replay: Option Omega legs on the SPX monthly expiration replay SPXW

Option Omega trade logs name the underlying `SPX` for every SPX trade. On the
AM-settled monthly expiration (the third Friday, or the Thursday before it when
that Friday is an exchange holiday), `replay_trade` in tradelog mode replayed
those legs as the `SPX` monthly contract. Option Omega fills them from the
PM-settled `SPXW` contract instead: its fills equal the `SPXW` mid at the entry
minute, not the `SPX` monthly's. The replay priced a different contract from
the one in the trade. Its first bar already showed a profit or loss equal to the
gap between the two contracts' prices, and `replay_trade`'s `totalPnl` (measured
from the fills) disagreed with `decompose_greeks`' `totalPnlChange` (measured
from the first bar) by that amount.

A tradelog leg in Option Omega format now replays the `SPXW` contract on a
monthly expiration, and the output leg's `occTicker` shows `SPXW`. If no `SPXW`
quotes are cached, the replay returns an error naming that contract; it does
not fall back to the `SPX` monthly. This reverses, for Option Omega tradelog
legs only, the 4.5.1 statement that replay never substitutes `SPXW` on a
monthly expiration.

What changes: replay paths, totals and MFE/MAE for Option Omega trades with a
leg on a monthly expiration, and the results that `analyze_exit_triggers`,
`batch_exit_analysis`, `decompose_greeks` and `get_greeks_attribution` derive
from them. A trade that replayed only because `SPX` monthly quotes were cached
now needs `SPXW` quotes for that expiration. Rerun analyses of such trades.

What does not change: every other trade replays exactly as before. Explicit
`legs[]` (hypothetical mode) with `ticker: "SPX"` still replays the `SPX`
monthly, and `ticker: "SPXW"` still replays `SPXW`. Tradelog legs without
Option Omega per-leg prices are unchanged. Tool inputs and outputs keep the same
shape.

The docs now also state why `replay_trade` and `decompose_greeks` totals can
differ: by the first bar's P&L, the gap between the entry prices and the first
mids.
