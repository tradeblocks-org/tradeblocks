import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, afterAll } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeConnection, importCsv, loadBlock } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerCoreBlockTools } from "../../src/tools/blocks/core.ts";
import { registerComparisonBlockTools } from "../../src/tools/blocks/comparison.ts";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ text?: string }>;
  isError?: boolean;
};
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;
type CallTool = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

async function fixture(run: (root: string, call: CallTool) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-paired-import-"));
  await fs.mkdir(path.join(root, "blocks"));
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as McpServer;
  registerImportTools(server, root);
  registerCoreBlockTools(server, root);
  registerComparisonBlockTools(server, root);
  try {
    await run(root, (tool, args) => handlers.get(tool)!(args));
  } finally {
    await closeConnection();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function source(root: string, name: string, contents: string) {
  const filename = path.join(root, name);
  await fs.writeFile(filename, contents);
  return filename;
}

function drawdown(result: ToolResult): number {
  const stats = result.structuredContent?.stats;
  if (!stats || typeof stats !== "object" || !("maxDrawdown" in stats)) {
    throw new Error("Statistics response lacks maxDrawdown");
  }
  if (typeof stats.maxDrawdown !== "number") {
    throw new Error("Statistics response has non-numeric maxDrawdown");
  }
  return stats.maxDrawdown;
}

const TRADES =
  "Date Opened,Date Closed,P/L,Strategy,Legs\n2024-01-02,2024-01-02,100,Alpha,SPY\n2024-01-03,2024-01-03,100,Beta,SPY\n";
const DAILY =
  "Date,Net Liquidity,P/L,Drawdown %\n2024-01-02,100000,0,0\n2024-01-03,80000,-20000,-20\n";
const REPORTING = "Date Opened,P/L,Strategy\n2024-01-02,100,Alpha\n";
const TAT = "TradeID,ProfitLoss,BuyingPower,OpenDate,Strategy\n123,100,1000,2024-01-02,Alpha\n";
const STAMPED_TRADES =
  "Date Opened,Date Closed,P/L,Strategy,Legs,P/L Basis\n2024-01-02,2024-01-02,100,Alpha,SPY,net_includes_fees\n2024-01-03,2024-01-03,100,Beta,SPY,net_includes_fees\n";
const FIRST_DATE = "2024-01-02";
const SECOND_DATE = "2024-01-03";

afterAll(async () => {
  await closeConnection();
});

describe("import_csv paired daily log", () => {
  it("uses daily-log drawdown only for the whole portfolio", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      const result = await call("import_csv", {
        csvPath,
        dailyLogPath,
        blockName: "Paired",
        csvType: "tradelog",
        plBasis: "net_includes_fees",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        csvType: "tradelog",
        recordCount: 2,
        dailyLog: { recordCount: 2 },
      });
      expect(await fs.readFile(path.join(root, "blocks", "paired", "dailylog.csv"), "utf-8")).toBe(
        DAILY,
      );
      const stats = await call("get_statistics", { blockId: "paired" });
      expect(stats.isError).not.toBe(true);
      expect(drawdown(stats)).toBe(20);
      expect(stats.structuredContent?.calculationMethodology).toMatchObject({
        calmar: { basis: "daily_log_marked_curve" },
      });
      const filtered = await call("get_statistics", {
        blockId: "paired",
        strategy: "Alpha",
      });
      expect(filtered.isError).not.toBe(true);
      expect(drawdown(filtered)).not.toBe(20);
      expect(filtered.structuredContent?.calculationMethodology).toMatchObject({
        calmar: { basis: "realized_trade_equity" },
      });
    });
  });

  it("labels each compared block's Calmar with the basis get_statistics reports", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      await call("import_csv", { csvPath, dailyLogPath, blockName: "Paired" });
      await call("import_csv", { csvPath, blockName: "Trade Only" });

      const compared = await call("compare_blocks", {
        blockIds: ["paired", "trade-only"],
        sortBy: "calmarRatio",
      });
      expect(compared.isError).not.toBe(true);
      const rows = compared.structuredContent?.comparisons as Array<{
        blockId: string;
        stats: { calmarRatio: number | null };
        calmarBasis?: string;
      }>;
      expect(Object.fromEntries(rows.map((row) => [row.blockId, row.calmarBasis]))).toEqual({
        paired: "daily_log_marked_curve",
        "trade-only": "realized_trade_equity",
      });
      for (const row of rows) {
        const stats = await call("get_statistics", { blockId: row.blockId });
        const single = stats.structuredContent as {
          stats: { calmarRatio?: number | null };
          calculationMethodology: { calmar: { basis: string } };
        };
        expect(row.stats.calmarRatio).toBe(single.stats.calmarRatio ?? null);
        expect(row.calmarBasis).toBe(single.calculationMethodology.calmar.basis);
      }

      const withoutCalmar = await call("compare_blocks", {
        blockIds: ["paired", "trade-only"],
        metrics: ["netPl"],
      });
      const plainRows = withoutCalmar.structuredContent?.comparisons as Array<object>;
      expect(plainRows.every((row) => !("calmarBasis" in row))).toBe(true);
    });
  });

  it.each([
    ["missing required column", "Date,P/L\n2024-01-02,2\n", "Missing required columns"],
    [
      "no convertible rows",
      "Date,Net Liquidity\ninvalid,100000\n",
      'CSV row 2: invalid Date "invalid"',
    ],
  ])("rejects invalid daily log: %s", async (_reason, contents, message) => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      const dailyLogPath = await source(root, "daily.csv", contents);
      const result = await call("import_csv", {
        csvPath,
        dailyLogPath,
        blockName: "Refused",
        csvType: "tradelog",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`daily log: ${message}`);
      await expect(fs.access(path.join(root, "blocks", "refused"))).rejects.toThrow();
    });
  });

  it("names an invalid trade log in a refused pair", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", "Date Opened,Strategy\n2024-01-02,Alpha\n");
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      const result = await call("import_csv", { csvPath, dailyLogPath, blockName: "Bad Trade" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("trade log: Missing required columns");
      await expect(fs.access(path.join(root, "blocks", "bad-trade"))).rejects.toThrow();
    });
  });

  it("rejects a missing daily-log path without creating a block", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      const result = await call("import_csv", {
        csvPath,
        dailyLogPath: path.join(root, "missing.csv"),
        blockName: "Missing",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("daily log: File not found:");
      await expect(fs.access(path.join(root, "blocks", "missing"))).rejects.toThrow();
    });
  });

  it.each(["dailylog", "reportinglog"])("rejects explicit %s pairing", async (csvType) => {
    await fixture(async (root, call) => {
      const csvPath = await source(
        root,
        "source.csv",
        csvType === "dailylog" ? DAILY : "Date Opened,P/L,Strategy\n2024-01-02,100,Alpha\n",
      );
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      const result = await call("import_csv", {
        csvPath,
        dailyLogPath,
        blockName: "Wrong Type",
        csvType,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("can only be paired with a tradelog");
      await expect(fs.access(path.join(root, "blocks", "wrong-type"))).rejects.toThrow();
    });
  });

  it("rejects pairing when a default trade log auto-detects as TAT", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(
        root,
        "tat.csv",
        "TradeID,ProfitLoss,BuyingPower,OpenDate\n123,100,1000,2024-01-02\n",
      );
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      const result = await call("import_csv", { csvPath, dailyLogPath, blockName: "Tat Pair" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("can only be paired with a tradelog");
      await expect(fs.access(path.join(root, "blocks", "tat-pair"))).rejects.toThrow();
    });
  });

  it("resolves daily-log filenames through searchPaths", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      await source(root, "daily.csv", DAILY);
      const result = await call("import_csv", {
        csvPath: path.basename(csvPath),
        dailyLogPath: "daily.csv",
        searchPaths: [root],
        blockName: "Searched",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.dailyLog).toEqual({
        recordCount: 2,
        dateRange: { start: "2024-01-02", end: "2024-01-03" },
      });
    });
  });

  it("creates a paired block when the data root does not yet exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-empty-root-"));
    const baseDir = path.join(root, "new-root");
    try {
      const csvPath = await source(root, "trades.csv", TRADES);
      const dailyLogPath = await source(root, "daily.csv", DAILY);
      const result = await importCsv(baseDir, {
        csvPath,
        dailyLogPath,
        blockName: "Fresh Block",
      });
      expect(result.dailyLog).toEqual({
        recordCount: 2,
        dateRange: { start: "2024-01-02", end: "2024-01-03" },
      });
      expect(await fs.readdir(result.blockPath)).toEqual(["dailylog.csv", "tradelog.csv"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves each single-file format", async () => {
    await fixture(async (root, call) => {
      const cases = [
        {
          type: "tradelog",
          contents: TRADES,
          file: "tradelog.csv",
          stored: STAMPED_TRADES,
          count: 2,
          start: FIRST_DATE,
          end: SECOND_DATE,
          strategies: ["Alpha", "Beta"],
          basis: "net_includes_fees",
        },
        {
          type: "dailylog",
          contents: DAILY,
          file: "dailylog.csv",
          stored: DAILY,
          count: 2,
          start: FIRST_DATE,
          end: SECOND_DATE,
          strategies: [],
        },
        {
          type: "reportinglog",
          contents: REPORTING,
          file: "reportinglog.csv",
          stored: REPORTING,
          count: 1,
          start: FIRST_DATE,
          end: FIRST_DATE,
          strategies: ["Alpha"],
        },
        {
          type: "tat",
          contents: TAT,
          file: "reportinglog.csv",
          stored: TAT,
          count: 1,
          start: FIRST_DATE,
          end: FIRST_DATE,
          strategies: ["Alpha"],
        },
      ] as const;
      for (const item of cases) {
        const csvPath = await source(root, `${item.type}.csv`, item.contents);
        const blockPath = path.join(root, "blocks", item.type);
        const csvType = item.type === "tat" ? "reportinglog" : item.type;
        const result = await call("import_csv", {
          csvPath,
          blockName: item.type,
          ...(item.type === "tat" ? {} : { csvType: item.type }),
        });
        expect(result.isError).not.toBe(true);
        expect(result.content[0].text).toBe(
          `Imported ${item.count} ${csvType} records to block "${item.type}"`,
        );
        expect(result.structuredContent).toMatchObject({
          blockId: item.type,
          name: item.type,
          csvType,
          plBasis: "basis" in item ? item.basis : null,
          sourcePath: csvPath,
          recordCount: item.count,
          dateRange: { start: item.start, end: item.end },
          strategies: item.strategies,
          blockPath,
        });
        expect(await fs.readdir(blockPath)).toEqual([item.file]);
        expect(await fs.readFile(path.join(blockPath, item.file), "utf-8")).toBe(item.stored);
      }
    });
  });
});

