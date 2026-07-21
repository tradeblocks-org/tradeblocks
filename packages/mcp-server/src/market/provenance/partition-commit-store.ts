import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import {
  addressBytes,
  addressCanonicalJson,
  canonicalJsonBytes,
  parseCanonicalJsonAddress,
  parseSha256Address,
  type CanonicalJsonAddress,
  type Sha256Address,
} from "./canonical-json.ts";
import { ContentObjectCollisionError, ContentObjectStore } from "./content-object-store.ts";
import {
  canonicalPartitionDataset,
  canonicalPartitionRelativePath,
  isRealMarketSessionDate,
  validatePartitionIdentity,
} from "./dataset-registry.ts";

export const PARTITION_COMMIT_RECEIPT_KIND = "tradeblocks.market-data.partition-commit" as const;
export const PARTITION_COMMIT_RECEIPT_VERSION = 1 as const;
export const PARTITION_COMMIT_EVENT_KIND =
  "tradeblocks.market-data.partition-commit-event" as const;
export const PARTITION_COMMIT_EVENT_VERSION = 1 as const;
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

export interface PartitionCommitEventV1 extends PartitionIdentity {
  kind: typeof PARTITION_COMMIT_EVENT_KIND;
  version: typeof PARTITION_COMMIT_EVENT_VERSION;
  receipt: CanonicalJsonAddress;
  previous?: CanonicalJsonAddress;
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

export interface PublishPartitionFileInput extends RecordPartitionCommitInput {
  /** Completed sibling file that has not yet been installed. */
  preparedPath: string;
  /** Caller expectation; the store derives and verifies this from relativePath. */
  expectedTargetPath: string;
}

export interface PartitionCommitRecorder {
  publishFileCommit(input: PublishPartitionFileInput): Promise<StoredPartitionCommit>;
  readCommit(address: CanonicalJsonAddress): Promise<StoredPartitionCommit>;
}

export interface FilePartitionCommitStoreOptions {
  /** A provably dead local claim is recoverable after this age. Defaults to 30 seconds. */
  staleLockMs?: number;
  /** Maximum time to wait for an earlier or ambiguous claim. Defaults to 5 seconds. */
  lockWaitMs?: number;
}

interface PartitionLockOwner {
  kind: "tradeblocks.market-data.partition-lock-owner";
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  bootId: string;
  createdAtMs: number;
}

interface PartitionLockTicket {
  kind: "tradeblocks.market-data.partition-lock-ticket";
  version: 1;
  token: string;
  number: number;
}

interface PartitionHeadV1 extends PartitionIdentity {
  kind: typeof PARTITION_HEAD_KIND;
  version: typeof PARTITION_HEAD_VERSION;
  receipt: CanonicalJsonAddress;
  event: CanonicalJsonAddress;
}

interface AuthorityTip {
  eventAddress: CanonicalJsonAddress;
  commit: StoredPartitionCommit;
}

type PartitionCommitTestFaultPoint = "after-claim-open" | "after-event-before-head";
const partitionCommitTestFaults = new WeakMap<
  FilePartitionCommitStore,
  (point: PartitionCommitTestFaultPoint) => void | Promise<void>
>();

/** @internal Test-only deterministic crash-boundary injection; not in the public barrel. */
export function setPartitionCommitTestFault(
  store: FilePartitionCommitStore,
  fault?: (point: PartitionCommitTestFaultPoint) => void | Promise<void>,
): void {
  if (fault) partitionCommitTestFaults.set(store, fault);
  else partitionCommitTestFaults.delete(store);
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

/** A canonical partition path does not name the regular file inode being verified. */
export class PartitionFileIntegrityError extends Error {
  constructor(
    readonly filePath: string,
    reason: string,
    cause?: unknown,
  ) {
    super(`Invalid partition file (${reason}): ${filePath}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "PartitionFileIntegrityError";
  }
}

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENT_HOSTNAME = hostname();
const CURRENT_BOOT_ID = (() => {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value.length > 0 ? value : "unavailable";
  } catch {
    return "unavailable";
  }
})();

function validateIdentity(identity: PartitionIdentity): void {
  validatePartitionIdentity(identity);
}

function canonicalRelativePath(identity: PartitionIdentity): string {
  return canonicalPartitionRelativePath(identity);
}

function validateRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new TypeError(`Invalid provenance relative path: ${JSON.stringify(relativePath)}`);
  }
}

function validateRegistryPath(identity: PartitionIdentity, relativePath: string): void {
  validateRelativePath(relativePath);
  const expected = canonicalRelativePath(identity);
  if (relativePath !== expected) {
    throw new TypeError(
      `Provenance path does not match the registered partition: ${JSON.stringify({ expected, observed: relativePath })}`,
    );
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

function validateCoverage(coverage: LogicalCoverage, rows: number): void {
  if (coverage.kind === "empty") {
    if (rows !== 0) throw new TypeError("Non-empty partition cannot have empty logical coverage");
    return;
  }
  if (!isRealMarketSessionDate(coverage.from) || !isRealMarketSessionDate(coverage.through)) {
    throw new TypeError(`Invalid logical date coverage: ${JSON.stringify(coverage)}`);
  }
  if (coverage.from > coverage.through) {
    throw new TypeError(`Logical coverage starts after it ends: ${JSON.stringify(coverage)}`);
  }
  if (rows === 0) throw new TypeError("Empty partition cannot have non-empty logical coverage");
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

function validateInput(input: RecordPartitionCommitInput): void {
  validateIdentity(input);
  if (!Number.isSafeInteger(input.schemaRevision) || input.schemaRevision < 1) {
    throw new TypeError(`Invalid schema revision: ${input.schemaRevision}`);
  }
  validateRegistryPath(input, input.relativePath);
  validateFingerprint(input.file);
  validateCoverage(input.coverage, input.file.rows);
  validateQuality(input.quality, input.file);
  const date = input.partition[canonicalPartitionDataset(input.dataset)!.provenance.sessionKey];
  if (
    input.coverage.kind === "date-range" &&
    (input.coverage.from !== date || input.coverage.through !== date)
  ) {
    throw new TypeError(
      `Partition logical coverage must equal its registered date: ${JSON.stringify({ date, coverage: input.coverage })}`,
    );
  }
}

function validateReceipt(receipt: PartitionCommitReceiptV1, identity: PartitionIdentity): void {
  if (
    receipt.kind !== PARTITION_COMMIT_RECEIPT_KIND ||
    receipt.version !== PARTITION_COMMIT_RECEIPT_VERSION ||
    receipt.dataset !== identity.dataset ||
    addressCanonicalJson(receipt.partition) !== addressCanonicalJson(identity.partition)
  ) {
    throw new Error("Partition receipt does not match its identity");
  }
  validateInput(receipt);
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

interface OpenRegularFile {
  handle: fs.FileHandle;
  stat: Awaited<ReturnType<fs.FileHandle["stat"]>>;
}

function sameInode(
  left: Awaited<ReturnType<fs.FileHandle["stat"]>>,
  right: Awaited<ReturnType<fs.FileHandle["stat"]>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openRegularFileNoFollow(filePath: string): Promise<OpenRegularFile> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new PartitionFileIntegrityError(filePath, "symbolic links are not allowed", error);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new PartitionFileIntegrityError(filePath, "expected a regular file");
    }
    if (stat.nlink !== 1) {
      throw new PartitionFileIntegrityError(filePath, "expected an unshared regular file inode");
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function exactOpenFileAddress(
  handle: fs.FileHandle,
): Promise<Omit<ExactFileFingerprint, "rows">> {
  const hash = createHash("sha256");
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (true) {
    const read = await handle.read(buffer, 0, buffer.byteLength, bytes);
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    bytes += read.bytesRead;
  }
  return { address: `sha256:${hash.digest("hex")}`, bytes };
}

async function requireNamedRegularInode(
  filePath: string,
  expected: Awaited<ReturnType<fs.FileHandle["stat"]>>,
): Promise<void> {
  let named: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    named = await fs.lstat(filePath);
  } catch (error) {
    throw new PartitionFileIntegrityError(
      filePath,
      "verified inode is no longer named here",
      error,
    );
  }
  if (!named.isFile()) {
    throw new PartitionFileIntegrityError(filePath, "canonical entry is not a regular file");
  }
  if (named.nlink !== 1 || expected.nlink !== 1) {
    throw new PartitionFileIntegrityError(filePath, "canonical inode has multiple hard links");
  }
  if (!sameInode(expected, named)) {
    throw new PartitionFileIntegrityError(filePath, "canonical entry changed during verification");
  }
}

async function exactFileAddress(filePath: string): Promise<Omit<ExactFileFingerprint, "rows">> {
  const opened = await openRegularFileNoFollow(filePath);
  try {
    const fingerprint = await exactOpenFileAddress(opened.handle);
    const after = await opened.handle.stat();
    if (!after.isFile() || after.nlink !== 1 || !sameInode(opened.stat, after)) {
      throw new PartitionFileIntegrityError(filePath, "open inode changed during verification");
    }
    await requireNamedRegularInode(filePath, opened.stat);
    return fingerprint;
  } finally {
    await opened.handle.close();
  }
}

function sameCommitContent(
  previous: PartitionCommitReceiptV1,
  input: RecordPartitionCommitInput,
): boolean {
  return (
    previous.schemaRevision === input.schemaRevision &&
    previous.relativePath === input.relativePath &&
    addressCanonicalJson(previous.coverage) === addressCanonicalJson(input.coverage) &&
    addressCanonicalJson(previous.quality) === addressCanonicalJson(input.quality) &&
    previous.file.address === input.file.address &&
    previous.file.bytes === input.file.bytes &&
    previous.file.rows === input.file.rows
  );
}

function captureIdentity(identity: PartitionIdentity): PartitionIdentity {
  const captured = JSON.parse(
    canonicalJsonBytes({ dataset: identity.dataset, partition: identity.partition }).toString(
      "utf8",
    ),
  ) as PartitionIdentity;
  validateIdentity(captured);
  return Object.freeze({ ...captured, partition: Object.freeze(captured.partition) });
}

function captureInput(input: RecordPartitionCommitInput): RecordPartitionCommitInput {
  const captured = JSON.parse(
    canonicalJsonBytes({
      dataset: input.dataset,
      partition: input.partition,
      schemaRevision: input.schemaRevision,
      relativePath: input.relativePath,
      coverage: input.coverage,
      quality: input.quality,
      file: input.file,
    }).toString("utf8"),
  ) as RecordPartitionCommitInput;
  validateInput(captured);
  Object.freeze(captured.partition);
  Object.freeze(captured.coverage);
  Object.freeze(captured.quality);
  Object.freeze(captured.file);
  return Object.freeze(captured);
}

/**
 * Durable partition receipt store rooted at the canonical market directory.
 * Data targets are derived from the registered identity and receipt path;
 * callers cannot redirect inspection or publication to arbitrary files.
 */
export class FilePartitionCommitStore implements PartitionCommitRecorder {
  readonly objects: ContentObjectStore;
  readonly provenanceRootDir: string;
  private readonly staleLockMs: number;
  private readonly lockWaitMs: number;

  constructor(
    readonly marketRootDir: string,
    options: FilePartitionCommitStoreOptions = {},
  ) {
    this.provenanceRootDir = path.join(marketRootDir, ".provenance");
    this.objects = new ContentObjectStore(this.provenanceRootDir);
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
  }

  private identityDigest(identity: PartitionIdentity): string {
    return parseCanonicalJsonAddress(identityAddress(identity));
  }

  private headPath(identity: PartitionIdentity): string {
    const digest = this.identityDigest(identity);
    return path.join(this.provenanceRootDir, "heads", digest.slice(0, 2), `${digest}.json`);
  }

  private eventIndexDir(identity: PartitionIdentity): string {
    const digest = this.identityDigest(identity);
    return path.join(this.provenanceRootDir, "events", digest.slice(0, 2), digest);
  }

  private lockRoot(identity: PartitionIdentity): string {
    const digest = this.identityDigest(identity);
    return path.join(this.provenanceRootDir, "locks", digest.slice(0, 2), digest);
  }

  private targetPath(relativePath: string): string {
    validateRelativePath(relativePath);
    return path.join(this.marketRootDir, ...relativePath.split("/"));
  }

  private async validateMarketRoot(): Promise<string> {
    const root = path.resolve(this.marketRootDir);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new PartitionFileIntegrityError(root, "market root must be a real directory");
    }
    return fs.realpath(root);
  }

  private async validatedTargetPath(
    relativePath: string,
    expectedRealRoot: string,
  ): Promise<string> {
    validateRelativePath(relativePath);
    const root = path.resolve(this.marketRootDir);
    const realRoot = await this.validateMarketRoot();
    if (realRoot !== expectedRealRoot) {
      throw new PartitionFileIntegrityError(root, "market root changed during publication");
    }
    const components = relativePath.split("/");
    let current = root;
    for (const component of components.slice(0, -1)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PartitionFileIntegrityError(
          current,
          "target path components must be real directories",
        );
      }
    }
    const realParent = await fs.realpath(current);
    const containment = path.relative(realRoot, realParent);
    if (
      containment === ".." ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment)
    ) {
      throw new PartitionFileIntegrityError(
        current,
        "target parent escapes the configured market root",
      );
    }
    return path.join(current, components.at(-1) as string);
  }

  private async quarantineClaim(claimedPath: string): Promise<void> {
    try {
      await fs.lstat(claimedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const quarantineDir = path.join(this.provenanceRootDir, "rejected-prepared");
    await this.ensureDurableDirectory(quarantineDir);
    const quarantinePath = path.join(quarantineDir, randomUUID());
    await fs.rename(claimedPath, quarantinePath);
    await this.syncDirectory(path.dirname(claimedPath));
    await this.syncDirectory(quarantineDir);
  }

  private async restoreOrQuarantineClaim(claimedPath: string, preparedPath: string): Promise<void> {
    let restored = false;
    let claimedRemoved = false;
    try {
      // link(2) is no-replace at the destination and preserves a symlink as a
      // symlink. It safely restores regular files, hard links, and symlinks;
      // directories fall through to quarantine without recursive deletion.
      await fs.link(claimedPath, preparedPath);
      restored = true;
      await fs.unlink(claimedPath);
      claimedRemoved = true;
      await this.syncDirectory(path.dirname(preparedPath));
      return;
    } catch (error) {
      if (claimedRemoved) throw error;
      if (restored) await fs.unlink(preparedPath).catch(() => undefined);
      await this.quarantineClaim(claimedPath);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureDurableDirectory(directory: string): Promise<void> {
    const parent = path.dirname(directory);
    if (parent !== directory) await this.ensureDurableDirectory(parent);
    try {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (parent !== directory) await this.syncDirectory(parent);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (parent === directory) throw new Error(`Cannot create provenance directory ${directory}`);
    let created = false;
    try {
      await fs.mkdir(directory);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      await this.syncDirectory(directory);
      await this.syncDirectory(parent);
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

  private async readCanonicalFile<T>(filePath: string): Promise<T | null> {
    try {
      const bytes = await fs.readFile(filePath);
      const value = JSON.parse(bytes.toString("utf8")) as T;
      if (!canonicalJsonBytes(value).equals(bytes)) return null;
      return value;
    } catch {
      return null;
    }
  }

  private validOwner(owner: PartitionLockOwner | null, token: string): owner is PartitionLockOwner {
    return Boolean(
      owner &&
      owner.kind === "tradeblocks.market-data.partition-lock-owner" &&
      owner.version === 1 &&
      owner.token === token &&
      TOKEN_RE.test(owner.token) &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.hostname === "string" &&
      owner.hostname.length > 0 &&
      typeof owner.bootId === "string" &&
      owner.bootId.length > 0 &&
      Number.isSafeInteger(owner.createdAtMs) &&
      owner.createdAtMs >= 0,
    );
  }

  private validTicket(
    ticket: PartitionLockTicket | null,
    token: string,
  ): ticket is PartitionLockTicket {
    return Boolean(
      ticket &&
      ticket.kind === "tradeblocks.market-data.partition-lock-ticket" &&
      ticket.version === 1 &&
      ticket.token === token &&
      Number.isSafeInteger(ticket.number) &&
      ticket.number >= 1,
    );
  }

  private ownerProvablyDead(owner: PartitionLockOwner): boolean {
    // A different host is intrinsically ambiguous; never steal it. A different
    // boot generation on this host is conclusive evidence that the process is
    // gone. Otherwise use the local PID liveness probe.
    if (owner.hostname !== CURRENT_HOSTNAME) return false;
    if (
      owner.bootId !== "unavailable" &&
      CURRENT_BOOT_ID !== "unavailable" &&
      owner.bootId !== CURRENT_BOOT_ID
    ) {
      return true;
    }
    return !this.isProcessAlive(owner.pid);
  }

  private async recoverClaim(claimsDir: string, token: string): Promise<boolean> {
    if (!TOKEN_RE.test(token)) return false;
    const claimPath = path.join(claimsDir, token);
    let claimStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      claimStat = await fs.stat(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const owner = await this.readCanonicalFile<PartitionLockOwner>(
      path.join(claimPath, "owner.json"),
    );
    const validOwner = this.validOwner(owner, token);
    // A malformed owner is ambiguous, even when old. Only a complete claim
    // with conclusive same-host generation/process evidence is recoverable.
    if (!validOwner) return false;
    const createdAtMs = owner.createdAtMs;
    if (Date.now() - createdAtMs < this.staleLockMs) return false;
    if (!this.ownerProvablyDead(owner)) return false;

    // Claim paths are unique generations and never reused. Recovery therefore
    // moves only the exact observed token path, never a constant path that a
    // replacement owner could have acquired (the usual stale-lock ABA race).
    const quarantineDir = path.join(path.dirname(claimsDir), "quarantine");
    await this.ensureDurableDirectory(quarantineDir);
    const quarantinePath = path.join(
      quarantineDir,
      `${token}-${claimStat.ino}-${Math.floor(claimStat.birthtimeMs)}`,
    );
    try {
      await fs.rename(claimPath, quarantinePath);
      await this.syncDirectory(claimsDir);
      await this.syncDirectory(quarantineDir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
  }

  private async publishClaim(claimsDir: string, token: string): Promise<string> {
    const owner: PartitionLockOwner = {
      kind: "tradeblocks.market-data.partition-lock-owner",
      version: 1,
      token,
      pid: process.pid,
      hostname: CURRENT_HOSTNAME,
      bootId: CURRENT_BOOT_ID,
      createdAtMs: Date.now(),
    };
    const publishingPath = path.join(claimsDir, `.publishing-${token}`);
    const claimPath = path.join(claimsDir, token);
    await fs.mkdir(publishingPath);
    try {
      const ownerHandle = await fs.open(path.join(publishingPath, "owner.json"), "wx", 0o444);
      try {
        await ownerHandle.writeFile(canonicalJsonBytes(owner));
        await ownerHandle.sync();
      } finally {
        await ownerHandle.close();
      }
      await this.syncDirectory(publishingPath);
      await fs.rename(publishingPath, claimPath);
      await this.syncDirectory(claimsDir);
      return claimPath;
    } catch (error) {
      await fs.rm(publishingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async assignTicket(claimsDir: string, claimPath: string, token: string): Promise<number> {
    let maximum = 0;
    for (const entry of await fs.readdir(claimsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !TOKEN_RE.test(entry.name)) continue;
      const ticket = await this.readCanonicalFile<PartitionLockTicket>(
        path.join(claimsDir, entry.name, "ticket.json"),
      );
      if (this.validTicket(ticket, entry.name)) maximum = Math.max(maximum, ticket.number);
    }
    if (!Number.isSafeInteger(maximum + 1)) throw new Error("Partition lock ticket overflow");
    const ticket: PartitionLockTicket = {
      kind: "tradeblocks.market-data.partition-lock-ticket",
      version: 1,
      token,
      number: maximum + 1,
    };
    const handle = await fs.open(path.join(claimPath, "ticket.json"), "wx", 0o444);
    try {
      await handle.writeFile(canonicalJsonBytes(ticket));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(claimPath);
    return ticket.number;
  }

  private async releaseClaim(claimsDir: string, claimPath: string, token: string): Promise<void> {
    const owner = await this.readCanonicalFile<PartitionLockOwner>(
      path.join(claimPath, "owner.json"),
    );
    if (!this.validOwner(owner, token) || owner.pid !== process.pid) {
      throw new Error(
        `Refusing to release a partition claim owned by another writer: ${claimPath}`,
      );
    }
    const releasedDir = path.join(path.dirname(claimsDir), "released");
    await this.ensureDurableDirectory(releasedDir);
    const releasedPath = path.join(releasedDir, token);
    await fs.rename(claimPath, releasedPath);
    await this.syncDirectory(claimsDir);
    await this.syncDirectory(releasedDir);
    await fs.rm(releasedPath, { recursive: true });
    await this.syncDirectory(releasedDir);
  }

  private async withPartitionLock<T>(
    identity: PartitionIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    validateIdentity(identity);
    const lockRoot = this.lockRoot(identity);
    const claimsDir = path.join(lockRoot, "claims");
    await this.ensureDurableDirectory(claimsDir);
    const token = randomUUID();
    const claimPath = await this.publishClaim(claimsDir, token);
    let ownTicket: number;
    try {
      ownTicket = await this.assignTicket(claimsDir, claimPath, token);
    } catch (error) {
      await this.releaseClaim(claimsDir, claimPath, token);
      throw error;
    }
    const deadline = Date.now() + this.lockWaitMs;
    let acquired = false;

    try {
      while (Date.now() <= deadline) {
        let blocked = false;
        const entries = await fs.readdir(claimsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === token) continue;
          if (!TOKEN_RE.test(entry.name)) {
            if (!entry.name.startsWith(".publishing-")) blocked = true;
            continue;
          }
          const otherPath = path.join(claimsDir, entry.name);
          const owner = await this.readCanonicalFile<PartitionLockOwner>(
            path.join(otherPath, "owner.json"),
          );
          if (!this.validOwner(owner, entry.name)) {
            blocked = true;
            continue;
          }
          const ticket = await this.readCanonicalFile<PartitionLockTicket>(
            path.join(otherPath, "ticket.json"),
          );
          if (!this.validTicket(ticket, entry.name)) {
            // A missing ticket is a valid interrupted-intent state and may be
            // recovered only with a valid, provably dead owner. Malformed
            // ticket bytes are ambiguous and permanently fail closed.
            try {
              await fs.stat(path.join(otherPath, "ticket.json"));
              blocked = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              if (!(await this.recoverClaim(claimsDir, entry.name))) blocked = true;
            }
            continue;
          }
          if (ticket.number < ownTicket || (ticket.number === ownTicket && entry.name < token)) {
            if (!(await this.recoverClaim(claimsDir, entry.name))) blocked = true;
          }
        }
        if (!blocked) {
          acquired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!acquired) throw new Error(`Timed out acquiring partition lock: ${lockRoot}`);
      return await operation();
    } finally {
      await this.releaseClaim(claimsDir, claimPath, token);
    }
  }

  private async readIndexedEvent(
    identity: PartitionIdentity,
    eventPath: string,
    address: CanonicalJsonAddress,
  ): Promise<{ event: PartitionCommitEventV1; commit: StoredPartitionCommit }> {
    const bytes = await fs.readFile(eventPath);
    if (addressBytes(bytes) !== address) {
      throw new ContentObjectCollisionError(address, eventPath);
    }
    const event = JSON.parse(bytes.toString("utf8")) as PartitionCommitEventV1;
    if (!canonicalJsonBytes(event).equals(bytes)) {
      throw new ContentObjectCollisionError(address, eventPath);
    }
    if (
      event.kind !== PARTITION_COMMIT_EVENT_KIND ||
      event.version !== PARTITION_COMMIT_EVENT_VERSION ||
      event.dataset !== identity.dataset ||
      addressCanonicalJson(event.partition) !== addressCanonicalJson(identity.partition)
    ) {
      throw new Error(`Invalid partition commit event at ${eventPath}`);
    }
    parseCanonicalJsonAddress(event.receipt);
    if (event.previous !== undefined) parseCanonicalJsonAddress(event.previous);
    const commit = await this.readCommit(event.receipt);
    validateReceipt(commit.receipt, identity);
    return { event, commit };
  }

  private async readAuthorityTip(identity: PartitionIdentity): Promise<AuthorityTip | null> {
    const indexDir = this.eventIndexDir(identity);
    let entries: string[];
    try {
      entries = await fs.readdir(indexDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const events = new Map<
      CanonicalJsonAddress,
      { event: PartitionCommitEventV1; commit: StoredPartitionCommit }
    >();
    for (const entry of entries) {
      const match = /^([0-9a-f]{64})\.json$/.exec(entry);
      if (!match) throw new Error(`Unexpected partition event index entry: ${entry}`);
      const address = `sha256:${match[1]}` as CanonicalJsonAddress;
      events.set(
        address,
        await this.readIndexedEvent(identity, path.join(indexDir, entry), address),
      );
    }
    if (events.size === 0) return null;

    const roots = [...events.entries()].filter(([, value]) => value.event.previous === undefined);
    if (roots.length !== 1) throw new Error("Partition event authority must have exactly one root");
    let [currentAddress, current] = roots[0];
    if (current.commit.receipt.classification !== "append") {
      throw new Error("Partition event root must reference an append receipt");
    }
    const visited = new Set<CanonicalJsonAddress>();
    while (true) {
      if (visited.has(currentAddress))
        throw new Error("Partition event authority contains a cycle");
      visited.add(currentAddress);
      const children = [...events.entries()].filter(
        ([, value]) => value.event.previous === currentAddress,
      );
      if (children.length === 0) break;
      if (children.length !== 1)
        throw new Error("Partition event authority contains ambiguous tips");
      const [childAddress, child] = children[0];
      if (
        child.commit.receipt.classification !== "repair" ||
        child.commit.receipt.parent !== current.commit.address
      ) {
        throw new Error("Partition event authority receipt ancestry is inconsistent");
      }
      currentAddress = childAddress;
      current = child;
    }
    if (visited.size !== events.size) {
      throw new Error("Partition event authority contains a disconnected or missing-parent event");
    }
    return { eventAddress: currentAddress, commit: current.commit };
  }

  private async readProjectedHead(identity: PartitionIdentity): Promise<PartitionHeadV1 | null> {
    const headPath = this.headPath(identity);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(headPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    try {
      const head = JSON.parse(bytes.toString("utf8")) as PartitionHeadV1;
      if (!canonicalJsonBytes(head).equals(bytes)) return null;
      if (
        head.kind !== PARTITION_HEAD_KIND ||
        head.version !== PARTITION_HEAD_VERSION ||
        head.dataset !== identity.dataset ||
        addressCanonicalJson(head.partition) !== addressCanonicalJson(identity.partition)
      ) {
        return null;
      }
      parseCanonicalJsonAddress(head.receipt);
      parseCanonicalJsonAddress(head.event);
      return head;
    } catch {
      return null;
    }
  }

  private async writeHead(identity: PartitionIdentity, tip: AuthorityTip): Promise<void> {
    const headPath = this.headPath(identity);
    await this.ensureDurableDirectory(path.dirname(headPath));
    const tempPath = `${headPath}.tmp-${randomUUID()}`;
    const head: PartitionHeadV1 = {
      kind: PARTITION_HEAD_KIND,
      version: PARTITION_HEAD_VERSION,
      dataset: identity.dataset,
      partition: identity.partition,
      receipt: tip.commit.address,
      event: tip.eventAddress,
    };
    let handle: fs.FileHandle | undefined;
    try {
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

  private async authorityWithRebuiltHead(
    identity: PartitionIdentity,
  ): Promise<AuthorityTip | null> {
    const tip = await this.readAuthorityTip(identity);
    const head = await this.readProjectedHead(identity);
    if (!tip) {
      if (head) throw new Error("Partition head exists without immutable event authority");
      return null;
    }
    if (head?.receipt !== tip.commit.address || head.event !== tip.eventAddress) {
      await this.writeHead(identity, tip);
    }
    return tip;
  }

  private async appendEvent(
    identity: PartitionIdentity,
    receipt: CanonicalJsonAddress,
    previous?: CanonicalJsonAddress,
  ): Promise<CanonicalJsonAddress> {
    const event: PartitionCommitEventV1 = {
      kind: PARTITION_COMMIT_EVENT_KIND,
      version: PARTITION_COMMIT_EVENT_VERSION,
      dataset: identity.dataset,
      partition: identity.partition,
      receipt,
      ...(previous ? { previous } : {}),
    };
    const stored = await this.objects.put(event);
    const indexDir = this.eventIndexDir(identity);
    await this.ensureDurableDirectory(indexDir);
    const digest = parseCanonicalJsonAddress(stored.address);
    const eventPath = path.join(indexDir, `${digest}.json`);
    try {
      await fs.link(stored.path, eventPath);
      await this.syncDirectory(indexDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readFile(eventPath);
      if (
        addressBytes(existing) !== stored.address ||
        !existing.equals(canonicalJsonBytes(event))
      ) {
        throw new ContentObjectCollisionError(stored.address, eventPath);
      }
      const handle = await fs.open(eventPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory(indexDir);
    }
    return stored.address;
  }

  async readCommit(address: CanonicalJsonAddress): Promise<StoredPartitionCommit> {
    parseCanonicalJsonAddress(address);
    const receipt = await this.objects.get<PartitionCommitReceiptV1>(address);
    validateReceipt(receipt, receipt);
    return Object.freeze({ address, receipt, created: false });
  }

  async publishFileCommit(input: PublishPartitionFileInput): Promise<StoredPartitionCommit> {
    // Snapshot every semantic field before the first await. Callers may retain
    // and mutate their input object; those mutations cannot change the lock,
    // target, receipt, event, or comparison after publication begins.
    const captured = captureInput(input);
    const preparedPath = path.resolve(String(input.preparedPath));
    const expectedTargetPath = path.resolve(String(input.expectedTargetPath));
    const targetPath = path.resolve(this.targetPath(captured.relativePath));
    if (expectedTargetPath !== targetPath) {
      throw new TypeError(
        `Provenance target does not match the store-owned market path: ${JSON.stringify({ expected: targetPath, observed: expectedTargetPath })}`,
      );
    }
    if (preparedPath === targetPath || path.dirname(preparedPath) !== path.dirname(targetPath)) {
      throw new TypeError("Prepared partition file must be a distinct sibling of its target");
    }
    // Reject an aliased or invalid configured root before lock acquisition can
    // create any authority directories through it.
    const realMarketRoot = await this.validateMarketRoot();
    return this.withPartitionLock(captured, async () => {
      const validatedTargetPath = await this.validatedTargetPath(
        captured.relativePath,
        realMarketRoot,
      );
      if (validatedTargetPath !== targetPath) {
        throw new PartitionFileIntegrityError(
          validatedTargetPath,
          "validated target differs from the registered path",
        );
      }
      const targetDirectory = path.dirname(targetPath);
      const claimedPath = path.join(targetDirectory, `.provenance-claim-${randomUUID()}`);
      let claimed = false;
      let targetTouched = false;
      let claimedHandle: fs.FileHandle | undefined;
      let claimedStat: Awaited<ReturnType<fs.FileHandle["stat"]>> | undefined;
      try {
        // Move the caller-controlled directory entry out of its known name
        // before following or reading anything. The random sibling is then
        // opened no-follow and pinned by file descriptor through install.
        await fs.rename(preparedPath, claimedPath);
        claimed = true;
        await this.syncDirectory(targetDirectory);
        const opened = await openRegularFileNoFollow(claimedPath);
        claimedHandle = opened.handle;
        claimedStat = opened.stat;
        await partitionCommitTestFaults.get(this)?.("after-claim-open");
        const prepared = await exactOpenFileAddress(claimedHandle);
        const afterPreparedHash = await claimedHandle.stat();
        if (
          !afterPreparedHash.isFile() ||
          afterPreparedHash.nlink !== 1 ||
          !sameInode(claimedStat, afterPreparedHash)
        ) {
          throw new PartitionFileIntegrityError(claimedPath, "claimed inode changed while hashing");
        }
        await requireNamedRegularInode(claimedPath, claimedStat);
        if (prepared.address !== captured.file.address || prepared.bytes !== captured.file.bytes) {
          throw new Error("Prepared partition bytes do not match the supplied fingerprint");
        }
        await claimedHandle.sync();
        await this.syncDirectory(targetDirectory);

        const previous = await this.authorityWithRebuiltHead(captured);
        let stored: StoredPartitionCommit;
        let pendingEvent:
          | { receipt: StoredPartitionCommit; previousEvent?: CanonicalJsonAddress }
          | undefined;
        if (previous && sameCommitContent(previous.commit.receipt, captured)) {
          stored = previous.commit;
        } else {
          const receipt: PartitionCommitReceiptV1 = {
            kind: PARTITION_COMMIT_RECEIPT_KIND,
            version: PARTITION_COMMIT_RECEIPT_VERSION,
            schemaRevision: captured.schemaRevision,
            dataset: captured.dataset,
            partition: captured.partition,
            relativePath: captured.relativePath,
            coverage: captured.coverage,
            quality: captured.quality,
            file: captured.file,
            classification: previous ? "repair" : "append",
            ...(previous ? { parent: previous.commit.address } : {}),
          };
          // Receipt bytes are immutable and durable before the data file is
          // installed. They are not authoritative/discoverable until the
          // event index is appended after the rename.
          const publishedReceipt = await this.objects.put(receipt);
          stored = {
            address: publishedReceipt.address,
            receipt: publishedReceipt.value,
            created: publishedReceipt.created,
          };
          Object.freeze(stored);
          pendingEvent = { receipt: stored, previousEvent: previous?.eventAddress };
        }

        // Revalidate the directory chain and the claimed name immediately
        // before rename. Node has no renameat(2), so the post-rename inode
        // comparison below is the final fail-closed path-swap check.
        if (
          (await this.validatedTargetPath(captured.relativePath, realMarketRoot)) !== targetPath
        ) {
          throw new PartitionFileIntegrityError(targetPath, "target parent changed before install");
        }
        const beforeInstall = await claimedHandle.stat();
        if (
          !beforeInstall.isFile() ||
          beforeInstall.nlink !== 1 ||
          !sameInode(claimedStat, beforeInstall)
        ) {
          throw new PartitionFileIntegrityError(
            claimedPath,
            "claimed inode changed before install",
          );
        }
        await requireNamedRegularInode(claimedPath, claimedStat);
        await fs.rename(claimedPath, targetPath);
        claimed = false;
        targetTouched = true;
        await this.syncDirectory(targetDirectory);
        await requireNamedRegularInode(targetPath, claimedStat);
        const afterInstall = await claimedHandle.stat();
        if (
          !afterInstall.isFile() ||
          afterInstall.nlink !== 1 ||
          !sameInode(claimedStat, afterInstall)
        ) {
          throw new PartitionFileIntegrityError(targetPath, "installed inode changed");
        }
        const observed = await exactOpenFileAddress(claimedHandle);
        const afterInstalledHash = await claimedHandle.stat();
        if (
          !afterInstalledHash.isFile() ||
          afterInstalledHash.nlink !== 1 ||
          !sameInode(claimedStat, afterInstalledHash)
        ) {
          throw new PartitionFileIntegrityError(
            targetPath,
            "installed inode changed while hashing",
          );
        }
        await requireNamedRegularInode(targetPath, claimedStat);
        await claimedHandle.sync();
        if (
          observed.address !== stored.receipt.file.address ||
          observed.bytes !== stored.receipt.file.bytes
        ) {
          throw new Error("Installed partition bytes disagree with immutable commit authority");
        }

        if (pendingEvent) {
          const eventAddress = await this.appendEvent(
            captured,
            pendingEvent.receipt.address,
            pendingEvent.previousEvent,
          );
          await partitionCommitTestFaults.get(this)?.("after-event-before-head");
          await this.writeHead(captured, { eventAddress, commit: pendingEvent.receipt });
        }
        const tip = await this.authorityWithRebuiltHead(captured);
        if (!tip || tip.commit.address !== stored.address) {
          throw new Error("Installed partition and authoritative head disagree");
        }
        if (
          (await this.validatedTargetPath(captured.relativePath, realMarketRoot)) !== targetPath
        ) {
          throw new PartitionFileIntegrityError(
            targetPath,
            "target parent changed before publication completed",
          );
        }
        const beforeReturn = await claimedHandle.stat();
        if (
          !beforeReturn.isFile() ||
          beforeReturn.nlink !== 1 ||
          !sameInode(claimedStat, beforeReturn)
        ) {
          throw new PartitionFileIntegrityError(
            targetPath,
            "installed inode changed before publication completed",
          );
        }
        await requireNamedRegularInode(targetPath, claimedStat);
        const finalObserved = await exactOpenFileAddress(claimedHandle);
        const afterFinalHash = await claimedHandle.stat();
        if (
          !afterFinalHash.isFile() ||
          afterFinalHash.nlink !== 1 ||
          !sameInode(claimedStat, afterFinalHash)
        ) {
          throw new PartitionFileIntegrityError(
            targetPath,
            "installed inode changed during final verification",
          );
        }
        await requireNamedRegularInode(targetPath, claimedStat);
        if (
          finalObserved.address !== stored.receipt.file.address ||
          finalObserved.bytes !== stored.receipt.file.bytes
        ) {
          throw new Error("Installed partition changed before publication completed");
        }
        return stored;
      } catch (error) {
        if (targetTouched) {
          throw new PartitionFilePublicationError(targetPath, captured.file, error);
        }
        throw error;
      } finally {
        await claimedHandle?.close();
        if (claimed) await this.restoreOrQuarantineClaim(claimedPath, preparedPath);
      }
    });
  }

  async inspectPartition(identity: PartitionIdentity): Promise<PartitionInspection> {
    const captured = captureIdentity(identity);
    const realMarketRoot = await this.validateMarketRoot();
    return this.withPartitionLock(captured, async () => {
      const tip = await this.authorityWithRebuiltHead(captured);
      const relativePath = tip?.commit.receipt.relativePath ?? canonicalRelativePath(captured);
      validateRegistryPath(captured, relativePath);
      let observed: Omit<ExactFileFingerprint, "rows">;
      try {
        const targetPath = await this.validatedTargetPath(relativePath, realMarketRoot);
        observed = await exactFileAddress(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return tip ? { status: "missing", receipt: tip.commit } : { status: "absent" };
        }
        throw error;
      }
      if (!tip) return { status: "orphan", observed };
      if (
        tip.commit.receipt.file.address !== observed.address ||
        tip.commit.receipt.file.bytes !== observed.bytes
      ) {
        return { status: "mismatch", receipt: tip.commit, observed };
      }
      return { status: "match", receipt: tip.commit };
    });
  }
}

export class PartitionFilePublicationError extends Error {
  constructor(
    readonly targetPath: string,
    readonly file: ExactFileFingerprint,
    cause: unknown,
  ) {
    super(`Partition file installed without a complete projected commit: ${targetPath}`, { cause });
    this.name = "PartitionFilePublicationError";
  }
}
