/**
 * Rule Calendar Tool
 *
 * Checks a strategy's entries against the calendar its stated entry rule
 * implies (entry weekdays, stated DTE, entry window): missing rule days,
 * stated vs. actual DTE per year, and entries outside the entry window.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import { buildRuleCalendar, formatDateKey, type RuleCalendarReport } from "@tradeblocks/lib";
import { filterByStrategy } from "../shared/filters.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const ruleCalendarInputSchema = z.object({
  blockId: z.string().describe("Block folder name to analyze"),
  strategy: z
    .string()
    .optional()
    .describe("Strategy name (case-insensitive). Omit when the block holds one strategy."),
  rule: z
    .object({
      entryWeekdays: z
        .union([z.array(z.number().int().min(1).max(5)).min(1), z.literal("daily")])
        .describe("Entry weekdays, 1 = Monday ... 5 = Friday, or 'daily' for every session."),
      dte: z.number().int().min(0).describe("Stated days to expiry of the front leg."),
      selection: z
        .enum(["exact", "firstAtLeast"])
        .describe(
          "'exact': every entry must expire exactly dte calendar days out. 'firstAtLeast': " +
            "the first listed expiry at least dte calendar days out; only the minimum is " +
            "checked, not whether the entry took the first eligible listed expiry (the trade " +
            "log has no listing data).",
        ),
      entryWindow: z
        .object({
          from: z.string().regex(HHMM).describe("Earliest entry time, HH:mm"),
          to: z.string().regex(HHMM).describe("Latest entry time, HH:mm"),
        })
        .optional()
        .describe(
          "Inclusive entry window in the trade log's time zone. Entries without a time or " +
            "with a malformed time are reported separately, not inside or outside.",
        ),
    })
    .describe("The stated entry rule to check the entries against."),
  dateRange: z
    .object({
      start: z.string().regex(ISO_DAY).optional().describe("First rule day (YYYY-MM-DD)"),
      end: z.string().regex(ISO_DAY).optional().describe("Last rule day (YYYY-MM-DD)"),
    })
    .optional()
    .describe("Range of rule days. Defaults to the first through last entry date."),
  recordEnd: z
    .string()
    .regex(ISO_DAY)
    .optional()
    .describe(
      "Last day the trade log can report a close (YYYY-MM-DD), e.g. an Option Omega " +
        "backtest's rangeEnd: a position still open then is left out of the log or closed " +
        "that day. A rule day without an entry whose earliest expiry (open date + dte) falls " +
        "after it is reported in unobservableRuleDays instead of as missing. Omit for a log " +
        "that keeps reporting closes after the range.",
    ),
});

type RuleCalendarInput = z.infer<typeof ruleCalendarInputSchema>;

const METHODOLOGY =
  "Rule days are NYSE sessions (XNYS calendar v2, 2013-2030) on the rule's weekdays; a " +
  "holiday is never a rule day. DTE is calendar days from the open date to the front " +
  "(earliest) leg expiry in the Option Omega legs column; an expiry without a year takes the " +
  "open date's year, or the next year when it would fall before the open date. Entries whose " +
  "legs are not in Option Omega format, or name a month/day that is not a real calendar date " +
  "(e.g. Feb 30), are counted as unresolved. With selection 'firstAtLeast' only the observed " +
  "DTE is checked against the minimum; whether an entry took the first eligible listed expiry " +
  "is not checked, because the trade log has no listing data (dte.firstListedCompliance). " +
  "For the entry window, a missing Time Opened is unknown and a malformed one is invalid; " +
  "neither is counted inside or outside the window. With recordEnd, a rule day without an " +
  "entry whose earliest expiry (open date + dte calendar days) falls after recordEnd cannot " +
  "appear in the log; it is listed in unobservableRuleDays and left out of missingRuleDays " +
  "and its share.";

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function summarize(strategy: string, report: RuleCalendarReport): string {
  const parts = [
    `Rule calendar (${strategy}, ${report.range.from} to ${report.range.through}): ` +
      `${report.tradedRuleDays} of ${report.ruleDays} rule days traded, ` +
      `${report.missingRuleDays.count} missing (${pct(report.missingRuleDays.share)})`,
    `DTE ${report.dte.selection} ${report.dte.target}: ${pct(report.dte.mismatchShare)} of ` +
      `${report.dte.resolved} entries differ, worst year ${pct(report.dte.maxYearMismatchShare)}, ` +
      (report.dte.selection === "exact"
        ? `${report.dte.ruleViolations} break the rule`
        : `${report.dte.ruleViolations} below the minimum; first-listed expiry selection not ` +
          `checked (no listing data)`),
  ];
  if (report.unobservableRuleDays && report.unobservableRuleDays.count > 0) {
    parts.push(
      `${report.unobservableRuleDays.count} rule day(s) not checkable: the entry would expire ` +
        `after the record end ${report.unobservableRuleDays.recordEnd}`,
    );
  }
  if (report.offRuleEntryDays.count > 0) {
    parts.push(`${report.offRuleEntryDays.count} entry day(s) are not rule days`);
  }
  if (report.dte.unresolved.count > 0) {
    const impossible = report.dte.unresolved.impossibleExpiry.count;
    parts.push(
      `${report.dte.unresolved.count} entries without a readable expiry` +
        (impossible > 0 ? ` (${impossible} impossible date)` : ""),
    );
  }
  if (report.entryWindow) {
    const win = report.entryWindow;
    let text = `${win.outside.count} of ${win.checked} timed entries outside ${win.from}-${win.to}`;
    if (win.unknownTime > 0) text += `, ${win.unknownTime} without an entry time`;
    if (win.invalidTime.count > 0) text += `, ${win.invalidTime.count} with an invalid time`;
    parts.push(text);
  }
  return parts.join("; ") + ".";
}

/**
 * Register the get_rule_calendar MCP tool.
 */
