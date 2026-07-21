import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalJson, type CanonicalJsonAddress, type Sha256Address } from "./canonical-json.ts";
import type { ContentObjectStore, PutContentObjectResult } from "./content-object-store.ts";
import {
  type CutoffManifestV1,
  type InputClosureObservationV1,
  type InputResolverRegistryV1,
  type ManifestInputResolver,
  type ManifestLeafReferenceV1,
  type ManifestResolution,
  type MaterializedResolverClassV1,
  type PartitionedResolverClassV1,
  proveCutoffManifestPrefix,
  publishCutoffManifest,
  publishInputResolverRegistry,
  publishMissingProbeEvidence,
  publishSemanticInputLeaf,
  verifyCutoffManifest,
  verifySemanticInputLeaf,
} from "./content-manifest.ts";
import {
  MARKET_DATASETS,
  isRealMarketSessionDate,
  type BoundedMarketDatasetDefinition,
} from "./dataset-registry.ts";
import { FilePartitionCommitStore } from "./partition-commit-store.ts";
import {
  XNYS_SESSION_CALENDAR_REVISION,
  enumerateXnysSessions,
  isXnysSessionDate,
} from "./xnys-session-calendar.ts";
import { verifyCanonicalRefreshCompletion } from "./refresh-completion.ts";
import { publishCanonicalRateSlice, type CanonicalRateDataClass } from "./rate-slices.ts";

export const CANONICAL_MARKET_RESOLVER_REVISION = "tradeblocks-market-resolver-v1" as const;
export const BLACKOUT_SLICE_KIND = "tradeblocks.market-data.blackout-slice" as const;
export const BLACKOUT_SLICE_VERSION = 1 as const;

export interface CanonicalControlIdentity {
  dataClass: string;
  role: string;
  relativePath: string;
}

