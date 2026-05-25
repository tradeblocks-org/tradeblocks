/**
 * Pure SQL builder for EnrichedStore reads (Market Data 3.0 — Phase 2 Wave 1).
 *
 * The enriched read supports two optional joins controlled by flags:
 *   - `includeOhlcv`   → LEFT JOIN a daily RTH aggregate of `market.spot`
 *   - `includeContext` → LEFT JOIN `market.enriched_context` for cross-ticker
 *                        VIX-family fields (Vol_Regime, Term_Structure_State,
 *                        Trend_Direction, VIX_Spike_Pct, VIX_Gap_Pct)
 *
 * Values are inlined as SQL literals — see `spot-sql.ts` header for the
 * extract_statements GC leak that ruled out positional parameters.
 *
 * Purity contract (PATTERNS.md "Pure SQL builders"; CONTEXT.md D-05): no `this`,
 * no `ctx`, no DB-connection value-level imports. Tests live in
 * `tests/unit/market/stores/enriched-sql.test.ts`.
 */
import { escapeSqlLiteral } from "../../utils/quote-parquet-projection.js";
import { rthDailyAggregateSubquery } from "./rth-aggregation.js";
import type { BuiltSQL } from "./spot-sql.js";

export interface BuildReadEnrichedArgs {
  ticker: string;
  from: string;
  to: string;
  includeContext: boolean;
  includeOhlcv: boolean;
}

function lit(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/**
 * Build the `SELECT ... FROM market.enriched ...` SQL, optionally joined with
 * the RTH daily aggregate from `market.spot` and the `market.enriched_context`
 * table.
 */
export function buildReadEnrichedSQL(
  args: BuildReadEnrichedArgs,
): BuiltSQL {
  const { ticker, from, to, includeContext, includeOhlcv } = args;

  const tickerLit = lit(ticker);
  const fromLit = lit(from);
  const toLit = lit(to);

  const ohlcvJoin = includeOhlcv
    ? `LEFT JOIN ${rthDailyAggregateSubquery({
        tickerLit,
        fromLit,
        toLit,
      })} s_daily
         ON s_daily.ticker = e.ticker AND s_daily.date = e.date`
    : "";

  const ctxJoin = includeContext
    ? `LEFT JOIN market.enriched_context c ON c.date = e.date`
    : "";

  const ohlcvCols = includeOhlcv
    ? ", s_daily.open, s_daily.high, s_daily.low, s_daily.close"
    : "";

  const ctxCols = includeContext
    ? ", c.Vol_Regime, c.Term_Structure_State, c.Trend_Direction, c.VIX_Spike_Pct, c.VIX_Gap_Pct"
    : "";

  const sql = `
    SELECT e.*${ohlcvCols}${ctxCols}
    FROM market.enriched e
    ${ohlcvJoin}
    ${ctxJoin}
    WHERE e.ticker = ${tickerLit} AND e.date >= ${fromLit} AND e.date <= ${toLit}
    ORDER BY e.date
  `;

  return { sql };
}
