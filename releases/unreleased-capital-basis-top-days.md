# Statistics: capital basis, P&L without the best days, yearly returns

`get_statistics` and `get_period_returns` take an optional `capitalBasis`:
`fixed` divides every return by the same amount, `compounding` by the amount
plus all earlier P&L. `get_statistics` then adds the total return and the
drawdown on that basis. With `topDays` (for example `[1, 5, 10]`),
`get_statistics` also reports net P&L without the best N days, the share of
total P&L those days carry, and the share of calendar years with positive net
P&L, so a result that hangs on a few days is visible at a glance.
`get_period_returns` gains `period: "yearly"` and, with a capital basis, a
`returnPct` per period. Without the new inputs both tools respond exactly as
before.
