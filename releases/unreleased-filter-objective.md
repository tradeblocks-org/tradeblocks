# Filter suggestion objectives and sample-size support

## Behavior change

`suggest_filters` now defaults to `objective: "totalPl"` on both the default market path and the optional fields path. It admits only positive P&L improvements and ranks by P&L improvement, with win-rate gain as tie-breaker. This changes public default output. Select `objective: "winRate"` for win-rate admission/ranking with P&L tie-breaks.

`minImprovementPct` remains a win-rate percentage-point threshold (default 3) under `winRate`. It is ignored under `totalPl`; no percentage P&L meaning is inferred. The response notes this when the argument was supplied.

`minImprovementThreshold` is now `null` under `totalPl`, the new default; previously it was always a number.

Composite projected metrics now describe **kept** trades, fixing the prior calculation on excluded trades. Composites use the same admission and ranking objective as standalone suggestions; the separate >2-point standalone-relative gate is removed.

On the fields path, sample-size support previously used at least 100 kept trades for high and 30 for medium. It now uses the shared rule: high requires at least 20 kept and 10 removed, medium requires 10 kept and 5 removed, and retention below 20% caps support at low.

## Output

Responses name the objective and ranking rule. Every suggestion includes kept count/fraction and removed count. The compatible `confidence` key is explicitly sample-size support, not statistical confidence: high needs 20 kept/10 removed, medium 10 kept/5 removed, otherwise low. Retention below 20% always caps support at low and adds a low-retention warning.
