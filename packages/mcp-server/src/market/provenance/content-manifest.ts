import {
  addressCanonicalJson,
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJsonAddress,
  parseSha256Address,
  type CanonicalJsonAddress,
  type Sha256Address,
} from "./canonical-json.ts";
import { ContentObjectStore, type PutContentObjectResult } from "./content-object-store.ts";
import {
  canonicalPartitionRelativePath,
  isRealMarketSessionDate,
  marketDatasetDefinition,
} from "./dataset-registry.ts";
import type {
  ExactFileFingerprint,
  FilePartitionCommitStore,
  LogicalCoverage,
  PartitionQualityCounts,
} from "./partition-commit-store.ts";

export const INPUT_RESOLVER_REGISTRY_KIND =
  "tradeblocks.market-data.input-resolver-registry" as const;
export const INPUT_RESOLVER_REGISTRY_VERSION = 1 as const;
export const INPUT_CLOSURE_DESCRIPTOR_KIND = "tradeblocks.market-data.input-closure" as const;
export const INPUT_CLOSURE_DESCRIPTOR_VERSION = 1 as const;
export const INPUT_DEPENDENCY_KEY_KIND = "tradeblocks.market-data.input-dependency" as const;
export const INPUT_DEPENDENCY_KEY_VERSION = 1 as const;
export const SEMANTIC_INPUT_LEAF_KIND = "tradeblocks.market-data.semantic-input-leaf" as const;
export const SEMANTIC_INPUT_LEAF_VERSION = 1 as const;
export const MISSING_PROBE_EVIDENCE_KIND =
  "tradeblocks.market-data.missing-probe-evidence" as const;
export const MISSING_PROBE_EVIDENCE_VERSION = 1 as const;
export const CUTOFF_MANIFEST_KIND = "tradeblocks.market-data.cutoff-manifest" as const;
export const CUTOFF_MANIFEST_VERSION = 1 as const;

export class ManifestVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManifestVerificationError";
  }
}

export interface PartitionedResolverClassV1 {
  kind: "partitioned";
  dataClass: string;
  dataset: string;
  selectorKeys: readonly string[];
  sessionKey: string;
  pathPrefix: string;
  filename: string;
  supportedSchemaRevisions: readonly number[];
  resolverRevision: string;
  calendarRevision: string;
}

export interface StaticResolverClassV1 {
  kind: "static";
  dataClass: string;
  role: string;
  relativePath: string;
  supportedSchemaRevisions: readonly number[];
  resolverRevision: string;
}

export interface MaterializedResolverClassV1 {
  kind: "materialized";
  dataClass: string;
  selectorKeys: readonly string[];
  sessionKey: string;
  supportedSchemaRevisions: readonly number[];
  resolverRevision: string;
  calendarRevision: string;
}

export type InputResolverClassV1 =
  | PartitionedResolverClassV1
  | StaticResolverClassV1
  | MaterializedResolverClassV1;

export interface InputResolverRegistryV1 {
  kind: typeof INPUT_RESOLVER_REGISTRY_KIND;
  version: typeof INPUT_RESOLVER_REGISTRY_VERSION;
  revision: string;
  classes: readonly InputResolverClassV1[];
}

export type InputResolverRegistryInputV1 = Omit<InputResolverRegistryV1, "kind" | "version">;

export type InputClosureObservationV1 =
  | {
      kind: "exact";
      dataClass: string;
      selector: Record<string, string>;
      session: string;
    }
  | {
      kind: "range";
      dataClass: string;
      selectorPrefix: Record<string, string>;
      fromSession: string;
      throughSession: string;
    }
  | {
      kind: "missing-probe";
      dataClass: string;
      selector: Record<string, string>;
      session: string;
    }
  | { kind: "control-file"; dataClass: string; role: string }
  | { kind: "unmanifestable"; readClass: string; reasonCode: string };

export interface InputClosureDescriptorV1 {
  kind: typeof INPUT_CLOSURE_DESCRIPTOR_KIND;
  version: typeof INPUT_CLOSURE_DESCRIPTOR_VERSION;
  registry: CanonicalJsonAddress;
  observations: readonly InputClosureObservationV1[];
}

export interface PartitionProjectionV1 {
  kind: "partition-projection";
  dataset: string;
  partition: Record<string, string>;
  relativePath: string;
  session: string;
  schemaRevision: number;
  coverage: LogicalCoverage;
  quality: PartitionQualityCounts;
  file: ExactFileFingerprint;
}

export interface MaterializedSliceV1 {
  kind: "materialized-slice";
  selector: Record<string, string>;
  session: string;
  schemaRevision: number;
  object: { address: CanonicalJsonAddress; bytes: number };
}

export interface ControlFileProjectionV1 {
  kind: "control-file";
  role: string;
  relativePath: string;
  schemaRevision: number;
  object: { address: CanonicalJsonAddress; bytes: number };
}

export interface MissingProbeProjectionV1 {
  kind: "missing-probe";
  session: string;
}

export type SemanticInputSourceV1 =
  | PartitionProjectionV1
  | MaterializedSliceV1
  | ControlFileProjectionV1
  | MissingProbeProjectionV1;

export interface SemanticInputLeafV1 {
  kind: typeof SEMANTIC_INPUT_LEAF_KIND;
  version: typeof SEMANTIC_INPUT_LEAF_VERSION;
  registry: CanonicalJsonAddress;
  dependency: CanonicalJsonAddress;
  dataClass: string;
  scope: { kind: "session"; session: string } | { kind: "static" };
  source: SemanticInputSourceV1;
}

export interface MissingProbeEvidenceV1 {
  kind: typeof MISSING_PROBE_EVIDENCE_KIND;
  version: typeof MISSING_PROBE_EVIDENCE_VERSION;
  registry: CanonicalJsonAddress;
  dependency: CanonicalJsonAddress;
  completeThrough: string;
}

export type ManifestLeafEvidenceV1 =
  | { kind: "partition-receipt"; receipt: CanonicalJsonAddress }
  | { kind: "content-object"; object: CanonicalJsonAddress }
  | { kind: "absence-object"; object: CanonicalJsonAddress };

export interface ManifestLeafReferenceV1 {
  leaf: CanonicalJsonAddress;
  evidence: ManifestLeafEvidenceV1;
}

export interface ManifestClassV1 {
  dataClass: string;
  completeThrough: string;
  entries: readonly ManifestLeafReferenceV1[];
  leafCount: number;
  root: Sha256Address;
}

export interface CutoffManifestV1 {
  kind: typeof CUTOFF_MANIFEST_KIND;
  version: typeof CUTOFF_MANIFEST_VERSION;
  closure: CanonicalJsonAddress;
  completeThrough: string;
  classes: readonly ManifestClassV1[];
  aggregateRoot: Sha256Address;
  refreshCompletion?: CanonicalJsonAddress;
  predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address };
}

export type ManifestResolution =
  | {
      kind: "resolved";
      completeThrough: string;
      entries: readonly ManifestLeafReferenceV1[];
    }
  | { kind: "unresolved" | "unmanifestable"; reasonCode: string };

export interface ManifestInputResolver {
  resolve(input: {
    registry: InputResolverRegistryV1;
    closure: InputClosureDescriptorV1;
    observation: InputClosureObservationV1;
    dependency: CanonicalJsonAddress;
    completeThrough: string;
  }): Promise<ManifestResolution>;
  /**
   * Project immutable descendant static leaves back to an older cutoff.
   *
   * Partition/session leaves are always checked directly from the descendant
   * manifest. A static class may opt into cutoff projection only when its
   * producer can derive the older value from the descendant's immutable
   * content object; re-reading mutable live state is not a valid projection.
   */
  projectStaticPrefix?(input: {
    registry: InputResolverRegistryV1;
    registryAddress: CanonicalJsonAddress;
    dataClass: string;
    ancestorCompleteThrough: string;
    descendantCompleteThrough: string;
    descendantEntries: readonly ManifestLeafReferenceV1[];
  }): Promise<readonly ManifestLeafReferenceV1[]>;
}

type JsonRecord = Record<string, unknown>;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SAFE_PATH_COMPONENT_RE = /^[A-Za-z0-9._=-]+$/;
const OBSERVATION_RANK: Readonly<Record<InputClosureObservationV1["kind"], number>> = Object.freeze(
  {
    exact: 0,
    range: 1,
    "missing-probe": 2,
    "control-file": 3,
    unmanifestable: 4,
  },
);

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function fail(message: string): never {
  throw new ManifestVerificationError(message);
}

