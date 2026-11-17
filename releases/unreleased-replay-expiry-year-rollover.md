# Replay: January legs of December entries resolve to the next year

Option Omega trade logs name each leg's expiry without a year (`Jan 16`).
`replay_trade` in tradelog mode gave every leg the year of the trade's open date.
That put the January leg of a December entry, such as the back month of a
calendar or diagonal, in January of the same year, before the trade opened.
The replay then found no quotes and refused the trade, or priced the wrong
contract. `analyze_exit_triggers`, `batch_exit_analysis`, `decompose_greeks` and
`get_greeks_attribution` reach the replay through the same path and refused or
skipped the same trades.

When an expiry would fall before the open date, it now moves to the next year.
A leg that expires on its open date keeps that year. Trades with no rollover
leg replay exactly as before. Explicit `legs[]` input (hypothetical mode)
carries full expiry dates and is unchanged. Tool inputs and outputs are the
same shape, and there is nothing to migrate. Rerun any analysis that refused
or skipped late-December entries.
