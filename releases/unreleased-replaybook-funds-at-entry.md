# Unreleased — Book replay funds at entry

The public `@tradeblocks/lib` calculation `replayBook` accepts optional `includeFundsAtEntry: true`, adding `fundsAtEntry` to each member's `contractsPerEntry` entry, including zero-quantity attempts. It records the closed funds sizing used after same-timestamp closes settle and before minimum-one, caps and admission. This is not marked equity or buying power remaining after reservations. Simultaneous entries follow the declared order; opens reserve buying power without spending closed funds.

The option works with `sizingSchedule` and `memberMarkedPl` without changing quantities, funds, marks or attribution. Omitting it preserves existing output bytes. No MCP tool interface changes, provider calls or market-data requirements are added.

Disabled schedule attempts also report their closed funds after same-timestamp settlement, without sizing or admitting a position. Held positions and disable/reinstate reporting remain unchanged.
