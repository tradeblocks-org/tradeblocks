import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  addressCanonicalJson,
  canonicalJsonBytes,
  parseCanonicalJsonAddress,
  parseSha256Address,
  type CanonicalJsonAddress,
  type Sha256Address,
} from "./canonical-json.ts";
import { ContentObjectStore } from "./content-object-store.ts";

export const PARTITION_COMMIT_RECEIPT_KIND = "tradeblocks.market-data.partition-commit" as const;
export const PARTITION_COMMIT_RECEIPT_VERSION = 1 as const;
export const PARTITION_HEAD_KIND = "tradeblocks.market-data.partition-head" as const;
export const PARTITION_HEAD_VERSION = 1 as const;

export type PartitionCommitClassification = "append" | "repair";

export type LogicalCoverage =
  | { kind: "date-range"; from: string; through: string }
  | { kind: "empty" };

export interface PartitionQualityCounts {
  inputRows: number;
  writtenRows: number;
  droppedRows: number;
}

export interface ExactFileFingerprint {
  address: Sha256Address;
  bytes: number;
  rows: number;
}

export interface PartitionIdentity {
  dataset: string;
  partition: Record<string, string>;
}

export interface PartitionCommitReceiptV1 extends PartitionIdentity {
  kind: typeof PARTITION_COMMIT_RECEIPT_KIND;
  version: typeof PARTITION_COMMIT_RECEIPT_VERSION;
  schemaRevision: number;
  relativePath: string;
  coverage: LogicalCoverage;
  quality: PartitionQualityCounts;
  file: ExactFileFingerprint;
  classification: PartitionCommitClassification;
  parent?: CanonicalJsonAddress;
}

export interface StoredPartitionCommit {
  address: CanonicalJsonAddress;
  receipt: PartitionCommitReceiptV1;
  created: boolean;
}

export interface RecordPartitionCommitInput extends PartitionIdentity {
  schemaRevision: number;
  relativePath: string;
  coverage: LogicalCoverage;
  quality: PartitionQualityCounts;
  file: ExactFileFingerprint;
}

export interface PartitionCommitRecorder {
  recordCommit(input: RecordPartitionCommitInput): Promise<StoredPartitionCommit>;
}

export interface FilePartitionCommitStoreOptions {
  /** A dead owner's lock is recoverable after this age. Defaults to 30 seconds. */
  staleLockMs?: number;
  /** Maximum time to wait for a live owner. Defaults to 5 seconds. */
  lockWaitMs?: number;
}

interface PartitionHeadLockOwner {
  kind: "tradeblocks.market-data.partition-head-lock";
  version: 1;
  token: string;
  pid: number;
  createdAtMs: number;
}

interface PartitionHeadV1 extends PartitionIdentity {
  kind: typeof PARTITION_HEAD_KIND;
  version: typeof PARTITION_HEAD_VERSION;
  receipt: CanonicalJsonAddress;
}

export type PartitionInspection =
  | { status: "absent" }
  | { status: "orphan"; observed: Omit<ExactFileFingerprint, "rows"> }
  | { status: "missing"; receipt: StoredPartitionCommit }
  | {
      status: "mismatch";
      receipt: StoredPartitionCommit;
      observed: Omit<ExactFileFingerprint, "rows">;
    }
  | { status: "match"; receipt: StoredPartitionCommit };

function validateIdentity(identity: PartitionIdentity): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(identity.dataset)) {
    throw new TypeError(`Invalid provenance dataset: ${JSON.stringify(identity.dataset)}`);
  }
  for (const [key, value] of Object.entries(identity.partition)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new TypeError(`Invalid provenance partition: ${JSON.stringify({ key, value })}`);
    }
  }
}

function validateRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw new TypeError(`Invalid provenance relative path: ${JSON.stringify(relativePath)}`);
  }
}

