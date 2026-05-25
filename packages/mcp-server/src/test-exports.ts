/**
 * Test exports for MCP server utilities
 *
 * This file re-exports functions needed for testing.
 * The main index.ts is an MCP server entry point that doesn't export these utilities.
 */

export {
  loadBlock,
  listBlocks,
  loadReportingLog,
  importCsv,
  type BlockInfo,
  type LoadedBlock,
  type CsvMappings,
  type ImportCsvResult,
  type ImportCsvOptions,
} from './utils/block-loader.js';

// Export CSV discovery utilities for unit testing
export { detectCsvType, discoverCsvFiles, logCsvDiscoveryWarning, type CsvType } from './utils/csv-discovery.js';

// Export PortfolioStatsCalculator for testing block_diff logic
export { PortfolioStatsCalculator } from '@tradeblocks/lib';

// Export correlation and tail-risk utilities for testing strategy_similarity
export { calculateCorrelationMatrix, performTailRiskAnalysis } from '@tradeblocks/lib';

// Export sync layer for integration testing
export {
  syncAllBlocks,
  syncBlock,
  type SyncResult,
  type BlockSyncResult,
} from './sync/index.js';

// Export DuckDB connection utilities for integration testing
export { getConnection, getReadOnlyConnection, closeConnection, isConnected, getConnectionMode, upgradeToReadWrite, downgradeToReadOnly, getCurrentConnection } from './db/connection.js';
export { setDataRoot, getDataRoot, resetDataRoot } from './db/data-root.js';
export { yesterdayET } from './utils/trading-dates.js';
export {
  resolveCanonicalMarketFile,
  resolveCanonicalMarketPartitionDir,
  resolveCanonicalMarketPartitionPath,
  resolveCanonicalMarketPartitionFile,
  canonicalMarketTableName,
} from './db/market-datasets.js';

// Export market schema utilities for integration testing
export { ensureMutableMarketTables, ensureMarketDataTables } from './db/market-schemas.js';

// Export shared filter utilities for testing
export {
  filterByStrategy,
  filterByDateRange,
  filterDailyLogsByDateRange,
} from './tools/shared/filters.js';

// Export field timing utilities for testing
export {
  OPEN_KNOWN_FIELDS,
  CLOSE_KNOWN_FIELDS,
  STATIC_FIELDS,
  DAILY_OPEN_FIELDS,
  DAILY_CLOSE_FIELDS,
  DAILY_STATIC_FIELDS,
  CONTEXT_OPEN_FIELDS,
  CONTEXT_CLOSE_FIELDS,
  buildLookaheadFreeQuery,
  buildOutcomeQuery,
  buildVixJoinClause,
} from './utils/field-timing.js';

// Export data availability helper for testing
export {
  checkDataAvailability,
  type DataAvailabilityReport,
} from './utils/data-availability.js';
export {
  queryCoverage,
  scoreDataQuality,
  formatCoverageReport,
  type DataQualityInput,
  type CoverageResult,
} from './utils/data-quality.js';

// Export intraday timing utilities for testing
export { computeIntradayTimingFields } from './utils/market-enricher.js';

// Export schema metadata for classification completeness tests
export { SCHEMA_DESCRIPTIONS } from './utils/schema-metadata.js';
export type { ColumnDescription } from './utils/schema-metadata.js';

// Export market import utilities for integration testing
export {
  validateColumnMapping,
  importMarketCsvFile,
  importFromDatabase,
  parseCsvToBars,
  parseDatabaseRowsToBars,
  type ImportMarketCsvParams,
  type ImportFromDatabaseParams,
  type ImportSpotResult,
} from './utils/market-importer.js';

// Export market import metadata helpers for integration testing
export {
  type MarketImportMetadata,
  getMarketImportMetadata,
  upsertMarketImportMetadata,
} from './sync/metadata.js';

// Export market enricher indicator functions for unit testing
export {
  computeRSI,
  computeATR,
  computeEMA,
  computeSMA,
  computeRealizedVol,
  computeConsecutiveDays,
  isGapFilled,
  isOpex,
  computeVIXDerivedFields,
  classifyVolRegime,
  classifyTrendDirection,
  classifyTermStructure,
  computeIVR,
  computeIVP,
  type ContextRow,
  type EnrichedContextRow,
} from './utils/market-enricher.js';

