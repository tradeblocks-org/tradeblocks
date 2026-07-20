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
} from "./utils/block-loader.ts";

// Export CSV discovery utilities for unit testing
export {
  detectCsvType,
  discoverCsvFiles,
  logCsvDiscoveryWarning,
  type CsvType,
} from "./utils/csv-discovery.ts";

// Export PortfolioStatsCalculator for testing block_diff logic
export { PortfolioStatsCalculator } from "@tradeblocks/lib";

// Export correlation and tail-risk utilities for testing strategy_similarity
export { calculateCorrelationMatrix, performTailRiskAnalysis } from "@tradeblocks/lib";

// Export paired_bootstrap_comparison internals for integration testing
export {
  registerPairedComparisonTool,
  runPairedBootstrapComparison,
  buildBlockTradingDayIndex,
  buildArmDaySeries,
  armHoldingPeriods,
  pairedComparisonInputSchema,
  type PairedComparisonParams,
  type PairedComparisonReport,
} from "./tools/blocks/paired-comparison.ts";

// Export sync layer for integration testing
export { syncAllBlocks, syncBlock, type SyncResult, type BlockSyncResult } from "./sync/index.ts";

// Export DuckDB connection utilities for integration testing
export {
  getConnection,
  getReadOnlyConnection,
  closeConnection,
  isConnected,
  getConnectionMode,
  upgradeToReadWrite,
  downgradeToReadOnly,
  getCurrentConnection,
  openMarketOnlyConnection,
  openMarketParquetConnection,
  openMarketReadOnlyConnection,
} from "./db/connection.ts";
export type {
  MarketOnlyConnection,
  MarketParquetConnection,
  MarketReadOnlyConnection,
  MarketConnectionOptions,
} from "./db/connection.ts";
export { setDataRoot, getDataRoot, resetDataRoot } from "./db/data-root.ts";
export { yesterdayET } from "./utils/trading-dates.ts";
export {
  resolveCanonicalMarketFile,
  resolveCanonicalMarketPartitionDir,
  resolveCanonicalMarketPartitionPath,
  resolveCanonicalMarketPartitionFile,
  canonicalMarketTableName,
} from "./db/market-datasets.ts";

// Export market schema utilities for integration testing
export { ensureMutableMarketTables, ensureMarketDataTables } from "./db/market-schemas.ts";

// Export shared filter utilities for testing
export {
  filterByStrategy,
  filterByDateRange,
  filterDailyLogsByDateRange,
} from "./tools/shared/filters.ts";

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
} from "./utils/field-timing.ts";

// Export data availability helper for testing
export { checkDataAvailability, type DataAvailabilityReport } from "./utils/data-availability.ts";
export {
  queryCoverage,
  scoreDataQuality,
  formatCoverageReport,
  type DataQualityInput,
  type CoverageResult,
} from "./utils/data-quality.ts";

// Export intraday timing utilities for testing
export { computeIntradayTimingFields } from "./utils/market-enricher.ts";

// Export schema metadata for classification completeness tests
export { SCHEMA_DESCRIPTIONS } from "./utils/schema-metadata.ts";
export type { ColumnDescription } from "./utils/schema-metadata.ts";

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
} from "./utils/market-importer.ts";

// Export market import metadata helpers for integration testing
export {
  type MarketImportMetadata,
  getMarketImportMetadata,
  upsertMarketImportMetadata,
} from "./sync/metadata.ts";

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
} from "./utils/market-enricher.ts";

// Export market enrichment utilities for integration testing
export {
  runEnrichment,
  runContextEnrichment,
  type EnrichmentResult,
  type EnrichmentOptions,
  type TierStatus,
} from "./utils/market-enricher.ts";

// Export strategy profile types and CRUD functions for integration testing
export type {
  StrategyProfile,
  StrategyProfileRow,
  LegDetail,
  EntryFilter,
  ExitRule,
  KeyMetrics,
  PositionSizing,
} from "./models/strategy-profile.ts";
export {
  ensureProfilesSchema,
  upsertProfile,
  getProfile,
  listProfiles,
  deleteProfile,
} from "./db/profile-schemas.ts";

// Export analysis utility modules for unit testing
export { computeSliceStats, type SliceStats } from "./utils/analysis-stats.ts";
export { buildFilterPredicate, type FilterPredicate } from "./utils/filter-predicates.ts";

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
} from "./tools/profiles.ts";

// Export profile analysis tool handlers and schemas for integration testing
export {
  handleAnalyzeStructureFit,
  handleValidateEntryFilters,
  handlePortfolioStructureMap,
  analyzeStructureFitSchema,
  validateEntryFiltersSchema,
  portfolioStructureMapSchema,
} from "./tools/profile-analysis.ts";

