/**
 * JSON Adapters for Metadata Stores
 *
 * Provides CRUD operations for five metadata stores backed by JSON files:
 * 1. Strategy profiles — per-block, per-strategy JSON files
 * 2. Sync metadata — per-block .sync-meta.json files
 * 3. Market import metadata — single aggregate file
 * 4. Flat import log — single aggregate file
 * 5. Enrichment watermarks — single aggregate file
 *
 * All adapters use json-store.ts for atomic write-then-rename operations.
 * File paths follow the canonical data-root layout.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  readJsonFile,
  writeJsonFile,
  deleteJsonFile,
  listJsonFiles,
  toFileSlug,
} from "./json-store.ts";
import { getDataRoot } from "./data-root.ts";
import type { StrategyProfile } from "../models/strategy-profile.ts";
import type { BlockSyncMetadata, MarketImportMetadata } from "../sync/metadata.ts";

// =============================================================================
// 1. Profile Adapter
//    Path: {blocksDir}/{blockId}/profiles/{toFileSlug(strategyName)}.json
// =============================================================================

/** Profile as stored in JSON (dates as ISO strings) */
interface ProfileJson extends Omit<StrategyProfile, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}

/** Convert StrategyProfile to JSON-safe format */
function profileToJson(profile: StrategyProfile): ProfileJson {
  return {
    ...profile,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/** Convert JSON-stored profile back to StrategyProfile with Date objects */
function jsonToProfile(json: ProfileJson): StrategyProfile {
  return {
    ...json,
    createdAt: new Date(json.createdAt),
    updatedAt: new Date(json.updatedAt),
  };
}

/** Resolve file path for a profile */
function profilePath(blockId: string, strategyName: string, blocksDir: string): string {
  return path.join(blocksDir, blockId, "profiles", toFileSlug(strategyName) + ".json");
}

/**
 * Create or update a profile JSON file.
 * Preserves existing createdAt on update; always sets new updatedAt.
 *
 * @param profile - Profile data (createdAt/updatedAt are managed automatically)
 * @param blocksDir - Root blocks directory
 * @returns The saved StrategyProfile with Date objects
 */
export async function upsertProfileJson(
  profile: Omit<StrategyProfile, "createdAt" | "updatedAt">,
  blocksDir: string,
): Promise<StrategyProfile> {
  const filePath = profilePath(profile.blockId, profile.strategyName, blocksDir);
  const now = new Date();

  // Preserve existing createdAt
  const existing = await readJsonFile<ProfileJson>(filePath);
  const createdAt = existing ? new Date(existing.createdAt) : now;

  const full: StrategyProfile = {
    ...profile,
    createdAt,
    updatedAt: now,
  };

  await writeJsonFile(filePath, profileToJson(full));
  return full;
}

/**
 * Get a profile by blockId and strategy name.
 *
 * @returns StrategyProfile with Date objects, or null if not found
 */
export async function getProfileJson(
  blockId: string,
  strategyName: string,
  blocksDir: string,
): Promise<StrategyProfile | null> {
  const filePath = profilePath(blockId, strategyName, blocksDir);
  const json = await readJsonFile<ProfileJson>(filePath);
  return json ? jsonToProfile(json) : null;
}

/**
 * List profiles for a block, or all profiles across all blocks.
 *
 * @param blocksDir - Root blocks directory
 * @param blockId - Optional block ID. If omitted, scans all block directories.
 * @returns Array of StrategyProfile with Date objects
 */
export async function listProfilesJson(
  blocksDir: string,
  blockId?: string,
): Promise<StrategyProfile[]> {
  if (blockId) {
    const profileDir = path.join(blocksDir, blockId, "profiles");
    const files = await listJsonFiles(profileDir);
    const profiles: StrategyProfile[] = [];
    for (const file of files) {
      const json = await readJsonFile<ProfileJson>(file);
      if (json) profiles.push(jsonToProfile(json));
    }
    return profiles;
  }

  // Scan all block directories
  const profiles: StrategyProfile[] = [];
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(blocksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const blockProfiles = await listProfilesJson(blocksDir, entry.name);
    profiles.push(...blockProfiles);
  }
  return profiles;
}

/**
 * Delete a profile JSON file.
 *
 * @returns true if deleted, false if not found
 */
export async function deleteProfileJson(
  blockId: string,
  strategyName: string,
  blocksDir: string,
): Promise<boolean> {
  const filePath = profilePath(blockId, strategyName, blocksDir);
  return deleteJsonFile(filePath);
}

// =============================================================================
// 2. Sync Metadata Adapter
//    Path: {blocksDir}/{blockId}/.sync-meta.json
// =============================================================================

/** Sync metadata as stored in JSON (synced_at as ISO string) */
interface SyncMetadataJson extends Omit<BlockSyncMetadata, "synced_at"> {
  synced_at: string;
}

/** Convert BlockSyncMetadata to JSON-safe format */
function syncMetaToJson(meta: BlockSyncMetadata): SyncMetadataJson {
  return {
    ...meta,
    synced_at: meta.synced_at.toISOString(),
  };
}

/** Convert JSON-stored sync metadata back to BlockSyncMetadata with Date */
function jsonToSyncMeta(json: SyncMetadataJson): BlockSyncMetadata {
  return {
    ...json,
    synced_at: new Date(json.synced_at),
  };
}

/** Resolve file path for sync metadata */
function syncMetaPath(blockId: string, blocksDir: string): string {
  return path.join(blocksDir, blockId, ".sync-meta.json");
}

/**
 * Get sync metadata for a block.
 *
 * @returns BlockSyncMetadata with synced_at as Date, or null if not found
 */
export async function getSyncMetadataJson(
  blockId: string,
  blocksDir: string,
): Promise<BlockSyncMetadata | null> {
  const filePath = syncMetaPath(blockId, blocksDir);
  const json = await readJsonFile<SyncMetadataJson>(filePath);
  return json ? jsonToSyncMeta(json) : null;
}

/**
 * Write sync metadata for a block.
 */
export async function upsertSyncMetadataJson(
  metadata: BlockSyncMetadata,
  blocksDir: string,
): Promise<void> {
  const filePath = syncMetaPath(metadata.block_id, blocksDir);
  await writeJsonFile(filePath, syncMetaToJson(metadata));
}

/**
 * Delete sync metadata for a block.
 *
 * @returns true if deleted, false if not found
 */
export async function deleteSyncMetadataJson(blockId: string, blocksDir: string): Promise<boolean> {
  const filePath = syncMetaPath(blockId, blocksDir);
  return deleteJsonFile(filePath);
}

/**
 * Scan blocksDir for directories containing .sync-meta.json.
 *
 * @returns Array of block IDs that have sync metadata
 */
export async function getAllSyncedBlockIdsJson(blocksDir: string): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(blocksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = syncMetaPath(entry.name, blocksDir);
    try {
      await fs.access(metaPath);
      ids.push(entry.name);
    } catch {
      // No .sync-meta.json in this directory
    }
  }
  return ids;
}

// =============================================================================
// 3. Market Import Metadata Adapter
//    Path: {dataDir}/market-meta/sync-metadata.json
// =============================================================================

/** Market import metadata as stored in JSON (synced_at as ISO string) */
type MarketImportMetadataJson = Omit<MarketImportMetadata, "synced_at"> & { synced_at: string };

/** Aggregate file shape for market import metadata */
interface MarketSyncMetadataFile {
  entries: Record<string, MarketImportMetadataJson>;
}

/** Build composite key for market import metadata */
function marketMetaKey(source: string, ticker: string, targetTable: string): string {
  return `${source}|${ticker}|${targetTable}`;
}

/** Resolve file path for market import metadata aggregate file */
function marketMetaFilePath(dataDir: string): string {
  return path.join(getDataRoot(dataDir), "market-meta", "sync-metadata.json");
}

/**
 * Get market import metadata for a specific source/ticker/table combination.
 *
 * @returns MarketImportMetadata with synced_at as Date, or null if not found
 */
export async function getMarketImportMetadataJson(
  source: string,
  ticker: string,
  targetTable: string,
  dataDir: string,
): Promise<MarketImportMetadata | null> {
  const filePath = marketMetaFilePath(dataDir);
  const file = await readJsonFile<MarketSyncMetadataFile>(filePath);
  if (!file) return null;

  const key = marketMetaKey(source, ticker, targetTable);
  const entry = file.entries[key];
  if (!entry) return null;

  return {
    ...entry,
    synced_at: new Date(entry.synced_at),
  };
}

/**
 * Create or update market import metadata entry.
 * Reads the aggregate file, updates the entry, writes back atomically.
 */
export async function upsertMarketImportMetadataJson(
  metadata: MarketImportMetadata,
  dataDir: string,
): Promise<void> {
  const filePath = marketMetaFilePath(dataDir);
  const file = (await readJsonFile<MarketSyncMetadataFile>(filePath)) ?? { entries: {} };

  const key = marketMetaKey(metadata.source, metadata.ticker, metadata.target_table);
  file.entries[key] = {
    ...metadata,
    synced_at: metadata.synced_at.toISOString(),
  };

  await writeJsonFile(filePath, file);
}

// =============================================================================
// 4. Flat Import Log Adapter
//    Path: {dataDir}/market-meta/flat-import-log.json
// =============================================================================

/** Single entry in the flat import log */
export interface FlatImportLogEntry {
  date: string;
  asset_class: string;
  underlying: string;
  imported_at: string;
  bar_count: number;
}

/** Aggregate file shape for flat import log */
interface FlatImportLogFile {
  entries: FlatImportLogEntry[];
}

/** Build composite key for deduplication */
function flatLogKey(entry: FlatImportLogEntry): string {
  return `${entry.date}|${entry.asset_class}|${entry.underlying}`;
}

/** Resolve file path for flat import log */
function flatLogFilePath(dataDir: string): string {
  return path.join(getDataRoot(dataDir), "market-meta", "flat-import-log.json");
}

/**
 * Get imported dates from the flat import log, filtered by asset_class, underlying, and date range.
 *
 * @returns Set of imported date strings
 */
export async function getFlatImportLogJson(
  assetClass: string,
  underlying: string,
  from: string,
  to: string,
  dataDir: string,
): Promise<Set<string>> {
  const filePath = flatLogFilePath(dataDir);
  const file = await readJsonFile<FlatImportLogFile>(filePath);
  if (!file) return new Set();

  const dates = new Set<string>();
  for (const entry of file.entries) {
    if (
      entry.asset_class === assetClass &&
      entry.underlying === underlying &&
      entry.date >= from &&
      entry.date <= to
    ) {
      dates.add(entry.date);
    }
  }
  return dates;
}

/**
 * Create or update a flat import log entry.
 * Replaces by composite key (date, asset_class, underlying).
 */
export async function upsertFlatImportLogJson(
  entry: FlatImportLogEntry,
  dataDir: string,
): Promise<void> {
  const filePath = flatLogFilePath(dataDir);
  const file = (await readJsonFile<FlatImportLogFile>(filePath)) ?? { entries: [] };

  const key = flatLogKey(entry);
  const idx = file.entries.findIndex((e) => flatLogKey(e) === key);
  if (idx >= 0) {
    file.entries[idx] = entry;
  } else {
    file.entries.push(entry);
  }

  await writeJsonFile(filePath, file);
}

// =============================================================================
// 5. Enrichment Watermarks Adapter
//    Path: {dataRoot}/market-meta/enrichment-watermarks.json
//
//    Tracks per-ticker `enriched_through` watermark for the market enricher.
//    Replaces the legacy `market._sync_metadata.enriched_through` SQL
//    reads/writes. Backend-independent — the same JSON file is written
//    whether Parquet mode is true or false.
//
//    Storage shape:
//      {
//        "version": 1,
//        "watermarks": {
//          "SPX":  { "enriched_through": "2026-04-15" },
//          "VIX":  { "enriched_through": "2026-04-14" }
//        }
//      }
//
//    Each entry is an object (not a bare string) so future additions
//    (`wilder_state`, `synced_at`, `last_source`) do not require a schema bump.
// =============================================================================

const TickerEntrySchema = z
  .object({
    // ISO calendar date `YYYY-MM-DD` or null when the ticker has been
    // registered but not yet enriched through any date.
    enriched_through: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  // Passthrough keeps forward compatibility — fields like `wilder_state` added
  // by future phases survive load/upsert round-trips without schema changes.
  .passthrough();

export const EnrichmentWatermarksSchema = z.object({
  version: z.literal(1),
  // Defense-in-depth ticker whitelist: mirrors the TICKER_RE used by
  // src/market/tickers/schemas.ts and rejects anything not shaped like a ticker.
  watermarks: z.record(z.string().regex(/^[A-Z0-9._-]+$/), TickerEntrySchema),
});

export type EnrichmentWatermarks = z.infer<typeof EnrichmentWatermarksSchema>;

/** Resolve file path for the aggregate enrichment-watermarks file. */
function watermarksFilePath(dataDir: string): string {
  return path.join(getDataRoot(dataDir), "market-meta", "enrichment-watermarks.json");
}

/**
 * Load the enrichment watermarks file.
 *
 * Missing file resolves to an empty structure — absent means "nothing
 * enriched yet", not an error. Malformed JSON or schema violations throw a
 * clear error; we never silently reset to empty, which would lose data
 * invisibly.
 */
export async function loadEnrichmentWatermarks(dataDir: string): Promise<EnrichmentWatermarks> {
  const raw = await readJsonFile<unknown>(watermarksFilePath(dataDir));
  if (raw === null) return { version: 1, watermarks: {} };
  const parsed = EnrichmentWatermarksSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`enrichment-watermarks.json is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Return the `enriched_through` date for a ticker, or null if no entry exists.
 *
 * Callers that treat "missing entry" and "entry with null enriched_through" the
 * same (most common case) can use the value directly; callers that need to
 * distinguish can read the raw file via `loadEnrichmentWatermarks`.
 */
export async function getEnrichedThrough(ticker: string, dataDir: string): Promise<string | null> {
  const { watermarks } = await loadEnrichmentWatermarks(dataDir);
  return watermarks[ticker]?.enriched_through ?? null;
}

/**
 * Upsert a ticker's `enriched_through` date.
 *
 * Preserves other tickers' entries and any passthrough fields (e.g.,
 * `wilder_state`) already stored on the target ticker.
 *
 * Concurrency note: atomic at the FS level (tmp+rename via writeJsonFile);
 * this is NOT read-modify-write atomic at the application level. Serial
 * callers (the current enricher flow) are safe. If concurrent enrichers of
 * different tickers become real, add an async-mutex.
 */
export async function upsertEnrichedThrough(
  ticker: string,
  enrichedThrough: string,
  dataDir: string,
): Promise<void> {
  const current = await loadEnrichmentWatermarks(dataDir);
  current.watermarks[ticker] = {
    ...(current.watermarks[ticker] ?? {}),
    enriched_through: enrichedThrough,
  };
  await writeJsonFile(watermarksFilePath(dataDir), current);
}