// Export market enrichment utilities for integration testing
export {
  runEnrichment,
  runContextEnrichment,
  type EnrichmentResult,
  type EnrichmentOptions,
  type TierStatus,
} from './utils/market-enricher.js';

// Export strategy profile types and CRUD functions for integration testing
export type {
  StrategyProfile,
  StrategyProfileRow,
  LegDetail,
  EntryFilter,
  ExitRule,
  KeyMetrics,
  PositionSizing,
} from './models/strategy-profile.js';
export {
  ensureProfilesSchema,
  upsertProfile,
  getProfile,
  listProfiles,
  deleteProfile,
} from './db/profile-schemas.js';

// Export analysis utility modules for unit testing
export { computeSliceStats, type SliceStats } from './utils/analysis-stats.js';
export { buildFilterPredicate, type FilterPredicate } from './utils/filter-predicates.js';

// Export profile tool handlers and schemas for integration testing
export {
  handleProfileStrategy,
  handleGetStrategyProfile,
  handleListProfiles,
  handleDeleteProfile,
  profileStrategySchema,
  getStrategyProfileSchema,
  listProfilesSchema,
  deleteProfileSchema,
} from './tools/profiles.js';

// Export profile analysis tool handlers and schemas for integration testing
export {
  handleAnalyzeStructureFit,
  handleValidateEntryFilters,
  handlePortfolioStructureMap,
  analyzeStructureFitSchema,
  validateEntryFiltersSchema,
  portfolioStructureMapSchema,
} from './tools/profile-analysis.js';

// Export regime advisor tool handler and schema for integration testing
export {
  handleRegimeAllocationAdvisor,
  regimeAllocationAdvisorSchema,
} from './tools/regime-advisor.js';

// Export market data provider interface and types
export {
  getProvider,
  _resetProvider,
  type BarRow,
  type AssetClass,
  type OptionContract,
  type FetchBarsOptions,
  type FetchSnapshotOptions,
  type FetchSnapshotResult,
  type MarketDataProvider,
} from './utils/market-provider.js';
export {
  resolveMassiveDataTier,
  resolveProviderCapabilities,
  getResolvedProviderCapabilities,
  type MassiveDataTier,
  type ResolvedProviderCapabilities,
} from './utils/provider-capabilities.js';

// Export Massive provider internals for provider-specific tests
export {
  MassiveProvider,
  toMassiveTicker,
  fromMassiveTicker,
  massiveTimestampToETDate,
  massiveTimestampToETTime,
  nanosToETMinuteKey,
  MassiveBarSchema,
  MassiveAggregateResponseSchema,
  MassiveQuoteSchema,
  MassiveQuotesResponseSchema,
  MASSIVE_BASE_URL,
  MASSIVE_MAX_LIMIT,
  MASSIVE_MAX_PAGES,
  type MassiveBar,
  type MassiveAggregateResponse,
  type MassiveQuote,
  type MassiveQuotesResponse,
} from './utils/providers/massive.js';

// Export trade replay utilities for unit testing
export {
  parseLegsString,
  buildOccTicker,
  computeStrategyPnlPath,
  computeReplayMfeMae,
  findNearestTimestamp,
  markPrice,
  type ReplayLeg,
  type ReplayResult,
  type PnlPoint,
  type ParsedLeg,
  type ParsedLegOO,
  type GreeksConfig,
} from './utils/trade-replay.js';

// Export trade replay tool handler and schema for integration testing
export {
  handleReplayTrade,
  replayTradeSchema,
  resolveOODateRange,
} from './tools/replay.js';

// Export Black-Scholes and Bachelier greeks computation for unit testing
export {
  pdf,
  cdf,
  bsPrice,
  bsDelta,
  bsGamma,
  bsTheta,
  bsVega,
  solveIV,
  bachelierPrice,
  bachelierDelta,
  bachelierGamma,
  bachelierTheta,
  bachelierVega,
  solveNormalIV,
  BACHELIER_DTE_THRESHOLD,
  computeLegGreeks,
  type GreeksResult,
} from './utils/black-scholes.js';

export { computeFractionalDte } from './utils/option-time.js';
export {
  applyQuoteGreeks,
  hasQuoteGreeks,
  OPTION_QUOTE_GREEKS_REVISION,
  type QuoteGreeksMode,
  type QuoteGreeksSource,
} from './utils/option-quote-greeks.js';
export {
  describeReadParquetColumns,
  quoteParquetCanonicalProjection,
  readParquetFilesSql,
} from './utils/quote-parquet-projection.js';

