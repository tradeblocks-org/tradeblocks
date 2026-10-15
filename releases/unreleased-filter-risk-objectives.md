# Filter curves: daily risk objectives

`filter_curve` adds `sharpe`, `mar`, and `maxDrawdown` objectives for `unit: "day"`. Covered entry dates remain on the curve, with removed dates flat at zero. Each threshold reports risk metrics and its baseline-relative objective delta; month permutation reruns the same full objective sweep, including the permuted baseline path.

- Sharpe uses daily dollar P&L, zero risk-free rate, sample standard deviation and √252. This needs no capital and intentionally differs from portfolio return Sharpe's Treasury-rate convention. Zero variance gives 0, matching the reused simulation helper.
- MAR uses calendar-span CAGR (365.25 days/year) divided by drawdown as a fraction of observed starting capital. An assumed default is not evidence: absent capital gives `mar_requires_capital`. Undefined MAR is explicitly null, candidates name `mar_undefined`, and no eligible MAR candidate is refused by name.
- Maximum drawdown is positive dollars and, when capital is available, percent of starting capital. Ranking uses **baseline minus kept drawdown**, so smaller drawdown is better, with existing P&L/win-rate tie-breaks.

Trade units refuse all three as `objective_requires_day`. `objectiveMetadata` states definitions, flat-day treatment, capital and undefined cases. Admission includes path work. Existing objectives and omitted-option outputs are unchanged.

The shared lib now exports the existing `calculateSharpeRatio` and `calculateMaxDrawdown` helpers. Drawdown retains its relative default and additionally accepts an `absolute` basis for ordered cumulative dollar P&L, beginning at zero.

Sharpe and MAR use covered entry dates only, with filtered entry dates flat at zero; dates without covered entries are not inserted. Sharpe annualizes by √252; MAR retains calendar-span CAGR at 365.25 days per year.

Per-year and per-group subsets spanning fewer than 90 calendar days now suppress MAR and its annualized return: baseline, kept and removed report `mar: null`, `annualizedReturnPct: null`, and `marUnstable: true`. The row also carries `marUnstable: true`, and the MAR objective delta is null. Exactly 90 days remains eligible. This guard does not change whole-population objectives or permutation.

**Strategy capital correction:** supplying `strategy` never applies the whole portfolio's daily-log capital to that strategy's P&L. Like the performance-chart tool, filter curves use only observed funds evidence in the strategy-filtered trades. If it is absent, MAR returns `mar_requires_capital` with `capitalReason: "portfolio_capital_not_applicable_to_strategy"`. Sharpe and dollar drawdown remain available; drawdown percent is null with the same `percentReason`. Calls without a strategy filter retain the existing capital policy.

**Calendar and window corrections:** MAR annualization and the subset stability guard share a calendar-parts day span, so local-midnight DST offsets cannot change the elapsed calendar days. Date-windowed calls restrict daily-log capital evidence to the same `startDate`/`endDate` range as the trades; they no longer use the block's pre-window daily-log balance. Strategy-filtered calls continue to exclude portfolio daily logs entirely.
