/**
 * Integration tests for the get_rule_calendar MCP tool: a synthetic Option
 * Omega trade log is imported with import_csv and checked against its stated
 * entry rule. No real trading data is used.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "@jest/globals";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  calendarDaysBetween,
  enumerateXnysSessionsV2,
  type RuleCalendarReport,
} from "@tradeblocks/lib";
import { closeConnection } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerRuleCalendarTool } from "../../src/tools/blocks/rule-calendar.ts";

type Result = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<Result>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ooLegs(expiry: string): string {
  const month = MONTHS[Number(expiry.slice(5, 7)) - 1];
  const day = Number(expiry.slice(8, 10));
  return `1 ${month} ${day} 1950 P STO 1.20 | 1 ${month} ${day} 1900 P BTO 0.80`;
}

/**
 * A5 pattern as an Option Omega trade log: "7 DTE, Mondays" in 2016 without
 * exact DTE, every other Friday listed, first listed Friday >= 7 days out.
 * One Monday is skipped, one entry is late, and a second strategy trades
 * exactly 7 DTE.
 */
function a5TradeLog(): string {
  const listedFridays: string[] = [];
  for (let d = "2016-01-08"; d <= "2017-01-31"; d = addDays(d, 14)) listedFridays.push(d);
  const mondays = enumerateXnysSessionsV2("2016-01-01", "2016-12-31").filter(
    (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1,
  );
  const rows = [
    "Date Opened,Time Opened,Date Closed,Time Closed,Legs,Premium,No. of Contracts,P/L,Strategy",
  ];
  for (const d of mondays) {
    if (d === "2016-05-02") continue;
    const expiry = listedFridays.find((f) => calendarDaysBetween(d, f) >= 7)!;
    const time = d === "2016-09-12" ? "11:05:00" : "09:35:00";
    rows.push(`${d},${time},${expiry},16:00:00,${ooLegs(expiry)},40,1,25,PCS-7`);
    rows.push(
      `${d},09:35:00,${addDays(d, 7)},16:00:00,${ooLegs(addDays(d, 7))},40,1,25,PCS-7-exact`,
    );
  }
  return rows.join("\n") + "\n";
}

async function withTools(
  run: (call: (name: string, args: Record<string, unknown>) => Promise<Result>) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-rule-calendar-"));
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as McpServer;
  registerImportTools(server, root);
  registerRuleCalendarTool(server, root);
  try {
    const csvPath = path.join(root, "source.csv");
    await fs.writeFile(csvPath, a5TradeLog());
    const imported = await handlers.get("import_csv")!({ csvPath, blockName: "A5" });
    expect(imported.isError).not.toBe(true);
    await run((name, args) => handlers.get(name)!(args));
  } finally {
    await closeConnection();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const RULE = {
  entryWeekdays: [1],
  dte: 7,
  selection: "firstAtLeast",
  entryWindow: { from: "09:30", to: "10:00" },
};

describe("get_rule_calendar", () => {
  it("flags the A5 expiry trap on an imported block", async () => {
    await withTools(async (call) => {
      const result = await call("get_rule_calendar", {
        blockId: "a5",
        strategy: "PCS-7",
        rule: RULE,
        dateRange: { start: "2016-01-01", end: "2016-12-31" },
      });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as unknown as RuleCalendarReport & {
        strategy: string;
        methodology: string;
      };
      expect(data.strategy).toBe("PCS-7");
      expect(data.calendar).toBe("xnys-v2");
      expect(data.ruleDays).toBe(46);
      expect(data.missingRuleDays.sample).toEqual(["2016-05-02"]);
      expect(data.offRuleEntryDays.count).toBe(0);
      expect(data.dte.resolved).toBe(45);
      expect(data.dte.unresolved.count).toBe(0);
      expect(data.dte.perYear).toHaveLength(1);
      expect(data.dte.perYear[0].mismatchShare).toBe(1);
      expect(data.dte.ruleViolations).toBe(0);
      expect(data.entryWindow!.outside.sample).toEqual(["2016-09-12 11:05"]);
      expect(data.methodology).toMatch(/holiday is never a rule day/);
      const summary = result.content?.[0]?.text ?? "";
      expect(summary).toMatch(/45 of 46 rule days traded/);
    });
  });

  it("passes an exact-DTE strategy", async () => {
    await withTools(async (call) => {
      const result = await call("get_rule_calendar", {
        blockId: "a5",
        strategy: "pcs-7-exact",
        rule: { ...RULE, selection: "exact" },
      });
      const data = result.structuredContent as unknown as RuleCalendarReport & {
        strategy: string;
        methodology: string;
      };
      expect(data.dte.mismatchShare).toBe(0);
      expect(data.dte.ruleViolations).toBe(0);
      expect(data.entryWindow!.outside.count).toBe(0);
    });
  });

  it("asks for a strategy when the block holds several", async () => {
    await withTools(async (call) => {
      const result = await call("get_rule_calendar", { blockId: "a5", rule: RULE });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/holds 2 strategies/);
    });
  });

  it("reports an unknown strategy", async () => {
    await withTools(async (call) => {
      const result = await call("get_rule_calendar", {
        blockId: "a5",
        strategy: "nope",
        rule: RULE,
      });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/No trades found for strategy "nope"/);
    });
  });
});