function plainRecord(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain object`);
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[], label: string): void {
  const observed = Object.keys(record).sort(compareUnicodeCodePoints);
  const wanted = [...expected].sort(compareUnicodeCodePoints);
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unknown or missing fields`);
  }
  for (const key of observed) {
    if (record[key] === null) fail(`${label}.${key} must use omission instead of null`);
  }
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value.normalize("NFC");
}

function identifier(value: unknown, label: string): string {
  const normalized = nonemptyString(value, label);
  if (!IDENTIFIER_RE.test(normalized)) fail(`${label} is not a safe identifier`);
  return normalized;
}

function revision(value: unknown, label: string): string {
  const normalized = nonemptyString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) fail(`${label} is not a safe revision`);
  return normalized;
}

function sessionDate(value: unknown, label: string): string {
  const normalized = nonemptyString(value, label);
  if (!isRealMarketSessionDate(normalized)) fail(`${label} is not a valid session date`);
  return normalized;
}

function relativePath(value: unknown, label: string): string {
  const normalized = nonemptyString(value, label).replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized
      .split("/")
      .some((part) => !SAFE_PATH_COMPONENT_RE.test(part) || part === "." || part === "..")
  ) {
    fail(`${label} is not a safe relative path`);
  }
  return normalized;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const record = plainRecord(value, label);
  const normalized: Record<string, string> = {};
  const normalizedKeys = new Map<string, string>();
  for (const sourceKey of Object.keys(record)) {
    const key = identifier(sourceKey, `${label} key`);
    const collision = normalizedKeys.get(key);
    if (collision !== undefined && collision !== sourceKey) {
      fail(`${label} has an NFC-normalized key collision`);
    }
    normalizedKeys.set(key, sourceKey);
    normalized[key] = nonemptyString(record[sourceKey], `${label}.${sourceKey}`);
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => compareUnicodeCodePoints(left, right)),
  );
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    fail(`${label} must be a positive safe integer`);
  return value as number;
}

function address(value: unknown, label: string): CanonicalJsonAddress {
  const normalized = nonemptyString(value, label);
  try {
    parseCanonicalJsonAddress(normalized);
  } catch (error) {
    throw new ManifestVerificationError(`${label} is not a canonical object address`, {
      cause: error,
    });
  }
  return normalized as CanonicalJsonAddress;
}

function snapshot<T>(value: unknown, label: string): T {
  try {
    return JSON.parse(canonicalJsonBytes(value).toString("utf8")) as T;
  } catch (error) {
    throw new ManifestVerificationError(`${label} is not canonical JSON v1`, { cause: error });
  }
}

function rawStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(rawStableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${rawStableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeSchemaRevisions(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const revisions = value.map((entry, index) => positiveSafeInteger(entry, `${label}[${index}]`));
  const sorted = [...revisions].sort((left, right) => left - right);
  if (sorted.some((entry, index) => index > 0 && entry === sorted[index - 1])) {
    fail(`${label} contains a duplicate revision`);
  }
  return sorted;
}

function normalizeSelectorKeys(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const keys = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(keys).size !== keys.length) fail(`${label} contains a duplicate key`);
  return keys;
}

function normalizeRegistryClass(value: unknown, label: string): InputResolverClassV1 {
  const record = plainRecord(value, label);
  const kind = record.kind;
  if (kind === "partitioned") {
    exactKeys(
      record,
      [
        "kind",
        "dataClass",
        "dataset",
        "selectorKeys",
        "sessionKey",
        "pathPrefix",
        "filename",
        "supportedSchemaRevisions",
        "resolverRevision",
        "calendarRevision",
      ],
      label,
    );
    const dataClass = identifier(record.dataClass, `${label}.dataClass`);
    const dataset = identifier(record.dataset, `${label}.dataset`);
    const selectorKeys = normalizeSelectorKeys(record.selectorKeys, `${label}.selectorKeys`);
    const sessionKey = identifier(record.sessionKey, `${label}.sessionKey`);
    const pathPrefix = relativePath(record.pathPrefix, `${label}.pathPrefix`);
    const filename = relativePath(record.filename, `${label}.filename`);
    if (filename.includes("/")) fail(`${label}.filename must be one path component`);
    const supportedSchemaRevisions = normalizeSchemaRevisions(
      record.supportedSchemaRevisions,
      `${label}.supportedSchemaRevisions`,
    );
    const resolverRevision = revision(record.resolverRevision, `${label}.resolverRevision`);
    const calendarRevision = revision(record.calendarRevision, `${label}.calendarRevision`);
    const shared = marketDatasetDefinition(dataset);
    if (!shared || shared.provenance.kind !== "bounded-session") {
      fail(`${label} references an unsupported or unbounded dataset`);
    }
    if (
      dataClass !== dataset ||
      canonicalJson(selectorKeys) !== canonicalJson(shared.partitionKeys) ||
      sessionKey !== shared.provenance.sessionKey ||
      pathPrefix !== shared.subdir ||
      filename !== shared.filename ||
      canonicalJson(supportedSchemaRevisions) !== canonicalJson([shared.schemaRevision])
    ) {
      fail(`${label} disagrees with the canonical dataset registry`);
    }
    return {
      kind,
      dataClass,
      dataset,
      selectorKeys,
      sessionKey,
      pathPrefix,
      filename,
      supportedSchemaRevisions,
      resolverRevision,
      calendarRevision,
    };
  }
  if (kind === "static") {
    exactKeys(
      record,
      ["kind", "dataClass", "role", "relativePath", "supportedSchemaRevisions", "resolverRevision"],
      label,
    );
    return {
      kind,
      dataClass: identifier(record.dataClass, `${label}.dataClass`),
      role: identifier(record.role, `${label}.role`),
      relativePath: relativePath(record.relativePath, `${label}.relativePath`),
      supportedSchemaRevisions: normalizeSchemaRevisions(
        record.supportedSchemaRevisions,
        `${label}.supportedSchemaRevisions`,
      ),
      resolverRevision: revision(record.resolverRevision, `${label}.resolverRevision`),
    };
  }
  if (kind === "materialized") {
    exactKeys(
      record,
      [
        "kind",
        "dataClass",
        "selectorKeys",
        "sessionKey",
        "supportedSchemaRevisions",
        "resolverRevision",
        "calendarRevision",
      ],
      label,
    );
    const selectorKeys = normalizeSelectorKeys(record.selectorKeys, `${label}.selectorKeys`);
    const sessionKey = identifier(record.sessionKey, `${label}.sessionKey`);
    if (!selectorKeys.includes(sessionKey)) {
      fail(`${label}.sessionKey is not one of its selector keys`);
    }
    return {
      kind,
      dataClass: identifier(record.dataClass, `${label}.dataClass`),
      selectorKeys,
      sessionKey,
      supportedSchemaRevisions: normalizeSchemaRevisions(
        record.supportedSchemaRevisions,
        `${label}.supportedSchemaRevisions`,
      ),
      resolverRevision: revision(record.resolverRevision, `${label}.resolverRevision`),
      calendarRevision: revision(record.calendarRevision, `${label}.calendarRevision`),
    };
  }
  fail(`${label}.kind is unsupported`);
}

function normalizeRegistry(value: unknown): InputResolverRegistryV1 {
  const captured = snapshot<unknown>(value, "input resolver registry");
  const record = plainRecord(captured, "input resolver registry");
  exactKeys(record, ["kind", "version", "revision", "classes"], "input resolver registry");
  if (record.kind !== INPUT_RESOLVER_REGISTRY_KIND) fail("input resolver registry kind is invalid");
  if (record.version !== INPUT_RESOLVER_REGISTRY_VERSION) {
    fail("input resolver registry version is unsupported");
  }
  if (!Array.isArray(record.classes) || record.classes.length === 0) {
    fail("input resolver registry classes must be a non-empty array");
  }
  const classes = record.classes.map((entry, index) =>
    normalizeRegistryClass(entry, `input resolver registry classes[${index}]`),
  );
  classes.sort((left, right) => {
    const byClass = compareUnicodeCodePoints(left.dataClass, right.dataClass);
    return byClass === 0 ? compareUnicodeCodePoints(left.kind, right.kind) : byClass;
  });
  for (let index = 1; index < classes.length; index += 1) {
    if (classes[index - 1].dataClass === classes[index].dataClass) {
      fail(
        `input resolver registry repeats data class ${JSON.stringify(classes[index].dataClass)}`,
      );
    }
  }
  return {
    kind: INPUT_RESOLVER_REGISTRY_KIND,
    version: INPUT_RESOLVER_REGISTRY_VERSION,
    revision: revision(record.revision, "input resolver registry revision"),
    classes,
  };
}

export async function publishInputResolverRegistry(
  objects: ContentObjectStore,
  input: InputResolverRegistryInputV1,
): Promise<PutContentObjectResult<InputResolverRegistryV1>> {
  const registry = normalizeRegistry({
    kind: INPUT_RESOLVER_REGISTRY_KIND,
    version: INPUT_RESOLVER_REGISTRY_VERSION,
    revision: input.revision,
    classes: input.classes,
  });
  return objects.put(registry);
}

export async function verifyInputResolverRegistry(
  objects: ContentObjectStore,
  registryAddress: CanonicalJsonAddress,
): Promise<PutContentObjectResult<InputResolverRegistryV1>> {
  address(registryAddress, "input resolver registry address");
  const stored = await objects.get<unknown>(registryAddress);
  const registry = normalizeRegistry(stored);
  if (!canonicalJsonBytes(registry).equals(canonicalJsonBytes(stored))) {
    fail("input resolver registry is not normalized and deterministically ordered");
  }
  return {
    address: registryAddress,
    value: registry,
    path: objects.objectPath(registryAddress),
    bytes: canonicalJsonBytes(stored).byteLength,
    created: false,
  };
}

function normalizeObservation(value: unknown, label: string): InputClosureObservationV1 {
  const record = plainRecord(snapshot(value, label), label);
  switch (record.kind) {
    case "exact":
    case "missing-probe": {
      exactKeys(record, ["kind", "dataClass", "selector", "session"], label);
      return {
        kind: record.kind,
        dataClass: identifier(record.dataClass, `${label}.dataClass`),
        selector: stringMap(record.selector, `${label}.selector`),
        session: sessionDate(record.session, `${label}.session`),
      };
    }
    case "range": {
      exactKeys(
        record,
        ["kind", "dataClass", "selectorPrefix", "fromSession", "throughSession"],
        label,
      );
      const fromSession = sessionDate(record.fromSession, `${label}.fromSession`);
      const throughSession = sessionDate(record.throughSession, `${label}.throughSession`);
      if (fromSession > throughSession) fail(`${label} has an inverted session range`);
      return {
        kind: record.kind,
        dataClass: identifier(record.dataClass, `${label}.dataClass`),
        selectorPrefix: stringMap(record.selectorPrefix, `${label}.selectorPrefix`),
        fromSession,
        throughSession,
      };
    }
    case "control-file":
      exactKeys(record, ["kind", "dataClass", "role"], label);
      return {
        kind: record.kind,
        dataClass: identifier(record.dataClass, `${label}.dataClass`),
        role: identifier(record.role, `${label}.role`),
      };
    case "unmanifestable":
      exactKeys(record, ["kind", "readClass", "reasonCode"], label);
      return {
        kind: record.kind,
        readClass: identifier(record.readClass, `${label}.readClass`),
        reasonCode: revision(record.reasonCode, `${label}.reasonCode`),
      };
    default:
      fail(`${label}.kind is unsupported`);
  }
}

function observationTuple(observation: InputClosureObservationV1): readonly string[] {
  switch (observation.kind) {
    case "exact":
    case "missing-probe":
      return [
        String(OBSERVATION_RANK[observation.kind]),
        observation.dataClass,
        canonicalJson(observation.selector),
        observation.session,
      ];
    case "range":
      return [
        String(OBSERVATION_RANK[observation.kind]),
        observation.dataClass,
        canonicalJson(observation.selectorPrefix),
        observation.fromSession,
        observation.throughSession,
      ];
    case "control-file":
      return [String(OBSERVATION_RANK[observation.kind]), observation.dataClass, observation.role];
    case "unmanifestable":
      return [
        String(OBSERVATION_RANK[observation.kind]),
        observation.readClass,
        observation.reasonCode,
      ];
  }
}

function compareTuples(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareUnicodeCodePoints(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function normalizeObservations(value: unknown): readonly InputClosureObservationV1[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("input closure observations must be a non-empty array");
  }
  const normalized = value.map((entry, index) => ({
    value: normalizeObservation(entry, `input closure observations[${index}]`),
    raw: rawStableJson(entry),
  }));
  normalized.sort((left, right) =>
    compareTuples(observationTuple(left.value), observationTuple(right.value)),
  );
  const result: InputClosureObservationV1[] = [];
  let previousNormalized: string | undefined;
  let previousRaw: string | undefined;
  for (const entry of normalized) {
    const encoded = canonicalJson(entry.value);
    if (encoded === previousNormalized) {
      if (entry.raw !== previousRaw) {
        fail("input closure observations collide after NFC normalization");
      }
      continue;
    }
    result.push(entry.value);
    previousNormalized = encoded;
    previousRaw = entry.raw;
  }
  return result;
}

function normalizeDescriptor(value: unknown): InputClosureDescriptorV1 {
  const captured = snapshot<unknown>(value, "input closure descriptor");
  const record = plainRecord(captured, "input closure descriptor");
  exactKeys(record, ["kind", "version", "registry", "observations"], "input closure descriptor");
  if (record.kind !== INPUT_CLOSURE_DESCRIPTOR_KIND)
    fail("input closure descriptor kind is invalid");
  if (record.version !== INPUT_CLOSURE_DESCRIPTOR_VERSION) {
    fail("input closure descriptor version is unsupported");
  }
  return {
    kind: INPUT_CLOSURE_DESCRIPTOR_KIND,
    version: INPUT_CLOSURE_DESCRIPTOR_VERSION,
    registry: address(record.registry, "input closure registry"),
    observations: normalizeObservations(record.observations),
  };
}

function sameStringSet(observed: readonly string[], expected: readonly string[]): boolean {
  const left = [...observed].sort(compareUnicodeCodePoints);
  const right = [...expected].sort(compareUnicodeCodePoints);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateObservationAgainstRegistry(
  observation: InputClosureObservationV1,
  registry: InputResolverRegistryV1,
): void {
  if (observation.kind === "unmanifestable") return;
  const resolverClass = registry.classes.find((entry) => entry.dataClass === observation.dataClass);
  if (!resolverClass) {
    fail(`input closure references unknown data class ${JSON.stringify(observation.dataClass)}`);
  }
  if (observation.kind === "control-file") {
    if (resolverClass.kind !== "static" || resolverClass.role !== observation.role) {
      fail("control-file observation disagrees with its registry class");
    }
    return;
  }
  if (resolverClass.kind === "static") {
    fail(`${observation.kind} observation requires a session-scoped registry class`);
  }
  if (observation.kind === "range") {
    const expectedPrefixKeys = resolverClass.selectorKeys.filter(
      (key) => key !== resolverClass.sessionKey,
    );
    const observedKeys = Object.keys(observation.selectorPrefix);
    if (!sameStringSet(observedKeys, expectedPrefixKeys)) {
      fail("range selector prefix disagrees with its registry class");
    }
    return;
  }
  const observedKeys = Object.keys(observation.selector);
  if (!sameStringSet(observedKeys, resolverClass.selectorKeys)) {
    fail(`${observation.kind} selector disagrees with its registry class`);
  }
  if (observation.selector[resolverClass.sessionKey] !== observation.session) {
    fail(`${observation.kind} selector session disagrees with its explicit session`);
  }
}

function validateDescriptorAgainstRegistry(
  descriptor: InputClosureDescriptorV1,
  registry: InputResolverRegistryV1,
): void {
  for (const observation of descriptor.observations) {
    validateObservationAgainstRegistry(observation, registry);
  }
}

export function createInputClosureDescriptor(
  registry: CanonicalJsonAddress,
  observations: readonly InputClosureObservationV1[],
): InputClosureDescriptorV1 {
  return normalizeDescriptor({
    kind: INPUT_CLOSURE_DESCRIPTOR_KIND,
    version: INPUT_CLOSURE_DESCRIPTOR_VERSION,
    registry: address(registry, "input closure registry"),
    observations,
  });
}

export async function publishInputClosure(
  objects: ContentObjectStore,
  input: {
    registry: CanonicalJsonAddress;
    observations: readonly InputClosureObservationV1[];
  },
): Promise<PutContentObjectResult<InputClosureDescriptorV1>> {
  const descriptor = createInputClosureDescriptor(input.registry, input.observations);
  const registry = await verifyInputResolverRegistry(objects, descriptor.registry);
  validateDescriptorAgainstRegistry(descriptor, registry.value);
  return objects.put(descriptor);
}

export async function verifyInputClosure(
  objects: ContentObjectStore,
  closureAddress: CanonicalJsonAddress,
): Promise<PutContentObjectResult<InputClosureDescriptorV1>> {
  address(closureAddress, "input closure address");
  const stored = await objects.get<unknown>(closureAddress);
  const descriptor = normalizeDescriptor(stored);
  if (!canonicalJsonBytes(descriptor).equals(canonicalJsonBytes(stored))) {
    fail("input closure is not normalized and deterministically ordered");
  }
  const registry = await verifyInputResolverRegistry(objects, descriptor.registry);
  validateDescriptorAgainstRegistry(descriptor, registry.value);
  return {
    address: closureAddress,
    value: descriptor,
    path: objects.objectPath(closureAddress),
    bytes: canonicalJsonBytes(stored).byteLength,
    created: false,
  };
}

function stableDependencyObservation(
  observation: InputClosureObservationV1,
):
  | Exclude<InputClosureObservationV1, { kind: "unmanifestable" }>
  | Omit<Extract<InputClosureObservationV1, { kind: "range" }>, "throughSession"> {
  if (observation.kind === "unmanifestable") {
    fail("unmanifestable observations do not have resolvable dependency keys");
  }
  if (observation.kind !== "range") return observation;
  return {
    kind: observation.kind,
    dataClass: observation.dataClass,
    selectorPrefix: observation.selectorPrefix,
    fromSession: observation.fromSession,
  };
}

export function dependencyKeyAddress(
  registry: CanonicalJsonAddress,
  observation: InputClosureObservationV1,
): CanonicalJsonAddress {
  const normalizedRegistry = address(registry, "input dependency registry");
  const normalizedObservation = normalizeObservation(observation, "input dependency observation");
  return addressCanonicalJson({
    kind: INPUT_DEPENDENCY_KEY_KIND,
    version: INPUT_DEPENDENCY_KEY_VERSION,
    registry: normalizedRegistry,
    observation: stableDependencyObservation(normalizedObservation),
  });
}

export function restrictInputClosureDescriptor(
  descriptor: InputClosureDescriptorV1,
  completeThrough: string,
): InputClosureDescriptorV1 {
  const normalized = normalizeDescriptor(descriptor);
  const cutoff = sessionDate(completeThrough, "input closure restriction cutoff");
  const observations: InputClosureObservationV1[] = [];
  for (const observation of normalized.observations) {
    switch (observation.kind) {
      case "exact":
      case "missing-probe":
        if (observation.session <= cutoff) observations.push(observation);
        break;
      case "range":
        if (observation.fromSession <= cutoff) {
          observations.push({
            ...observation,
            throughSession:
              observation.throughSession <= cutoff ? observation.throughSession : cutoff,
          });
        }
        break;
      case "control-file":
      case "unmanifestable":
        observations.push(observation);
        break;
    }
  }
  if (observations.length === 0) {
    fail("input closure restriction removed every observation");
  }
  return createInputClosureDescriptor(normalized.registry, observations);
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function sha256Address(value: unknown, label: string): Sha256Address {
  const normalized = nonemptyString(value, label);
  try {
    parseSha256Address(normalized);
  } catch (error) {
    throw new ManifestVerificationError(`${label} is not a SHA-256 address`, { cause: error });
  }
  return normalized as Sha256Address;
}

function normalizeCoverage(value: unknown, label: string): LogicalCoverage {
  const record = plainRecord(value, label);
  if (record.kind === "empty") {
    exactKeys(record, ["kind"], label);
    return { kind: "empty" };
  }
  if (record.kind === "date-range") {
    exactKeys(record, ["kind", "from", "through"], label);
    const from = sessionDate(record.from, `${label}.from`);
    const through = sessionDate(record.through, `${label}.through`);
    if (from > through) fail(`${label} has an inverted date range`);
    return { kind: "date-range", from, through };
  }
  fail(`${label}.kind is unsupported`);
}

function normalizeQuality(value: unknown, label: string): PartitionQualityCounts {
  const record = plainRecord(value, label);
  exactKeys(record, ["inputRows", "writtenRows", "droppedRows"], label);
  const quality = {
    inputRows: nonnegativeSafeInteger(record.inputRows, `${label}.inputRows`),
    writtenRows: nonnegativeSafeInteger(record.writtenRows, `${label}.writtenRows`),
    droppedRows: nonnegativeSafeInteger(record.droppedRows, `${label}.droppedRows`),
  };
  if (quality.inputRows !== quality.writtenRows + quality.droppedRows) {
    fail(`${label} row counts are inconsistent`);
  }
  return quality;
}

function normalizeFile(value: unknown, label: string): ExactFileFingerprint {
  const record = plainRecord(value, label);
  exactKeys(record, ["address", "bytes", "rows"], label);
  return {
    address: sha256Address(record.address, `${label}.address`),
    bytes: nonnegativeSafeInteger(record.bytes, `${label}.bytes`),
    rows: nonnegativeSafeInteger(record.rows, `${label}.rows`),
  };
}

function normalizeObjectReference(
  value: unknown,
  label: string,
): { address: CanonicalJsonAddress; bytes: number } {
  const record = plainRecord(value, label);
  exactKeys(record, ["address", "bytes"], label);
  return {
    address: address(record.address, `${label}.address`),
    bytes: positiveSafeInteger(record.bytes, `${label}.bytes`),
  };
}

function registryClass(registry: InputResolverRegistryV1, dataClass: string): InputResolverClassV1 {
  const found = registry.classes.find((entry) => entry.dataClass === dataClass);
  if (!found) fail(`semantic input references unknown data class ${JSON.stringify(dataClass)}`);
  return found;
}

function normalizePartitionProjection(
  record: JsonRecord,
  label: string,
  resolverClass: PartitionedResolverClassV1,
): PartitionProjectionV1 {
  exactKeys(
    record,
    [
      "kind",
      "dataset",
      "partition",
      "relativePath",
      "session",
      "schemaRevision",
      "coverage",
      "quality",
      "file",
    ],
    label,
  );
  const dataset = identifier(record.dataset, `${label}.dataset`);
  const partition = stringMap(record.partition, `${label}.partition`);
  const relative = relativePath(record.relativePath, `${label}.relativePath`);
  const session = sessionDate(record.session, `${label}.session`);
  const schemaRevision = positiveSafeInteger(record.schemaRevision, `${label}.schemaRevision`);
  const coverage = normalizeCoverage(record.coverage, `${label}.coverage`);
  const quality = normalizeQuality(record.quality, `${label}.quality`);
  const file = normalizeFile(record.file, `${label}.file`);
  if (dataset !== resolverClass.dataset) fail(`${label}.dataset disagrees with the registry`);
  if (!sameStringSet(Object.keys(partition), resolverClass.selectorKeys)) {
    fail(`${label}.partition disagrees with the registry selector keys`);
  }
  if (partition[resolverClass.sessionKey] !== session) {
    fail(`${label}.partition session disagrees with its explicit session`);
  }
  const expectedPath = canonicalPartitionRelativePath({ dataset, partition });
  if (relative !== expectedPath) fail(`${label}.relativePath disagrees with the registry`);
  if (!resolverClass.supportedSchemaRevisions.includes(schemaRevision)) {
    fail(`${label}.schemaRevision is unsupported`);
  }
  if (quality.writtenRows !== file.rows) fail(`${label}.quality disagrees with file rows`);
  if (coverage.kind === "empty" && file.rows !== 0) {
    fail(`${label}.coverage is empty for a non-empty file`);
  }
  if (coverage.kind === "date-range" && file.rows === 0) {
    fail(`${label}.coverage is non-empty for an empty file`);
  }
  return {
    kind: "partition-projection",
    dataset,
    partition,
    relativePath: relative,
    session,
    schemaRevision,
    coverage,
    quality,
    file,
  };
}

function normalizeMaterializedSlice(
  record: JsonRecord,
  label: string,
  resolverClass: MaterializedResolverClassV1,
): MaterializedSliceV1 {
  exactKeys(record, ["kind", "selector", "session", "schemaRevision", "object"], label);
  const selector = stringMap(record.selector, `${label}.selector`);
  const session = sessionDate(record.session, `${label}.session`);
  const schemaRevision = positiveSafeInteger(record.schemaRevision, `${label}.schemaRevision`);
  if (!sameStringSet(Object.keys(selector), resolverClass.selectorKeys)) {
    fail(`${label}.selector disagrees with the registry selector keys`);
  }
  if (selector[resolverClass.sessionKey] !== session) {
    fail(`${label}.selector session disagrees with its explicit session`);
  }
  if (!resolverClass.supportedSchemaRevisions.includes(schemaRevision)) {
    fail(`${label}.schemaRevision is unsupported`);
  }
  return {
    kind: "materialized-slice",
    selector,
    session,
    schemaRevision,
    object: normalizeObjectReference(record.object, `${label}.object`),
  };
}

function normalizeSemanticSource(
  value: unknown,
  label: string,
  resolverClass: InputResolverClassV1,
): SemanticInputSourceV1 {
  const record = plainRecord(snapshot(value, label), label);
  switch (record.kind) {
    case "partition-projection":
      if (resolverClass.kind !== "partitioned") {
        fail(`${label} requires a partitioned registry class`);
      }
      return normalizePartitionProjection(record, label, resolverClass);
    case "control-file": {
      if (resolverClass.kind !== "static") fail(`${label} requires a static registry class`);
      exactKeys(record, ["kind", "role", "relativePath", "schemaRevision", "object"], label);
      const role = identifier(record.role, `${label}.role`);
      const relative = relativePath(record.relativePath, `${label}.relativePath`);
      const schemaRevision = positiveSafeInteger(record.schemaRevision, `${label}.schemaRevision`);
      if (role !== resolverClass.role || relative !== resolverClass.relativePath) {
        fail(`${label} disagrees with the static registry class`);
      }
      if (!resolverClass.supportedSchemaRevisions.includes(schemaRevision)) {
        fail(`${label}.schemaRevision is unsupported`);
      }
      return {
        kind: "control-file",
        role,
        relativePath: relative,
        schemaRevision,
        object: normalizeObjectReference(record.object, `${label}.object`),
      };
    }
    case "missing-probe": {
      if (resolverClass.kind !== "partitioned") {
        fail(`${label} requires a partitioned registry class`);
      }
      exactKeys(record, ["kind", "session"], label);
      return {
        kind: "missing-probe",
        session: sessionDate(record.session, `${label}.session`),
      };
    }
    case "materialized-slice":
      if (resolverClass.kind !== "materialized") {
        fail(`${label} requires a materialized registry class`);
      }
      return normalizeMaterializedSlice(record, label, resolverClass);
    default:
      fail(`${label}.kind is unsupported`);
  }
}

function expectedScope(
  observation: Exclude<InputClosureObservationV1, { kind: "unmanifestable" }>,
  source: SemanticInputSourceV1,
): SemanticInputLeafV1["scope"] {
  if (observation.kind === "control-file") return { kind: "static" };
  if (source.kind === "control-file") {
    fail(`${observation.kind} observation cannot use ${source.kind} source evidence`);
  }
  return { kind: "session", session: source.session };
}

function validateSourceAgainstObservation(
  source: SemanticInputSourceV1,
  observation: Exclude<InputClosureObservationV1, { kind: "unmanifestable" }>,
  resolverClass: InputResolverClassV1,
  options: { allowRangeFuture?: boolean } = {},
): "included" | "future" {
  if (observation.kind === "control-file") {
    if (source.kind !== "control-file" || resolverClass.kind !== "static") {
      fail("control-file observation has incompatible semantic source evidence");
    }
    if (source.role !== observation.role) fail("control-file source role is incorrect");
    return "included";
  }
  if (observation.kind === "missing-probe") {
    if (source.kind !== "missing-probe") {
      fail("missing-probe observation has incompatible semantic source evidence");
    }
    if (source.session !== observation.session) fail("missing-probe source session is incorrect");
    return "included";
  }
  if (
    (source.kind !== "partition-projection" || resolverClass.kind !== "partitioned") &&
    (source.kind !== "materialized-slice" || resolverClass.kind !== "materialized")
  ) {
    fail(`${observation.kind} observation requires compatible session evidence`);
  }
  const selector = source.kind === "partition-projection" ? source.partition : source.selector;
  if (observation.kind === "exact") {
    if (
      source.session !== observation.session ||
      canonicalJson(selector) !== canonicalJson(observation.selector)
    ) {
      fail("exact source partition is incorrect");
    }
    return "included";
  }
  for (const [key, value] of Object.entries(observation.selectorPrefix)) {
    if (selector[key] !== value) fail("range source partition prefix is incorrect");
  }
  if (source.session < observation.fromSession) fail("range source precedes the requested range");
  if (source.session > observation.throughSession) {
    if (options.allowRangeFuture) return "future";
    fail("range source exceeds the requested range");
  }
  return "included";
}

function normalizeSemanticLeaf(value: unknown): SemanticInputLeafV1 {
  const captured = snapshot<unknown>(value, "semantic input leaf");
  const record = plainRecord(captured, "semantic input leaf");
  exactKeys(
    record,
    ["kind", "version", "registry", "dependency", "dataClass", "scope", "source"],
    "semantic input leaf",
  );
  if (record.kind !== SEMANTIC_INPUT_LEAF_KIND) fail("semantic input leaf kind is invalid");
  if (record.version !== SEMANTIC_INPUT_LEAF_VERSION) {
    fail("semantic input leaf version is unsupported");
  }
  const registryAddress = address(record.registry, "semantic input leaf registry");
  const dependency = address(record.dependency, "semantic input leaf dependency");
  const dataClass = identifier(record.dataClass, "semantic input leaf dataClass");
  const scopeRecord = plainRecord(record.scope, "semantic input leaf scope");
  let scope: SemanticInputLeafV1["scope"];
  if (scopeRecord.kind === "static") {
    exactKeys(scopeRecord, ["kind"], "semantic input leaf scope");
    scope = { kind: "static" };
  } else if (scopeRecord.kind === "session") {
    exactKeys(scopeRecord, ["kind", "session"], "semantic input leaf scope");
    scope = {
      kind: "session",
      session: sessionDate(scopeRecord.session, "semantic input leaf scope.session"),
    };
  } else {
    fail("semantic input leaf scope kind is unsupported");
  }
  return {
    kind: SEMANTIC_INPUT_LEAF_KIND,
    version: SEMANTIC_INPUT_LEAF_VERSION,
    registry: registryAddress,
    dependency,
    dataClass,
    scope,
    source: record.source as SemanticInputSourceV1,
  };
}

async function normalizeSemanticLeafWithRegistry(
  objects: ContentObjectStore,
  value: unknown,
): Promise<SemanticInputLeafV1> {
  const leaf = normalizeSemanticLeaf(value);
  const registry = await verifyInputResolverRegistry(objects, leaf.registry);
  const resolverClass = registryClass(registry.value, leaf.dataClass);
  const source = normalizeSemanticSource(leaf.source, "semantic input leaf source", resolverClass);
  if (source.kind === "control-file") {
    if (leaf.scope.kind !== "static") fail("control-file leaf must have static scope");
  } else {
    if (leaf.scope.kind !== "session" || leaf.scope.session !== source.session) {
      fail("semantic input leaf scope disagrees with its source");
    }
  }
  return { ...leaf, source };
}

export async function publishSemanticInputLeaf(
  objects: ContentObjectStore,
  input: {
    registry: CanonicalJsonAddress;
    observation: InputClosureObservationV1;
    source: SemanticInputSourceV1;
  },
): Promise<PutContentObjectResult<SemanticInputLeafV1>> {
  const registryAddress = address(input.registry, "semantic input registry");
  const observation = normalizeObservation(input.observation, "semantic input observation");
  const capturedSource = snapshot<SemanticInputSourceV1>(input.source, "semantic input source");
  if (observation.kind === "unmanifestable") {
    fail("unmanifestable observations cannot publish semantic leaves");
  }
  const registry = await verifyInputResolverRegistry(objects, registryAddress);
  validateObservationAgainstRegistry(observation, registry.value);
  const resolverClass = registryClass(registry.value, observation.dataClass);
  const source = normalizeSemanticSource(capturedSource, "semantic input source", resolverClass);
  validateSourceAgainstObservation(source, observation, resolverClass);
  if (source.kind === "control-file") {
    const stored = await objects.get<unknown>(source.object.address);
    if (canonicalJsonBytes(stored).byteLength !== source.object.bytes) {
      fail("control-file object byte length is incorrect");
    }
  }
  return objects.put({
    kind: SEMANTIC_INPUT_LEAF_KIND,
    version: SEMANTIC_INPUT_LEAF_VERSION,
    registry: registryAddress,
    dependency: dependencyKeyAddress(registryAddress, observation),
    dataClass: observation.dataClass,
    scope: expectedScope(observation, source),
    source,
  });
}

export async function verifySemanticInputLeaf(
  objects: ContentObjectStore,
  leafAddress: CanonicalJsonAddress,
): Promise<PutContentObjectResult<SemanticInputLeafV1>> {
  address(leafAddress, "semantic input leaf address");
  const stored = await objects.get<unknown>(leafAddress);
  const leaf = await normalizeSemanticLeafWithRegistry(objects, stored);
  if (!canonicalJsonBytes(leaf).equals(canonicalJsonBytes(stored))) {
    fail("semantic input leaf is not normalized");
  }
  return {
    address: leafAddress,
    value: leaf,
    path: objects.objectPath(leafAddress),
    bytes: canonicalJsonBytes(stored).byteLength,
    created: false,
  };
}

export async function publishMissingProbeEvidence(
  objects: ContentObjectStore,
  input: {
    registry: CanonicalJsonAddress;
    observation: Extract<InputClosureObservationV1, { kind: "missing-probe" }>;
    completeThrough: string;
  },
): Promise<PutContentObjectResult<MissingProbeEvidenceV1>> {
  const registryAddress = address(input.registry, "missing-probe evidence registry");
  const observation = normalizeObservation(input.observation, "missing-probe evidence observation");
  if (observation.kind !== "missing-probe") fail("missing-probe evidence requires a probe");
  const completeThrough = sessionDate(
    input.completeThrough,
    "missing-probe evidence completeThrough",
  );
  const registry = await verifyInputResolverRegistry(objects, registryAddress);
  validateObservationAgainstRegistry(observation, registry.value);
  if (completeThrough < observation.session) {
    fail("missing-probe evidence complete horizon precedes the probe");
  }
  return objects.put({
    kind: MISSING_PROBE_EVIDENCE_KIND,
    version: MISSING_PROBE_EVIDENCE_VERSION,
    registry: registryAddress,
    dependency: dependencyKeyAddress(registryAddress, observation),
    completeThrough,
  });
}

function normalizeMissingProbeEvidence(value: unknown): MissingProbeEvidenceV1 {
  const captured = snapshot<unknown>(value, "missing-probe evidence");
  const record = plainRecord(captured, "missing-probe evidence");
  exactKeys(
    record,
    ["kind", "version", "registry", "dependency", "completeThrough"],
    "missing-probe evidence",
  );
  if (record.kind !== MISSING_PROBE_EVIDENCE_KIND) {
    fail("missing-probe evidence kind is invalid");
  }
  if (record.version !== MISSING_PROBE_EVIDENCE_VERSION) {
    fail("missing-probe evidence version is unsupported");
  }
  return {
    kind: MISSING_PROBE_EVIDENCE_KIND,
    version: MISSING_PROBE_EVIDENCE_VERSION,
    registry: address(record.registry, "missing-probe evidence registry"),
    dependency: address(record.dependency, "missing-probe evidence dependency"),
    completeThrough: sessionDate(record.completeThrough, "missing-probe evidence completeThrough"),
  };
}

async function verifyMissingProbeEvidence(
  objects: ContentObjectStore,
  evidenceAddress: CanonicalJsonAddress,
): Promise<MissingProbeEvidenceV1> {
  address(evidenceAddress, "missing-probe evidence address");
  const stored = await objects.get<unknown>(evidenceAddress);
  const evidence = normalizeMissingProbeEvidence(stored);
  if (!canonicalJsonBytes(evidence).equals(canonicalJsonBytes(stored))) {
    fail("missing-probe evidence is not normalized");
  }
  await verifyInputResolverRegistry(objects, evidence.registry);
  return evidence;
}

function normalizeLeafEvidence(value: unknown, label: string): ManifestLeafEvidenceV1 {
  const record = plainRecord(value, label);
  switch (record.kind) {
    case "partition-receipt":
      exactKeys(record, ["kind", "receipt"], label);
      return {
        kind: "partition-receipt",
        receipt: address(record.receipt, `${label}.receipt`),
      };
    case "content-object":
      exactKeys(record, ["kind", "object"], label);
      return {
        kind: "content-object",
        object: address(record.object, `${label}.object`),
      };
    case "absence-object":
      exactKeys(record, ["kind", "object"], label);
      return {
        kind: "absence-object",
        object: address(record.object, `${label}.object`),
      };
    default:
      fail(`${label}.kind is unsupported`);
  }
}

function normalizeLeafReferences(
  value: unknown,
  label: string,
): readonly ManifestLeafReferenceV1[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const references = value.map((entry, index) => {
    const record = plainRecord(entry, `${label}[${index}]`);
    exactKeys(record, ["leaf", "evidence"], `${label}[${index}]`);
    return {
      leaf: address(record.leaf, `${label}[${index}].leaf`),
      evidence: normalizeLeafEvidence(record.evidence, `${label}[${index}].evidence`),
    };
  });
  references.sort((left, right) => {
    const byLeaf = compareUnicodeCodePoints(left.leaf, right.leaf);
    return byLeaf === 0
      ? compareUnicodeCodePoints(canonicalJson(left.evidence), canonicalJson(right.evidence))
      : byLeaf;
  });
  for (let index = 1; index < references.length; index += 1) {
    if (references[index - 1].leaf === references[index].leaf) {
      fail(`${label} contains a duplicate semantic leaf`);
    }
  }
  return references;
}

interface MerkleNode {
  address: Sha256Address;
  count: number;
}

function merkleTreeRoot(leaves: readonly CanonicalJsonAddress[]): Sha256Address {
  if (leaves.length === 0) {
    return addressCanonicalJson({
      kind: "tradeblocks.market-data.merkle-empty",
      version: 1,
      count: 0,
    });
  }
  let level: MerkleNode[] = leaves.map((leaf) => ({
    address: addressCanonicalJson({
      kind: "tradeblocks.market-data.merkle-leaf",
      version: 1,
      count: 1,
      leaf,
    }),
    count: 1,
  }));
  while (level.length > 1) {
    const next: MerkleNode[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!right) {
        next.push({
          address: addressCanonicalJson({
            kind: "tradeblocks.market-data.merkle-unary",
            version: 1,
            count: left.count,
            child: left.address,
          }),
          count: left.count,
        });
      } else {
        const count = left.count + right.count;
        next.push({
          address: addressCanonicalJson({
            kind: "tradeblocks.market-data.merkle-binary",
            version: 1,
            count,
            left: left.address,
            right: right.address,
          }),
          count,
        });
      }
    }
    level = next;
  }
  return level[0].address;
}

function createManifestClass(
  dataClass: string,
  completeThrough: string,
  entries: readonly ManifestLeafReferenceV1[],
): ManifestClassV1 {
  const normalizedEntries = normalizeLeafReferences(entries, `${dataClass} manifest entries`);
  const leafCount = normalizedEntries.length;
  const treeRoot = merkleTreeRoot(normalizedEntries.map((entry) => entry.leaf));
  return {
    dataClass,
    completeThrough,
    entries: normalizedEntries,
    leafCount,
    root: addressCanonicalJson({
      kind: "tradeblocks.market-data.merkle-class",
      version: 1,
      dataClass,
      completeThrough,
      leafCount,
      treeRoot,
    }),
  };
}

function normalizePredecessor(
  value: unknown,
  label: string,
): { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address } {
  const record = plainRecord(value, label);
  exactKeys(record, ["manifest", "aggregateRoot"], label);
  return {
    manifest: address(record.manifest, `${label}.manifest`),
    aggregateRoot: sha256Address(record.aggregateRoot, `${label}.aggregateRoot`),
  };
}

function createCutoffManifestValue(
  closure: CanonicalJsonAddress,
  completeThrough: string,
  classes: readonly ManifestClassV1[],
  refreshCompletion?: CanonicalJsonAddress,
  predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address },
): CutoffManifestV1 {
  const sortedClasses = [...classes].sort((left, right) =>
    compareUnicodeCodePoints(left.dataClass, right.dataClass),
  );
  if (sortedClasses.length === 0) fail("cutoff manifest must contain at least one data class");
  const aggregateRoot = addressCanonicalJson({
    kind: "tradeblocks.market-data.merkle-aggregate",
    version: 1,
    closure,
    completeThrough,
    ...(refreshCompletion ? { refreshCompletion } : {}),
    classes: sortedClasses.map(({ dataClass, leafCount, root }) => ({
      dataClass,
      leafCount,
      root,
    })),
  });
  return {
    kind: CUTOFF_MANIFEST_KIND,
    version: CUTOFF_MANIFEST_VERSION,
    closure,
    completeThrough,
    classes: sortedClasses,
    aggregateRoot,
    ...(refreshCompletion ? { refreshCompletion } : {}),
    ...(predecessor ? { predecessor } : {}),
  };
}

function normalizeManifestClass(value: unknown, label: string): ManifestClassV1 {
  const record = plainRecord(value, label);
  exactKeys(record, ["dataClass", "completeThrough", "entries", "leafCount", "root"], label);
  const entries = normalizeLeafReferences(record.entries, `${label}.entries`);
  const leafCount = positiveSafeInteger(record.leafCount, `${label}.leafCount`);
  if (leafCount !== entries.length) fail(`${label}.leafCount disagrees with its entries`);
  return {
    dataClass: identifier(record.dataClass, `${label}.dataClass`),
    completeThrough: sessionDate(record.completeThrough, `${label}.completeThrough`),
    entries,
    leafCount,
    root: sha256Address(record.root, `${label}.root`),
  };
}

function normalizeCutoffManifest(value: unknown): CutoffManifestV1 {
  const captured = snapshot<unknown>(value, "cutoff manifest");
  const record = plainRecord(captured, "cutoff manifest");
  const expected = [
    "kind",
    "version",
    "closure",
    "completeThrough",
    "classes",
    "aggregateRoot",
    ...(Object.hasOwn(record, "refreshCompletion") ? ["refreshCompletion"] : []),
    ...(Object.hasOwn(record, "predecessor") ? ["predecessor"] : []),
  ];
  exactKeys(record, expected, "cutoff manifest");
  if (record.kind !== CUTOFF_MANIFEST_KIND) fail("cutoff manifest kind is invalid");
  if (record.version !== CUTOFF_MANIFEST_VERSION) fail("cutoff manifest version is unsupported");
  if (!Array.isArray(record.classes) || record.classes.length === 0) {
    fail("cutoff manifest classes must be a non-empty array");
  }
  const classes = record.classes.map((entry, index) =>
    normalizeManifestClass(entry, `cutoff manifest classes[${index}]`),
  );
  classes.sort((left, right) => compareUnicodeCodePoints(left.dataClass, right.dataClass));
  for (let index = 1; index < classes.length; index += 1) {
    if (classes[index - 1].dataClass === classes[index].dataClass) {
      fail("cutoff manifest contains a duplicate data class");
    }
  }
  return {
    kind: CUTOFF_MANIFEST_KIND,
    version: CUTOFF_MANIFEST_VERSION,
    closure: address(record.closure, "cutoff manifest closure"),
    completeThrough: sessionDate(record.completeThrough, "cutoff manifest completeThrough"),
    classes,
    aggregateRoot: sha256Address(record.aggregateRoot, "cutoff manifest aggregateRoot"),
    ...(record.refreshCompletion === undefined
      ? {}
      : {
          refreshCompletion: address(record.refreshCompletion, "cutoff manifest refreshCompletion"),
        }),
    ...(record.predecessor === undefined
      ? {}
      : { predecessor: normalizePredecessor(record.predecessor, "cutoff manifest predecessor") }),
  };
}

async function verifyLeafEvidence(
  partitions: FilePartitionCommitStore,
  leaf: SemanticInputLeafV1,
  reference: ManifestLeafReferenceV1,
  observation: Exclude<InputClosureObservationV1, { kind: "unmanifestable" }>,
  resolverClass: InputResolverClassV1,
  completeThrough: string,
): Promise<void> {
  switch (reference.evidence.kind) {
    case "partition-receipt": {
      if (leaf.source.kind !== "partition-projection" || resolverClass.kind !== "partitioned") {
        fail("partition receipt evidence requires a partition projection leaf");
      }
      const commit = await partitions.readCommit(reference.evidence.receipt);
      const receipt = commit.receipt;
      const projected: PartitionProjectionV1 = {
        kind: "partition-projection",
        dataset: receipt.dataset,
        partition: receipt.partition,
        relativePath: receipt.relativePath,
        session: receipt.partition[resolverClass.sessionKey],
        schemaRevision: receipt.schemaRevision,
        coverage: receipt.coverage,
        quality: receipt.quality,
        file: receipt.file,
      };
      if (canonicalJson(projected) !== canonicalJson(leaf.source)) {
        fail("partition receipt does not reproduce the semantic leaf");
      }
      const inspected = await partitions.inspectPartition({
        dataset: receipt.dataset,
        partition: receipt.partition,
      });
      if (
        inspected.status !== "match" ||
        inspected.receipt.address !== reference.evidence.receipt
      ) {
        fail("partition receipt is not the current exact-byte authority tip");
      }
      return;
    }
    case "content-object": {
      if (leaf.source.kind !== "control-file" && leaf.source.kind !== "materialized-slice") {
        fail("content-object evidence requires an object-backed semantic leaf");
      }
      if (leaf.source.object.address !== reference.evidence.object) {
        fail("content-object evidence address disagrees with the semantic leaf");
      }
      const stored = await partitions.objects.get<unknown>(reference.evidence.object);
      if (canonicalJsonBytes(stored).byteLength !== leaf.source.object.bytes) {
        fail("content-object evidence byte length disagrees with the semantic leaf");
      }
      return;
    }
    case "absence-object": {
      if (
        leaf.source.kind !== "missing-probe" ||
        observation.kind !== "missing-probe" ||
        resolverClass.kind !== "partitioned"
      ) {
        fail("absence-object evidence requires a missing-probe leaf");
      }
      const evidence = await verifyMissingProbeEvidence(
        partitions.objects,
        reference.evidence.object,
      );
      if (
        evidence.registry !== leaf.registry ||
        evidence.dependency !== leaf.dependency ||
        evidence.completeThrough < completeThrough
      ) {
        fail("missing-probe evidence does not cover the requested dependency horizon");
      }
      const inspected = await partitions.inspectPartition({
        dataset: resolverClass.dataset,
        partition: observation.selector,
      });
      if (inspected.status !== "absent") {
        fail("missing-probe evidence is stale because the partition is no longer absent");
      }
      return;
    }
  }
}

async function resolveManifestClasses(
  partitions: FilePartitionCommitStore,
  descriptor: InputClosureDescriptorV1,
  completeThrough: string,
  resolver: ManifestInputResolver,
): Promise<readonly ManifestClassV1[]> {
  const cutoffClosure = restrictInputClosureDescriptor(descriptor, completeThrough);
  const registry = await verifyInputResolverRegistry(partitions.objects, cutoffClosure.registry);
  const entriesByClass = new Map<string, ManifestLeafReferenceV1[]>();
  const dependencies = new Set<string>();
  for (const observation of cutoffClosure.observations) {
    if (observation.kind === "unmanifestable") {
      fail(
        `input closure contains unmanifestable read ${JSON.stringify(observation.readClass)} (${observation.reasonCode})`,
      );
    }
    const dependency = dependencyKeyAddress(cutoffClosure.registry, observation);
    if (dependencies.has(dependency)) {
      fail("input closure contains more than one observation for the same stable dependency");
    }
    dependencies.add(dependency);
    const resolution = await resolver.resolve({
      registry: registry.value,
      closure: cutoffClosure,
      observation,
      dependency,
      completeThrough,
    });
    if (resolution.kind !== "resolved") {
      fail(`input dependency is ${resolution.kind}: ${resolution.reasonCode}`);
    }
    const resolvedThrough = sessionDate(
      resolution.completeThrough,
      `resolved ${observation.dataClass} completeThrough`,
    );
    if (resolvedThrough < completeThrough) {
      fail(`resolved ${observation.dataClass} input does not reach the complete horizon`);
    }
    const resolverClass = registryClass(registry.value, observation.dataClass);
    const candidates = normalizeLeafReferences(
      resolution.entries,
      `resolved ${observation.dataClass} entries`,
    );
    const included: ManifestLeafReferenceV1[] = [];
    for (const reference of candidates) {
      const leaf = await verifySemanticInputLeaf(partitions.objects, reference.leaf);
      if (
        leaf.value.registry !== cutoffClosure.registry ||
        leaf.value.dependency !== dependency ||
        leaf.value.dataClass !== observation.dataClass
      ) {
        fail("resolved semantic leaf disagrees with its closure dependency");
      }
      const posture = validateSourceAgainstObservation(
        leaf.value.source,
        observation,
        resolverClass,
        { allowRangeFuture: observation.kind === "range" },
      );
      if (posture === "future") continue;
      await verifyLeafEvidence(
        partitions,
        leaf.value,
        reference,
        observation,
        resolverClass,
        completeThrough,
      );
      included.push(reference);
    }
    if (included.length === 0) {
      fail(`resolved ${observation.dataClass} dependency has no applicable semantic leaves`);
    }
    if (observation.kind !== "range" && included.length !== 1) {
      fail(`${observation.kind} dependency must resolve to exactly one semantic leaf`);
    }
    const classEntries = entriesByClass.get(observation.dataClass) ?? [];
    classEntries.push(...included);
    entriesByClass.set(observation.dataClass, classEntries);
  }
  return [...entriesByClass.entries()]
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([dataClass, entries]) => createManifestClass(dataClass, completeThrough, entries));
}

export async function publishCutoffManifest(
  partitions: FilePartitionCommitStore,
  input: {
    closure: CanonicalJsonAddress;
    completeThrough: string;
    resolver: ManifestInputResolver;
    refreshCompletion?: CanonicalJsonAddress;
    predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address };
  },
): Promise<PutContentObjectResult<CutoffManifestV1>> {
  // Capture every caller-owned semantic field before the first await. Mutable
  // input objects must not let verification and publication use two closures.
  const closureAddress = address(input.closure, "cutoff manifest closure");
  const completeThrough = sessionDate(input.completeThrough, "cutoff manifest completeThrough");
  const resolver = input.resolver;
  const refreshCompletion = input.refreshCompletion
    ? address(input.refreshCompletion, "cutoff manifest refreshCompletion")
    : undefined;
  const predecessor = input.predecessor
    ? normalizePredecessor(input.predecessor, "cutoff manifest predecessor")
    : undefined;
  const closure = await verifyInputClosure(partitions.objects, closureAddress);
  const classes = await resolveManifestClasses(
    partitions,
    closure.value,
    completeThrough,
    resolver,
  );
  if (refreshCompletion) await partitions.objects.get<unknown>(refreshCompletion);
  const value = createCutoffManifestValue(
    closureAddress,
    completeThrough,
    classes,
    refreshCompletion,
    predecessor,
  );
  const published = await partitions.objects.put(value);
  // Evidence checks span multiple independently locked resources. Re-resolve
  // after immutable publication so a repair or control change during the first
  // pass makes this object an unadvertised orphan instead of a successful mint.
  const finalClasses = await resolveManifestClasses(
    partitions,
    closure.value,
    completeThrough,
    resolver,
  );
  const finalValue = createCutoffManifestValue(
    closureAddress,
    completeThrough,
    finalClasses,
    refreshCompletion,
    predecessor,
  );
  if (!canonicalJsonBytes(finalValue).equals(canonicalJsonBytes(value))) {
    fail("market inputs changed during cutoff manifest publication");
  }
  return published;
}

