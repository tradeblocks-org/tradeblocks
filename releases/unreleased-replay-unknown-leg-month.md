# Replay: an unrecognized leg month is refused instead of read as January

In tradelog mode, `replay_trade` read the month of each Option Omega leg's
expiry (`Mar 13`) from a table that knew only `Jan`-style spellings. Any other
word, including an upper-case `MAR`, silently became January, and since the
year-rollover fix that January date could also move into the next year. The
replay then priced the wrong contract without saying so.

Months now match regardless of case, so `MAR 13` resolves to March. A word
that is not a month is refused with an error naming it, as an unparseable leg
already is. Option Omega writes `Jan`-style months, so existing trade logs
replay exactly as before. `analyze_exit_triggers`, `batch_exit_analysis`,
`decompose_greeks` and `get_greeks_attribution` reach the replay through the
same path. Tool inputs and outputs are the same shape, and there is nothing to
migrate.
