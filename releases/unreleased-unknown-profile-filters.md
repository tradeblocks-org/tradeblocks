# Unreleased — Explicit unknown profile filter fields

`validate_entry_filters` now names unresolvable market filter fields and their reasons in `unresolvable_filters`, warnings, and the summary. Unknown filters are excluded from per-filter analysis and ablation, so they no longer empty the baseline for known filters. If no market filter is resolvable, the tool returns `error: "no_resolvable_filters"` naming the fields instead of an empty analysis.

`analyze_structure_fit` also reports unknown profile filter dimensions explicitly while retaining its fixed and known-field dimensions. Resolvability uses the built-in market field timing classifications, not the presence of values on particular dates. Known-field missing-data behavior and execution-only filter handling are unchanged. No dataset support or package version changes are included.
