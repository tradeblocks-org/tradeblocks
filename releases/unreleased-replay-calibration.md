# Unreleased — Replay calibration comparator

The public package and calculations entrypoints now export the pure
`compareReplayToNative(expected, observed, tolerances?)` calculation. Both sides
accept provider-neutral normalized ledgers, so a frozen prediction and a replay
can use the same comparison without a provider or market-data requirement.

The result names missing/extra entries, member and whole-contract quantity
mismatches, cent-precision per-unit net P&L mismatches, ending cash differences,
terminal open-position differences and curve-date differences. Marked drawdown
uses the same running-peak calculation on both curves, with a default inclusive
0.01 percentage-point tolerance. The result includes every dated equity residual
and labeled peak/trough residuals for each maximum drawdown episode.

Invalid ledgers and tolerances throw; absent dates fail explicitly rather than
being silently intersected. Existing replay calculations and interfaces are
unchanged. Caller normalization, evidence retention and tolerance policy remain
outside the library.
