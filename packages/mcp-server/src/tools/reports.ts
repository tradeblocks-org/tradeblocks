/**
 * Report Tools
 *
 * Re-export from new module structure for backwards compatibility.
 *
 * Tools are now organized in separate files under ./reports/:
 * - fields.ts: list_available_fields, get_field_statistics
 * - queries.ts: run_filtered_query, aggregate_by_field
 * - predictive.ts: find_predictive_fields, filter_curve
 * - slippage.ts: analyze_discrepancies, suggest_strategy_matches, slippage_trends
 */

export { registerReportTools } from "./reports/index.ts";