// Export regime advisor tool handler and schema for integration testing
export {
  handleRegimeAllocationAdvisor,
  regimeAllocationAdvisorSchema,
} from "./tools/regime-advisor.ts";

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
} from "./utils/market-provider.ts";
export {
  resolveMassiveDataTier,
  resolveProviderCapabilities,
  getResolvedProviderCapabilities,
  type MassiveDataTier,
  type ResolvedProviderCapabilities,
} from "./utils/provider-capabilities.ts";

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
} from "./utils/providers/massive.ts";

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
} from "./utils/trade-replay.ts";

// Export trade replay tool handler and schema for integration testing
export { handleReplayTrade, replayTradeSchema, resolveOODateRange } from "./tools/replay.ts";

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
} from "./utils/black-scholes.ts";

export { computeFractionalDte } from "./utils/option-time.ts";
export {
  applyQuoteGreeks,
  applyQuoteGreeksParallel,
  hasQuoteGreeks,
  OPTION_QUOTE_GREEKS_REVISION,
  type QuoteGreeksMode,
  type QuoteGreeksSource,
} from "./utils/option-quote-greeks.ts";
export {
  IvSolverPool,
  getSharedIvSolverPool,
  destroySharedIvSolverPool,
  type IvSolveJob,
  type IvSolveJobResult,
} from "./utils/iv-solver-pool.ts";
export {
  describeReadParquetColumns,
  quoteParquetCanonicalProjection,
  quoteParquetGreekProjection,
  readWindowGreekProjection,
  assertKnownGreeks,
  ALL_GREEKS,
  readParquetFilesSql,
} from "./utils/quote-parquet-projection.ts";
export type { GreekColumn } from "./utils/quote-parquet-projection.ts";

// Export parquet-writer utility functions for unit testing
export {
  isParquetMode,
  writeParquetAtomic,
  writeParquetPartition,
  resolveMarketDir,
} from "./db/parquet-writer.ts";

// Export json-store utility for unit testing
export {
  readJsonFile,
  writeJsonFile,
  deleteJsonFile,
  listJsonFiles,
  toFileSlug,
} from "./db/json-store.ts";

// Export Massive snapshot schemas for unit testing
export {
  MassiveSnapshotResponseSchema,
  MassiveSnapshotContractSchema,
} from "./utils/providers/massive.ts";

// Export snapshot tool handler and schema for integration testing
export { handleGetOptionSnapshot, getOptionSnapshotSchema } from "./tools/snapshot.ts";

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
} from "./utils/greeks-decomposition.ts";

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
} from "./utils/exit-triggers.ts";

// Export exit analysis tool handlers and schemas for integration testing
export {
  handleAnalyzeExitTriggers,
  handleDecomposeGreeks,
  analyzeExitTriggersSchema,
  decomposeGreeksSchema,
} from "./tools/exit-analysis.ts";

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
} from "./utils/batch-exit-analysis.ts";

// Export batch exit analysis tool handler and schema for integration testing
export { handleBatchExitAnalysis, batchExitAnalysisSchema } from "./tools/batch-exit-analysis.ts";

// Export quote enricher pure functions for unit testing
export { shouldSkipEnrichment, buildEnrichmentPlan } from "./utils/quote-enricher.ts";
export type { EnrichmentPlanInput } from "./utils/quote-enricher.ts";

// SQL tool validator — unit-tested for path-gate + hard-block rules
export { validateQuery, isUnderDataRoot } from "./tools/sql.ts";

// Chain loader pure functions (unit testing)
export { filterChain } from "./utils/chain-loader.ts";

// Provider classes for capability-resolution testing
export { ThetaDataProvider } from "./utils/providers/thetadata.ts";

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
  normalizeThetaOpenInterestRow,
  normalizeThetaStockEodRow,
  normalizeThetaStockOhlcRow,
  OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE,
  OPTION_QUOTE_MID_GREEKS_REVISION,
  optionAtTimeQuote,
  optionHistoryGreeksFirstOrderBand,
  optionHistoryGreeksFirstOrder,
  optionHistoryImpliedVolatilityBand,
  optionHistoryOpenInterest,
  optionHistoryQuote,
  optionHistoryQuoteBand,
  optionListContracts,
  stockHistoryEod,
  stockHistoryOhlc,
  thetaTimestampToEtMinute,
} from "./utils/providers/thetadata/index.ts";

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
} from "./utils/providers/thetadata/backfill.ts";
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
} from "./utils/providers/thetadata/backfill.ts";

// Parquet view registration (integration testing)
export { createMarketParquetViews } from "./db/market-views.ts";

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
} from "./tools/greeks-attribution.ts";

export {
  handleGetGreeksAttribution,
  getGreeksAttributionSchema,
  filterSparseSteps,
} from "./tools/greeks-attribution.ts";

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
} from "./db/json-adapters.ts";
export type { FlatImportLogEntry } from "./db/json-adapters.ts";

// Export json-migration for integration testing
export { migrateMetadataToJson, type MigrationResult } from "./db/json-migration.ts";

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
} from "./market/stores/index.ts";
export type {
  StoreContext,
  MarketStores,
  EnrichedReadOpts,
  QuoteRow,
  CoverageReport,
} from "./market/stores/index.ts";
export type { BarRow as MarketStoreBarRow, ContractRow } from "./market/stores/index.ts";