function validateFingerprint(file: ExactFileFingerprint): void {
  parseSha256Address(file.address);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
    throw new TypeError(`Invalid provenance byte count: ${file.bytes}`);
  }
  if (!Number.isSafeInteger(file.rows) || file.rows < 0) {
    throw new TypeError(`Invalid provenance row count: ${file.rows}`);
  }
}

function validateCoverage(coverage: LogicalCoverage): void {
  if (coverage.kind === "empty") return;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const isRealDate = (value: string): boolean => {
    if (!isoDate.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isRealDate(coverage.from) || !isRealDate(coverage.through)) {
    throw new TypeError(`Invalid logical date coverage: ${JSON.stringify(coverage)}`);
  }
  if (coverage.from > coverage.through) {
    throw new TypeError(`Logical coverage starts after it ends: ${JSON.stringify(coverage)}`);
  }
}

function validateQuality(quality: PartitionQualityCounts, file: ExactFileFingerprint): void {
  for (const [name, count] of Object.entries(quality)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Invalid provenance ${name}: ${count}`);
    }
  }
  if (quality.writtenRows !== file.rows) {
    throw new TypeError(
      `Provenance writtenRows ${quality.writtenRows} does not match file rows ${file.rows}`,
    );
  }
  if (quality.inputRows !== quality.writtenRows + quality.droppedRows) {
    throw new TypeError("Provenance inputRows must equal writtenRows + droppedRows");
  }
}

function validateReceipt(receipt: PartitionCommitReceiptV1, identity: PartitionIdentity): void {
  if (
    receipt.kind !== PARTITION_COMMIT_RECEIPT_KIND ||
    receipt.version !== PARTITION_COMMIT_RECEIPT_VERSION ||
    receipt.dataset !== identity.dataset ||
    addressCanonicalJson(receipt.partition) !== addressCanonicalJson(identity.partition)
  ) {
    throw new Error("Partition receipt does not match its head identity");
  }
  if (!Number.isSafeInteger(receipt.schemaRevision) || receipt.schemaRevision < 1) {
    throw new TypeError(`Invalid schema revision: ${receipt.schemaRevision}`);
  }
  validateRelativePath(receipt.relativePath);
  validateFingerprint(receipt.file);
  validateCoverage(receipt.coverage);
  validateQuality(receipt.quality, receipt.file);
  if (receipt.classification !== "append" && receipt.classification !== "repair") {
    throw new Error(`Invalid partition receipt classification: ${String(receipt.classification)}`);
  }
  if (receipt.classification === "append" && receipt.parent !== undefined) {
    throw new Error("Append receipt must not have a parent");
  }
  if (receipt.classification === "repair" && receipt.parent === undefined) {
    throw new Error("Repair receipt must have a parent");
  }
  if (receipt.parent !== undefined) parseCanonicalJsonAddress(receipt.parent);
}

function identityAddress(identity: PartitionIdentity): CanonicalJsonAddress {
  return addressCanonicalJson({
    kind: "tradeblocks.market-data.partition-identity",
    version: 1,
    dataset: identity.dataset,
    partition: identity.partition,
  });
}

async function exactFileAddress(targetPath: string): Promise<Omit<ExactFileFingerprint, "rows">> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(targetPath)) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { address: `sha256:${hash.digest("hex")}`, bytes };
}

export class FilePartitionCommitStore implements PartitionCommitRecorder {
  readonly objects: ContentObjectStore;
  private readonly staleLockMs: number;
  private readonly lockWaitMs: number;

  constructor(
    readonly rootDir: string,
    options: FilePartitionCommitStoreOptions = {},
  ) {
    this.objects = new ContentObjectStore(rootDir);
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
  }

  private headPath(identity: PartitionIdentity): string {
    const digest = parseCanonicalJsonAddress(identityAddress(identity));
    return path.join(this.rootDir, "heads", digest.slice(0, 2), `${digest}.json`);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async readLockOwner(lockPath: string): Promise<PartitionHeadLockOwner | null> {
    try {
      const owner = JSON.parse(
        await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
      ) as PartitionHeadLockOwner;
      if (
        owner.kind !== "tradeblocks.market-data.partition-head-lock" ||
        owner.version !== 1 ||
        !/^[0-9a-f-]{36}$/.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) ||
        !Number.isSafeInteger(owner.createdAtMs)
      ) {
        return null;
      }
      return owner;
    } catch {
      return null;
    }
  }

  private async recoverStaleLock(lockPath: string): Promise<boolean> {
    let lockStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      lockStat = await fs.stat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const owner = await this.readLockOwner(lockPath);
    const createdAtMs = owner?.createdAtMs ?? Math.floor(lockStat.mtimeMs);
    if (Date.now() - createdAtMs < this.staleLockMs) return false;
    if (owner && this.isProcessAlive(owner.pid)) return false;

    // Every contender derives the same quarantine path from the stale owner.
    // The first rename wins; its retained non-empty tombstone makes later
    // contenders fail rather than moving a newly acquired live lock.
    const staleIdentity =
      owner?.token ?? `unowned-${lockStat.ino}-${Math.floor(lockStat.birthtimeMs)}`;
    const quarantinePath = `${lockPath}.stale-${staleIdentity}`;
    try {
      await fs.rename(lockPath, quarantinePath);
      await this.syncDirectory(path.dirname(lockPath));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
  }

  private async releaseOwnedLock(lockPath: string, token: string): Promise<void> {
    const owner = await this.readLockOwner(lockPath);
    if (!owner || owner.token !== token || owner.pid !== process.pid) {
      throw new Error(`Refusing to release a partition lock owned by another writer: ${lockPath}`);
    }
    const releasedPath = `${lockPath}.released-${token}`;
    await fs.rename(lockPath, releasedPath);
    await this.syncDirectory(path.dirname(lockPath));
    await fs.rm(releasedPath, { recursive: true });
    await this.syncDirectory(path.dirname(lockPath));
  }

  private async withHeadLock<T>(
    identity: PartitionIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const headPath = this.headPath(identity);
    const directory = path.dirname(headPath);
    const lockPath = `${headPath}.lock`;
    await fs.mkdir(directory, { recursive: true });

    const token = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    let acquired = false;
    while (Date.now() <= deadline) {
      let createdLock = false;
      try {
        await fs.mkdir(lockPath);
        createdLock = true;
        const owner: PartitionHeadLockOwner = {
          kind: "tradeblocks.market-data.partition-head-lock",
          version: 1,
          token,
          pid: process.pid,
          createdAtMs: Date.now(),
        };
        const ownerPath = path.join(lockPath, "owner.json");
        const ownerHandle = await fs.open(ownerPath, "wx", 0o644);
        try {
          await ownerHandle.writeFile(canonicalJsonBytes(owner));
          await ownerHandle.sync();
        } finally {
          await ownerHandle.close();
        }
        await this.syncDirectory(lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (createdLock) {
          const abandonedPath = `${lockPath}.abandoned-${token}`;
          await fs.rename(lockPath, abandonedPath).catch(() => undefined);
          await fs.rm(abandonedPath, { recursive: true, force: true });
          await this.syncDirectory(directory);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.recoverStaleLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!acquired) throw new Error(`Timed out acquiring partition head lock: ${lockPath}`);

    try {
      return await operation();
    } finally {
      await this.releaseOwnedLock(lockPath, token);
    }
  }

  private async readHead(identity: PartitionIdentity): Promise<StoredPartitionCommit | null> {
    const headPath = this.headPath(identity);
    let raw: string;
    try {
      raw = await fs.readFile(headPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const head = JSON.parse(raw) as PartitionHeadV1;
    if (
      head.kind !== PARTITION_HEAD_KIND ||
      head.version !== PARTITION_HEAD_VERSION ||
      head.dataset !== identity.dataset ||
      addressCanonicalJson(head.partition) !== addressCanonicalJson(identity.partition)
    ) {
      throw new Error(`Invalid partition head at ${headPath}`);
    }
    parseCanonicalJsonAddress(head.receipt);
    const receipt = await this.objects.get<PartitionCommitReceiptV1>(head.receipt);
    validateReceipt(receipt, identity);
    return { address: head.receipt, receipt, created: false };
  }

  private async writeHead(
    identity: PartitionIdentity,
    receipt: CanonicalJsonAddress,
  ): Promise<void> {
    const headPath = this.headPath(identity);
    await fs.mkdir(path.dirname(headPath), { recursive: true });
    const tempPath = `${headPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const head: PartitionHeadV1 = {
      kind: PARTITION_HEAD_KIND,
      version: PARTITION_HEAD_VERSION,
      dataset: identity.dataset,
      partition: identity.partition,
      receipt,
    };
    let handle: fs.FileHandle | undefined;
    try {
      // Heads are mutable derived indexes. The immutable receipt chain is the
      // authority; the per-identity lock serializes head replacement.
      handle = await fs.open(tempPath, "wx", 0o644);
      await handle.writeFile(canonicalJsonBytes(head));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, headPath);
      await this.syncDirectory(path.dirname(headPath));
    } catch (error) {
      await handle?.close();
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async recordCommit(input: RecordPartitionCommitInput): Promise<StoredPartitionCommit> {
    validateIdentity(input);
    if (!Number.isSafeInteger(input.schemaRevision) || input.schemaRevision < 1) {
      throw new TypeError(`Invalid schema revision: ${input.schemaRevision}`);
    }
    validateRelativePath(input.relativePath);
    validateFingerprint(input.file);
    validateCoverage(input.coverage);
    validateQuality(input.quality, input.file);

    return this.withHeadLock(input, async () => {
      const previous = await this.readHead(input);
      if (
        previous &&
        previous.receipt.schemaRevision === input.schemaRevision &&
        previous.receipt.relativePath === input.relativePath &&
        addressCanonicalJson(previous.receipt.coverage) === addressCanonicalJson(input.coverage) &&
        addressCanonicalJson(previous.receipt.quality) === addressCanonicalJson(input.quality) &&
        previous.receipt.file.address === input.file.address &&
        previous.receipt.file.bytes === input.file.bytes &&
        previous.receipt.file.rows === input.file.rows
      ) {
        return previous;
      }

      const receipt: PartitionCommitReceiptV1 = {
        kind: PARTITION_COMMIT_RECEIPT_KIND,
        version: PARTITION_COMMIT_RECEIPT_VERSION,
        schemaRevision: input.schemaRevision,
        dataset: input.dataset,
        partition: input.partition,
        relativePath: input.relativePath,
        coverage: input.coverage,
        quality: input.quality,
        file: input.file,
        classification: previous ? "repair" : "append",
        ...(previous ? { parent: previous.address } : {}),
      };
      const stored = await this.objects.put(receipt);
      await this.writeHead(input, stored.address);
      return {
        address: stored.address,
        receipt,
        created: stored.created,
      };
    });
  }

  async inspectPartition(
    identity: PartitionIdentity & { targetPath: string },
  ): Promise<PartitionInspection> {
    validateIdentity(identity);
    const receipt = await this.readHead(identity);
    let observed: Omit<ExactFileFingerprint, "rows">;
    try {
      observed = await exactFileAddress(identity.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return receipt ? { status: "missing", receipt } : { status: "absent" };
      }
      throw error;
    }
    if (!receipt) return { status: "orphan", observed };
    if (
      receipt.receipt.file.address !== observed.address ||
      receipt.receipt.file.bytes !== observed.bytes
    ) {
      return { status: "mismatch", receipt, observed };
    }
    return { status: "match", receipt };
  }
}
