/**
 * Import Tools
 *
 * MCP tools for importing CSV files into the blocks directory.
 * Paths must be readable by this server (locally in stdio, or mounted in Docker/HTTP).
 */

import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlBasis } from "@tradeblocks/lib";
import { importCsv } from "../utils/block-loader.ts";
import { createToolOutput } from "../utils/output-formatter.ts";

/**
 * Common directories where users might have CSV files
 */
const DEFAULT_SEARCH_PATHS = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
];

/**
 * Search for a file by name in multiple directories
 */
async function findFile(filename: string, searchPaths: string[]): Promise<string | null> {
  for (const dir of searchPaths) {
    const fullPath = path.join(dir, filename);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // File not found in this directory, continue
    }
  }
  return null;
}

async function resolveCsvPath(csvPath: string, searchPaths?: string[]): Promise<string> {
  let resolvedPath = csvPath;
  if (resolvedPath.startsWith("~")) {
    resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
  }
  const isFilenameOnly = !resolvedPath.includes(path.sep) && !resolvedPath.includes("/");
  if (isFilenameOnly) {
    const dirsToSearch = searchPaths || DEFAULT_SEARCH_PATHS;
    const foundPath = await findFile(resolvedPath, dirsToSearch);
    if (!foundPath) {
      const searchedDirs = dirsToSearch.join(", ");
      throw new Error(
        `File "${resolvedPath}" not found. Searched: ${searchedDirs}. ` +
          `Please provide the full path to the file, or move it to one of these directories.`,
      );
    }
    resolvedPath = foundPath;
  }
  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(
      `File not found: ${resolvedPath}. ` +
        `Please check the path is correct. If the file is in Downloads, try: ~/Downloads/${path.basename(csvPath)}`,
    );
  }
  return resolvedPath;
}

/**
 * Register import-related MCP tools
 */
export function registerImportTools(server: McpServer, baseDir: string): void {
  // Tool: import_csv
  server.registerTool(
    "import_csv",
    {
      description:
        "Import a CSV file from a path readable by this server into the blocks directory. " +
        "Creates a new block that can be analyzed with other TradeBlocks tools. " +
        "For stdio (npx tradeblocks-mcp), use a local filesystem path; for Docker/HTTP, use a path inside the server's mounted data directory. " +
        "If only a filename is provided, searches common directories (Downloads, Desktop, Documents).",
      inputSchema: z.object({
        csvPath: z
          .string()
          .describe(
            "Path to the CSV file. Can be: (1) absolute path like '/Users/me/data.csv', " +
              "(2) path with ~ like '~/Downloads/data.csv', or (3) just filename like 'data.csv' " +
              "(will search Downloads, Desktop, Documents)",
          ),
        dailyLogPath: z
          .string()
          .optional()
          .describe(
            "Optional daily log CSV path to import with a trade log. Supports absolute paths, ~, and filename search in searchPaths or the default directories.",
          ),
        blockName: z
          .string()
          .describe(
            "Name for the new block. Will be converted to kebab-case for the block ID. " +
              "Example: 'My Strategy 2024' becomes block ID 'my-strategy-2024'",
          ),
        csvType: z
          .enum(["tradelog", "dailylog", "reportinglog"])
          .default("tradelog")
          .describe(
            "Type of CSV: 'tradelog' (default) for trade records with P/L, " +
              "'dailylog' for daily portfolio values, 'reportinglog' for actual/reported trades",
          ),
        plBasis: z
          .enum(PlBasis)
          .default(PlBasis.NetIncludesFees)
          .describe(
            "Basis of the tradelog P/L column. Use 'net_includes_fees' for Option Omega exports (default), or 'gross_before_fees' when commission/fee columns still need to be deducted.",
          ),
        searchPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Additional directories to search if csvPath is just a filename. " +
              "Defaults to ~/Downloads, ~/Desktop, ~/Documents",
          ),
      }),
    },
    async ({ csvPath, dailyLogPath, blockName, csvType, plBasis, searchPaths }) => {
      try {
        if (dailyLogPath && csvType && csvType !== "tradelog") {
          throw new Error(
            "A daily log can only be paired with a tradelog, not a reportinglog or dailylog",
          );
        }
        const resolvedPath = dailyLogPath
          ? await resolveCsvPath(csvPath, searchPaths).catch((error: Error) => {
              throw new Error(`trade log: ${error.message}`);
            })
          : await resolveCsvPath(csvPath, searchPaths);
        const resolvedDailyLogPath = dailyLogPath
          ? await resolveCsvPath(dailyLogPath, searchPaths).catch((error: Error) => {
              throw new Error(`daily log: ${error.message}`);
            })
          : undefined;
        const result = await importCsv(baseDir, {
          csvPath: resolvedPath,
          dailyLogPath: resolvedDailyLogPath,
          blockName,
          csvType,
          plBasis,
        });

        const summary = `Imported ${result.recordCount} ${result.csvType} records to block "${result.blockId}"${result.dailyLog ? ` with ${result.dailyLog.recordCount} daily log records` : ""}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId: result.blockId,
          name: result.name,
          csvType: result.csvType,
          plBasis: result.plBasis ?? null,
          sourcePath: resolvedPath,
          recordCount: result.recordCount,
          dateRange: result.dateRange,
          strategies: result.strategies,
          blockPath: result.blockPath,
          ...(result.dailyLog ? { dailyLog: result.dailyLog } : {}),
          nextSteps: [
            `Use get_block_info("${result.blockId}") to inspect the imported block`,
            `Use run_sql to query trades.trade_data for block_id "${result.blockId}" and examine individual trades`,
            `Use run_monte_carlo with blockId "${result.blockId}" for risk analysis`,
          ],
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error importing CSV: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