export interface PublishCanonicalMarketRegistryInput {
  /** Engine-observed data-root-relative control paths. */
  controlFiles?: readonly string[];
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

export function canonicalControlIdentity(relativePath: string): CanonicalControlIdentity {
  const normalized = relativePath.normalize("NFC").replaceAll("\\", "/");
  const match = /^blackouts\/([A-Za-z_][A-Za-z0-9._-]*)\.json$/.exec(normalized);
  if (!match) {
    throw new TypeError(
      `Unsupported canonical market control path: ${JSON.stringify(relativePath)}`,
    );
  }
  const role = `blackout.${match[1]}`;
  return Object.freeze({ dataClass: role, role, relativePath: normalized });
}

function canonicalPartitionedClasses(): PartitionedResolverClassV1[] {
  return Object.entries(MARKET_DATASETS).flatMap(([dataset, candidate]) => {
    if (candidate.provenance.kind !== "bounded-session") return [];
    const definition = candidate as BoundedMarketDatasetDefinition;
    return [
      {
        kind: "partitioned" as const,
        dataClass: dataset,
        dataset,
        selectorKeys: definition.partitionKeys,
        sessionKey: definition.provenance.sessionKey,
        pathPrefix: definition.subdir,
        filename: definition.filename,
        supportedSchemaRevisions: [definition.schemaRevision],
        resolverRevision: CANONICAL_MARKET_RESOLVER_REVISION,
        calendarRevision: XNYS_SESSION_CALENDAR_REVISION,
      },
    ];
  });
}

function canonicalMaterializedClasses(): MaterializedResolverClassV1[] {
  return (["sofr_rates", "treasury_rates"] as const).map((dataClass) => ({
    kind: "materialized",
    dataClass,
    selectorKeys: ["date"],
    sessionKey: "date",
    supportedSchemaRevisions: [1],
    resolverRevision: CANONICAL_MARKET_RESOLVER_REVISION,
    calendarRevision: XNYS_SESSION_CALENDAR_REVISION,
  }));
}

function canonicalRegistryClasses(controls: readonly CanonicalControlIdentity[]) {
  return [
    ...canonicalPartitionedClasses(),
    ...canonicalMaterializedClasses(),
    ...controls.map((control) => ({
      kind: "static" as const,
      ...control,
      supportedSchemaRevisions: [1],
      resolverRevision: CANONICAL_MARKET_RESOLVER_REVISION,
    })),
  ].sort((left, right) => {
    const byClass = compareCodePoints(left.dataClass, right.dataClass);
    return byClass === 0 ? compareCodePoints(left.kind, right.kind) : byClass;
  });
}

function validateCanonicalRegistry(registry: InputResolverRegistryV1): void {
  const controls = registry.classes
    .filter((entry) => entry.kind === "static")
    .map((entry) => canonicalControlIdentity(entry.relativePath))
    .sort((left, right) => compareCodePoints(left.dataClass, right.dataClass));
  const expectedRevision = `${CANONICAL_MARKET_RESOLVER_REVISION}.${XNYS_SESSION_CALENDAR_REVISION}`;
  if (
    registry.revision !== expectedRevision ||
    canonicalJson(registry.classes) !== canonicalJson(canonicalRegistryClasses(controls))
  ) {
    throw new Error("Input resolver registry is not the canonical producer registry");
  }
}

export async function publishCanonicalMarketResolverRegistry(
  objects: ContentObjectStore,
  input: PublishCanonicalMarketRegistryInput = {},
): Promise<PutContentObjectResult<InputResolverRegistryV1>> {
  const controls = [
    ...new Map(
      (input.controlFiles ?? []).map((controlPath) => {
        const identity = canonicalControlIdentity(controlPath);
        return [identity.relativePath, identity] as const;
      }),
    ).values(),
  ].sort((left, right) => compareCodePoints(left.dataClass, right.dataClass));
  return publishInputResolverRegistry(objects, {
    revision: `${CANONICAL_MARKET_RESOLVER_REVISION}.${XNYS_SESSION_CALENDAR_REVISION}`,
    classes: canonicalRegistryClasses(controls),
  });
}

function requireCanonicalClass(
  registry: InputResolverRegistryV1,
  observation: Exclude<InputClosureObservationV1, { kind: "unmanifestable" }>,
) {
  const resolverClass = registry.classes.find((entry) => entry.dataClass === observation.dataClass);
  if (!resolverClass) throw new Error(`Unknown canonical input class ${observation.dataClass}`);
  if (resolverClass.resolverRevision !== CANONICAL_MARKET_RESOLVER_REVISION) {
    throw new Error(`Unsupported resolver revision for ${observation.dataClass}`);
  }
  if (
    resolverClass.kind !== "static" &&
    resolverClass.calendarRevision !== XNYS_SESSION_CALENDAR_REVISION
  ) {
    throw new Error(`Unsupported calendar revision for ${observation.dataClass}`);
  }
  return resolverClass;
}

function partitionLeafReference(
  leaf: CanonicalJsonAddress,
  receipt: CanonicalJsonAddress,
): ManifestLeafReferenceV1 {
  return { leaf, evidence: { kind: "partition-receipt", receipt } };
}

function sessionFromObservation(observation: InputClosureObservationV1): string | undefined {
  return observation.kind === "exact" || observation.kind === "missing-probe"
    ? observation.session
    : undefined;
}

async function readCanonicalBlackoutSlice(
  objects: ContentObjectStore,
  dataRootDir: string,
  identity: CanonicalControlIdentity,
  completeThrough: string,
) {
  const root = await fs.realpath(path.resolve(dataRootDir));
  const components = identity.relativePath.split("/");
  let parent = root;
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component);
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Canonical control parents must be real directories");
    }
  }
  const realParent = await fs.realpath(parent);
  const containment = path.relative(root, realParent);
  if (
    containment === ".." ||
    containment.startsWith(`..${path.sep}`) ||
    path.isAbsolute(containment)
  ) {
    throw new Error("Canonical control path escapes the configured data root");
  }
  const candidate = path.join(parent, components.at(-1) as string);
  const handle = await fs.open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("Canonical control input must be a singly-linked regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Canonical control input changed while it was read");
    }
    let revalidatedParent = root;
    for (const component of components.slice(0, -1)) {
      revalidatedParent = path.join(revalidatedParent, component);
      const stat = await fs.lstat(revalidatedParent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Canonical control parent changed while it was read");
      }
    }
    if ((await fs.realpath(revalidatedParent)) !== realParent) {
      throw new Error("Canonical control parent changed while it was read");
    }
    const named = await fs.lstat(candidate, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.size !== after.size ||
      named.mtimeNs !== after.mtimeNs ||
      named.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Canonical control input name changed while it was read");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    const dates = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { dates?: unknown }).dates
        : undefined;
    if (!Array.isArray(dates)) throw new Error("Blackout control input has no dates array");
    const normalized = dates.map((date, index) => {
      if (typeof date !== "string" || !isRealMarketSessionDate(date)) {
        throw new Error(`Blackout control date ${index} is invalid`);
      }
      return date.normalize("NFC");
    });
    normalized.sort(compareCodePoints);
    const unique = normalized.filter(
      (date, index) => date <= completeThrough && (index === 0 || date !== normalized[index - 1]),
    );
    return objects.put({
      kind: BLACKOUT_SLICE_KIND,
      version: BLACKOUT_SLICE_VERSION,
      role: identity.role,
      dates: unique,
    });
  } finally {
    await handle.close();
  }
}

