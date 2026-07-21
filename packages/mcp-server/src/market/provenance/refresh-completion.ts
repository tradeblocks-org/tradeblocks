import * as path from "node:path";
import {
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJsonAddress,
  parseSha256Address,
  type CanonicalJsonAddress,
  type Sha256Address,
} from "./canonical-json.ts";
import type { PutContentObjectResult } from "./content-object-store.ts";
import {
  canonicalPartitionDataset,
  canonicalPartitionRelativePath,
  validatePartitionIdentity,
  type DatasetPartitionIdentity,
} from "./dataset-registry.ts";
import {
  runPartitionCommitAttempt,
  type PartitionCommitAttemptResult,
} from "./partition-commit-attempt.ts";
import {
  FilePartitionCommitStore,
  publishRefreshCompletionAuthority,
  verifyRefreshCompletionAuthority,
  type StoredPartitionCommit,
} from "./partition-commit-store.ts";
import { isXnysSessionDate } from "./xnys-session-calendar.ts";
import {
  finalizeCanonicalMarketDataCutoff,
  verifyCanonicalMarketDataCutoff,
} from "./canonical-market-resolver.ts";
import { verifyInputClosure, verifyInputResolverRegistry } from "./content-manifest.ts";
import type { MarketIngestor, MarketIngestorDeps } from "../ingestor/market-ingestor.ts";
import type {
  BulkProgressEvent,
  BulkProgressReporter,
  IngestResult,
  RefreshOptions,
  RefreshResult,
} from "../ingestor/types.ts";
import { bulkQuoteRootsForUnderlying } from "../../utils/providers/thetadata/bulk-roots.ts";

export const CANONICAL_REFRESH_COMPLETION_KIND =
  "tradeblocks.market-data.canonical-refresh-completion" as const;
export const CANONICAL_REFRESH_COMPLETION_VERSION = 1 as const;

export interface CanonicalRefreshPlanV1 {
  asOf: string;
  spotTickers: readonly string[];
  chainUnderlyings: readonly string[];
  quoteUnderlyings: readonly string[];
  openInterestUnderlyings: readonly string[];
  provider?: "massive" | "thetadata";
}

export interface CanonicalRefreshReceiptV1 extends DatasetPartitionIdentity {
  receipt: CanonicalJsonAddress;
}

export interface CanonicalRefreshOperationV1 {
  kind: "spot" | "chain" | "quotes" | "open-interest";
  target: string;
  status: "ok";
  rowsWritten: number;
}

export interface CanonicalRefreshQuoteGroupV1 {
  underlying: string;
  root: string;
  right: "call" | "put";
  date: string;
  completedContracts: number;
  totalContracts: number;
}

export interface CanonicalRefreshCompletionV1 {
  kind: typeof CANONICAL_REFRESH_COMPLETION_KIND;
  version: typeof CANONICAL_REFRESH_COMPLETION_VERSION;
  attemptId: string;
  closure: CanonicalJsonAddress;
  plan: CanonicalRefreshPlanV1;
  operations: readonly CanonicalRefreshOperationV1[];
  quoteGroups: readonly CanonicalRefreshQuoteGroupV1[];
  receipts: readonly CanonicalRefreshReceiptV1[];
}

interface BoundedRefreshResult {
  perOperation: RefreshResult["perOperation"];
  quoteGroups: readonly CanonicalRefreshQuoteGroupV1[];
}

interface CanonicalProvenanceRefreshOptions {
  closure: CanonicalJsonAddress;
  attemptId: string;
  predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address };
}

type ProvenanceRefreshInput = RefreshOptions & {
  provenance: CanonicalProvenanceRefreshOptions;
};

function normalizeAuthority(
  input: CanonicalProvenanceRefreshOptions,
): CanonicalProvenanceRefreshOptions {
  parseCanonicalJsonAddress(input.closure);
  const attemptId = input.attemptId.normalize("NFC").trim();
  if (attemptId.length === 0) throw new TypeError("Canonical refresh attemptId must not be empty");
  const predecessor = input.predecessor
    ? {
        manifest: input.predecessor.manifest,
        aggregateRoot: input.predecessor.aggregateRoot,
      }
    : undefined;
  if (predecessor) {
    parseCanonicalJsonAddress(predecessor.manifest);
    parseSha256Address(predecessor.aggregateRoot);
  }
  return Object.freeze({
    closure: input.closure,
    attemptId,
    ...(predecessor ? { predecessor: Object.freeze(predecessor) } : {}),
  });
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalizedSymbols(values: readonly string[] | undefined, label: string): string[] {
  const normalized = (values ?? []).map((value, index) => {
    if (typeof value !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    const symbol = value.normalize("NFC").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9._-]*$/.test(symbol)) {
      throw new TypeError(`${label}[${index}] is not a canonical market symbol`);
    }
    return symbol;
  });
  return [...new Set(normalized)].sort(compareCodePoints);
}

