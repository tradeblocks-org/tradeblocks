import type { WalkForwardAnalysis } from "../models/walk-forward.ts";
import {
  INDEXES,
  STORES,
  promisifyRequest,
  withReadTransaction,
  withWriteTransaction,
} from "./index.ts";

export async function saveWalkForwardAnalysis(analysis: WalkForwardAnalysis): Promise<void> {
  await withWriteTransaction(STORES.WALK_FORWARD, async (transaction) => {
    const store = transaction.objectStore(STORES.WALK_FORWARD);
    await promisifyRequest(store.put(analysis));
  });
}

export async function getWalkForwardAnalysis(id: string): Promise<WalkForwardAnalysis | undefined> {
  return withReadTransaction(STORES.WALK_FORWARD, async (transaction) => {
    const store = transaction.objectStore(STORES.WALK_FORWARD);
    const result = await promisifyRequest(store.get(id));
    return result ?? undefined;
  });
}

export async function getWalkForwardAnalysesByBlock(
  blockId: string,
): Promise<WalkForwardAnalysis[]> {
  return withReadTransaction(STORES.WALK_FORWARD, async (transaction) => {
    const store = transaction.objectStore(STORES.WALK_FORWARD);
    const index = store.index(INDEXES.WALK_FORWARD_BY_BLOCK);
    const result = await promisifyRequest(index.getAll(blockId));

    return result
      .map((entry) => ({
        ...entry,
        createdAt: new Date(entry.createdAt),
        updatedAt: entry.updatedAt ? new Date(entry.updatedAt) : undefined,
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });
}

export async function deleteWalkForwardAnalysis(id: string): Promise<void> {
  await withWriteTransaction(STORES.WALK_FORWARD, async (transaction) => {
    const store = transaction.objectStore(STORES.WALK_FORWARD);
    await promisifyRequest(store.delete(id));
  });
}

export async function deleteWalkForwardAnalysesByBlock(blockId: string): Promise<void> {
  await withWriteTransaction(STORES.WALK_FORWARD, async (transaction) => {
    const store = transaction.objectStore(STORES.WALK_FORWARD);
    const index = store.index(INDEXES.WALK_FORWARD_BY_BLOCK);
    const request = index.openCursor(IDBKeyRange.only(blockId));

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}
