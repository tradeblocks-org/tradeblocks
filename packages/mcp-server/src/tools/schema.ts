/**
 * Schema Discovery Tools
 *
 * Provides MCP tools for discovering the DuckDB database schema.
 * Claude should call describe_database BEFORE using run_sql to understand
 * what tables and columns are available for analysis.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConnection, upgradeToReadWrite, downgradeToReadOnly, getConnectionMode } from "../db/connection.ts";
import { withFullSync } from "./middleware/sync-middleware.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import {
  SCHEMA_DESCRIPTIONS,
  EXAMPLE_QUERIES,
  type ColumnDescription,
} from "../utils/schema-metadata.ts";
import {
  OPEN_KNOWN_FIELDS,
  CLOSE_KNOWN_FIELDS,
  STATIC_FIELDS,
  DAILY_OPEN_FIELDS,
  DAILY_STATIC_FIELDS,
  CONTEXT_OPEN_FIELDS,
} from "../utils/field-timing.ts";

// ============================================================================
// Types for output structure
// ============================================================================

interface ColumnInfo {
  name: string;
  type: string;
  description: string;
  nullable: boolean;
  hypothesis: boolean;
  timing?: 'open' | 'close' | 'static';
}

interface BlockBreakdown {
  blockId: string;
  rowCount: number;
}

interface TableInfo {
  description: string;
  keyColumns: string[];
  rowCount: number;
  blockBreakdown?: BlockBreakdown[];
  columns: ColumnInfo[];
}

interface SchemaInfo {
  description: string;
  tables: Record<string, TableInfo>;
}

interface VixTenorInfo {
  available: string[];
  queryPattern: string;
  ratioPattern: string;
}

interface DatabaseSchemaOutput {
  schemas: Record<string, SchemaInfo>;
  examples: typeof EXAMPLE_QUERIES;
  lagTemplate: {
    description: string;
    sql: string;
    fieldCounts: {
      openKnown: number;
      static: number;
      closeDerived: number;
    };
  };
  importWorkflow: {
    description: string;
    steps: string[];
  };
  syncInfo: {
    blocksProcessed: number;
  };
  vixTenors?: VixTenorInfo;
}

// ============================================================================
// Constants
// ============================================================================

// (MARKET_TABLE_FILE_PATTERNS removed — purge_market_table now uses target_table column directly)

// ============================================================================
// LAG Template Generator
// ============================================================================

/**
 * Generate a reusable LAG() CTE template for lookahead-free queries.
 * Dynamically built from OPEN_KNOWN_FIELDS, CLOSE_KNOWN_FIELDS, STATIC_FIELDS
 * so it stays in sync with field-timing classifications automatically.
 */