describe("import_csv row acceptance and loaded receipts", () => {
  it.each(["2024-02-30", "2024-13-01"])(
    "refuses impossible opened date %s before writing a paired block",
    async (date) => {
      await fixture(async (root, call) => {
        const csvPath = await source(
          root,
          "bad.csv",
          `Date Opened,Date Closed,P/L\n${date},2024-03-01,100\n`,
        );
        const dailyLogPath = await source(root, "daily.csv", DAILY);
        const result = await call("import_csv", { csvPath, dailyLogPath, blockName: "Bad Date" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(`CSV row 2: invalid Date Opened "${date}"`);
        await expect(fs.access(path.join(root, "blocks", "bad-date"))).rejects.toThrow();
      });
    },
  );
  it("refuses a calendar prefix with an unloadable timestamp suffix", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "bad.csv", "Date Opened,P/L\n2024-01-02Tinvalid,100\n");
      const result = await call("import_csv", { csvPath, blockName: "Bad Timestamp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CSV row 2: invalid Date Opened");
      await expect(fs.access(path.join(root, "blocks", "bad-timestamp"))).rejects.toThrow();
    });
  });

  it("refuses nonnumeric trade P/L and leaves no block", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "bad.csv", "Date Opened,P/L\n2024-01-02,abc\n");
      const result = await call("import_csv", { csvPath, blockName: "Bad PL" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('CSV row 2: invalid P/L "abc"');
      await expect(fs.access(path.join(root, "blocks", "bad-pl"))).rejects.toThrow();
    });
  });

  it.each([
    ["tradelog", "Date Opened,Date Closed,P/L\n2024-01-02,2024-02-30,100\n", "Date Closed"],
    ["reportinglog", "Date Opened,Date Closed,P/L\n2024-01-02,2024-02-30,100\n", "Date Closed"],
    ["reportinglog", "Date Opened,P/L\n2024-01-02,abc\n", "P/L"],
    [
      "reportinglog",
      "TradeID,ProfitLoss,BuyingPower,OpenDate\n123,abc,1000,2024-01-02\n",
      "ProfitLoss",
    ],
    [
      "reportinglog",
      "TradeID,ProfitLoss,BuyingPower,OpenDate\n123,100,1000,2024-02-30\n",
      "OpenDate",
    ],
  ])("refuses %s invalid %s before creating a block", async (csvType, csv, column) => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "bad.csv", csv);
      const result = await call("import_csv", { csvPath, blockName: "Bad Reporting", csvType });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`CSV row 2: invalid ${column}`);
      await expect(fs.access(path.join(root, "blocks", "bad-reporting"))).rejects.toThrow();
    });
  });

  it("retains folder trade acceptance for unparseable P/L while import refuses it", async () => {
    await fixture(async (root) => {
      const folder = path.join(root, "blocks", "legacy");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "tradelog.csv"), "Date Opened,P/L\n2024-01-02,abc\n");
      expect((await loadBlock(root, "legacy")).trades.map((trade) => trade.pl)).toEqual([0]);
    });
  });

  it("imports the repository's complete OO trade export without dropping rows", async () => {
    await fixture(async (root, call) => {
      const csvPath = path.join(process.cwd(), "../../tests/data/MEIC Test Data/meic-tradelog.csv");
      const result = await call("import_csv", { csvPath, blockName: "OO MEIC Real" });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        recordCount: 532,
        strategies: ["oo-meic-real"],
        dateRange: { start: "2025-01-03", end: "2025-11-21" },
      });
      const loaded = await loadBlock(root, "oo-meic-real");
      expect(loaded.trades).toHaveLength(532);
      expect(loaded.trades.some((trade) => trade.pl === 231.44)).toBe(true);
      const stored = await fs.readFile(
        path.join(root, "blocks", "oo-meic-real", "tradelog.csv"),
        "utf8",
      );
      expect(stored).toContain("P/L Basis");
      expect(stored).toContain("net_includes_fees");
      expect(await fs.readFile(csvPath, "utf8")).toContain('"Opening Short/Long Ratio"');
    });
  }, 20_000);

  it.each(["Portfolio Value", "Value", "Equity"])(
    "loads daily-log %s from import and folder",
    async (alias) => {
      await fixture(async (root, call) => {
        const csvPath = await source(root, "trades.csv", TRADES);
        const daily = `Date,${alias},P/L,Drawdown %\n2024-01-02,100000,0,0\n2024-01-03,80000,-20000,-20\n`;
        const dailyLogPath = await source(root, "daily.csv", daily);
        const result = await call("import_csv", { csvPath, dailyLogPath, blockName: "Aliased" });
        expect(result.isError).not.toBe(true);
        expect(
          (await loadBlock(root, "aliased")).dailyLogs?.map((entry) => entry.netLiquidity),
        ).toEqual([100000, 80000]);
        const stats = await call("get_statistics", { blockId: "aliased" });
        expect(stats.isError).not.toBe(true);
        expect(drawdown(stats)).toBe(20);
        const folder = path.join(root, "blocks", "manual");
        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, "tradelog.csv"), TRADES);
        await fs.writeFile(path.join(folder, "dailylog.csv"), daily);
        expect(
          (await loadBlock(root, "manual")).dailyLogs?.map((entry) => entry.netLiquidity),
        ).toEqual([100000, 80000]);
        const alternate = path.join(root, "blocks", "custom");
        await fs.mkdir(alternate);
        await fs.writeFile(path.join(alternate, "tradelog.csv"), TRADES);
        await fs.writeFile(path.join(alternate, "account-values.csv"), daily);
        expect(
          (await loadBlock(root, "custom")).dailyLogs?.map((entry) => entry.netLiquidity),
        ).toEqual([100000, 80000]);
      });
    },
  );

  it.each(["", "abc"])("refuses daily-log value %s and folder loading drops it", async (value) => {
    await fixture(async (root, call) => {
      const csvPath = await source(root, "trades.csv", TRADES);
      const daily = `Date,Equity\n2024-01-02,100000\n2024-01-03,${value}\n`;
      const dailyLogPath = await source(root, "daily.csv", daily);
      const result = await call("import_csv", { csvPath, dailyLogPath, blockName: "Bad Daily" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CSV row 3: invalid Equity");
      await expect(fs.access(path.join(root, "blocks", "bad-daily"))).rejects.toThrow();
      const folder = path.join(root, "blocks", "manual");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "tradelog.csv"), TRADES);
      await fs.writeFile(path.join(folder, "dailylog.csv"), daily);
      expect(
        (await loadBlock(root, "manual")).dailyLogs?.map((entry) => entry.netLiquidity),
      ).toEqual([100000]);
    });
  });

  it("uses the loaded blockId strategy in receipt and trade count", async () => {
    await fixture(async (root, call) => {
      const csvPath = await source(
        root,
        "oo.csv",
        "Date Opened,Date Closed,P/L,Legs,No. of Contracts,Premium,Opening Commissions + Fees,Closing Commissions + Fees\n2024-01-02,2024-01-03,100,SPY,1,2.00,1.50,1.50\n",
      );
      const result = await call("import_csv", { csvPath, blockName: "OO RIC 2025" });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        recordCount: 1,
        strategies: ["oo-ric-2025"],
      });
      const info = await call("get_block_info", { blockId: "oo-ric-2025" });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent?.strategies).toEqual(result.structuredContent?.strategies);
      expect(await fs.readdir(path.join(root, "blocks", "oo-ric-2025"))).toContain("tradelog.csv");
    });
  });
});