function normalizePlan(input: RefreshOptions, deps: MarketIngestorDeps): CanonicalRefreshPlanV1 {
  if (!isXnysSessionDate(input.asOf)) {
    throw new Error(`Canonical refresh cutoff is not a supported XNYS session: ${input.asOf}`);
  }
  if ((input.quoteTickers?.length ?? 0) > 0) {
    throw new Error(
      "Canonical refresh refuses quoteTickers because per-ticker writes overwrite a shared partition",
    );
  }
  const rawQuoteUnderlyings = normalizedSymbols(input.quoteUnderlyings, "quoteUnderlyings");
  const quoteUnderlyings = normalizedSymbols(
    rawQuoteUnderlyings.map((underlying) => deps.stores.quote.tickers.resolve(underlying)),
    "resolved quoteUnderlyings",
  );
  const rawOiUnderlyings = normalizedSymbols(
    input.openInterestUnderlyings,
    "openInterestUnderlyings",
  );
  const openInterestUnderlyings = normalizedSymbols(
    rawOiUnderlyings.map((underlying) => deps.stores.quote.tickers.resolve(underlying)),
    "resolved openInterestUnderlyings",
  );
  if (
    (quoteUnderlyings.length > 0 || openInterestUnderlyings.length > 0) &&
    input.provider !== "thetadata"
  ) {
    throw new Error("Canonical option refresh requires the explicit ThetaData terminal protocol");
  }
  const plan: CanonicalRefreshPlanV1 = {
    asOf: input.asOf,
    spotTickers: normalizedSymbols(input.spotTickers, "spotTickers"),
    chainUnderlyings: normalizedSymbols(input.chainUnderlyings, "chainUnderlyings"),
    quoteUnderlyings,
    openInterestUnderlyings,
    ...(input.provider ? { provider: input.provider } : {}),
  };
  const inventorySize =
    plan.spotTickers.length +
    plan.chainUnderlyings.length +
    plan.quoteUnderlyings.length +
    plan.openInterestUnderlyings.length;
  if (inventorySize === 0) throw new Error("Canonical refresh inventory must not be empty");
  return Object.freeze({
    ...plan,
    spotTickers: Object.freeze(plan.spotTickers),
    chainUnderlyings: Object.freeze(plan.chainUnderlyings),
    quoteUnderlyings: Object.freeze(plan.quoteUnderlyings),
    openInterestUnderlyings: Object.freeze(plan.openInterestUnderlyings),
  });
}

function expectedInventory(plan: CanonicalRefreshPlanV1): DatasetPartitionIdentity[] {
  const session = plan.asOf;
  return [
    ...plan.spotTickers.map((ticker) => ({
      dataset: "spot",
      partition: { ticker, date: session },
    })),
    ...plan.chainUnderlyings.map((underlying) => ({
      dataset: "option_chain",
      partition: { underlying, date: session },
    })),
    ...plan.quoteUnderlyings.map((underlying) => ({
      dataset: "option_quote_minutes",
      partition: { underlying, date: session },
    })),
    ...plan.openInterestUnderlyings.map((underlying) => ({
      dataset: "option_oi_daily",
      partition: { underlying, date: session },
    })),
  ];
}

