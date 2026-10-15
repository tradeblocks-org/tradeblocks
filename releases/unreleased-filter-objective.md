# Filter suggestion objectives and sample-size support

## Behavior change

`suggest_filters` now defaults to `objective: "totalPl"` on both the default market path and the optional fields path. It admits only positive P&L improvements and ranks by P&L improvement, with win-rate gain as tie-breaker. This changes public default output. Select `objective: "winRate"` for win-rate admission/ranking with P&L tie-breaks.

`minImprovementPct` remains a win-rate percentage-point threshold (default 3) under `winRate`. It is ignored under `totalPl`; no percentage P&L meaning is inferred. The response notes this when the argument was supplied.

Composite projected metrics now describe **kept** trades, fixing the prior calculation on excluded trades. Composites use the same admission and ranking objective as standalone suggestions; the separate >2-point standalone-relative gate is removed.

## Output

Responses name the objective and ranking rule. Every suggestion includes kept count/fraction and removed count. The compatible `confidence` key is explicitly sample-size support, not statistical confidence: high needs 20 kept/10 removed, medium 10 kept/5 removed, otherwise low. Retention below 20% always caps support at low and adds a low-retention warning.
