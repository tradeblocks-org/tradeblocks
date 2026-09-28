/**
 * Report Tools
 *
 * Re-export from new module structure for backwards compatibility.
 *
 * Tools are now organized in separate files under ./reports/:
 * - fields.ts: get_field_statistics
 * - predictive.ts: find_predictive_fields, filter_curve
 * - discrepancies.ts: analyze_discrepancies
 * - strategy-matches.ts: suggest_strategy_matches
 * - slippage-trends.ts: analyze_slippage_trends
 */

export { registerReportTools } from "./reports/index.ts";
