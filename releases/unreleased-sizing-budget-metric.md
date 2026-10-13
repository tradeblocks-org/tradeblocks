# Unreleased — independent book sizing budget metric

The public `@tradeblocks/lib` helper `sizeBookAtEqualStandaloneRisk` accepts optional `bookBudgetRisk`: marked maximum drawdown in percentage points, or book expected shortfall at a declared confidence in loss-positive decimal units. Standalone references still fit the caller's `risk` and `standaloneTarget`; stage two selects against `bookBudgetRisk` and `bookBudget`. ES95 standalone fitting can therefore target a 5-percentage-point marked book drawdown budget without a separate caller search.

Explicit declarations return both metric units and the book risk-minus-budget residual. Omitting the option preserves the previous output exactly. Fixed contract caps, the deterministic `feasible` policy and the declared ignored-buying-power hypothesis remain unchanged. The finite-domain fit makes no exact-final-parity claim and reports `not attained within domain` when no book qualifies. This is library-only; no MCP tool changes.