// Export parquet-writer utility functions for unit testing
export { isParquetMode, writeParquetAtomic, writeParquetPartition, resolveMarketDir } from './db/parquet-writer.js';

// Export json-store utility for unit testing
export {
  readJsonFile,
  writeJsonFile,
  deleteJsonFile,
  listJsonFiles,
  toFileSlug,
} from './db/json-store.js';

// Export Massive snapshot schemas for unit testing
export {
  MassiveSnapshotResponseSchema,
  MassiveSnapshotContractSchema,
} from './utils/providers/massive.js';

// Export snapshot tool handler and schema for integration testing
export {
  handleGetOptionSnapshot,
  getOptionSnapshotSchema,
} from './tools/snapshot.js';

// Export greeks decomposition utilities for unit testing
export {
  decomposeGreeks,
  computeTimeDeltaDays,
  type GreeksDecompositionConfig,
  type GreeksDecompositionResult,
  type FactorContribution,
  type LegGroupVega,
  type LegGroupDef,
  type FactorName,
} from './utils/greeks-decomposition.js';

// Export exit trigger analysis utilities for unit testing
export {
  evaluateTrigger,
  analyzeExitTriggers,
  type ExitTriggerConfig,
  type ExitTriggerResult,
  type TriggerFireEvent,
  type TriggerType,
  type LegGroupConfig,
  type LegGroupResult,
} from './utils/exit-triggers.js';

// Export exit analysis tool handlers and schemas for integration testing
export {
  handleAnalyzeExitTriggers,
  handleDecomposeGreeks,
  analyzeExitTriggersSchema,
  decomposeGreeksSchema,
} from './tools/exit-analysis.js';

// Export batch exit analysis engine for unit testing
export {
  analyzeBatch,
  computeAggregateStats,
  computeTriggerAttribution,
  type BatchExitConfig,
  type BatchExitResult,
  type TradeExitResult,
  type TradeInput,
  type AggregateStats,
  type TriggerAttribution,
  type BaselineMode,
} from './utils/batch-exit-analysis.js';

// Export batch exit analysis tool handler and schema for integration testing
export {
  handleBatchExitAnalysis,
  batchExitAnalysisSchema,
} from './tools/batch-exit-analysis.js';

// Export quote enricher pure functions for unit testing
export { shouldSkipEnrichment, buildEnrichmentPlan } from './utils/quote-enricher.js';
export type { EnrichmentPlanInput } from './utils/quote-enricher.js';

// SQL tool validator — unit-tested for path-gate + hard-block rules
export { validateQuery, isUnderDataRoot } from './tools/sql.js';

// Chain loader pure functions (unit testing)
export { filterChain } from './utils/chain-loader.js';

// Provider classes for capability-resolution testing
export { ThetaDataProvider } from './utils/providers/thetadata.js';

// ThetaData MDDS provider internals (unit testing)
export {
  ThetaMddsClient,
  computeThetaQuoteMidGreekRow,
  decodeThetaResponseData,
  indexHistoryEod,
  indexHistoryOhlc,
  joinThetaQuotesAndFirstOrderGreeks,
  normalizeThetaFirstOrderGreekRow,
  normalizeThetaIndexEodRow,
  normalizeThetaIndexOhlcRow,
  normalizeThetaStockEodRow,
  normalizeThetaStockOhlcRow,
  OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE,
  OPTION_QUOTE_MID_GREEKS_REVISION,
  optionAtTimeQuote,
  optionHistoryGreeksFirstOrderBand,
  optionHistoryGreeksFirstOrder,
  optionHistoryImpliedVolatilityBand,
  optionHistoryQuote,
  optionHistoryQuoteBand,
  optionListContracts,
  stockHistoryEod,
  stockHistoryOhlc,
  thetaTimestampToEtMinute,
} from './utils/providers/thetadata/index.js';

// ThetaData MDDS backfill preflight helpers
export {
  appendBackfillManifestLineDurable,
  backfillRewriteSelectSql,
  backfillManifestPath,
  backfillPartitionPath,
  backfillShadowPartitionPath,
  collectBackfillConcreteFallbacks,
  estimateBackfillBandRequestCount,
  estimateBackfillRequestCount,
  enumerateBackfillDates,
  formatBackfillManifestLine,
  groupBackfillTickersByGreekBand,
  makeBackfillManifestEntry,
  makeBackfillRunId,
  parseBackfillOccTicker,
  projectBackfillWallTimeHours,
} from './utils/providers/thetadata/backfill.js';
export type {
  BackfillBandRequestCountInput,
  BackfillConcreteFallback,
  BackfillConcreteFallbackInput,
  BackfillGreekBandGroup,
  BackfillManifestEntry,
  BackfillManifestStatus,
  BackfillParsedOccTicker,
  BackfillProjectionInput,
  BackfillRequestCountInput,
  BackfillRewriteSelectInput,
  BackfillStagedGreekRow,
} from './utils/providers/thetadata/backfill.js';

