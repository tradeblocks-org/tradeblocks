# Unreleased — Causal multi-member book walk-forward

`walkForwardBook({ input, folds, fit, policies, initialRules? })` is a new, pure calculation for multi-member books.

**Fitting.** For each declared fold it calls a caller-supplied fit with only the training sessions strictly before the fold origin. Future closes are redacted to an out-of-axis close with zero P/L, and future marks are removed. Marks already known on still-open positions remain. When a fit is unavailable, the previous rules (or the declared `initialRules`) are carried, and the carry is recorded with its reason and the member(s) that caused it.

**Replay.** The frozen fold rules become one `sizingSchedule`. It is replayed once per declared ignored-buying-power policy over one continuous real-member ledger, so funds, held positions and concurrency persist across folds.

**Results.** Each fold reports:

- attainment;
- participation, separating zero-quantity active entries from scheduled-disabled entries;
- a logical computation ledger.

`fitBookAtEqualRisk(training, recipe, previous?)` is one book-generic recipe: standalone equal marked-drawdown risk with a declared common-factor search, rounding and repair. Its `noTrainingEntries` parameter is required:

- `unavailable` makes the fold unavailable and names the member(s) with no training entries.
- `carry-member` fits the remaining members and carries each empty member's prior rule.

The fit budget then excludes carried members; replayed drawdown measures the combined schedule.

Existing exports and behaviour are unchanged, including `replayBook`, `searchBookAtDrawdown` and `singleTapeWalkForwardByTrades`. No provider, file or network access is added. Results screen and order candidates; they are not broker or backtester evidence.
