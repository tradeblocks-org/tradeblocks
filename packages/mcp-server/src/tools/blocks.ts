/**
 * Block Tools
 *
 * Re-export from new module structure for backwards compatibility.
 *
 * Tools are now organized in separate files under ./blocks/:
 * - core.ts: list_blocks, get_block_info, get_statistics, get_reporting_log_stats, get_trades
 * - comparison.ts: get_strategy_comparison, compare_blocks, block_diff
 * - analysis.ts: stress_test, drawdown_attribution, marginal_contribution
 * - similarity.ts: strategy_similarity, what_if_scaling
 * - health.ts: portfolio_health_check
 */

export { registerBlockTools } from "./blocks/index.ts";
