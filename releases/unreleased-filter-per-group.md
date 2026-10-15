# Filter curves: chosen-threshold regime breakdowns

`filter_curve` accepts `groupBy` for a registered dataset or built-in market field, with optional numeric `bins`. Every field's chosen threshold gains `perGroup` rows alongside `perYear`, using the same covered baseline, uncovered counts/P&L, kept/removed statistics, objective delta and small-sample warnings. Groups do not fit separate thresholds or expand the permutation search.

Numeric grouping reuses `analyze_regime_performance`'s explicit cut points or quartiles. Categories group by value. Missing group values are retained in an explicit `uncoveredGroup: true` row, so all selected observations partition the totals. Group values use the shared causal resolver and honor `maxMissedSessions`. Day mode refuses varying or partially missing within-day group values as `day_group_varies`, listing affected dates. Unknown group fields and invalid/incompatible bins refuse by name. Omitting `groupBy` leaves outputs unchanged.

Field-named analysis now asks the existing causal resolver for only the fields it uses: filter/group fields, `get_field_statistics`, explicit-field `suggest_filters` and `analyze_regime_performance`, and the profile filter fields and comparison operands consumed by `validate_entry_filters` and `analyze_structure_fit`. This also fixes large-filter latency caused by unrelated sparse datasets being resolved and aged for every trade. Field selection does not alter timing, freshness or coverage. Exhaustive predictive ranking still needs all fields; paginated `enrich_trades` still returns all fields by design.

The runtime catalog now recognizes the built-in `Trend_Direction` varchar as categorical using the existing context field-type metadata. Its values still come from the prior session; regime grouping no longer incorrectly sends them through numeric bins.

**Behavior change:** varchar market fields such as `Trend_Direction` are now categorical. This changes `suggest_filters` to propose categorical equality exclusions and `analyze_regime_performance` to report category segments instead of numeric bins for those fields.

Missing group values now use `group: null`, `groupValue: null`, and `uncoveredGroup: true`. A real category named `"uncovered"` remains distinct.
