# New tool: get_rule_calendar

`get_rule_calendar` checks a strategy's entries against its stated entry rule:
the entry weekdays, the stated days to expiry and an optional entry window. It
reports the rule days without an entry, entry dates that are not rule days,
the stated and actual DTE per year, and the entries outside the entry window.

Rule days are NYSE sessions on the rule's weekdays (XNYS calendar, 2013-2030),
so an exchange holiday is never counted as missing. DTE is counted in calendar
days to the front leg's expiry from the Option Omega legs column; an expiry
that is not a real calendar date (such as `Feb 30`) is unresolved, never a DTE.
With `selection: "firstAtLeast"` the tool checks that the observed DTE meets the
stated minimum: an entry above it is reported as such but does not break the
rule; with `"exact"` every other DTE does. A backtest whose "7 DTE" Monday
entries landed at 11 or 18 DTE in a year without daily expiries shows up as a
mismatch share of 100 % for that year.

The trade log has no listing data, so the tool does not check whether an entry
took the first eligible listed expiry; the report says so in
`dte.firstListedCompliance` (`"not_checked"`). Entries without an entry time, or
with a malformed one, are reported apart and not counted inside or outside the
entry window.
