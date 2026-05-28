/**
 * Import Tools
 *
 * MCP tools for importing CSV files into the blocks directory.
 * Designed for local filesystem access (via npx or mcpb desktop extension).
 */

import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
async function findFile(
  filename: string,
  searchPaths: string[]
): Promise<string | null> {
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

/**
 * Register import-related MCP tools
 */
export function registerImportTools(server: McpServer, baseDir: string): void {
  // Tool: import_csv
  server.registerTool(
    "import_csv",
    {
      description:
        "Import a CSV file from the local filesystem into the blocks directory. " +
        "Creates a new block that can be analyzed with other TradeBlocks tools. " +
        "Requires local filesystem access (run via npx tradeblocks-mcp or mcpb desktop extension). " +
        "If only a filename is provided (not full path), searches common directories (Downloads, Desktop, Documents).",
      inputSchema: z.object({
        csvPath: z
          .string()
          .describe(
            "Path to the CSV file. Can be: (1) absolute path like '/Users/me/data.csv', " +
            "(2) path with ~ like '~/Downloads/data.csv', or (3) just filename like 'data.csv' " +
            "(will search Downloads, Desktop, Documents)"
          ),
        blockName: z
          .string()
          .describe(
            "Name for the new block. Will be converted to kebab-case for the block ID. " +
            "Example: 'My Strategy 2024' becomes block ID 'my-strategy-2024'"
          ),
        csvType: z
          .enum(["tradelog", "dailylog", "reportinglog"])
          .default("tradelog")
          .describe(
            "Type of CSV: 'tradelog' (default) for trade records with P/L, " +
            "'dailylog' for daily portfolio values, 'reportinglog' for actual/reported trades"
          ),
        searchPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Additional directories to search if csvPath is just a filename. " +
            "Defaults to ~/Downloads, ~/Desktop, ~/Documents"
          ),
      }),
    },
    async ({ csvPath, blockName, csvType, searchPaths }) => {
      try {
        let resolvedPath = csvPath;

        // Expand ~ to home directory
        if (resolvedPath.startsWith("~")) {
          resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
        }

        // Check if it's just a filename (no directory separators)
        const isFilenameOnly = !resolvedPath.includes(path.sep) && !resolvedPath.includes("/");

        if (isFilenameOnly) {
          // Search for the file in common directories
          const dirsToSearch = searchPaths || DEFAULT_SEARCH_PATHS;
          const foundPath = await findFile(resolvedPath, dirsToSearch);

          if (!foundPath) {
            const searchedDirs = dirsToSearch.join(", ");
            throw new Error(
              `File "${resolvedPath}" not found. Searched: ${searchedDirs}. ` +
              `Please provide the full path to the file, or move it to one of these directories.`
            );
          }
          resolvedPath = foundPath;
        }

        // Verify file exists
        try {
          await fs.access(resolvedPath);
        } catch {
          throw new Error(
            `File not found: ${resolvedPath}. ` +
            `Please check the path is correct. If the file is in Downloads, try: ~/Downloads/${path.basename(csvPath)}`
          );
        }

        const result = await importCsv(baseDir, {
          csvPath: resolvedPath,
          blockName,
          csvType,
        });

        // Brief summary for user display (use result.csvType which reflects auto-detection)
        const summary = `Imported ${result.recordCount} ${result.csvType} records to block "${result.blockId}"`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId: result.blockId,
          name: result.name,
          csvType: result.csvType,
          sourcePath: resolvedPath,
          recordCount: result.recordCount,
          dateRange: result.dateRange,
          strategies: result.strategies,
          blockPath: result.blockPath,
          nextSteps: [
            `Use get_block_details("${result.blockId}") to see full statistics`,
            `Use get_trades("${result.blockId}") to examine individual trades`,
            `Use run_analysis("${result.blockId}", "monte_carlo") for risk analysis`,
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
    }
  );
}