function normalizeBlackoutSlice(
  value: unknown,
  expectedRole: string,
  completeThrough: string,
): {
  kind: typeof BLACKOUT_SLICE_KIND;
  version: typeof BLACKOUT_SLICE_VERSION;
  role: string;
  dates: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Blackout slice must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  if (canonicalJson(keys) !== canonicalJson(["dates", "kind", "role", "version"])) {
    throw new Error("Blackout slice has unknown or missing fields");
  }
  if (
    record.kind !== BLACKOUT_SLICE_KIND ||
    record.version !== BLACKOUT_SLICE_VERSION ||
    record.role !== expectedRole ||
    !Array.isArray(record.dates)
  ) {
    throw new Error("Blackout slice identity is invalid");
  }
  const dates = record.dates.map((date, index) => {
    if (typeof date !== "string" || !isRealMarketSessionDate(date) || date > completeThrough) {
      throw new Error(`Blackout slice date ${index} is invalid`);
    }
    return date.normalize("NFC");
  });
  const sorted = [...dates].sort(compareCodePoints);
  if (canonicalJson(dates) !== canonicalJson(sorted) || new Set(dates).size !== dates.length) {
    throw new Error("Blackout slice dates are not normalized");
  }
  return {
    kind: BLACKOUT_SLICE_KIND,
    version: BLACKOUT_SLICE_VERSION,
    role: expectedRole,
    dates,
  };
}

/**
 * Producer-owned resolver for the bounded market registry.
 *
 * Range completeness comes from XNYS session enumeration, never from the set
 * of files that happen to exist. Every expected partition must have a current
 * exact-byte authority tip before the resolver reports a complete horizon.
 */
export class CanonicalMarketInputResolver implements ManifestInputResolver {
  readonly dataRootDir: string;

  constructor(readonly partitions: FilePartitionCommitStore) {
    const marketRoot = path.resolve(partitions.marketRootDir);
    if (path.basename(marketRoot) !== "market") {
      throw new Error("Canonical market resolver requires a data-root/market authority store");
    }
    this.dataRootDir = path.dirname(marketRoot);
  }