async function closureTailInventory(
  partitions: FilePartitionCommitStore,
  closureAddress: CanonicalJsonAddress,
  completeThrough: string,
): Promise<DatasetPartitionIdentity[]> {
  const closure = await verifyInputClosure(partitions.objects, closureAddress);
  const registry = await verifyInputResolverRegistry(partitions.objects, closure.value.registry);
  const identities: DatasetPartitionIdentity[] = [];
  for (const observation of closure.value.observations) {
    if (observation.kind === "missing-probe" && observation.session === completeThrough) {
      throw new Error("A cutoff missing-probe cannot satisfy refresh completion authority");
    }
    if (observation.kind !== "exact" && observation.kind !== "range") continue;
    const reachesCutoff =
      observation.kind === "exact"
        ? observation.session === completeThrough
        : observation.fromSession <= completeThrough &&
          observation.throughSession >= completeThrough;
    if (!reachesCutoff) continue;
    const resolverClass = registry.value.classes.find(
      (entry) => entry.dataClass === observation.dataClass,
    );
    if (resolverClass?.kind === "materialized") continue;
    if (!resolverClass || resolverClass.kind !== "partitioned") {
      throw new Error("Cutoff closure tail is not a canonical partitioned input class");
    }
    const identity: DatasetPartitionIdentity = {
      dataset: resolverClass.dataset,
      partition:
        observation.kind === "exact"
          ? observation.selector
          : {
              ...observation.selectorPrefix,
              [resolverClass.sessionKey]: completeThrough,
            },
    };
    validatePartitionIdentity(identity);
    identities.push(identity);
  }
  identities.sort((left, right) => compareCodePoints(identityKey(left), identityKey(right)));
  if (identities.length === 0) {
    throw new Error("Canonical refresh closure has no partitioned cutoff-tail inventory");
  }
  if (new Set(identities.map(identityKey)).size !== identities.length) {
    throw new Error("Canonical refresh closure repeats a cutoff-tail partition");
  }
  return identities;
}

function identityKey(identity: DatasetPartitionIdentity): string {
  return canonicalJson({ dataset: identity.dataset, partition: identity.partition });
}

function requireTerminalResult(result: IngestResult, label: string): IngestResult {
  if (result.status !== "ok" || result.rowsWritten <= 0 || (result.skipped?.length ?? 0) > 0) {
    throw new Error(
      `Canonical refresh operation ${label} was not terminal: ${canonicalJson({
        status: result.status,
        rowsWritten: result.rowsWritten,
        skipped: result.skipped?.length ?? 0,
        error: result.error ?? "",
      })}`,
    );
  }
  return result;
}

async function runBoundedRefresh(
  ingestor: MarketIngestor,
  plan: CanonicalRefreshPlanV1,
  onProgress: BulkProgressReporter | undefined,
): Promise<BoundedRefreshResult> {
  const spot: IngestResult[] = [];
  for (const ticker of plan.spotTickers) {
    spot.push(
      requireTerminalResult(
        await ingestor.ingestBars({
          tickers: [ticker],
          from: plan.asOf,
          to: plan.asOf,
          timespan: "1m",
          skipEnrichment: true,
          ...(plan.provider ? { provider: plan.provider } : {}),
        }),
        `spot ${ticker}`,
      ),
    );
  }
  const chain: IngestResult[] = [];
  for (const underlying of plan.chainUnderlyings) {
    chain.push(
      requireTerminalResult(
        await ingestor.ingestChain({
          underlyings: [underlying],
          from: plan.asOf,
          to: plan.asOf,
          ...(plan.provider ? { provider: plan.provider } : {}),
        }),
        `chain ${underlying}`,
      ),
    );
  }
  const quotes: IngestResult[] = [];
  const quoteGroups: CanonicalRefreshQuoteGroupV1[] = [];
  for (const underlying of plan.quoteUnderlyings) {
    const observed = new Map<string, CanonicalRefreshQuoteGroupV1>();
    const poisoned = new Set<string>();
    const collectProgress = async (event: BulkProgressEvent) => {
      if (event.kind === "group" && event.phase === "complete") {
        const key = `${event.root.toUpperCase()}:${event.right}`;
        if (
          event.underlying.toUpperCase() === underlying &&
          event.date === plan.asOf &&
          event.status === "ok" &&
          Number.isSafeInteger(event.completedContracts) &&
          Number.isSafeInteger(event.totalContracts) &&
          (event.completedContracts as number) >= 0 &&
          event.completedContracts === event.totalContracts
        ) {
          if (!poisoned.has(key)) {
            observed.set(key, {
              underlying,
              root: event.root.toUpperCase(),
              right: event.right,
              date: plan.asOf,
              completedContracts: event.completedContracts as number,
              totalContracts: event.totalContracts as number,
            });
          }
        } else {
          poisoned.add(key);
          observed.delete(key);
        }
      }
      await onProgress?.(event);
    };
    quotes.push(
      requireTerminalResult(
        await ingestor.ingestQuotes({
          underlyings: [underlying],
          from: plan.asOf,
          to: plan.asOf,
          ...(plan.provider ? { provider: plan.provider } : {}),
          onProgress: collectProgress,
        }),
        `quotes ${underlying}`,
      ),
    );
    const expected = bulkQuoteRootsForUnderlying(underlying)
      .flatMap((root) => [`${root}:call`, `${root}:put`])
      .sort(compareCodePoints);
    const completed = [...observed.keys()].sort(compareCodePoints);
    if (
      canonicalJson(completed) !== canonicalJson(expected) ||
      expected.some((key) => poisoned.has(key))
    ) {
      throw new Error(
        `Canonical quote refresh did not complete every root/right group: ${canonicalJson({ expected, completed })}`,
      );
    }
    quoteGroups.push(...observed.values());
  }
  const openInterest: IngestResult[] = [];
  for (const underlying of plan.openInterestUnderlyings) {
    openInterest.push(
      requireTerminalResult(
        await ingestor.ingestOpenInterest({
          underlyings: [underlying],
          from: plan.asOf,
          to: plan.asOf,
          ...(plan.provider ? { provider: plan.provider } : {}),
        }),
        `open interest ${underlying}`,
      ),
    );
  }
  quoteGroups.sort((left, right) =>
    compareCodePoints(
      `${left.underlying}:${left.root}:${left.right}`,
      `${right.underlying}:${right.root}:${right.right}`,
    ),
  );
  return {
    perOperation: { spot, chain, quotes, openInterest, vixContext: null },
    quoteGroups,
  };
}