// Jest's sandboxed process.env cannot change the V8 time zone, so each zone runs the real
// MCP server in a child process started with that TZ.
describe.each(["UTC", "Pacific/Kiritimati", "America/Los_Angeles"])(
  "import_csv single-file dateRange in %s",
  (timeZone) => {
    // Rows are out of order and span a year boundary, so both ends must come from the data.
    const csvFiles = {
      tradelog:
        "Date Opened,Date Closed,P/L,Strategy,Legs\n2024-01-02,2024-01-02,100,Alpha,SPY\n2023-12-29,2023-12-29,100,Alpha,SPY\n2024-01-05,2024-01-05,100,Alpha,SPY\n",
      dailylog:
        "Date,Net Liquidity,P/L,Drawdown %\n2024-01-02,100000,0,0\n2023-12-29,100000,0,0\n2024-01-05,100000,0,0\n",
      reportinglog:
        "Date Opened,P/L,Strategy\n2024-01-02,100,Alpha\n2023-12-29,100,Alpha\n2024-01-05,100,Alpha\n",
    };

    it("reports each CSV type's first and last calendar days", async () => {
      const packageDir = path.resolve(import.meta.dirname, "../..");
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-import-tz-"));
      const client = new Client({ name: "import-csv-tz-test", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--experimental-strip-types", path.join(packageDir, "src/index.ts"), root],
        cwd: path.resolve(packageDir, "../.."),
        env: { ...getDefaultEnvironment(), TZ: timeZone },
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const registeredTools = new Set((await client.listTools()).tools.map((tool) => tool.name));
        for (const [csvType, contents] of Object.entries(csvFiles)) {
          const csvPath = await source(root, `${csvType}.csv`, contents);
          const result = await client.callTool({
            name: "import_csv",
            arguments: { csvPath, blockName: csvType, csvType },
          });
          expect(result.isError).not.toBe(true);
          expect([csvType, result.structuredContent?.dateRange]).toEqual([
            csvType,
            { start: "2023-12-29", end: "2024-01-05" },
          ]);
          const nextSteps = result.structuredContent?.nextSteps;
          expect(Array.isArray(nextSteps)).toBe(true);
          for (const step of nextSteps as string[]) {
            const toolName = /^Use ([a-z_]+)(?:\s|\()/.exec(step)?.[1];
            expect(toolName).toBeDefined();
            expect(registeredTools.has(toolName!)).toBe(true);
          }
        }
      } finally {
        await client.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