// Parquet view registration (integration testing)
export { createMarketParquetViews } from './db/market-views.js';

// Greeks attribution (v2.3)
export {
  collapseFactors,
  computeAttribution,
  computeGrossAttributionFlow,
  assessPrecision,
  type AttributionEntry,
  type AttributionSummaryResult,
  type AttributionInstanceResult,
  type AttributionStepEntry,
} from './tools/greeks-attribution.js';

export {
  handleGetGreeksAttribution,
  getGreeksAttributionSchema,
  filterSparseSteps,
} from './tools/greeks-attribution.js';

// Export json-adapters for integration testing
export {
  upsertProfileJson,
  getProfileJson,
  listProfilesJson,
  deleteProfileJson,
  getSyncMetadataJson,
  upsertSyncMetadataJson,
  deleteSyncMetadataJson,
  getAllSyncedBlockIdsJson,
  getMarketImportMetadataJson,
  upsertMarketImportMetadataJson,
  getFlatImportLogJson,
  upsertFlatImportLogJson,
} from './db/json-adapters.js';
export type { FlatImportLogEntry } from './db/json-adapters.js';

// Export json-migration for integration testing
export { migrateMetadataToJson, type MigrationResult } from './db/json-migration.js';

// ============================================================================
// Market Data — store interfaces, registry, datasets
//
// All modules below are shared code, re-exported here for test access.
// ============================================================================

// Store interfaces + factory
export {
  SpotStore,
  EnrichedStore,
  ChainStore,
  QuoteStore,
  createMarketStores,
} from './market/stores/index.js';
export type {
  StoreContext,
  MarketStores,
  EnrichedReadOpts,
  QuoteRow,
  CoverageReport,
} from './market/stores/index.js';
export type { BarRow as MarketStoreBarRow, ContractRow } from './market/stores/index.js';

// Ticker registry + resolver + loader + schemas
export { extractRoot, rootToUnderlying } from './market/tickers/resolver.js';
export { TickerRegistry } from './market/tickers/registry.js';
export type { TickerEntry, EntrySource } from './market/tickers/registry.js';
export { loadRegistry, saveUserOverride } from './market/tickers/loader.js';
export {
  UnderlyingsFileSchema,
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
  listUnderlyingsSchema,
  resolveRootSchema,
  TICKER_RE,
} from './market/tickers/schemas.js';

// Parquet writer multi-level options type
// Note: the value-level parquet-writer re-exports above already cover the
// runtime symbols; this line adds the type alias for the multi-level
// overload so tests can type-check against the V3 shape.
export type { WriteParquetPartitionOptsV3 } from './db/parquet-writer.js';

// Dataset registry + per-dataset helpers
export {
  DATASETS_V3,
  writeSpotPartition,
  writeChainPartition,
  writeQuoteMinutesPartition,
  writeEnrichedTickerFile,
  writeEnrichedContext,
} from './db/market-datasets.js';
export type { DatasetDef } from './db/market-datasets.js';

// Ticker MCP tool handlers — schemas re-exported from tickers/schemas.ts above
export {
  registerTickerTools,
  handleRegisterUnderlying,
  handleUnregisterUnderlying,
  handleListUnderlyings,
  handleResolveRoot,
} from './tools/tickers.js';

// ============================================================================
// Pure helpers + watermark adapter
//
// Pure SQL builders, RTH aggregation helper, partition enumerator, and the
// enrichment watermark JSON adapter.
// ============================================================================

// Pure SQL builders
export {
  buildReadBarsSQL,
  buildReadDailyBarsSQL,
  buildReadRthOpensSQL,
} from './market/stores/spot-sql.js';
export type { BuiltSQL } from './market/stores/spot-sql.js';
export { buildReadEnrichedSQL } from './market/stores/enriched-sql.js';
export type { BuildReadEnrichedArgs } from './market/stores/enriched-sql.js';
export { buildReadChainSQL } from './market/stores/chain-sql.js';
export { buildReadQuotesSQL } from './market/stores/quote-sql.js';
export { rthDailyAggregateSubquery } from './market/stores/rth-aggregation.js';
export type { RthWindowOpts } from './market/stores/rth-aggregation.js';