function operationKey(operation: Pick<CanonicalRefreshOperationV1, "kind" | "target">): string {
  return `${operation.kind}:${operation.target}`;
}

function terminalOperations(
  plan: CanonicalRefreshPlanV1,
  value: BoundedRefreshResult["perOperation"],
): CanonicalRefreshOperationV1[] {
  if (
    value.spot.length !== plan.spotTickers.length ||
    value.chain.length !== plan.chainUnderlyings.length ||
    value.quotes.length !== plan.quoteUnderlyings.length ||
    value.openInterest.length !== plan.openInterestUnderlyings.length ||
    value.vixContext !== null
  ) {
    throw new Error("Canonical refresh terminal operation evidence disagrees with its plan");
  }
  const operations: CanonicalRefreshOperationV1[] = [
    ...plan.spotTickers.map((target, index) => ({
      kind: "spot" as const,
      target,
      status: "ok" as const,
      rowsWritten: value.spot[index].rowsWritten,
    })),
    ...plan.chainUnderlyings.map((target, index) => ({
      kind: "chain" as const,
      target,
      status: "ok" as const,
      rowsWritten: value.chain[index].rowsWritten,
    })),
    ...plan.quoteUnderlyings.map((target, index) => ({
      kind: "quotes" as const,
      target,
      status: "ok" as const,
      rowsWritten: value.quotes[index].rowsWritten,
    })),
    ...plan.openInterestUnderlyings.map((target, index) => ({
      kind: "open-interest" as const,
      target,
      status: "ok" as const,
      rowsWritten: value.openInterest[index].rowsWritten,
    })),
  ];
  operations.sort((left, right) => compareCodePoints(operationKey(left), operationKey(right)));
  return operations;
}

function expectedOperationKeys(plan: CanonicalRefreshPlanV1): string[] {
  return [
    ...plan.spotTickers.map((target) => operationKey({ kind: "spot", target })),
    ...plan.chainUnderlyings.map((target) => operationKey({ kind: "chain", target })),
    ...plan.quoteUnderlyings.map((target) => operationKey({ kind: "quotes", target })),
    ...plan.openInterestUnderlyings.map((target) =>
      operationKey({ kind: "open-interest", target }),
    ),
  ].sort(compareCodePoints);
}

