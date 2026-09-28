import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Owned by the tradeblocks-skills plugin (#4167); the server does not install or invoke it.
const captureSkill = "/tradeblocks:oo-capture";
const optimumSkill = "/tradeblocks:is-this-optimum-real";

const dataIntegrity = `Keep Option Omega (OO) and TradeBlocks (TB) evidence separate.
Never re-type OO trade data from tool responses: move bytes via a file. Quote OO
headline CAGR, max drawdown, MAR, Sharpe and Sortino under OO's label only;
never recompute them under that label. Label trade-realized statistics as TB's,
and never describe trade-realized drawdown as OO's marked-equity drawdown. OO
isIgnored rows and still-open trades are not closed economic trades. OO profit
already includes fees; never subtract fees twice. The user's OO MCP server name
is unknown: find its tools by their names, not a hard-coded server prefix.`;

export function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    "bring-in-oo-backtest",
    {
      title: "Bring in an OO backtest",
      description: "Import an Option Omega trade log as a TradeBlocks block",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Bring the requested Option Omega backtest into TradeBlocks.
Use OO list_backtests and get_saved_backtest to identify the source and
get_backtest_results for OO's own headline figures; ask for the source if
ambiguous. If the tradeblocks-skills Claude Code plugin is installed, use its
${captureSkill} skill for the selected saved backtest (or scratch run by runId).
Its verified capture handles OO get_trade_log; do not manually transcribe pages.
Otherwise ask the user to export OO's trade log CSV and save it at a path readable
by the TradeBlocks server (for Docker/HTTP, inside the server's mounted data
directory), then call TB import_csv with that file path. If there is no
server-readable CSV, stop and say import cannot proceed; never reconstruct CSV
from OO responses. Verify the resulting block with get_block_info and
get_statistics, and report provenance and any missing marked daily curve.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "is-this-optimum-real",
    {
      title: "Is this optimum real?",
      description: "Test an OO optimizer lead against two captured scratch runs",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Evaluate the requested OO optimization, not just its ranking.
Read OO get_optimization_results pages in context, without importing cells.
Choose the best cell under the metric used to rank this optimization and the
centre of the broadest stable region; state the neighbourhood/tolerance rule
used to judge stability. Call out a boundary optimum, flat grid, tied regions
or too few cells instead of inventing a plateau. If winner and centre are the
same cell, make only ONE scratch run and skip the paired test for that reason.
Read OO get_saved_backtest for the base configuration. Change only candidate
coordinates in memory and call OO run_backtest for each distinct candidate.
Do not use OO save_backtest, replace_saved_backtest, edit_saved_backtest, or
any save_*, replace_* or edit_* tool. Poll OO get_backtest_status for each runId
until complete; stop on failure or cancellation. Quote each completed run's
get_backtest_results headline as OO's own figures.

If the tradeblocks-skills Claude Code plugin is installed, invoke
${optimumSkill}. For each distinct runId use ${captureSkill} to capture
get_backtest_results and unfiltered, contiguous get_trade_log pages; verify
each run's source identity and reconcile its trade P/L to the cent separately.
Do not proceed with an unverified capture. For two distinct verified runs,
use oo-capture combine with both capture IDs and distinct best/centre Strategy
labels. Import the trade-only comparison CSV ONCE with TB import_csv using
plBasis: net_includes_fees and no dailyLogPath. Do not attach either OO curve
to this comparison block or call its trade-derived curve a marked curve.
Check each arm's count and SUM(pl) via TB run_sql grouped by strategy against
that run's verification. On this one block run TB run_walk_forward,
run_monte_carlo and analyze_edge_decay for EACH arm using its strategy filter;
run paired_bootstrap_comparison with strategyA=best and strategyB=centre.
Report its mode, jointly traded days and arm-only days, interval and status
(or its refusal); never silently replace a refused paired test with zero.
If winner equals centre, analyze the one verified run without claiming a
best-minus-centre comparison.

Without the plugin, ask the user to export each scratch run's trade-log CSV
to a path readable by the TB server (Docker/HTTP: inside its mounted data
directory). If no server-readable CSV is available, stop; never reconstruct
trades from OO responses. Import each distinct run into a SEPARATE block
with TB import_csv (plBasis: net_includes_fees), verify with get_block_info
and get_statistics, then run run_walk_forward, run_monte_carlo,
analyze_edge_decay and paired_bootstrap_comparison against zero (strategyA
only) per block. Compare the blocks side by side, but state explicitly that
NO paired difference between the runs ran. Never describe a test against
zero as best minus centre.

Give a verdict naming each test's result, evidence and limit, including any
insufficient-data outcomes. Neighbourhood cells are leads, not findings.
The paired best-minus-centre interval answers only whether their difference
is distinguishable from noise on jointly traded days; it is NOT adjusted
for selecting coordinates from the grid. Walk-forward, Monte Carlo and edge
decay are single-tape diagnostics on the history used for selection, not
out-of-sample confirmation; OO-executed select/confirm is separate work.
Never call a setting robust from ranking or a confidence interval alone.
Do not label a TB-recomputed figure as OO's.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "stress-oo-portfolio",
    {
      title: "Stress an OO portfolio",
      description: "Examine portfolio trade risk in TradeBlocks",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Stress the requested Option Omega portfolio's trades.
Use OO list_portfolios, get_saved_portfolio and get_portfolio_results to establish
identity and quote OO's own figures. Use an existing TradeBlocks block if it
contains that portfolio's economic trades; otherwise ask the user to export the
portfolio trade-log CSV from OO and save it at a path readable by the TB server
(Docker/HTTP: inside the mounted server data directory), then use import_csv.
Do not claim the saved-backtest capture skill captures portfolios; it does not.
If the portfolio CSV is unavailable, stop without a stress verdict; never build
it from OO get_trade_log responses. Use list_blocks and get_block_info to
select/verify the block, then TB portfolio_health_check, stress_test,
drawdown_attribution, get_correlation_matrix, get_tail_risk and
marginal_contribution as applicable to the block's strategies and history.
Explain missing coverage, scenario assumptions and trade-realized limitations;
do not mistake historical closed-trade stress for intratrade or marked-account
exposure.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "live-vs-oo",
    {
      title: "Live vs OO",
      description: "Compare live fills in a reporting log with an OO reference backtest",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Compare the user's live trades with an Option Omega reference backtest.
The OO reference must be a TradeBlocks block of OO's trades. If it is not one
yet, bring it in as the bring-in-oo-backtest prompt does (${captureSkill} or an
OO trade-log CSV with import_csv). Use list_blocks and get_block_info to select
and verify the block; ask if ambiguous. Name the OO reference as the capture
recorded it: a scratch run by its runId; a saved backtest by its
savedBacktestId and capture date, saying a saved backtest can be edited or
re-run in OO, so it is not a pinned run. For a block imported from CSV, ask
which OO backtest or run it came from and report that as the user's statement.
TB compares trades only within one block. The user's reporting log (live
trades CSV) must be in that block's own folder in the TB server's blocks
directory, beside its trade log, ideally named reportinglog.csv (Docker/HTTP:
inside the mounted data directory). Do not import_csv it: that makes a separate
block no comparison tool can pair. Ask the user to place the file; never write,
edit or re-type its rows. Confirm it with get_reporting_log_stats; with no
reporting log, stop and say no live comparison was run. Trades match on date,
exact strategy name and opening minute; OO trades with no strategy name take the
block ID as their name. Compare the strategy names from get_block_info and
get_reporting_log_stats; if they differ, tell the user which, and let them
decide how to align them; never rename or edit files yourself. Run each tool on
that block with scaling "perContract", so live and OO sizes compare per
contract. First run analyze_live_alignment; pass its overlapDateRange as the
dateRange of the others, so reference trades outside live coverage are not
counted as missed. Then run compare_backtest_to_actual with detailLevel
"trades" (its default summary level pairs by date and strategy only) and
matchedOnly true (otherwise its totals add unmatched trades; it still counts
them), analyze_discrepancies and analyze_slippage_trends. Report the matched
and unmatched trade counts and the dates compared, and each tool's
insufficient-data or error result by name. With no matched trades, give no
slippage verdict. Slippage here is live P/L versus the
reference's per-trade realized P/L, per contract, not OO's marked equity;
matching within one minute is order-dependent. The tools use the block's
recorded P/L basis: deduct no fees yourself.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );
}
