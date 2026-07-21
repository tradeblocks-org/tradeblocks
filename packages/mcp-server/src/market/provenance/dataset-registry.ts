import * as path from "node:path";

export interface DatasetPartitionIdentity {
  dataset: string;
  partition: Record<string, string>;
}

export type DatasetProvenancePosture =
  | { kind: "bounded-session"; sessionKey: string }
  | { kind: "unbounded-unsupported" };

export interface MarketDatasetDefinition {
  subdir: string;
  partitionKeys: readonly string[];
  filename: string;
  schemaRevision: number;
  provenance: DatasetProvenancePosture;
}

export interface BoundedMarketDatasetDefinition extends MarketDatasetDefinition {
  provenance: { kind: "bounded-session"; sessionKey: string };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One canonical registry for every market dataset writer and provenance path.
 * Unbounded legacy files remain writable outside attempts but cannot mint
 * partition receipts or cutoff manifests until bounded slices replace them.
 */
function deepFreezeDatasetRegistry<T extends Record<string, MarketDatasetDefinition>>(
  registry: T,
): T {
  for (const definition of Object.values(registry)) {
    Object.freeze(definition.partitionKeys);
    Object.freeze(definition.provenance);
    Object.freeze(definition);
  }
  return Object.freeze(registry);
}

export const MARKET_DATASETS = deepFreezeDatasetRegistry({
  spot: {
    subdir: "spot",
    partitionKeys: ["ticker", "date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
  enriched: {
    subdir: "enriched",
    partitionKeys: ["ticker", "date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
  enriched_context: {
    subdir: "enriched/context",
    partitionKeys: ["date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
  option_chain: {
    subdir: "option_chain",
    partitionKeys: ["underlying", "date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
  option_quote_minutes: {
    subdir: "option_quote_minutes",
    partitionKeys: ["underlying", "date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
  option_oi_daily: {
    subdir: "option_oi_daily",
    partitionKeys: ["underlying", "date"],
    filename: "data.parquet",
    schemaRevision: 1,
    provenance: { kind: "bounded-session", sessionKey: "date" },
  },
} satisfies Record<string, MarketDatasetDefinition>);

export type MarketDatasetName = keyof typeof MARKET_DATASETS;

export function isRealMarketSessionDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function marketDatasetDefinition(dataset: string): MarketDatasetDefinition | undefined {
  return Object.hasOwn(MARKET_DATASETS, dataset)
    ? MARKET_DATASETS[dataset as MarketDatasetName]
    : undefined;
}

export function canonicalPartitionDataset(
  dataset: string,
): BoundedMarketDatasetDefinition | undefined {
  const definition = marketDatasetDefinition(dataset);
  return definition?.provenance.kind === "bounded-session"
    ? (definition as BoundedMarketDatasetDefinition)
    : undefined;
}

export function validatePartitionIdentity(identity: DatasetPartitionIdentity): void {
  const definition = canonicalPartitionDataset(identity.dataset);
  if (!definition) {
    throw new TypeError(`Unregistered provenance dataset: ${JSON.stringify(identity.dataset)}`);
  }
  const expectedKeys = [...definition.partitionKeys].sort();
  const observedKeys = Object.keys(identity.partition).sort();
  if (
    observedKeys.length !== expectedKeys.length ||
    observedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `Invalid provenance partition keys: ${JSON.stringify({ dataset: identity.dataset, observedKeys, expectedKeys })}`,
    );
  }
  for (const [key, value] of Object.entries(identity.partition)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new TypeError(`Invalid provenance partition: ${JSON.stringify({ key, value })}`);
    }
  }
  const session = identity.partition[definition.provenance.sessionKey];
  if (!isRealMarketSessionDate(session)) {
    throw new TypeError(`Invalid provenance partition date: ${JSON.stringify(session)}`);
  }
}

export function canonicalPartitionRelativePath(identity: DatasetPartitionIdentity): string {
  validatePartitionIdentity(identity);
  const definition = canonicalPartitionDataset(identity.dataset) as BoundedMarketDatasetDefinition;
  return path.posix.join(
    definition.subdir,
    ...definition.partitionKeys.map((key) => `${key}=${identity.partition[key]}`),
    definition.filename,
  );
}
