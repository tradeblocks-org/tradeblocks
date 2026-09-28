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
import { closeConnection, importCsv } from "../../src/test-exports.ts";
import { registerImportTools } from "../../src/tools/imports.ts";
import { registerCoreBlockTools } from "../../src/tools/blocks/core.ts";

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
      const filtered = await call("get_statistics", {
        blockId: "paired",
        strategy: "Alpha",
      });
      expect(filtered.isError).not.toBe(true);
      expect(drawdown(filtered)).not.toBe(20);
    });
  });

  it.each([
    ["missing required column", "Date,P/L\n2024-01-02,2\n", "Missing required columns"],
    ["no convertible rows", "Date,Net Liquidity\ninvalid,100000\n", "no rows could be converted"],
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