  private async resolvePartition(
    registryAddress: CanonicalJsonAddress,
    observation: Exclude<
      InputClosureObservationV1,
      { kind: "control-file" | "unmanifestable" | "missing-probe" }
    >,
    resolverClass: PartitionedResolverClassV1,
    partition: Record<string, string>,
  ): Promise<ManifestLeafReferenceV1> {
    const inspected = await this.partitions.inspectPartition({
      dataset: resolverClass.dataset,
      partition,
    });
    if (inspected.status !== "match") {
      throw new Error(
        `Canonical partition is not complete/current: ${resolverClass.dataset} ${JSON.stringify(partition)} (${inspected.status})`,
      );
    }
    const receipt = inspected.receipt.receipt;
    const session = partition[resolverClass.sessionKey];
    if (
      !resolverClass.supportedSchemaRevisions.includes(receipt.schemaRevision) ||
      receipt.file.rows <= 0 ||
      receipt.coverage.kind !== "date-range" ||
      receipt.coverage.from !== session ||
      receipt.coverage.through !== session ||
      receipt.quality.writtenRows !== receipt.file.rows ||
      receipt.quality.inputRows !== receipt.file.rows ||
      receipt.quality.droppedRows !== 0
    ) {
      throw new Error(
        `Canonical partition is not a complete zero-drop cutoff partition: ${resolverClass.dataset} ${JSON.stringify(partition)}`,
      );
    }
    const leaf = await publishSemanticInputLeaf(this.partitions.objects, {
      registry: registryAddress,
      observation,
      source: {
        kind: "partition-projection",
        dataset: receipt.dataset,
        partition: receipt.partition,
        relativePath: receipt.relativePath,
        session,
        schemaRevision: receipt.schemaRevision,
        coverage: receipt.coverage,
        quality: receipt.quality,
        file: receipt.file,
      },
    });
    return partitionLeafReference(leaf.address, inspected.receipt.address);
  }

  private async resolveMaterializedRate(
    registryAddress: CanonicalJsonAddress,
    observation: Extract<InputClosureObservationV1, { kind: "exact" | "range" }>,
    resolverClass: MaterializedResolverClassV1,
    selector: Record<string, string>,
  ): Promise<ManifestLeafReferenceV1> {
    const session = selector[resolverClass.sessionKey];
    const object = await publishCanonicalRateSlice(
      this.partitions.objects,
      resolverClass.dataClass as CanonicalRateDataClass,
      session,
    );
    const leaf = await publishSemanticInputLeaf(this.partitions.objects, {
      registry: registryAddress,
      observation,
      source: {
        kind: "materialized-slice",
        selector,
        session,
        schemaRevision: 1,
        object: { address: object.address, bytes: object.bytes },
      },
    });
    return {
      leaf: leaf.address,
      evidence: { kind: "content-object", object: object.address },
    };
  }

