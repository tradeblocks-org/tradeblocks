/**
 * Static Dataset Rows Store - CRUD operations for static dataset data rows
 */

import type { StaticDatasetRow, StoredStaticDatasetRow } from '../models/static-dataset.ts'
import { STORES, INDEXES, withReadTransaction, withWriteTransaction, promisifyRequest } from './index.ts'

/**
 * Add rows for a static dataset (batch operation with chunking)
 * Processes in batches to avoid memory issues with large datasets
 */
export async function addStaticDatasetRows(
  datasetId: string,
  rows: Omit<StaticDatasetRow, 'datasetId'>[]
): Promise<void> {
  if (rows.length === 0) return

  // Process in chunks to avoid overwhelming memory/transaction
  // 10,000 rows per chunk is a safe balance for most browsers
  const CHUNK_SIZE = 10000

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE)

    await withWriteTransaction(STORES.STATIC_DATASET_ROWS, async (transaction) => {
      const store = transaction.objectStore(STORES.STATIC_DATASET_ROWS)

      const promises = chunk.map((row) => {
        const storedRow: StoredStaticDatasetRow = { ...row, datasetId }
        return promisifyRequest(store.add(storedRow))
      })

      await Promise.all(promises)
    })
  }
}

/**
 * Get all rows for a static dataset
 */
export async function getStaticDatasetRows(datasetId: string): Promise<StoredStaticDatasetRow[]> {
  return withReadTransaction(STORES.STATIC_DATASET_ROWS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASET_ROWS)
    const index = store.index(INDEXES.STATIC_DATASET_ROWS_BY_DATASET)
    const result = await promisifyRequest(index.getAll(datasetId))

    // Sort by timestamp (chronological order)
    return result.sort((a, b) => {
      const timestampA = new Date(a.timestamp).getTime()
      const timestampB = new Date(b.timestamp).getTime()
      return timestampA - timestampB
    })
  })
}

/**
 * Get rows for a dataset within a timestamp range
 */
export async function getStaticDatasetRowsByRange(
  datasetId: string,
  startTimestamp: Date,
  endTimestamp: Date
): Promise<StoredStaticDatasetRow[]> {
  return withReadTransaction(STORES.STATIC_DATASET_ROWS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASET_ROWS)
    const index = store.index('composite_dataset_timestamp')

    // Create compound key range [datasetId, startTimestamp] to [datasetId, endTimestamp]
    const range = IDBKeyRange.bound(
      [datasetId, startTimestamp],
      [datasetId, endTimestamp],
      false,
      false
    )

    const result = await promisifyRequest(index.getAll(range))
    return result
  })
}

/**
 * Get row count for a dataset
 */
export async function getStaticDatasetRowCount(datasetId: string): Promise<number> {
  return withReadTransaction(STORES.STATIC_DATASET_ROWS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASET_ROWS)
    const index = store.index(INDEXES.STATIC_DATASET_ROWS_BY_DATASET)
    const result = await promisifyRequest(index.count(datasetId))
    return result
  })
}

/**
 * Delete all rows for a dataset
 */
export async function deleteStaticDatasetRows(datasetId: string): Promise<void> {
  await withWriteTransaction(STORES.STATIC_DATASET_ROWS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASET_ROWS)
    const index = store.index(INDEXES.STATIC_DATASET_ROWS_BY_DATASET)
    const request = index.openCursor(IDBKeyRange.only(datasetId))

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      request.onerror = () => reject(request.error)
    })
  })
}

/**
 * Delete a static dataset and all its rows (full cleanup)
 */
export async function deleteStaticDatasetWithRows(datasetId: string): Promise<void> {
  // Delete rows first
  await deleteStaticDatasetRows(datasetId)

  // Then delete metadata
  await withWriteTransaction(STORES.STATIC_DATASETS, async (transaction) => {
    const store = transaction.objectStore(STORES.STATIC_DATASETS)
    await promisifyRequest(store.delete(datasetId))
  })
}

/**
 * Get the date range covered by a dataset's rows
 */
export async function getStaticDatasetDateRange(
  datasetId: string
): Promise<{ start: Date; end: Date } | null> {
  const rows = await getStaticDatasetRows(datasetId)

  if (rows.length === 0) {
    return null
  }

  const timestamps = rows.map((row) => new Date(row.timestamp).getTime())
  const minTimestamp = Math.min(...timestamps)
  const maxTimestamp = Math.max(...timestamps)

  return {
    start: new Date(minTimestamp),
    end: new Date(maxTimestamp),
  }
}
