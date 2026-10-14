import { z } from "zod";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { processStaticDatasetContent, validateDatasetName } from "@tradeblocks/lib";
import { getConnection, upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.ts";
import { getDataRoot } from "../db/data-root.ts";
import {
  ensureDatasetsSchema,
  replaceDataset,
  listDatasets,
  deleteDataset,
  datasetFields,
  runtimeFieldCatalog,
} from "../db/dataset-schemas.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import { normalizeTicker } from "../utils/ticker.ts";

export function registerDatasetTools(server: McpServer, baseDir: string): void {
  server.registerTool(
    "list_analysis_fields",
    {
      description: "Discover built-in and registered dataset fields, type, timing, and source.",
      inputSchema: z.object({}),
    },
    async () => {
      const fields = await runtimeFieldCatalog(await getConnection(baseDir));
      return createToolOutput(`${fields.length} analysis fields`, { fields });
    },
  );
  server.registerTool(
    "import_daily_dataset",
    {
      description:
        "Import a Static Dataset CSV (timestamp first, then numeric or categorical columns). Date-only close values become available next calendar day at 00:00 ET; open requires knownBy. Re-import replaces atomically. No market data is modified.",
      inputSchema: z.object({
        name: z.string(),
        csvPath: z.string().optional(),
        content: z.string().optional(),
        ticker: z.string().optional(),
        columnTiming: z.record(z.string(), z.enum(["open", "close"])).optional(),
        knownBy: z.string().optional(),
      }),
    },
    async ({ name, csvPath, content, ticker, columnTiming, knownBy }) => {
      try {
        const validation = validateDatasetName(name);
        if (!validation.valid) throw new Error(validation.error);
        if ((csvPath === undefined) === (content === undefined))
          throw new Error("Provide exactly one of csvPath or content");
        let source = "inline";
        if (csvPath !== undefined) {
          const root = await fs.realpath(getDataRoot(baseDir));
          source = await fs.realpath(path.resolve(root, csvPath));
          const relative = path.relative(root, source);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw new Error("CSV path must be under the data root");
          content = await fs.readFile(source, "utf8");
        }
        const parsed = await processStaticDatasetContent(content!, {
          name,
          fileName: source,
          columnTiming,
          knownBy,
        });
        if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
        const entry = {
          dataset: parsed.dataset,
          ticker: ticker ? normalizeTicker(ticker) : null,
          source,
          rows: parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id })),
        };
        await upgradeToReadWrite(baseDir);
        try {
          await replaceDataset(await getConnection(baseDir), entry);
        } finally {
          await downgradeToReadOnly(baseDir);
        }
        return createToolOutput(`Imported ${name}: ${entry.rows.length} rows`, {
          name,
          fields: datasetFields([entry]),
          coverage: {
            rows: entry.rows.length,
            start: parsed.dataset.dateRange.start,
            end: parsed.dataset.dateRange.end,
          },
          warnings: parsed.warnings,
        });
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    },
  );
  server.registerTool(
    "list_daily_datasets",
    {
      description: "List imported Static Datasets, registered fields, timing and coverage.",
      inputSchema: z.object({}),
    },
    async () => {
      const entries = await listDatasets(await getConnection(baseDir));
      return createToolOutput(`${entries.length} datasets`, {
        datasets: entries.map((entry) => ({
          name: entry.dataset.name,
          ticker: entry.ticker,
          fields: datasetFields([entry]),
          coverage: entry.dataset.dateRange,
          rows: entry.rows.length,
        })),
      });
    },
  );
  server.registerTool(
    "delete_daily_dataset",
    {
      description: "Delete a Static Dataset and remove its fields from the runtime catalog.",
      inputSchema: z.object({ name: z.string() }),
    },
    async ({ name }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const conn = await getConnection(baseDir);
        await ensureDatasetsSchema(conn);
        await conn.run("BEGIN TRANSACTION");
        try {
          await deleteDataset(conn, name);
          await conn.run("COMMIT");
        } catch (error) {
          await conn.run("ROLLBACK");
          throw error;
        }
        return createToolOutput(`Deleted ${name}`, { name });
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );
}