function operationIdentity(
  operation: CanonicalRefreshOperationV1,
  asOf: string,
): DatasetPartitionIdentity {
  switch (operation.kind) {
    case "spot":
      return { dataset: "spot", partition: { ticker: operation.target, date: asOf } };
    case "chain":
      return {
        dataset: "option_chain",
        partition: { underlying: operation.target, date: asOf },
      };
    case "quotes":
      return {
        dataset: "option_quote_minutes",
        partition: { underlying: operation.target, date: asOf },
      };
    case "open-interest":
      return {
        dataset: "option_oi_daily",
        partition: { underlying: operation.target, date: asOf },
      };
  }
}

function validateAttemptInventory(
  plan: CanonicalRefreshPlanV1,
  attempt: PartitionCommitAttemptResult<BoundedRefreshResult>,
): void {
  const expected = new Map(
    expectedInventory(plan).map((identity) => [identityKey(identity), identity]),
  );
  const observed = new Map(
    attempt.receipts.map((commit) => [identityKey(commit.receipt), commit] as const),
  );
  if (expected.size !== observed.size || [...expected.keys()].some((key) => !observed.has(key))) {
    throw new Error(
      `Canonical refresh receipts do not equal the producer inventory: ${canonicalJson({
        expected: [...expected.keys()].sort(compareCodePoints),
        observed: [...observed.keys()].sort(compareCodePoints),
      })}`,
    );
  }
}

async function validateCurrentReceipt(
  partitions: FilePartitionCommitStore,
  plan: CanonicalRefreshPlanV1,
  commit: StoredPartitionCommit,
): Promise<void> {
  const receipt = commit.receipt;
  const definition = canonicalPartitionDataset(receipt.dataset);
  if (!definition)
    throw new Error(`Canonical refresh receipt has unknown dataset ${receipt.dataset}`);
  const session = receipt.partition[definition.provenance.sessionKey];
  if (
    session !== plan.asOf ||
    receipt.schemaRevision !== definition.schemaRevision ||
    receipt.relativePath !== canonicalPartitionRelativePath(receipt) ||
    receipt.coverage.kind !== "date-range" ||
    receipt.coverage.from !== plan.asOf ||
    receipt.coverage.through !== plan.asOf ||
    receipt.file.rows <= 0 ||
    receipt.quality.inputRows !== receipt.quality.writtenRows ||
    receipt.quality.writtenRows !== receipt.file.rows ||
    receipt.quality.droppedRows !== 0
  ) {
    throw new Error(`Canonical refresh receipt is not a complete zero-drop cutoff partition`);
  }
  const inspected = await partitions.inspectPartition(receipt);
  if (inspected.status !== "match" || inspected.receipt.address !== commit.address) {
    throw new Error("Canonical refresh receipt is not the current exact-byte authority tip");
  }
}

function receiptValue(commit: StoredPartitionCommit): CanonicalRefreshReceiptV1 {
  return {
    dataset: commit.receipt.dataset,
    partition: commit.receipt.partition,
    receipt: commit.address,
  };
}