// Shared coverage helper
export { listPartitionValues } from './market/stores/coverage.js';

// Enrichment watermark adapter
export {
  EnrichmentWatermarksSchema,
  loadEnrichmentWatermarks,
  getEnrichedThrough,
  upsertEnrichedThrough,
} from './db/json-adapters.js';
export type { EnrichmentWatermarks } from './db/json-adapters.js';

// Schema ensure functions are re-exported earlier in this file via
// `ensureMutableMarketTables, ensureMarketDataTables` near the top; do NOT
// re-export them here to avoid duplicate-export errors.

// ============================================================================
// Concrete Spot/Chain/Quote stores
//
// Tests import the concrete class names directly via
// `../../../src/test-exports.js`.
// ============================================================================

// Concrete Spot store pair
export { ParquetSpotStore } from './market/stores/parquet-spot-store.js';
export { DuckdbSpotStore } from './market/stores/duckdb-spot-store.js';

// Concrete Chain store pair
export { ParquetChainStore } from './market/stores/parquet-chain-store.js';
export { DuckdbChainStore } from './market/stores/duckdb-chain-store.js';

// Concrete Quote store pair
export { ParquetQuoteStore } from './market/stores/parquet-quote-store.js';
export { DuckdbQuoteStore } from './market/stores/duckdb-quote-store.js';

// ============================================================================
// Concrete Enriched stores
//
// Thin wrappers around the existing runEnrichment pipeline. Both classes
// extend the abstract EnrichedStore and accept an injected SpotStore so
// that the enricher's IO boundaries (minute-bar reads, watermark
// get/upsert) are satisfied without reimplementing the math.
// ============================================================================

// Concrete Enriched store pair
export { ParquetEnrichedStore } from './market/stores/parquet-enriched-store.js';
export { DuckdbEnrichedStore } from './market/stores/duckdb-enriched-store.js';

// ============================================================================
// Ingestor exports
//
// Market ingestor class + types exposed for integration tests that import
// from dist/.
// ============================================================================

// Market ingestor — exposed for integration tests that import from dist/
export { MarketIngestor } from "./market/ingestor/index.js";
export type { MarketIngestorDeps } from "./market/ingestor/index.js";
export type {
  IngestStatus,
  IngestResult,
  IngestBarsOptions,
  IngestQuotesOptions,
  IngestChainOptions,
  IngestFlatFileOptions,
  ComputeVixContextOptions,
  RefreshOptions,
  RefreshResult,
} from "./market/ingestor/index.js";

// ============================================================================
// Option-data migration helpers
//
// Pure helpers for the in-place option-data migration script. The .mjs
// script itself is NOT re-exported — scripts with filesystem effects
// cannot be unit-tested cleanly via test-exports; unit tests target these
// pure helpers.
// ============================================================================

export {
  groupTickersByUnderlying,
  buildOptionChainSelectQuery,
  buildOptionQuoteSelectQuery,
  LEVERAGED_ETFS,
} from './utils/migrate-option-data-helpers.js';
export type { GroupResult } from './utils/migrate-option-data-helpers.js';

// ============================================================================
// Tool dependency registry
// ============================================================================
export { TOOL_TICKER_DEPS, unionTickerDeps } from './utils/tool-ticker-deps.js';
// ============================================================================

// ============================================================================
// Spot backfill + enrichment-rebuild support
//
// Verification helper, sample-date selector, calibration probe.
// ============================================================================
export {
  selectVerificationSampleDates,
  PHASE_5_FIXTURE_SEED,
  PHASE_5_KNOWN_EVENTS,
  PHASE_5_STRUCTURAL_DATES,
} from './utils/sample-date-selector.js';
export type { SampleDate } from './utils/sample-date-selector.js';
export {
  compareFields,
  compareRow,
  DOUBLE_EPSILON,
  ENRICHED_FIELD_TYPES,
  CONTEXT_FIELD_TYPES,
} from './utils/enrichment-verification.js';
export type {
  FieldType,
  FieldDiff,
  RowDiff,
} from './utils/enrichment-verification.js';
export { calibrateProviderFetch } from './utils/calibration-probe.js';
// ============================================================================
