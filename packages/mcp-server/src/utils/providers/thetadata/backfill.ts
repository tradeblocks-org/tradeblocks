import { open, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BackfillProjectionInput {
  requestCount: number;
  avgLatencyMs: number;
  concurrency: number;
}

export interface BackfillRequestCountInput {
  partitionCount: number;
  contractCount: number;
}

export interface BackfillBandRequestCountInput {
  bandGroupCount: number;
  fallbackContractCount?: number;
}

export interface BackfillParsedOccTicker {
  ticker: string;
  symbol: string;
  expiration: string;
  right: "call" | "put";
  strike: number;
  strikeText: string;
}

export interface BackfillGreekBandGroup {
  key: string;
  symbol: string;
  expiration: string;
  date: string;
  contracts: BackfillParsedOccTicker[];
}

export interface BackfillStagedGreekRow {
  ticker: string;
  timestamp: string;
}

export interface BackfillConcreteFallback {
  contract: BackfillParsedOccTicker;
  missingTimes: string[];
}

export interface BackfillConcreteFallbackInput {
  group: BackfillGreekBandGroup;
  fallbackUncoveredContracts?: boolean;
  expectedTimesByTicker: ReadonlyMap<string, ReadonlySet<string>>;
  stagedRows: BackfillStagedGreekRow[];
}

export type BackfillManifestStatus =
  | "prepared"
  | "committed"
  | "failed"
  | "committed_manifest_failed";

export interface BackfillManifestEntry {
  status: BackfillManifestStatus;
  partitionPath: string;
  underlying: string;
  date: string;
  rowCountBefore: number;
  rowCountAfter: number;
  providerFirstOrderRows: number;
  computedFallbackRows: number;
  nullGreekRows: number;
  endpointErrors: string[];
  startedAt: string;
  completedAt: string;
}

export interface BackfillRewriteSelectInput {
  existingTable: string;
  providerGreeksTable: string;
}

export function backfillManifestPath(dataRoot: string, runId: string): string {
  return join(
    dataRoot,
    "market",
    "_manifests",
    "thetadata-mdds-backfill",
    `${runId}.ndjson`,
  );
}

export function backfillPartitionPath(
  dataRoot: string,
  underlying: string,
  date: string,
): string {
  return join(
    dataRoot,
    "market",
    "option_quote_minutes",
    `underlying=${normalizeUnderlying(underlying)}`,
    `date=${validateDate(date)}`,
    "data.parquet",
  );
}

export function backfillShadowPartitionPath(partitionPath: string): string {
  if (!partitionPath.trim()) {
    throw new Error("partitionPath must not be empty");
  }
  return `${partitionPath}.shadow`;
}

export function makeBackfillRunId(now = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error("run id date must be valid");
  }
  return now.toISOString().replace(/[-:.]/g, "");
}

