/**
 * DuckDB module exports
 *
 * Provides connection management and schema definitions for the analytics database
 * (analytics.duckdb) and the market database (market.duckdb).
 */

export { getConnection, closeConnection, isConnected, upgradeToReadWrite, downgradeToReadOnly, getConnectionMode, getCurrentConnection } from "./connection.ts";
export {
  ensureSyncTables,
  ensureTradeDataTable,
  ensureReportingDataTable,
  tableExists,
} from "./schemas.ts";
export { ensureMutableMarketTables, ensureMarketDataTables } from "./market-schemas.ts";
export { ensureProfilesSchema, upsertProfile, getProfile, listProfiles, deleteProfile } from "./profile-schemas.ts";
export { isParquetMode, writeParquetAtomic, writeParquetPartition, resolveMarketDir } from "./parquet-writer.ts";
export {
  resolveCanonicalMarketFile,
  resolveCanonicalMarketPartitionDir,
  resolveCanonicalMarketPartitionPath,
  resolveCanonicalMarketPartitionFile,
  canonicalMarketTableName,
} from "./market-datasets.ts";
export { readJsonFile, writeJsonFile, deleteJsonFile, listJsonFiles, toFileSlug } from "./json-store.ts";
