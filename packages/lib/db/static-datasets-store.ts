/**
 * Static Datasets Store - CRUD operations for static dataset metadata
 */

import type { StaticDataset, MatchStrategy } from "../models/static-dataset.ts";
import { STORES, withReadTransaction, withWriteTransaction, promisifyRequest } from "./index.ts";

/**
 * Create a new static dataset
 */
export async function createStaticDataset(dataset: StaticDataset): Promise<void> {
  await withWriteTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    await promisifyRequest(store.add(dataset));
  });
}

/**
 * Get a static dataset by ID
 */
export async function getStaticDataset(id: string): Promise<StaticDataset | null> {
  return withReadTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const result = await promisifyRequest(store.get(id));
    return result ?? null;
  });
}

/**
 * Get a static dataset by name
 */
export async function getStaticDatasetByName(name: string): Promise<StaticDataset | null> {
  return withReadTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const index = store.index("name");
    const result = await promisifyRequest(index.get(name));
    return result ?? null;
  });
}

/**
 * Get all static datasets
 */
export async function getAllStaticDatasets(): Promise<StaticDataset[]> {
  return withReadTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const result = await promisifyRequest(store.getAll());
    // Sort by upload date (newest first)
    return result.sort((a, b) => {
      const dateA = new Date(a.uploadedAt).getTime();
      const dateB = new Date(b.uploadedAt).getTime();
      return dateB - dateA;
    });
  });
}

/**
 * Update a static dataset's match strategy
 */
export async function updateStaticDatasetMatchStrategy(
  id: string,
  matchStrategy: MatchStrategy,
): Promise<void> {
  await withWriteTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const existing = await promisifyRequest(store.get(id));

    if (!existing) {
      throw new Error(`Static dataset with id ${id} not found`);
    }

    const updated: StaticDataset = { ...existing, matchStrategy };
    await promisifyRequest(store.put(updated));
  });
}

/**
 * Update a static dataset's name
 */
export async function updateStaticDatasetName(id: string, name: string): Promise<void> {
  await withWriteTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const existing = await promisifyRequest(store.get(id));

    if (!existing) {
      throw new Error(`Static dataset with id ${id} not found`);
    }

    const updated: StaticDataset = { ...existing, name };
    await promisifyRequest(store.put(updated));
  });
}

/**
 * Delete a static dataset by ID
 * Note: This only deletes the metadata. Use deleteStaticDatasetWithRows for full deletion.
 */
export async function deleteStaticDataset(id: string): Promise<void> {
  await withWriteTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    await promisifyRequest(store.delete(id));
  });
}

/**
 * Check if a dataset name is already in use
 */
export async function isDatasetNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const existing = await getStaticDatasetByName(name);
  if (!existing) return false;
  if (excludeId && existing.id === excludeId) return false;
  return true;
}

/**
 * Get total count of static datasets
 */
export async function getStaticDatasetCount(): Promise<number> {
  return withReadTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS);
    const result = await promisifyRequest(store.count());
    return result;
  });
}