export function enumerateBackfillDates(from: string, to: string): string[] {
  const startText = validateDate(from);
  const endText = validateDate(to);
  const cursor = parseIsoDate(startText);
  const end = parseIsoDate(endText);
  if (cursor > end) {
    throw new Error("from must be on or before to");
  }

  const dates: string[] = [];
  while (cursor <= end) {
    dates.push(formatIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function estimateBackfillRequestCount(input: BackfillRequestCountInput): number {
  assertNonNegativeInteger("partitionCount", input.partitionCount);
  assertNonNegativeInteger("contractCount", input.contractCount);
  return input.partitionCount * input.contractCount;
}

export function estimateBackfillBandRequestCount(input: BackfillBandRequestCountInput): number {
  assertNonNegativeInteger("bandGroupCount", input.bandGroupCount);
  const fallbackContractCount = input.fallbackContractCount ?? 0;
  assertNonNegativeInteger("fallbackContractCount", fallbackContractCount);
  return input.bandGroupCount + fallbackContractCount;
}

export function projectBackfillWallTimeHours(input: BackfillProjectionInput): number {
  assertPositiveFinite("requestCount", input.requestCount);
  assertPositiveFinite("avgLatencyMs", input.avgLatencyMs);
  assertFinite("concurrency", input.concurrency);

  return (input.requestCount * input.avgLatencyMs) / Math.max(1, input.concurrency) / 3_600_000;
}

export function makeBackfillManifestEntry(entry: BackfillManifestEntry): BackfillManifestEntry {
  return {
    status: validateManifestStatus(entry.status),
    partitionPath: requireNonEmpty("partitionPath", entry.partitionPath),
    underlying: normalizeUnderlying(entry.underlying),
    date: validateDate(entry.date),
    rowCountBefore: sanitizeCount("rowCountBefore", entry.rowCountBefore),
    rowCountAfter: sanitizeCount("rowCountAfter", entry.rowCountAfter),
    providerFirstOrderRows: sanitizeCount("providerFirstOrderRows", entry.providerFirstOrderRows),
    computedFallbackRows: sanitizeCount("computedFallbackRows", entry.computedFallbackRows),
    nullGreekRows: sanitizeCount("nullGreekRows", entry.nullGreekRows),
    endpointErrors: entry.endpointErrors.map((error) => String(error).trim()).filter(Boolean),
    startedAt: validateIsoTimestamp("startedAt", entry.startedAt),
    completedAt: validateIsoTimestamp("completedAt", entry.completedAt),
  };
}

export function formatBackfillManifestLine(entry: BackfillManifestEntry): string {
  return `${JSON.stringify(makeBackfillManifestEntry(entry))}\n`;
}

export function parseBackfillOccTicker(ticker: string): BackfillParsedOccTicker {
  const normalizedTicker = requireNonEmpty("ticker", ticker).toUpperCase();
  const match = normalizedTicker.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})(C|P)(\d{8})$/);
  if (!match) {
    throw new Error(`Invalid OCC option ticker: ${ticker}`);
  }

  const strike = Number.parseInt(match[6], 10) / 1000;
  return {
    ticker: normalizedTicker,
    symbol: match[1],
    expiration: `20${match[2]}-${match[3]}-${match[4]}`,
    right: match[5] === "C" ? "call" : "put",
    strike,
    strikeText: strike.toFixed(3),
  };
}