  async resolve(input: {
    registry: InputResolverRegistryV1;
    closure: import("./content-manifest.ts").InputClosureDescriptorV1;
    observation: InputClosureObservationV1;
    dependency: CanonicalJsonAddress;
    completeThrough: string;
  }): Promise<ManifestResolution> {
    const { registry, observation, completeThrough } = input;
    if (observation.kind === "unmanifestable") {
      return { kind: "unmanifestable", reasonCode: observation.reasonCode };
    }
    try {
      validateCanonicalRegistry(registry);
      if (!isXnysSessionDate(completeThrough)) {
        return { kind: "unresolved", reasonCode: "cutoff-not-xnys-session" };
      }
      const resolverClass = requireCanonicalClass(registry, observation);
      if (observation.kind === "control-file") {
        if (resolverClass.kind !== "static") {
          return { kind: "unmanifestable", reasonCode: "control-class-not-static" };
        }
        const identity = canonicalControlIdentity(resolverClass.relativePath);
        if (identity.role !== observation.role || identity.role !== resolverClass.role) {
          return { kind: "unmanifestable", reasonCode: "control-identity-mismatch" };
        }
        const object = await readCanonicalBlackoutSlice(
          this.partitions.objects,
          this.dataRootDir,
          identity,
          completeThrough,
        );
        const leaf = await publishSemanticInputLeaf(this.partitions.objects, {
          registry: input.closure.registry,
          observation,
          source: {
            kind: "control-file",
            role: identity.role,
            relativePath: identity.relativePath,
            schemaRevision: 1,
            object: { address: object.address, bytes: object.bytes },
          },
        });
        return {
          kind: "resolved",
          completeThrough,
          entries: [
            {
              leaf: leaf.address,
              evidence: { kind: "content-object", object: object.address },
            },
          ],
        };
      }
      if (resolverClass.kind === "static") {
        return { kind: "unmanifestable", reasonCode: "session-observation-class-is-static" };
      }
      if (observation.kind === "missing-probe") {
        if (resolverClass.kind !== "partitioned") {
          return { kind: "unmanifestable", reasonCode: "probe-class-not-partitioned" };
        }
        if (!isXnysSessionDate(observation.session)) {
          return { kind: "unmanifestable", reasonCode: "probe-not-xnys-session" };
        }
        const inspected = await this.partitions.inspectPartition({
          dataset: resolverClass.dataset,
          partition: observation.selector,
        });
        if (inspected.status !== "absent") {
          return { kind: "unresolved", reasonCode: `probe-${inspected.status}` };
        }
        const evidence = await publishMissingProbeEvidence(this.partitions.objects, {
          registry: input.closure.registry,
          observation,
          completeThrough,
        });
        const leaf = await publishSemanticInputLeaf(this.partitions.objects, {
          registry: input.closure.registry,
          observation,
          source: { kind: "missing-probe", session: observation.session },
        });
        return {
          kind: "resolved",
          completeThrough,
          entries: [
            {
              leaf: leaf.address,
              evidence: { kind: "absence-object", object: evidence.address },
            },
          ],
        };
      }
      const sessions =
        observation.kind === "exact"
          ? [sessionFromObservation(observation) as string]
          : enumerateXnysSessions(observation.fromSession, observation.throughSession);
      if (sessions.length === 0) {
        return { kind: "unresolved", reasonCode: "range-has-no-xnys-sessions" };
      }
      const entries: ManifestLeafReferenceV1[] = [];
      for (const session of sessions) {
        if (!isXnysSessionDate(session)) {
          return { kind: "unmanifestable", reasonCode: "exact-not-xnys-session" };
        }
        const partition =
          observation.kind === "exact"
            ? observation.selector
            : { ...observation.selectorPrefix, [resolverClass.sessionKey]: session };
        entries.push(
          resolverClass.kind === "partitioned"
            ? await this.resolvePartition(
                input.closure.registry,
                observation,
                resolverClass,
                partition,
              )
            : await this.resolveMaterializedRate(
                input.closure.registry,
                observation,
                resolverClass,
                partition,
              ),
        );
      }
      return { kind: "resolved", completeThrough, entries };
    } catch (error) {
      return {
        kind: "unresolved",
        reasonCode: error instanceof Error ? error.message : "canonical-resolution-failed",
      };
    }
  }

