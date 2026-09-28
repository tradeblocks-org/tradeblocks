import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  McpError,
  type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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

// Names the arguments the user supplied; empty when the prompt was called without any.
function givenArguments(args: Record<string, string | undefined>): string {
  const given = Object.entries(args).flatMap(([name, value]) =>
    value?.trim() ? [`${name} = ${JSON.stringify(value.trim())}`] : [],
  );
  return given.length ? `Arguments given: ${given.join("; ")}.\n` : "";
}

type PromptArgs = Record<string, z.ZodOptional<z.ZodString>>;
type PromptConfig = { title: string; description: string; argsSchema: PromptArgs };
type RenderPrompt = (args: Record<string, string | undefined>) => GetPromptResult;

export function registerWorkflowPrompts(server: McpServer): void {
  const prompts = new Map<string, { args: z.ZodObject<PromptArgs>; render: RenderPrompt }>();
  const register = (name: string, config: PromptConfig, render: RenderPrompt) => {
    server.registerPrompt(name, config, render);
    prompts.set(name, { args: z.object(config.argsSchema), render });
  };

  register(
    "bring-in-oo-backtest",
    {
      title: "Bring in an OO backtest",
      description:
        "Import an Option Omega backtest's trade log and marked daily curve as a TradeBlocks block",
      // Claude Code passes prompt arguments positionally, split on whitespace, so
      // each is one token and the most-used argument comes first.
      argsSchema: {
        ooId: z
          .string()
          .optional()
          .describe("OO savedBacktestId or a scratch run's runId; tried as savedBacktestId first"),
        block: z.string().optional().describe("Name for the new TradeBlocks block"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Bring the requested Option Omega backtest into TradeBlocks.
${givenArguments(args)}Identify the OO source; ask the user if it is ambiguous. A saved backtest:
find it with OO list_backtests and read it with get_saved_backtest, whose result
holds OO's own headline figures. A scratch run: poll OO get_backtest_status with
its runId until it completes, then read get_backtest_results by that runId.
get_backtest_results takes only a runId; never pass it a savedBacktestId. Given
an ooId, try it as a savedBacktestId with get_saved_backtest first, and treat it
as a runId only if OO has no saved backtest with that ID. Given a block, use it
as the new block's name. If the tradeblocks-skills Claude Code plugin is
installed, use its ${captureSkill} skill for the selected saved backtest (or
scratch run by runId). Its verified capture handles OO get_trade_log and the
marked daily curve; do not manually transcribe pages. Otherwise ask the user to
export both OO's trade log CSV and its daily log CSV and save them at paths
readable by the TradeBlocks server (for Docker/HTTP, inside the server's mounted
data directory). Then call TB import_csv once, with csvPath set to the trade log
and dailyLogPath set to the daily log, so one block holds OO's trades and OO's
marked daily curve. If only the trade log is available, import it without
dailyLogPath and say plainly that the block has no OO marked daily curve, so
its drawdown is trade-realized only. If there is no server-readable trade-log
CSV, stop and say import cannot proceed; never reconstruct CSV from OO
responses. Verify the resulting block with get_block_info (tradeCount and
dailyLogCount) and get_statistics, and report provenance and whether OO's
marked daily curve is present.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );

  register(
    "is-this-optimum-real",
    {
      title: "Is this optimum real?",
      description: "Test an OO optimizer lead against two captured scratch runs",
      argsSchema: {
        optimizationId: z.string().optional().describe("OO optimizationId to evaluate"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${givenArguments(args)}Evaluate the requested OO optimization, not just its ranking.
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
Report its mode, per-arm observedDays, interval and status (or its refusal);
never silently replace a refused paired test with zero. The tool does not
report shared days: derive jointly held, best-only and centre-only days with
TB run_sql over the block's trade open-to-close dates, check the per-arm
counts equal observedDays, and report them.
If winner equals centre, import that one verified capture's CSV with TB
import_csv (plBasis: net_includes_fees), check its count and SUM(pl) against
the verification, run the three single-arm tests on that block, and skip the
paired test, saying why; claim no best-minus-centre comparison.

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

  register(
    "stress-oo-portfolio",
    {
      title: "Stress an OO portfolio",
      description: "Examine portfolio trade risk in TradeBlocks",
      argsSchema: {
        ooId: z
          .string()
          .optional()
          .describe(
            "OO savedPortfolioId or a scratch run's runId; tried as savedPortfolioId first",
          ),
        block: z
          .string()
          .optional()
          .describe(
            "TradeBlocks block ID holding the portfolio's trades, or a name for its import",
          ),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Stress the requested Option Omega portfolio's trades.
${givenArguments(args)}Identify the OO portfolio; ask the user if it is ambiguous. A saved portfolio:
find it with OO list_portfolios and read it with get_saved_portfolio, whose
result holds OO's own figures. A portfolio scratch run: poll OO
get_portfolio_status with its runId until it completes, then read
get_portfolio_results by that runId. get_portfolio_results takes only a runId;
never pass it a savedPortfolioId. Given an ooId, try it as a savedPortfolioId
with get_saved_portfolio first, and treat it as a runId only if OO has no saved
portfolio with that ID. Given a block, check it with get_block_info: use that
block if it exists, otherwise use it as the imported block's name. Use an
existing TradeBlocks block if it contains that portfolio's economic trades.
Otherwise, in plugin-capable clients, ${captureSkill} can capture a saved
portfolio as a strategy-labelled block with its whole-book daily curve.
Without that plugin, ask the user for OO's portfolio trade-log CSV at a path
readable by the TB server (Docker/HTTP: inside the mounted data directory),
and import_csv, including dailyLogPath if the daily-log CSV is available.
If neither capture nor a server-readable CSV is available, stop without a
stress verdict; never build it from OO get_trade_log responses. Use list_blocks
and get_block_info to select/verify the block, then TB portfolio_health_check,
stress_test, drawdown_attribution, get_correlation_matrix, get_tail_risk and
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

  register(
    "live-vs-oo",
    {
      title: "Live vs OO",
      description: "Compare live fills in a reporting log with an OO reference backtest",
      argsSchema: {
        block: z.string().optional().describe("TradeBlocks block ID of the OO reference backtest"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Compare the user's live trades with an Option Omega reference backtest.
${givenArguments(args)}The OO reference must be a TradeBlocks block of OO's trades. If it is not one
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

  register(
    "allocate-oo-portfolio",
    {
      title: "Allocate an OO portfolio",
      description:
        "Propose strategy allocations from TradeBlocks and check them in an OO portfolio run",
      argsSchema: {
        ooId: z
          .string()
          .optional()
          .describe("OO savedPortfolioId or a scratch portfolio runId; try the saved ID first"),
        block: z
          .string()
          .optional()
          .describe("TradeBlocks block ID with this portfolio's member strategies, or import name"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find allocations for the requested Option Omega (OO) portfolio.
Use TradeBlocks (TB) as a proposal lab and OO as the portfolio check.
${givenArguments(args)}Identify the source and baseline first. For a saved
portfolio, use OO list_portfolios and get_saved_portfolio with savedPortfolioId
to read its member savedBacktestId values, settings, existing allocations and
OO headline figures. For a scratch portfolio runId, wait on
get_portfolio_status, then read get_portfolio_results; never pass a
savedPortfolioId to get_portfolio_results. If ooId was supplied, try it as a
savedPortfolioId first, then as a runId only if no saved portfolio has that ID.
Ask the user when source, block or constraints are ambiguous.

Use list_blocks and get_block_info to identify a TB block containing all of
this portfolio's economic member trades under distinct, case-insensitively
unique Strategy labels. Check the label-to-OO-member mapping; two members with
the same name must not merge. When the running client has the tradeblocks-skills
plugin, use its ${captureSkill} portfolio capture for a saved OO portfolio to
obtain a strategy-labelled block and the whole-book marked daily curve.
Otherwise ask for the portfolio's OO trade-log CSV export and optional
daily-log CSV export at paths readable by the TB server (Docker/HTTP: inside
the mounted data directory); call import_csv with csvPath, blockName and
dailyLogPath when available. If the CSV is unavailable or member labels cannot
be distinguished, stop the allocation proposal rather than transcribing OO
trade rows or inventing membership. Without the daily log, say the block has
no marked book curve.

On that verified block, use get_correlation_matrix, marginal_contribution and
get_tail_risk to diagnose overlap, marginal risk/return and joint tails; use
what_if_scaling and portfolio_health_check where supported to form a small,
explicit set of candidate allocation percentages, including the unchanged
baseline. State each candidate's member IDs, percentage changes, comparison
window, assumptions and trade coverage. TB's correlation, marginal, tail,
what-if and health results are trade-derived counterfactuals, not OO's marked
equity or OO headline figures. The daily log is a whole-book curve only; it
has no per-member marks. A TB proposal is a lead, never a verdict.

For each candidate, call OO run_portfolio with
{ parameters: { strategies: [{ savedBacktestId, allocationPercentage }, ...],
rangeStart, rangeEnd, startingFunds, ... } }. Take savedBacktestId from the
saved OO members (list_backtests if needed); retain the baseline's portfolio
settings and member sizing overrides other than the intended allocation
changes. The strategies share one startingFunds pool in OO;
allocationPercentage is each strategy's share of current funds per new trade
and percentages need not total 100. Do not sum standalone results or
substitute TB what-if scaling for the shared-funds run. Do not duplicate a run
while it is pending. Use the runId returned by run_portfolio with
get_portfolio_status, waiting pollAfterMs between calls until status is
complete, failed or cancelled. For complete only, call get_portfolio_results
with { runId } and read the OO book metrics and strategyResults. A candidate is
OO-tested only after get_portfolio_status reports complete and
get_portfolio_results for that run has been read; failed, cancelled or unread
runs remain untested. Compare candidates to the baseline on OO's same window
and capital, label OO and TB numbers separately and explain changed exposure,
sample/selection limits and any missing evidence. One OO run is a diagnostic,
not a causal finding; a mechanism claim needs a direct lever test and
discrimination against confounds.

Never save, replace, archive or delete the user's saved portfolio. Only if
the user explicitly asks to save a candidate, create a new portfolio; never
replace the original.
${dataIntegrity}`,
          },
        },
      ],
    }),
  );

  // SDK 1.30 rejects a missing arguments field when a prompt has argsSchema,
  // even if every argument is optional. MCP allows prompts/get without it.
  server.server.setRequestHandler(GetPromptRequestSchema, ({ params }) => {
    const prompt = prompts.get(params.name);
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${params.name} not found`);
    }
    const args = prompt.args.safeParse(params.arguments ?? {});
    if (!args.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for prompt ${params.name}: ${z.prettifyError(args.error)}`,
      );
    }
    return prompt.render(args.data);
  });
}