function generateLagTemplate(): {
  description: string;
  sql: string;
  fieldCounts: { openKnown: number; static: number; closeDerived: number };
} {
  // Qualify daily-sourced fields with d., context-sourced with c.
  const dailyOpenCols = [...DAILY_OPEN_FIELDS].map(f => `    d.${f}`).join(',\n');
  const contextOpenCols = [...CONTEXT_OPEN_FIELDS].map(f => `    c.${f}`).join(',\n');
  const staticCols = [...DAILY_STATIC_FIELDS].map(f => `    d.${f}`).join(',\n');

  const sql = `-- Lookahead-free CTE template for market.enriched + market.spot_daily + VIX tickers + market.enriched_context
-- Open-known fields: safe to use same-day (known at/before market open)
-- Static fields: safe to use same-day (calendar facts)
-- Close-derived fields: use LAG() for prior trading day values
--
-- Indicators come from market.enriched; OHLCV (open/high/low/close) comes from market.spot_daily.
-- Copy this CTE into your query, then JOIN on (ticker, date)
WITH requested AS (
  SELECT DISTINCT
    COALESCE(NULLIF(ticker, ''), 'SPX') AS ticker,
    CAST(date_opened AS VARCHAR) AS date
  FROM trades.trade_data
  WHERE block_id = 'my-block'
),
joined AS (
  -- Scan full ticker history so LAG sees correct prior trading day
  SELECT d.ticker, d.date,
    -- Open-known fields from enriched indicators (safe same-day)
${dailyOpenCols},
    -- Open-known fields from VIX ticker JOIN (safe same-day)
${contextOpenCols},
    -- Static fields (safe same-day)
${staticCols},
    -- Close-derived fields from enriched + spot_daily OHLCV + VIX JOINs + enriched_context (will be LAGged below)
    s.high, s.low, s.close, d.RSI_14, d.ATR_Pct,
    d.Realized_Vol_5D, d.Realized_Vol_20D, d.Return_5D, d.Return_20D,
    d.Intraday_Range_Pct, d.Intraday_Return_Pct, d.Close_Position_In_Range,
    d.Gap_Filled, d.Consecutive_Days,
    vix_s.close AS VIX_Close, vix_s.high AS VIX_High, vix_s.low AS VIX_Low,
    vix.ivr AS VIX_IVR, vix.ivp AS VIX_IVP,
    vix9d_s.close AS VIX9D_Close, vix9d.ivr AS VIX9D_IVR, vix9d.ivp AS VIX9D_IVP,
    vix3m_s.close AS VIX3M_Close, vix3m.ivr AS VIX3M_IVR, vix3m.ivp AS VIX3M_IVP,
    cd.Vol_Regime, cd.Term_Structure_State, cd.VIX_Spike_Pct
  FROM market.enriched d
  LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
  LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
  LEFT JOIN market.enriched vix ON vix.date = d.date AND vix.ticker = 'VIX'
  LEFT JOIN market.spot_daily vix9d_s ON vix9d_s.date = d.date AND vix9d_s.ticker = 'VIX9D'
  LEFT JOIN market.enriched vix9d ON vix9d.date = d.date AND vix9d.ticker = 'VIX9D'
  LEFT JOIN market.spot_daily vix3m_s ON vix3m_s.date = d.date AND vix3m_s.ticker = 'VIX3M'
  LEFT JOIN market.enriched vix3m ON vix3m.date = d.date AND vix3m.ticker = 'VIX3M'
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker IN (SELECT ticker FROM requested)
),
lagged AS (
  SELECT *,
    -- Close-derived fields (prior trading day via LAG)
    LAG(high) OVER (PARTITION BY ticker ORDER BY date) AS prev_high,
    LAG(RSI_14) OVER (PARTITION BY ticker ORDER BY date) AS prev_RSI_14,
    LAG(Realized_Vol_20D) OVER (PARTITION BY ticker ORDER BY date) AS prev_Realized_Vol_20D,
    LAG(VIX_Close) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_Close,
    LAG(Vol_Regime) OVER (PARTITION BY ticker ORDER BY date) AS prev_Vol_Regime,
    LAG(Term_Structure_State) OVER (PARTITION BY ticker ORDER BY date) AS prev_Term_Structure_State,
    LAG(VIX_IVP) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_IVP
  FROM joined
)
SELECT t.*, m.*
FROM trades.trade_data t
JOIN lagged m
  ON COALESCE(NULLIF(t.ticker, ''), 'SPX') = m.ticker
 AND CAST(t.date_opened AS VARCHAR) = m.date
WHERE t.block_id = 'my-block'`;

  return {
    description:
      'Reusable LAG() CTE for lookahead-free queries joining trades to market.enriched + market.spot_daily + VIX tickers + market.enriched_context. ' +
      'Close-derived fields (VIX_Close, Vol_Regime, RSI_14, etc.) use LAG() to get the prior trading day value, ' +
      'preventing lookahead bias. Open-known and static fields are safe to use same-day.',
    sql,
    fieldCounts: {
      openKnown: OPEN_KNOWN_FIELDS.size,
      static: STATIC_FIELDS.size,
      closeDerived: CLOSE_KNOWN_FIELDS.size,
    },
  };
}

