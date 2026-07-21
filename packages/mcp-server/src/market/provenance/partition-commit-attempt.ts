import { AsyncLocalStorage } from "node:async_hooks";
import type { PartitionCommitRecorder, StoredPartitionCommit } from "./partition-commit-store.ts";
import type { CanonicalJsonAddress } from "./canonical-json.ts";

export interface PartitionCommitAttemptOptions {
  /** Caller-owned correlation identifier; not part of receipt content identity. */
  attemptId: string;
  recorder: PartitionCommitRecorder;
}

export interface PartitionCommitAttemptResult<T> {
  attemptId: string;
  value: T;
  receipts: readonly StoredPartitionCommit[];
}

interface ActivePartitionCommitAttempt extends PartitionCommitAttemptOptions {
  receiptAddresses: CanonicalJsonAddress[];
}

const attempts = new AsyncLocalStorage<ActivePartitionCommitAttempt>();

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function commitTuple(commit: StoredPartitionCommit): string[] {
  const partition = Object.entries(commit.receipt.partition)
    .sort(([left], [right]) => compareCodePoints(left, right))
    .flatMap(([key, value]) => [key, value]);
  return [commit.receipt.dataset, ...partition, commit.address];
}

function compareTuple(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const compared = compareCodePoints(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

/**
 * Run an ingest/write operation with exact-byte partition receipt capture.
 *
 * Store APIs remain unchanged: canonical dataset writers discover this async
 * scope, persist receipts through its recorder, and append successful commits
 * to the returned list. Outside a scope, those writers retain legacy behavior
 * and skip the hashing/receipt work entirely.
 */
export async function runPartitionCommitAttempt<T>(
  options: PartitionCommitAttemptOptions,
  operation: () => Promise<T>,
): Promise<PartitionCommitAttemptResult<T>> {
  if (options.attemptId.trim().length === 0) {
    throw new TypeError("Partition commit attemptId must not be empty");
  }
  const active: ActivePartitionCommitAttempt = { ...options, receiptAddresses: [] };
  const value = await attempts.run(active, operation);
  const receipts = await Promise.all(
    [...new Set(active.receiptAddresses)].map((address) => active.recorder.readCommit(address)),
  );
  receipts.sort((left, right) => compareTuple(commitTuple(left), commitTuple(right)));
  return {
    attemptId: active.attemptId,
    value,
    receipts: Object.freeze(receipts),
  };
}

/** @internal Package-internal canonical writer hook; omitted from the public barrel. */
export function activePartitionCommitAttempt():
  | Pick<ActivePartitionCommitAttempt, "attemptId" | "recorder">
  | undefined {
  return attempts.getStore();
}

/** @internal Package-internal hook; captures only successfully projected commits. */
export function capturePartitionCommitReceipt(receipt: StoredPartitionCommit): void {
  const active = attempts.getStore();
  if (!active) return;
  active.receiptAddresses.push(receipt.address);
}
