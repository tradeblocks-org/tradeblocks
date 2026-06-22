/**
 * Strategy Profile Schema Definitions
 *
 * Creates and manages the `profiles` schema and `profiles.strategy_profiles` table
 * in the analytics DuckDB database. Provides CRUD utilities for strategy profile storage.
 *
 * Schema: profiles
 * Table: profiles.strategy_profiles
 * Primary Key: (block_id, strategy_name) — composite key allows multiple strategies per block
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import type { StrategyProfile } from "../models/strategy-profile.ts";
import { isParquetMode } from "./parquet-writer.ts";
import {
  upsertProfileJson,
  getProfileJson,
  listProfilesJson,
  deleteProfileJson,
} from "./json-adapters.ts";
import { getBlocksDir } from "../sync/index.ts";

/**
 * Ensure the profiles schema and strategy_profiles table exist.
 * Safe to call multiple times (CREATE IF NOT EXISTS semantics).
 *
 * @param conn - Active DuckDB connection
 */
export async function ensureProfilesSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run("CREATE SCHEMA IF NOT EXISTS profiles");
  await conn.run(`
    CREATE TABLE IF NOT EXISTS profiles.strategy_profiles (
      block_id VARCHAR NOT NULL,
      strategy_name VARCHAR NOT NULL,
      structure_type VARCHAR NOT NULL,
      greeks_bias VARCHAR NOT NULL,
      thesis TEXT NOT NULL DEFAULT '',
      legs JSON,
      entry_filters JSON,
      exit_rules JSON,
      expected_regimes JSON,
      key_metrics JSON,
      position_sizing JSON,
      created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (block_id, strategy_name)
    )
  `);
  // Migration: add position_sizing column if table existed before it was added
  await conn.run(`
    ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS position_sizing JSON
  `);
  // Migration: add schema v2 top-level columns (nullable for backward compat)
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS underlying VARCHAR`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS re_entry BOOLEAN`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS cap_profits BOOLEAN`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS cap_losses BOOLEAN`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS require_two_prices_pt BOOLEAN`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS close_on_completion BOOLEAN`,
  );
  await conn.run(
    `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS ignore_margin_req BOOLEAN`,
  );

  // Migration: add strategy execution param columns.
  // block_id stays NOT NULL in the PRIMARY KEY. Template profiles
  // (definitions without a live block) use block_id = '_template' sentinel value.
  // DuckDB does not support ALTER COLUMN ... DROP NOT NULL.
  const strategyCols: Array<{ name: string; type: string }> = [
    { name: "slippage_entry", type: "DOUBLE" },
    { name: "slippage_exit", type: "DOUBLE" },
    { name: "slippage_stop_exit", type: "DOUBLE" },
    { name: "opening_commission", type: "DOUBLE" },
    { name: "closing_commission", type: "DOUBLE" },
    { name: "starting_capital", type: "DOUBLE" },
    { name: "margin_per_spread", type: "DOUBLE" },
    { name: "entry_frequency", type: "VARCHAR" },
    { name: "default_from_date", type: "VARCHAR" },
    { name: "default_to_date", type: "VARCHAR" },
  ];
  for (const col of strategyCols) {
    await conn.run(
      `ALTER TABLE profiles.strategy_profiles ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
    );
  }

  // Migration: normalize expected_regimes to canonical Vol_Regime labels
  // Old values: "low_vol", "moderate_vol", "high_vol", "normal", "low" (free-text)
  // Canonical:  "very_low", "low", "below_avg", "above_avg", "high", "extreme"
  await migrateExpectedRegimes(conn);
}

/**
 * One-shot migration: rewrite expected_regimes JSON arrays from free-text
 * vocabulary to canonical Vol_Regime labels.
 *
 * Mapping:
 *   low_vol      → ["very_low", "low"]
 *   moderate_vol → ["below_avg", "above_avg"]
 *   normal       → ["below_avg", "above_avg"]
 *   high_vol     → ["high", "extreme"]
 *
 * Values already in canonical form are kept as-is. Duplicates are removed.
 * Runs every connection open but only UPDATEs rows containing non-canonical values.
 */
async function migrateExpectedRegimes(conn: DuckDBConnection): Promise<void> {
  const CANONICAL = new Set(["very_low", "low", "below_avg", "above_avg", "high", "extreme"]);
  const MAPPING: Record<string, string[]> = {
    low_vol: ["very_low", "low"],
    moderate_vol: ["below_avg", "above_avg"],
    normal: ["below_avg", "above_avg"],
    high_vol: ["high", "extreme"],
  };

  // Read all profiles with non-empty expected_regimes
  const result = await conn.runAndReadAll(
    `SELECT block_id, strategy_name, expected_regimes
     FROM profiles.strategy_profiles
     WHERE expected_regimes IS NOT NULL AND expected_regimes != '[]'`,
  );

  for (const row of result.getRows()) {
    const blockId = String(row[0]);
    const strategyName = String(row[1]);
    const rawJson = String(row[2]);

    let regimes: string[];
    try {
      regimes = JSON.parse(rawJson);
    } catch {
      continue;
    }

    // Check if any value needs mapping
    const needsMigration = regimes.some((r) => !CANONICAL.has(r));
    if (!needsMigration) continue;

    // Expand free-text values to canonical labels
    const expanded = new Set<string>();
    for (const r of regimes) {
      if (CANONICAL.has(r)) {
        expanded.add(r);
      } else if (MAPPING[r]) {
        for (const mapped of MAPPING[r]) expanded.add(mapped);
      }
      // Unknown values are dropped silently
    }

    const newJson = JSON.stringify([...expanded].sort());
    await conn.run(
      `UPDATE profiles.strategy_profiles
       SET expected_regimes = '${escSql(newJson)}', updated_at = current_timestamp
       WHERE block_id = '${escSql(blockId)}' AND strategy_name = '${escSql(strategyName)}'`,
    );
  }
}

/**
 * Escape a single-quoted string for safe inclusion in DuckDB SQL.
 * Doubles any embedded single quotes.
 */
function escSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Convert a DuckDB row value to a JS Date.
 * DuckDB timestamps may come back as numbers (microseconds since epoch) or Date objects.
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "bigint") {
    // DuckDB timestamps are microseconds since Unix epoch
    return new Date(Number(value) / 1000);
  }
  if (typeof value === "number") {
    // May be microseconds or milliseconds depending on DuckDB version
    // Values larger than ~9e12 are likely microseconds
    return value > 9e12 ? new Date(value / 1000) : new Date(value);
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  return new Date();
}

/**
 * Map a DuckDB row array to a StrategyProfile object.
 * Column order must match the SELECT in query functions.
 *
 * Column order: block_id, strategy_name, structure_type, greeks_bias, thesis,
 *               legs, entry_filters, exit_rules, expected_regimes, key_metrics,
 *               position_sizing, underlying, re_entry, cap_profits, cap_losses,
 *               require_two_prices_pt, close_on_completion, ignore_margin_req,
 *               created_at, updated_at
 */
function rowToProfile(row: unknown[]): StrategyProfile {
  const parseJson = (v: unknown) => {
    if (v === null || v === undefined) return [];
    if (typeof v === "string") return JSON.parse(v);
    return v; // DuckDB may auto-parse JSON columns
  };

  const parseJsonObj = (v: unknown) => {
    if (v === null || v === undefined) return {};
    if (typeof v === "string") return JSON.parse(v);
    return v;
  };

  const toBoolOrUndef = (v: unknown): boolean | undefined =>
    v === null || v === undefined ? undefined : Boolean(v);

  return {
    blockId: row[0] as string,
    strategyName: row[1] as string,
    structureType: row[2] as string,
    greeksBias: row[3] as string,
    thesis: row[4] as string,
    legs: parseJson(row[5]),
    entryFilters: parseJson(row[6]),
    exitRules: parseJson(row[7]),
    expectedRegimes: parseJson(row[8]),
    keyMetrics: parseJsonObj(row[9]),
    positionSizing: (() => {
      const ps = parseJsonObj(row[10]);
      return ps && Object.keys(ps).length > 0 ? ps : undefined;
    })(),
    underlying: (row[11] as string | undefined) ?? undefined,
    reEntry: toBoolOrUndef(row[12]),
    capProfits: toBoolOrUndef(row[13]),
    capLosses: toBoolOrUndef(row[14]),
    requireTwoPricesPT: toBoolOrUndef(row[15]),
    closeOnCompletion: toBoolOrUndef(row[16]),
    ignoreMarginReq: toBoolOrUndef(row[17]),
    createdAt: toDate(row[18]),
    updatedAt: toDate(row[19]),
  };
}

const SELECT_COLUMNS = `
  block_id, strategy_name, structure_type, greeks_bias, thesis,
  legs, entry_filters, exit_rules, expected_regimes, key_metrics,
  position_sizing, underlying, re_entry, cap_profits, cap_losses,
  require_two_prices_pt, close_on_completion, ignore_margin_req,
  created_at, updated_at
`.trim();

/**
 * Upsert a strategy profile.
 * If a profile with the same (block_id, strategy_name) exists, it is overwritten.
 * created_at is preserved on update; updated_at is set to the current timestamp.
 *
 * @param conn - Active DuckDB connection
 * @param profile - Profile to insert or update (createdAt/updatedAt are managed by DB)
 * @returns The stored profile with DB-assigned timestamps
 */
export async function upsertProfile(
  conn: DuckDBConnection,
  profile: Omit<StrategyProfile, "createdAt" | "updatedAt">,
  baseDir?: string,
): Promise<StrategyProfile> {
  if (isParquetMode() && baseDir) {
    return upsertProfileJson(profile, getBlocksDir(baseDir));
  }
  const legsJson = escSql(JSON.stringify(profile.legs));
  const entryFiltersJson = escSql(JSON.stringify(profile.entryFilters));
  const exitRulesJson = escSql(JSON.stringify(profile.exitRules));
  const expectedRegimesJson = escSql(JSON.stringify(profile.expectedRegimes));
  const keyMetricsJson = escSql(JSON.stringify(profile.keyMetrics));
  const positionSizingJson = profile.positionSizing
    ? escSql(JSON.stringify(profile.positionSizing))
    : null;

  const nowTs = new Date().toISOString().replace("T", " ").replace("Z", "");

  const underlyingSql = profile.underlying ? `'${escSql(profile.underlying)}'` : "NULL";
  const reEntrySql = profile.reEntry === undefined ? "NULL" : String(profile.reEntry);
  const capProfitsSql = profile.capProfits === undefined ? "NULL" : String(profile.capProfits);
  const capLossesSql = profile.capLosses === undefined ? "NULL" : String(profile.capLosses);
  const requireTwoPricesPTSql =
    profile.requireTwoPricesPT === undefined ? "NULL" : String(profile.requireTwoPricesPT);
  const closeOnCompletionSql =
    profile.closeOnCompletion === undefined ? "NULL" : String(profile.closeOnCompletion);
  const ignoreMarginReqSql =
    profile.ignoreMarginReq === undefined ? "NULL" : String(profile.ignoreMarginReq);

  await conn.run(`
    INSERT INTO profiles.strategy_profiles
      (block_id, strategy_name, structure_type, greeks_bias, thesis,
       legs, entry_filters, exit_rules, expected_regimes, key_metrics,
       position_sizing, underlying, re_entry, cap_profits, cap_losses,
       require_two_prices_pt, close_on_completion, ignore_margin_req,
       created_at, updated_at)
    VALUES (
      '${escSql(profile.blockId)}',
      '${escSql(profile.strategyName)}',
      '${escSql(profile.structureType)}',
      '${escSql(profile.greeksBias)}',
      '${escSql(profile.thesis)}',
      '${legsJson}'::JSON,
      '${entryFiltersJson}'::JSON,
      '${exitRulesJson}'::JSON,
      '${expectedRegimesJson}'::JSON,
      '${keyMetricsJson}'::JSON,
      ${positionSizingJson ? `'${positionSizingJson}'::JSON` : "NULL"},
      ${underlyingSql},
      ${reEntrySql},
      ${capProfitsSql},
      ${capLossesSql},
      ${requireTwoPricesPTSql},
      ${closeOnCompletionSql},
      ${ignoreMarginReqSql},
      TIMESTAMPTZ '${nowTs}',
      TIMESTAMPTZ '${nowTs}'
    )
    ON CONFLICT (block_id, strategy_name) DO UPDATE SET
      structure_type = excluded.structure_type,
      greeks_bias = excluded.greeks_bias,
      thesis = excluded.thesis,
      legs = excluded.legs,
      entry_filters = excluded.entry_filters,
      exit_rules = excluded.exit_rules,
      expected_regimes = excluded.expected_regimes,
      key_metrics = excluded.key_metrics,
      position_sizing = excluded.position_sizing,
      underlying = excluded.underlying,
      re_entry = excluded.re_entry,
      cap_profits = excluded.cap_profits,
      cap_losses = excluded.cap_losses,
      require_two_prices_pt = excluded.require_two_prices_pt,
      close_on_completion = excluded.close_on_completion,
      ignore_margin_req = excluded.ignore_margin_req,
      updated_at = TIMESTAMPTZ '${nowTs}'
  `);

  const stored = await getProfile(conn, profile.blockId, profile.strategyName, baseDir);
  if (!stored) {
    throw new Error(
      `Failed to retrieve profile after upsert: ${profile.blockId}/${profile.strategyName}`,
    );
  }
  return stored;
}

/**
 * Retrieve a single strategy profile by block_id and strategy_name.
 *
 * @param conn - Active DuckDB connection
 * @param blockId - Block identifier
 * @param strategyName - Strategy name
 * @returns The profile, or null if not found
 */
export async function getProfile(
  conn: DuckDBConnection,
  blockId: string,
  strategyName: string,
  baseDir?: string,
): Promise<StrategyProfile | null> {
  if (isParquetMode() && baseDir) {
    return getProfileJson(blockId, strategyName, getBlocksDir(baseDir));
  }
  const result = await conn.runAndReadAll(`
    SELECT ${SELECT_COLUMNS}
    FROM profiles.strategy_profiles
    WHERE block_id = '${escSql(blockId)}'
      AND strategy_name = '${escSql(strategyName)}'
  `);
  const rows = result.getRows();
  if (rows.length === 0) return null;
  return rowToProfile(rows[0]);
}

/**
 * List strategy profiles.
 *
 * @param conn - Active DuckDB connection
 * @param blockId - Optional filter; if provided, only profiles for that block are returned
 * @returns Array of matching profiles
 */
export async function listProfiles(
  conn: DuckDBConnection,
  blockId?: string,
  baseDir?: string,
): Promise<StrategyProfile[]> {
  if (isParquetMode() && baseDir) {
    return listProfilesJson(getBlocksDir(baseDir), blockId);
  }
  const whereClause = blockId ? `WHERE block_id = '${escSql(blockId)}'` : "";

  const result = await conn.runAndReadAll(`
    SELECT ${SELECT_COLUMNS}
    FROM profiles.strategy_profiles
    ${whereClause}
    ORDER BY block_id, strategy_name
  `);

  return result.getRows().map(rowToProfile);
}

/**
 * Delete a strategy profile by block_id and strategy_name.
 *
 * @param conn - Active DuckDB connection
 * @param blockId - Block identifier
 * @param strategyName - Strategy name
 * @returns true if a row was deleted, false if no matching row existed
 */
export async function deleteProfile(
  conn: DuckDBConnection,
  blockId: string,
  strategyName: string,
  baseDir?: string,
): Promise<boolean> {
  if (isParquetMode() && baseDir) {
    return deleteProfileJson(blockId, strategyName, getBlocksDir(baseDir));
  }
  // Check existence before delete so we can return accurate boolean
  const existing = await getProfile(conn, blockId, strategyName);
  if (!existing) return false;

  await conn.run(`
    DELETE FROM profiles.strategy_profiles
    WHERE block_id = '${escSql(blockId)}'
      AND strategy_name = '${escSql(strategyName)}'
  `);

  return true;
}