export function groupBackfillTickersByGreekBand(
  tickers: string[],
  date: string,
): BackfillGreekBandGroup[] {
  const validatedDate = validateDate(date);
  const byKey = new Map<string, BackfillGreekBandGroup & {
    contractByTicker: Map<string, BackfillParsedOccTicker>;
  }>();

  for (const ticker of tickers) {
    const contract = parseBackfillOccTicker(ticker);
    const key = `${contract.symbol}|${contract.expiration}|${validatedDate}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        symbol: contract.symbol,
        expiration: contract.expiration,
        date: validatedDate,
        contracts: [],
        contractByTicker: new Map(),
      };
      byKey.set(key, group);
    }
    group.contractByTicker.set(contract.ticker, contract);
  }

  return [...byKey.values()]
    .map((group) => ({
      key: group.key,
      symbol: group.symbol,
      expiration: group.expiration,
      date: group.date,
      contracts: [...group.contractByTicker.values()].sort((left, right) =>
        left.ticker.localeCompare(right.ticker)
      ),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function collectBackfillConcreteFallbacks(
  input: BackfillConcreteFallbackInput,
): BackfillConcreteFallback[] {
  const coveredTimesByTicker = new Map<string, Set<string>>();
  for (const row of input.stagedRows) {
    const ticker = requireNonEmpty("staged ticker", row.ticker).toUpperCase();
    const time = row.timestamp.slice(11, 16);
    if (!time) continue;
    let coveredTimes = coveredTimesByTicker.get(ticker);
    if (!coveredTimes) {
      coveredTimes = new Set();
      coveredTimesByTicker.set(ticker, coveredTimes);
    }
    coveredTimes.add(time);
  }

  const fallbacks: BackfillConcreteFallback[] = [];
  for (const contract of input.group.contracts) {
    const expectedTimes = input.expectedTimesByTicker.get(contract.ticker) ?? new Set<string>();
    const coveredTimes = coveredTimesByTicker.get(contract.ticker) ?? new Set<string>();
    if (coveredTimes.size === 0 && !input.fallbackUncoveredContracts) {
      continue;
    }
    const missingTimes = [...expectedTimes]
      .filter((time) => !coveredTimes.has(time))
      .sort();
    if (missingTimes.length > 0) {
      fallbacks.push({ contract, missingTimes });
    }
  }
  return fallbacks;
}

export async function appendBackfillManifestLineDurable(
  manifestPath: string,
  line: string,
): Promise<void> {
  const path = requireNonEmpty("manifestPath", manifestPath);
  const text = String(line);
  if (!text.endsWith("\n")) {
    throw new Error("manifest line must end with a newline");
  }
  const parentDir = dirname(path);
  await mkdir(parentDir, { recursive: true });
  const existedBeforeOpen = await pathExists(path);
  const handle = await open(path, "a");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existedBeforeOpen) {
    await fsyncDirectoryBestEffort(parentDir);
  }
}

export function backfillRewriteSelectSql(input: BackfillRewriteSelectInput): string {
  const existingTable = validateSqlIdentifier(input.existingTable);
  const providerGreeksTable = validateSqlIdentifier(input.providerGreeksTable);
  return `
    SELECT
      CAST(e.underlying AS VARCHAR) AS underlying,
      CAST(e.date AS VARCHAR) AS date,
      CAST(e.ticker AS VARCHAR) AS ticker,
      CAST(e.time AS VARCHAR) AS time,
      CAST(e.bid AS DOUBLE) AS bid,
      CAST(e.ask AS DOUBLE) AS ask,
      CAST(e.mid AS DOUBLE) AS mid,
      CAST(e.last_updated_ns AS BIGINT) AS last_updated_ns,
      CAST(e.source AS VARCHAR) AS source,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.delta ELSE e.delta END AS REAL) AS delta,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.gamma ELSE e.gamma END AS REAL) AS gamma,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.theta ELSE e.theta END AS REAL) AS theta,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.vega ELSE e.vega END AS REAL) AS vega,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.iv ELSE e.iv END AS REAL) AS iv,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.greeks_source ELSE e.greeks_source END AS VARCHAR) AS greeks_source,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.greeks_revision ELSE e.greeks_revision END AS INTEGER) AS greeks_revision,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.rate_type ELSE e.rate_type END AS VARCHAR) AS rate_type,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.rate_value ELSE e.rate_value END AS DOUBLE) AS rate_value,
      CAST(CASE WHEN g.greeks_source = 'thetadata' THEN g.gamma_source ELSE e.gamma_source END AS VARCHAR) AS gamma_source
    FROM ${existingTable} e
    LEFT JOIN ${providerGreeksTable} g
      ON e.ticker = g.ticker
     AND e.time = g.time
  `.trim();
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function sanitizeCount(name: string, value: number): number {
  assertNonNegativeInteger(name, value);
  return value;
}

function validateManifestStatus(value: BackfillManifestStatus): BackfillManifestStatus {
  if (
    value === "prepared"
    || value === "committed"
    || value === "failed"
    || value === "committed_manifest_failed"
  ) {
    return value;
  }
  throw new Error("status must be prepared, committed, failed, or committed_manifest_failed");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function fsyncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirPath, "r");
    await handle.sync();
  } catch {
    // Some platforms/filesystems do not support directory fsync. Linux does,
    // and failures elsewhere should not make manifest append unusable.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function requireNonEmpty(name: string, value: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} must not be empty`);
  return text;
}

function normalizeUnderlying(value: string): string {
  return requireNonEmpty("underlying", value).toUpperCase();
}

function validateSqlIdentifier(value: string): string {
  const text = requireNonEmpty("sql identifier", value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new Error("sql identifier must contain only letters, numbers, and underscores");
  }
  return text;
}

function validateDate(value: string): string {
  const text = requireNonEmpty("date", value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("date must use YYYY-MM-DD");
  }
  const parsed = parseIsoDate(text);
  if (Number.isNaN(parsed.getTime()) || formatIsoDate(parsed) !== text) {
    throw new Error("date must be a valid calendar date");
  }
  return text;
}

function validateIsoTimestamp(name: string, value: string): string {
  const text = requireNonEmpty(name, value);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return text;
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function formatIsoDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