// ============================================================================
// Tool Implementation
// ============================================================================

/**
 * Register schema discovery tools with the MCP server.
 *
 * @param server - MCP server instance
 * @param baseDir - Base directory for data files
 */
export function registerSchemaTools(server: McpServer, baseDir: string): void {
  server.registerTool(
    "describe_database",
    {
      description:
        "Get complete database schema: all tables, columns, types, row counts, and example queries. " +
        "Call this BEFORE using run_sql to understand available data and query patterns. " +
        "Returns schema organized by namespace (trades.*, market.*), with descriptions, " +
        "row counts, block breakdowns for trades, and example SQL queries.",
      inputSchema: z.object({}),
    },
    withFullSync(baseDir, async (_, { blockSyncResult }) => {
      const conn = await getConnection(baseDir);

      // Get all user tables in trades/market schemas (excluding sync metadata)
      const tablesResult = await conn.runAndReadAll(`
        SELECT schema_name, table_name, column_count
        FROM duckdb_tables()
        WHERE internal = false
          AND schema_name IN ('trades', 'market')
          AND table_name NOT LIKE '%_sync_metadata'
        ORDER BY schema_name, table_name
      `);

      const tables = tablesResult.getRows() as Array<[string, string, number]>;

      // Build schema output structure
      const schemas: Record<string, SchemaInfo> = {};
      let totalRows = 0;

      for (const [schemaName, tableName] of tables) {
        // Initialize schema if first table in it
        if (!schemas[schemaName]) {
          const schemaDesc = SCHEMA_DESCRIPTIONS[schemaName as keyof typeof SCHEMA_DESCRIPTIONS];
          schemas[schemaName] = {
            description: schemaDesc?.description || `${schemaName} schema`,
            tables: {},
          };
        }

        // Get columns from DuckDB introspection
        const columnsResult = await conn.runAndReadAll(`
          SELECT column_name, data_type, is_nullable
          FROM duckdb_columns()
          WHERE schema_name = '${schemaName}' AND table_name = '${tableName}'
          ORDER BY column_index
        `);

        const columnsData = columnsResult.getRows() as Array<[string, string, boolean]>;

        // Get row count
        const countResult = await conn.runAndReadAll(
          `SELECT COUNT(*) FROM ${schemaName}.${tableName}`
        );
        const rowCount = Number(countResult.getRows()[0][0]);
        totalRows += rowCount;

        // Get hardcoded descriptions for this table
        const schemaDesc = SCHEMA_DESCRIPTIONS[schemaName as keyof typeof SCHEMA_DESCRIPTIONS];
        const tableDesc = schemaDesc?.tables?.[tableName];

        // Build column info with merged descriptions
        const columns: ColumnInfo[] = columnsData.map(
          ([columnName, dataType, isNullable]) => {
            const colDesc: ColumnDescription | undefined =
              tableDesc?.columns?.[columnName];
            return {
              name: columnName,
              type: dataType,
              description: colDesc?.description || "",
              nullable: isNullable,
              hypothesis: colDesc?.hypothesis || false,
              timing: colDesc?.timing,
            };
          }
        );

        // Build table info
        const tableInfo: TableInfo = {
          description: tableDesc?.description || `${tableName} table`,
          keyColumns: tableDesc?.keyColumns || [],
          rowCount,
          columns,
        };

        // For trades.trade_data, add block breakdown
        if (schemaName === "trades" && tableName === "trade_data" && rowCount > 0) {
          const blockResult = await conn.runAndReadAll(`
            SELECT block_id, COUNT(*) as row_count
            FROM trades.trade_data
            GROUP BY block_id
            ORDER BY block_id
          `);
          const blockRows = blockResult.getRows() as Array<[string, bigint]>;
          tableInfo.blockBreakdown = blockRows.map(([blockId, count]) => ({
            blockId,
            rowCount: Number(count),
          }));
        }

        schemas[schemaName].tables[tableName] = tableInfo;
      }

      // Discover available VIX tenors from market.enriched
      let vixTenors: string[] = [];
      try {
        const tenorResult = await conn.runAndReadAll(
          `SELECT DISTINCT ticker FROM market.enriched WHERE ticker LIKE 'VIX%' ORDER BY ticker`
        );
        vixTenors = tenorResult.getRows().map(r => r[0] as string);
      } catch {
        // No market.enriched or no VIX rows — skip
      }

      // Build output
      const result: DatabaseSchemaOutput = {
        schemas,
        examples: EXAMPLE_QUERIES,
        lagTemplate: generateLagTemplate(),
        importWorkflow: {
          description: "Two-step pipeline to populate market tables from CSV exports.",
          steps: [
            "1. import_market_csv — ingest raw CSV (daily OHLCV, VIX tenors, or intraday bars) into market.spot (feeds market.spot_daily) or market.enriched",
            "2. enrich_market_data — compute ~40 derived indicators (RSI, ATR, IVR, IVP, Vol_Regime, etc.) and write back to market.enriched and market.enriched_context",
          ],
        },
        syncInfo: {
          blocksProcessed: blockSyncResult.blocksProcessed,
        },
        vixTenors: vixTenors.length > 0 ? {
          available: vixTenors,
          queryPattern: "SELECT e.date, s.close, e.ivr, e.ivp FROM market.enriched e JOIN market.spot_daily s ON s.date = e.date AND s.ticker = e.ticker WHERE e.ticker = '{TENOR}'",
          ratioPattern: "SELECT a.date, a.close / b.close AS ratio FROM market.spot_daily a JOIN market.spot_daily b ON a.date = b.date AND b.ticker = 'VIX' WHERE a.ticker = '{TENOR}'",
        } : undefined,
      };

      const tableCount = tables.length;
      const schemaCount = Object.keys(schemas).length;
      const summary = `Database schema: ${tableCount} tables across ${schemaCount} schemas. ${totalRows} total rows.`;

      return createToolOutput(summary, result);
    })
  );

  // --------------------------------------------------------------------------
  // purge_market_table - Delete all data from a market table for re-sync
  // --------------------------------------------------------------------------
  server.registerTool(
    "purge_market_table",
    {
      description:
        "Delete all data from a market table and clear its sync metadata. " +
        "Use when market data is corrupted and needs to be re-imported. " +
        "After purging, re-import with the market import tools and re-run enrich_market_data as needed. " +
        "Valid tables: daily, date_context, intraday",
      inputSchema: z.object({
        table: z
          .enum(["daily", "date_context", "intraday"])
          .describe("Market table to purge (without 'market.' prefix)"),
      }),
    },
    async ({ table }) => {
      const conn = await upgradeToReadWrite(baseDir);
      if (getConnectionMode() !== "read_write") {
        throw new Error(
          "Cannot purge market table: another session holds the database write lock. " +
          "Close other Claude Code sessions or wait for their sync to complete."
        );
      }
      try {
        const fullTableName = `market.${table}`;

        // Get current row count before deletion
        const countResult = await conn.runAndReadAll(
          `SELECT COUNT(*) FROM ${fullTableName}`
        );
        const rowsBefore = Number(countResult.getRows()[0][0]);

        // Delete table data and sync metadata atomically
        try {
          await conn.run(`BEGIN TRANSACTION`);
          await conn.run(`DELETE FROM ${fullTableName}`);
          await conn.run(
            `DELETE FROM market._sync_metadata WHERE target_table = '${table}'`
          );
          await conn.run(`COMMIT`);
        } catch (e) {
          await conn.run(`ROLLBACK`).catch(() => {});
          throw e;
        }

        const result = {
          table: fullTableName,
          rowsDeleted: rowsBefore,
          syncMetadataCleared: true,
          nextStep: "Next query will trigger fresh import from CSV",
        };

        return createToolOutput(
          `Purged ${rowsBefore} rows from ${fullTableName}. Sync metadata cleared for matching market files.`,
          result
        );
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    }
  );
}