export async function verifyCutoffManifest(
  partitions: FilePartitionCommitStore,
  manifestAddress: CanonicalJsonAddress,
  resolver: ManifestInputResolver,
): Promise<{ address: CanonicalJsonAddress; manifest: CutoffManifestV1 }> {
  address(manifestAddress, "cutoff manifest address");
  const stored = await partitions.objects.get<unknown>(manifestAddress);
  const manifest = normalizeCutoffManifest(stored);
  if (!canonicalJsonBytes(manifest).equals(canonicalJsonBytes(stored))) {
    fail("cutoff manifest is not normalized and deterministically ordered");
  }
  if (manifest.refreshCompletion) {
    await partitions.objects.get<unknown>(manifest.refreshCompletion);
  }
  const closure = await verifyInputClosure(partitions.objects, manifest.closure);
  const classes = await resolveManifestClasses(
    partitions,
    closure.value,
    manifest.completeThrough,
    resolver,
  );
  const expected = createCutoffManifestValue(
    manifest.closure,
    manifest.completeThrough,
    classes,
    manifest.refreshCompletion,
    manifest.predecessor,
  );
  if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(manifest))) {
    fail("cutoff manifest does not match the resolver-owned complete input set");
  }
  return { address: manifestAddress, manifest };
}

export async function proveCutoffManifestPrefix(
  partitions: FilePartitionCommitStore,
  ancestorAddress: CanonicalJsonAddress,
  descendantAddress: CanonicalJsonAddress,
  resolver: ManifestInputResolver,
): Promise<{ valid: boolean; reason?: string }> {
  const ancestor = await verifyCutoffManifest(partitions, ancestorAddress, resolver);
  const descendant = await verifyCutoffManifest(partitions, descendantAddress, resolver);
  // Prefix is reflexive for one immutable, content-addressed manifest. This is
  // the producer proof used by already-current resume operations: both reads
  // above still re-verify the exact object before equality is accepted.
  if (ancestorAddress === descendantAddress) {
    return { valid: true };
  }
  if (ancestor.manifest.completeThrough >= descendant.manifest.completeThrough) {
    return { valid: false, reason: "cutoff-not-increasing" };
  }
  const ancestorClosure = await verifyInputClosure(partitions.objects, ancestor.manifest.closure);
  const descendantClosure = await verifyInputClosure(
    partitions.objects,
    descendant.manifest.closure,
  );
  if (ancestorClosure.value.registry !== descendantClosure.value.registry) {
    return { valid: false, reason: "registry-mismatch" };
  }
  const restricted = restrictInputClosureDescriptor(
    descendantClosure.value,
    ancestor.manifest.completeThrough,
  );
  if (canonicalJson(restricted) !== canonicalJson(ancestorClosure.value)) {
    return { valid: false, reason: "closure-restriction-mismatch" };
  }
  if (
    descendant.manifest.predecessor &&
    (descendant.manifest.predecessor.manifest !== ancestorAddress ||
      descendant.manifest.predecessor.aggregateRoot !== ancestor.manifest.aggregateRoot)
  ) {
    return { valid: false, reason: "predecessor-hint-mismatch" };
  }
  const ancestorByClass = new Map(
    ancestor.manifest.classes.map((entry) => [entry.dataClass, entry]),
  );
  const descendantByClass = new Map(
    descendant.manifest.classes.map((entry) => [entry.dataClass, entry]),
  );
  if (!sameStringSet([...ancestorByClass.keys()], [...descendantByClass.keys()])) {
    return { valid: false, reason: "class-set-mismatch" };
  }
  const registry = await verifyInputResolverRegistry(
    partitions.objects,
    ancestorClosure.value.registry,
  );
  for (const [dataClass, ancestorClass] of ancestorByClass) {
    const descendantClass = descendantByClass.get(dataClass) as ManifestClassV1;
    const resolverClass = registryClass(registry.value, dataClass);
    let retained: readonly ManifestLeafReferenceV1[];
    if (resolverClass.kind === "static" && resolver.projectStaticPrefix) {
      retained = await resolver.projectStaticPrefix({
        registry: registry.value,
        registryAddress: ancestorClosure.value.registry,
        dataClass,
        ancestorCompleteThrough: ancestor.manifest.completeThrough,
        descendantCompleteThrough: descendant.manifest.completeThrough,
        descendantEntries: descendantClass.entries,
      });
    } else {
      const historical: ManifestLeafReferenceV1[] = [];
      for (const reference of descendantClass.entries) {
        const leaf = await verifySemanticInputLeaf(partitions.objects, reference.leaf);
        if (
          leaf.value.scope.kind === "static" ||
          leaf.value.scope.session <= ancestor.manifest.completeThrough
        ) {
          historical.push(reference);
        }
      }
      retained = historical;
    }
    const normalizedRetained = normalizeLeafReferences(retained, `prefix ${dataClass} entries`);
    for (const reference of normalizedRetained) {
      const leaf = await verifySemanticInputLeaf(partitions.objects, reference.leaf);
      if (
        leaf.value.registry !== ancestorClosure.value.registry ||
        leaf.value.dataClass !== dataClass
      ) {
        fail("prefix projection returned a leaf outside the manifest class");
      }
      if (resolverClass.kind === "static" && leaf.value.scope.kind !== "static") {
        fail("static prefix projection returned a session-scoped leaf");
      }
    }
    if (
      canonicalJson(normalizedRetained.map((entry) => entry.leaf)) !==
      canonicalJson(ancestorClass.entries.map((entry) => entry.leaf))
    ) {
      return { valid: false, reason: "historical-leaf-mismatch" };
    }
    const reproduced = createManifestClass(
      dataClass,
      ancestor.manifest.completeThrough,
      normalizedRetained,
    );
    if (reproduced.root !== ancestorClass.root) {
      return { valid: false, reason: "historical-root-mismatch" };
    }
  }
  // Prefix authorization must end on a fresh currentness pass; otherwise a
  // repair racing the proof walk could be accepted after its evidence changed.
  await verifyCutoffManifest(partitions, ancestorAddress, resolver);
  await verifyCutoffManifest(partitions, descendantAddress, resolver);
  return { valid: true };
}
