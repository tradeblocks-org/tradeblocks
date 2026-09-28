import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Owned by the tradeblocks-skills plugin (#4167); the server does not install or invoke it.
const captureSkill = "/tradeblocks:oo-capture";

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
Read OO get_optimization_results (paged, in context; do not import optimizer
cells) and identify the top-scoring cell and the centre of the broadest stable
region. Read OO get_saved_backtest for the base configuration; change only the
candidate coordinates in memory and call OO run_backtest twice as scratch runs,
one per candidate. Do not use OO save_backtest, replace_saved_backtest,
edit_saved_backtest, or any save_*, replace_* or edit_* tool. run_backtest
returns before the run finishes: poll OO get_backtest_status for each runId until
it completes, and stop if a run fails or is cancelled. Then use
get_backtest_results by runId for each run's OO figures. Bring each run's trade
log into a separate TB block: when the tradeblocks-skills plugin is installed
use ${captureSkill} with each runId (OO get_trade_log); otherwise have the user
export a CSV for each scratch run to a path the TB server can read and call
import_csv for each. For Docker/HTTP the files must be inside the mounted server
data directory. If either server-readable CSV is unavailable, stop: the
robustness verdict cannot be reached. Verify each block with get_block_info and
get_statistics. Run TB run_walk_forward, run_monte_carlo, analyze_edge_decay
and paired_bootstrap_comparison (strategyA only: that run versus zero) on each
block, and set them side by side with compare_blocks. paired_bootstrap_comparison
reads one block, so it cannot test one run minus the other across two blocks;
never pass both arms from the same block as if they were the two runs. Name each
test's result, including insufficient-data outcomes, state that no paired
difference test between the runs was run, and explain what the evidence does or
does not establish. An optimizer ranking is only a lead, never a finding; no
verdict from optimizer cells alone.
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
}
