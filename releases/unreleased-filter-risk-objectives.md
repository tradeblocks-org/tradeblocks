# Filter curves: daily risk objectives

`filter_curve` adds `sharpe`, `mar`, and `maxDrawdown` objectives for `unit: "day"`. Covered entry dates remain on the curve, with removed dates flat at zero. Each threshold reports risk metrics and its baseline-relative objective delta; month permutation reruns the same full objective sweep, including the permuted baseline path.

- Sharpe uses daily dollar P&L, zero risk-free rate, sample standard deviation and √252. This needs no capital and intentionally differs from portfolio return Sharpe's Treasury-rate convention. Zero variance gives 0, matching the reused simulation helper.
- MAR uses calendar-span CAGR (365.25 days/year) divided by drawdown as a fraction of observed starting capital. An assumed default is not evidence: absent capital gives `mar_requires_capital`. Undefined MAR is explicitly null, candidates name `mar_undefined`, and no eligible MAR candidate is refused by name.
- Maximum drawdown is positive dollars and, when capital is available, percent of starting capital. Ranking uses **baseline minus kept drawdown**, so smaller drawdown is better, with existing P&L/win-rate tie-breaks.

Trade units refuse all three as `objective_requires_day`. `objectiveMetadata` states definitions, flat-day treatment, capital and undefined cases. Admission includes path work. Existing objectives and omitted-option outputs are unchanged.

The shared lib now exports the existing `calculateSharpeRatio` and `calculateMaxDrawdown` helpers. Drawdown retains its relative default and additionally accepts an `absolute` basis for ordered cumulative dollar P&L, beginning at zero.
