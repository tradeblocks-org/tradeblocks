import { AsyncLocalStorage } from "node:async_hooks";
import type { PartitionCommitRecorder, StoredPartitionCommit } from "./partition-commit-store.ts";

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
  receipts: StoredPartitionCommit[];
}

const attempts = new AsyncLocalStorage<ActivePartitionCommitAttempt>();

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
  const active: ActivePartitionCommitAttempt = { ...options, receipts: [] };
  const value = await attempts.run(active, operation);
  return {
    attemptId: active.attemptId,
    value,
    receipts: Object.freeze([...active.receipts]),
  };
}

/** @internal Writer hook; public for custom canonical dataset writers. */
export function activePartitionCommitAttempt():
  | Pick<ActivePartitionCommitAttempt, "attemptId" | "recorder">
  | undefined {
  return attempts.getStore();
}

/** @internal Writer hook; records only receipts whose head commit succeeded. */
export function capturePartitionCommitReceipt(receipt: StoredPartitionCommit): void {
  const active = attempts.getStore();
  if (!active) return;
  active.receipts.push(receipt);
}