export function registerRuleCalendarTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "get_rule_calendar",
    {
      description:
        "Check a strategy's entries against the calendar its stated entry rule implies " +
        "(entry weekdays, stated DTE, entry window): missing rule days, stated vs. actual DTE " +
        "per year, entries outside the entry window. " +
        METHODOLOGY,
      inputSchema: ruleCalendarInputSchema,
    },
    withSyncedBlock(baseDir, async (input: RuleCalendarInput) => {
      try {
        const block = await loadBlock(baseDir, input.blockId);
        const trades = filterByStrategy(block.trades, input.strategy);
        const strategies = new Set(trades.map((t) => t.strategy));
        if (trades.length === 0) {
          throw new Error(
            input.strategy
              ? `No trades found for strategy "${input.strategy}".`
              : "The block has no trades.",
          );
        }
        if (!input.strategy && strategies.size > 1) {
          throw new Error(
            `The block holds ${strategies.size} strategies; pass strategy to pick one.`,
          );
        }
        const report = buildRuleCalendar(
          trades.map((t) => ({
            openDate: formatDateKey(t.dateOpened),
            // The loader fills a missing Time Opened with "00:00:00" for sorting; that is
            // not an observed entry time, so it stays unknown here.
            openTime: t.timeOpenedProvided === false ? undefined : t.timeOpened,
            legs: t.legs,
          })),
          input.rule,
          { from: input.dateRange?.start, through: input.dateRange?.end },
          input.recordEnd === undefined ? undefined : { recordEnd: input.recordEnd },
        );
        const strategy = input.strategy ?? [...strategies][0];
        return createToolOutput(summarize(strategy, report), {
          blockId: input.blockId,
          strategy,
          ...report,
          methodology: METHODOLOGY,
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error building rule calendar: ${(error as Error).message}`,
            },
          ],
          isError: true as const,
        };
      }
    }),
  );
}
