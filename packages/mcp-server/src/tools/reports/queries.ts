/**
 * Report Query Tools
 *
 * This module previously contained:
 * - run_filtered_query: Apply filter conditions to trades
 * - aggregate_by_field: Bucket trades by field values
 *
 * These tools were REMOVED in v0.6.0.
 *
 * Migration: Use `run_sql` with SQL queries instead:
 *
 * run_filtered_query replacement:
 *   SELECT COUNT(*) as matches, SUM(pl) as total_pl
 *   FROM trades.trade_data
 *   WHERE block_id = 'my-block' AND pl > 100 AND strategy ILIKE '%iron%'
 *
 * aggregate_by_field replacement:
 *   SELECT
 *     CASE WHEN VIX_Close < 15 THEN '10-15'
 *          WHEN VIX_Close < 20 THEN '15-20'
 *          ELSE '20+' END as bucket,
 *     COUNT(*) as trades,
 *     SUM(pl) as total_pl
 *   FROM trades.trade_data t
 *   JOIN market.enriched m ON t.date_opened = m.date
 *   LEFT JOIN market.spot_daily vix_s ON vix_s.date = m.date AND vix_s.ticker = 'VIX'
 *   WHERE t.block_id = 'my-block'
 *   GROUP BY bucket
 */

// No tools registered - module kept for documentation purposes