  async projectStaticPrefix(input: {
    registry: InputResolverRegistryV1;
    registryAddress: CanonicalJsonAddress;
    dataClass: string;
    ancestorCompleteThrough: string;
    descendantCompleteThrough: string;
    descendantEntries: readonly ManifestLeafReferenceV1[];
  }): Promise<readonly ManifestLeafReferenceV1[]> {
    validateCanonicalRegistry(input.registry);
    const resolverClass = input.registry.classes.find(
      (entry) => entry.dataClass === input.dataClass,
    );
    if (!resolverClass || resolverClass.kind !== "static") {
      throw new Error("Canonical static prefix projection requires a static registry class");
    }
    if (input.descendantEntries.length !== 1) {
      throw new Error("Canonical static prefix projection requires exactly one descendant leaf");
    }
    const reference = input.descendantEntries[0];
    const leaf = await verifySemanticInputLeaf(this.partitions.objects, reference.leaf);
    if (
      leaf.value.registry !== input.registryAddress ||
      leaf.value.dataClass !== input.dataClass ||
      leaf.value.scope.kind !== "static" ||
      leaf.value.source.kind !== "control-file" ||
      reference.evidence.kind !== "content-object" ||
      reference.evidence.object !== leaf.value.source.object.address
    ) {
      throw new Error("Canonical static prefix projection received invalid descendant evidence");
    }
    const descendantObject = await this.partitions.objects.get<unknown>(reference.evidence.object);
    const descendantSlice = normalizeBlackoutSlice(
      descendantObject,
      resolverClass.role,
      input.descendantCompleteThrough,
    );
    const projectedObject = await this.partitions.objects.put({
      ...descendantSlice,
      dates: descendantSlice.dates.filter((date) => date <= input.ancestorCompleteThrough),
    });
    const observation: InputClosureObservationV1 = {
      kind: "control-file",
      dataClass: input.dataClass,
      role: resolverClass.role,
    };
    const projectedLeaf = await publishSemanticInputLeaf(this.partitions.objects, {
      registry: input.registryAddress,
      observation,
      source: {
        ...leaf.value.source,
        object: { address: projectedObject.address, bytes: projectedObject.bytes },
      },
    });
    return [
      {
        leaf: projectedLeaf.address,
        evidence: { kind: "content-object", object: projectedObject.address },
      },
    ];
  }
}

export async function finalizeCanonicalMarketDataCutoff(
  partitions: FilePartitionCommitStore,
  input: {
    closure: CanonicalJsonAddress;
    completeThrough: string;
    refreshCompletion: CanonicalJsonAddress;
    predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address };
  },
): Promise<PutContentObjectResult<CutoffManifestV1>> {
  if (!isXnysSessionDate(input.completeThrough)) {
    throw new Error(`Canonical cutoff is not a supported XNYS session: ${input.completeThrough}`);
  }
  const completion = await verifyCanonicalRefreshCompletion(partitions, input.refreshCompletion);
  if (
    completion.value.plan.asOf !== input.completeThrough ||
    completion.value.closure !== input.closure
  ) {
    throw new Error("Canonical refresh completion does not authorize this closure and cutoff");
  }
  const manifest = await publishCutoffManifest(partitions, {
    closure: input.closure,
    completeThrough: input.completeThrough,
    resolver: new CanonicalMarketInputResolver(partitions),
    refreshCompletion: completion.address,
    ...(input.predecessor ? { predecessor: input.predecessor } : {}),
  });
  await verifyCanonicalRefreshCompletion(partitions, completion.address);
  return manifest;
}

export async function verifyCanonicalMarketDataCutoff(
  partitions: FilePartitionCommitStore,
  manifest: CanonicalJsonAddress,
) {
  const verified = await verifyCutoffManifest(
    partitions,
    manifest,
    new CanonicalMarketInputResolver(partitions),
  );
  if (!verified.manifest.refreshCompletion) {
    throw new Error("Canonical cutoff manifest has no refresh completion authority");
  }
  const completion = await verifyCanonicalRefreshCompletion(
    partitions,
    verified.manifest.refreshCompletion,
  );
  if (
    completion.value.plan.asOf !== verified.manifest.completeThrough ||
    completion.value.closure !== verified.manifest.closure
  ) {
    throw new Error("Canonical cutoff manifest refresh authority is inconsistent");
  }
  return verified;
}

export async function proveCanonicalMarketDataPrefix(
  partitions: FilePartitionCommitStore,
  ancestor: CanonicalJsonAddress,
  descendant: CanonicalJsonAddress,
) {
  await verifyCanonicalMarketDataCutoff(partitions, ancestor);
  await verifyCanonicalMarketDataCutoff(partitions, descendant);
  const proof = await proveCutoffManifestPrefix(
    partitions,
    ancestor,
    descendant,
    new CanonicalMarketInputResolver(partitions),
  );
  await verifyCanonicalMarketDataCutoff(partitions, ancestor);
  await verifyCanonicalMarketDataCutoff(partitions, descendant);
  return proof;
}