// Ticker registry + resolver + loader + schemas
export { extractRoot, rootToUnderlying } from "./market/tickers/resolver.ts";
export { TickerRegistry } from "./market/tickers/registry.ts";
export type { TickerEntry, EntrySource } from "./market/tickers/registry.ts";
export { loadRegistry, saveUserOverride } from "./market/tickers/loader.ts";
export {
  UnderlyingsFileSchema,
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
  listUnderlyingsSchema,
  resolveRootSchema,
  TICKER_RE,
} from "./market/tickers/schemas.ts";

// Parquet writer multi-level options type
// Note: the value-level parquet-writer re-exports above already cover the
// runtime symbols; this line adds the type alias for the multi-level
// overload so tests can type-check against the V3 shape.
export type { WriteParquetPartitionOptsV3 } from "./db/parquet-writer.ts";

// Dataset registry + per-dataset helpers
export {
  DATASETS_V3,
  writeSpotPartition,
  writeChainPartition,
  writeQuoteMinutesPartition,
  writeOiDailyPartition,
  writeEnrichedTickerFile,
  writeEnrichedContext,
} from "./db/market-datasets.ts";
export type { DatasetDef } from "./db/market-datasets.ts";

// Ticker MCP tool handlers — schemas re-exported from tickers/schemas.ts above
export {
  registerTickerTools,
  handleRegisterUnderlying,
  handleUnregisterUnderlying,
  handleListUnderlyings,
  handleResolveRoot,
} from "./tools/tickers.ts";

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
} from "./market/stores/spot-sql.ts";
export type { BuiltSQL } from "./market/stores/spot-sql.ts";
export { buildReadEnrichedSQL } from "./market/stores/enriched-sql.ts";
export type { BuildReadEnrichedArgs } from "./market/stores/enriched-sql.ts";
export { buildReadChainSQL } from "./market/stores/chain-sql.ts";
export { buildReadQuotesSQL } from "./market/stores/quote-sql.ts";
export { rthDailyAggregateSubquery } from "./market/stores/rth-aggregation.ts";
export type { RthWindowOpts } from "./market/stores/rth-aggregation.ts";

// Shared coverage helper
export { listPartitionValues } from "./market/stores/coverage.ts";

// Enrichment watermark adapter
export {
  EnrichmentWatermarksSchema,
  loadEnrichmentWatermarks,
  getEnrichedThrough,
  upsertEnrichedThrough,
} from "./db/json-adapters.ts";
export type { EnrichmentWatermarks } from "./db/json-adapters.ts";

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
export { ParquetSpotStore } from "./market/stores/parquet-spot-store.ts";
export { DuckdbSpotStore } from "./market/stores/duckdb-spot-store.ts";

// Concrete Chain store pair
export { ParquetChainStore } from "./market/stores/parquet-chain-store.ts";
export { DuckdbChainStore } from "./market/stores/duckdb-chain-store.ts";

// Concrete Quote store pair
export { ParquetQuoteStore } from "./market/stores/parquet-quote-store.ts";
export { DuckdbQuoteStore } from "./market/stores/duckdb-quote-store.ts";

// Daily open-interest store
export { ParquetOiDailyStore } from "./market/stores/parquet-oi-daily-store.ts";

// ============================================================================
// Concrete Enriched stores
//
// Thin wrappers around the existing runEnrichment pipeline. Both classes
// extend the abstract EnrichedStore and accept an injected SpotStore so
// that the enricher's IO boundaries (minute-bar reads, watermark
// get/upsert) are satisfied without reimplementing the math.
// ============================================================================

// Concrete Enriched store pair
export { ParquetEnrichedStore } from "./market/stores/parquet-enriched-store.ts";
export { DuckdbEnrichedStore } from "./market/stores/duckdb-enriched-store.ts";

// ============================================================================
// Ingestor exports
//
// Market ingestor class + types exposed for integration tests that import
// from dist/.
// ============================================================================

// Market ingestor — exposed for integration tests that import from dist/
export { MarketIngestor } from "./market/ingestor/index.ts";
export type { MarketIngestorDeps } from "./market/ingestor/index.ts";
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
} from "./market/ingestor/index.ts";

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
} from "./utils/migrate-option-data-helpers.ts";
export type { GroupResult } from "./utils/migrate-option-data-helpers.ts";

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
} from "./utils/sample-date-selector.ts";
export type { SampleDate } from "./utils/sample-date-selector.ts";
export {
  compareFields,
  compareRow,
  DOUBLE_EPSILON,
  ENRICHED_FIELD_TYPES,
  CONTEXT_FIELD_TYPES,
} from "./utils/enrichment-verification.ts";
export type { FieldType, FieldDiff, RowDiff } from "./utils/enrichment-verification.ts";
export { calibrateProviderFetch } from "./utils/calibration-probe.ts";
// ============================================================================
