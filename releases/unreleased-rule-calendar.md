# New tool: get_rule_calendar

`get_rule_calendar` checks a strategy's entries against its stated entry rule:
the entry weekdays, the stated days to expiry and an optional entry window. It
reports the rule days without an entry, entry dates that are not rule days,
the stated and actual DTE per year, and the entries outside the entry window.

Rule days are NYSE sessions on the rule's weekdays (XNYS calendar, 2013-2030),
so an exchange holiday is never counted as missing. DTE is counted in calendar
days to the front leg's expiry from the Option Omega legs column. With
`selection: "firstAtLeast"` an entry above the stated DTE is reported as such
but does not break the rule; with `"exact"` every other DTE does. A backtest
whose "7 DTE" Monday entries landed at 11 or 18 DTE in a year without daily
expiries shows up as a mismatch share of 100 % for that year.