function normalizeCompletion(value: unknown): CanonicalRefreshCompletionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical refresh completion must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  if (
    canonicalJson(keys) !==
    canonicalJson([
      "attemptId",
      "closure",
      "kind",
      "operations",
      "plan",
      "quoteGroups",
      "receipts",
      "version",
    ])
  ) {
    throw new Error("Canonical refresh completion has unknown or missing fields");
  }
  if (
    record.kind !== CANONICAL_REFRESH_COMPLETION_KIND ||
    record.version !== CANONICAL_REFRESH_COMPLETION_VERSION
  ) {
    throw new Error("Canonical refresh completion identity is invalid");
  }
  if (typeof record.attemptId !== "string" || record.attemptId.trim().length === 0) {
    throw new Error("Canonical refresh completion attemptId is invalid");
  }
  const attemptId = record.attemptId.normalize("NFC").trim();
  if (typeof record.closure !== "string") {
    throw new Error("Canonical refresh completion closure is invalid");
  }
  parseCanonicalJsonAddress(record.closure);
  if (record.plan === null || typeof record.plan !== "object" || Array.isArray(record.plan)) {
    throw new Error("Canonical refresh completion plan must be an object");
  }
  const planRecord = record.plan as Record<string, unknown>;
  const planKeys = Object.keys(planRecord).sort(compareCodePoints);
  const expectedPlanKeys = [
    "asOf",
    "chainUnderlyings",
    "openInterestUnderlyings",
    "quoteUnderlyings",
    "spotTickers",
    ...(Object.hasOwn(planRecord, "provider") ? ["provider"] : []),
  ].sort(compareCodePoints);
  if (canonicalJson(planKeys) !== canonicalJson(expectedPlanKeys)) {
    throw new Error("Canonical refresh completion plan has unknown or missing fields");
  }
  const plan: CanonicalRefreshPlanV1 = {
    asOf: String(planRecord.asOf),
    spotTickers: normalizedSymbols(planRecord.spotTickers as string[], "plan.spotTickers"),
    chainUnderlyings: normalizedSymbols(
      planRecord.chainUnderlyings as string[],
      "plan.chainUnderlyings",
    ),
    quoteUnderlyings: normalizedSymbols(
      planRecord.quoteUnderlyings as string[],
      "plan.quoteUnderlyings",
    ),
    openInterestUnderlyings: normalizedSymbols(
      planRecord.openInterestUnderlyings as string[],
      "plan.openInterestUnderlyings",
    ),
    ...(planRecord.provider === undefined
      ? {}
      : planRecord.provider === "massive" || planRecord.provider === "thetadata"
        ? { provider: planRecord.provider }
        : (() => {
            throw new Error("Canonical refresh completion provider is invalid");
          })()),
  };
  if (!isXnysSessionDate(plan.asOf) || expectedInventory(plan).length === 0) {
    throw new Error("Canonical refresh completion plan is empty or outside the calendar");
  }
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error("Canonical refresh completion operations must be a non-empty array");
  }
  const operations = record.operations.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Canonical refresh completion operations[${index}] must be an object`);
    }
    const operation = entry as Record<string, unknown>;
    if (
      canonicalJson(Object.keys(operation).sort(compareCodePoints)) !==
      canonicalJson(["kind", "rowsWritten", "status", "target"])
    ) {
      throw new Error(`Canonical refresh completion operations[${index}] has invalid fields`);
    }
    if (
      operation.kind !== "spot" &&
      operation.kind !== "chain" &&
      operation.kind !== "quotes" &&
      operation.kind !== "open-interest"
    ) {
      throw new Error(`Canonical refresh completion operations[${index}] kind is invalid`);
    }
    const target = normalizedSymbols(
      [operation.target as string],
      `operations[${index}].target`,
    )[0];
    if (
      operation.status !== "ok" ||
      !Number.isSafeInteger(operation.rowsWritten) ||
      (operation.rowsWritten as number) <= 0
    ) {
      throw new Error(`Canonical refresh completion operations[${index}] is not terminal`);
    }
    return {
      kind: operation.kind as CanonicalRefreshOperationV1["kind"],
      target,
      status: "ok" as const,
      rowsWritten: operation.rowsWritten as number,
    };
  });
  operations.sort((left, right) => compareCodePoints(operationKey(left), operationKey(right)));
  if (canonicalJson(operations.map(operationKey)) !== canonicalJson(expectedOperationKeys(plan))) {
    throw new Error("Canonical refresh completion operations disagree with its plan");
  }
  if (!Array.isArray(record.quoteGroups)) {
    throw new Error("Canonical refresh completion quoteGroups must be an array");
  }
  const quoteGroups = record.quoteGroups.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Canonical refresh completion quoteGroups[${index}] must be an object`);
    }
    const group = entry as Record<string, unknown>;
    if (
      canonicalJson(Object.keys(group).sort(compareCodePoints)) !==
      canonicalJson(["completedContracts", "date", "right", "root", "totalContracts", "underlying"])
    ) {
      throw new Error(`Canonical refresh completion quoteGroups[${index}] has invalid fields`);
    }
    const underlying = normalizedSymbols(
      [group.underlying as string],
      `quoteGroups[${index}].underlying`,
    )[0];
    const root = normalizedSymbols([group.root as string], `quoteGroups[${index}].root`)[0];
    if (
      (group.right !== "call" && group.right !== "put") ||
      group.date !== plan.asOf ||
      !Number.isSafeInteger(group.completedContracts) ||
      !Number.isSafeInteger(group.totalContracts) ||
      (group.completedContracts as number) < 0 ||
      group.completedContracts !== group.totalContracts
    ) {
      throw new Error(`Canonical refresh completion quoteGroups[${index}] is not terminal`);
    }
    return {
      underlying,
      root,
      right: group.right as CanonicalRefreshQuoteGroupV1["right"],
      date: plan.asOf,
      completedContracts: group.completedContracts as number,
      totalContracts: group.totalContracts as number,
    };
  });
  quoteGroups.sort((left, right) =>
    compareCodePoints(
      `${left.underlying}:${left.root}:${left.right}`,
      `${right.underlying}:${right.root}:${right.right}`,
    ),
  );
  const expectedQuoteGroups = plan.quoteUnderlyings
    .flatMap((underlying) =>
      bulkQuoteRootsForUnderlying(underlying).flatMap((root) => [
        `${underlying}:${root}:call`,
        `${underlying}:${root}:put`,
      ]),
    )
    .sort(compareCodePoints);
  if (
    canonicalJson(
      quoteGroups.map((group) => `${group.underlying}:${group.root}:${group.right}`),
    ) !== canonicalJson(expectedQuoteGroups)
  ) {
    throw new Error("Canonical refresh completion quoteGroups disagree with its plan");
  }
  if (!Array.isArray(record.receipts) || record.receipts.length === 0) {
    throw new Error("Canonical refresh completion receipts must be a non-empty array");
  }
  const receipts = record.receipts.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Canonical refresh completion receipts[${index}] must be an object`);
    }
    const receipt = entry as Record<string, unknown>;
    if (
      canonicalJson(Object.keys(receipt).sort(compareCodePoints)) !==
      canonicalJson(["dataset", "partition", "receipt"])
    ) {
      throw new Error(`Canonical refresh completion receipts[${index}] has invalid fields`);
    }
    const normalized: CanonicalRefreshReceiptV1 = {
      dataset: String(receipt.dataset),
      partition: receipt.partition as Record<string, string>,
      receipt: receipt.receipt as CanonicalJsonAddress,
    };
    validatePartitionIdentity(normalized);
    parseCanonicalJsonAddress(normalized.receipt);
    return normalized;
  });
  receipts.sort((left, right) => compareCodePoints(identityKey(left), identityKey(right)));
  const normalized = {
    kind: CANONICAL_REFRESH_COMPLETION_KIND,
    version: CANONICAL_REFRESH_COMPLETION_VERSION,
    attemptId,
    closure: record.closure as CanonicalJsonAddress,
    plan,
    operations,
    quoteGroups,
    receipts,
  };
  if (!canonicalJsonBytes(normalized).equals(canonicalJsonBytes(value))) {
    throw new Error("Canonical refresh completion is not normalized");
  }
  return normalized;
}

export async function verifyCanonicalRefreshCompletion(
  partitions: FilePartitionCommitStore,
  completionAddress: CanonicalJsonAddress,
): Promise<PutContentObjectResult<CanonicalRefreshCompletionV1>> {
  parseCanonicalJsonAddress(completionAddress);
  await verifyRefreshCompletionAuthority(partitions, completionAddress);
  const stored = await partitions.objects.get<unknown>(completionAddress);
  const completion = normalizeCompletion(stored);
  const closureInventory = await closureTailInventory(
    partitions,
    completion.closure,
    completion.plan.asOf,
  );
  const expected = new Set(expectedInventory(completion.plan).map(identityKey));
  if (
    canonicalJson([...expected].sort(compareCodePoints)) !==
    canonicalJson(closureInventory.map(identityKey))
  ) {
    throw new Error("Canonical refresh plan does not equal the closure cutoff-tail inventory");
  }
  const observed = new Set<string>();
  const receiptRows = new Map<string, number>();
  for (const reference of completion.receipts) {
    const key = identityKey(reference);
    if (observed.has(key)) throw new Error("Canonical refresh completion has duplicate receipts");
    observed.add(key);
    const commit = await partitions.readCommit(reference.receipt);
    if (identityKey(commit.receipt) !== key) {
      throw new Error("Canonical refresh receipt reference disagrees with its stored receipt");
    }
    await validateCurrentReceipt(partitions, completion.plan, commit);
    receiptRows.set(key, commit.receipt.file.rows);
  }
  if (expected.size !== observed.size || [...expected].some((key) => !observed.has(key))) {
    throw new Error("Canonical refresh completion does not cover its producer inventory");
  }
  for (const operation of completion.operations) {
    const rows = receiptRows.get(identityKey(operationIdentity(operation, completion.plan.asOf)));
    if (rows !== operation.rowsWritten) {
      throw new Error("Canonical refresh terminal rows disagree with the exact-byte receipt");
    }
  }
  return {
    address: completionAddress,
    bytes: canonicalJsonBytes(completion).byteLength,
    value: completion,
    path: partitions.objects.objectPath(completionAddress),
    created: false,
  };
}

async function publishCompletion(
  partitions: FilePartitionCommitStore,
  closure: CanonicalJsonAddress,
  plan: CanonicalRefreshPlanV1,
  attempt: PartitionCommitAttemptResult<BoundedRefreshResult>,
): Promise<PutContentObjectResult<CanonicalRefreshCompletionV1>> {
  validateAttemptInventory(plan, attempt);
  for (const commit of attempt.receipts) {
    await validateCurrentReceipt(partitions, plan, commit);
  }
  const completion = await partitions.objects.put<CanonicalRefreshCompletionV1>({
    kind: CANONICAL_REFRESH_COMPLETION_KIND,
    version: CANONICAL_REFRESH_COMPLETION_VERSION,
    attemptId: attempt.attemptId,
    closure,
    plan,
    operations: terminalOperations(plan, attempt.value.perOperation),
    quoteGroups: attempt.value.quoteGroups,
    receipts: attempt.receipts.map(receiptValue),
  });
  await publishRefreshCompletionAuthority(partitions, completion.address);
  await verifyCanonicalRefreshCompletion(partitions, completion.address);
  return completion;
}

/** Producer-owned bounded refresh + completion + cutoff publication path. */
export async function runCanonicalProvenanceRefresh(
  ingestor: MarketIngestor,
  deps: MarketIngestorDeps,
  input: ProvenanceRefreshInput,
): Promise<RefreshResult> {
  // Snapshot semantic caller fields before the first await. The progress
  // callback is operational only and is deliberately excluded from identity.
  const authority = normalizeAuthority(input.provenance);
  const plan = normalizePlan(input, deps);
  const onProgress = input.onProgress;
  const computeVixContext = input.computeVixContext ?? true;
  const marketRoot = path.join(path.resolve(deps.dataRoot), "market");
  const partitions = new FilePartitionCommitStore(marketRoot);
  const attempt = await runPartitionCommitAttempt(
    { attemptId: authority.attemptId, recorder: partitions },
    () => runBoundedRefresh(ingestor, plan, onProgress),
  );
  const completion = await publishCompletion(partitions, authority.closure, plan, attempt);

  // Legacy derived datasets stay outside the bounded attempt. Any closure
  // that reads them still fails canonical registry validation until bounded
  // enriched slices exist.
  for (const ticker of plan.spotTickers) {
    await deps.stores.enriched.compute(ticker, plan.asOf, plan.asOf);
  }
  const vixFamily = new Set(["VIX", "VIX9D", "VIX3M", "VXN"]);
  const shouldComputeContext =
    computeVixContext && plan.spotTickers.some((ticker) => vixFamily.has(ticker));
  const vixContext = shouldComputeContext
    ? await ingestor.computeVixContext({ from: plan.asOf, to: plan.asOf })
    : null;
  if (vixContext && vixContext.status !== "ok") {
    throw new Error(
      `Canonical post-refresh VIX context failed: ${vixContext.error ?? vixContext.status}`,
    );
  }

  const cutoff = await finalizeCanonicalMarketDataCutoff(partitions, {
    closure: authority.closure,
    completeThrough: plan.asOf,
    refreshCompletion: completion.address,
    ...(authority.predecessor ? { predecessor: authority.predecessor } : {}),
  });
  await verifyCanonicalMarketDataCutoff(partitions, cutoff.address);
  const coverage = Object.fromEntries(
    plan.spotTickers.map((ticker) => [
      ticker,
      { totalDates: 1, dateRange: { from: plan.asOf, to: plan.asOf } },
    ]),
  );
  return {
    status: "ok",
    perOperation: { ...attempt.value.perOperation, vixContext },
    coverage,
    errors: [],
    provenance: {
      attemptId: attempt.attemptId,
      completion: completion.address,
      receipts: completion.value.receipts.map((receipt) => receipt.receipt),
      cutoff: cutoff.address,
      aggregateRoot: cutoff.value.aggregateRoot,
    },
  };
}
