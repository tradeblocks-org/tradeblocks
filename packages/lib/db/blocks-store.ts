/**
 * Blocks Store - CRUD operations for trading blocks
 */

import type { ProcessedBlock, Block } from '../models/block.ts'
import { STORES, withReadTransaction, withWriteTransaction, promisifyRequest, DatabaseError } from './index.ts'

/**
 * Create a new block
 */
export async function createBlock(blockData: Omit<ProcessedBlock, 'id' | 'created' | 'lastModified'>): Promise<ProcessedBlock> {
  const block: ProcessedBlock = {
    ...blockData,
    id: crypto.randomUUID(),
    created: new Date(),
    lastModified: new Date(),
  }

  await withWriteTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    await promisifyRequest(store.add(block))
  })

  return block
}

/**
 * Get block by ID
 */
export async function getBlock(blockId: string): Promise<ProcessedBlock | null> {
  return withReadTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    const result = await promisifyRequest(store.get(blockId))
    return result || null
  })
}

/**
 * Get all blocks
 */
export async function getAllBlocks(): Promise<ProcessedBlock[]> {
  return withReadTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    const result = await promisifyRequest(store.getAll())

    // Sort by last modified (newest first)
    return result.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
  })
}

/**
 * Get active block
 */
export async function getActiveBlock(): Promise<ProcessedBlock | null> {
  return withReadTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    const index = store.index('isActive')
    const result = await promisifyRequest(index.get(true as unknown as IDBValidKey))
    return result || null
  })
}

/**
 * Update block
 */
export async function updateBlock(blockId: string, updates: Partial<ProcessedBlock>): Promise<ProcessedBlock> {
  return withWriteTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)

    // Get existing block
    const existing = await promisifyRequest(store.get(blockId))
    if (!existing) {
      throw new DatabaseError(`Block not found: ${blockId}`, 'update', STORES.BLOCKS)
    }

    // Merge updates with lastModified timestamp
    const updatedBlock: ProcessedBlock = {
      ...existing,
      ...updates,
      lastModified: new Date(),
    }

    await promisifyRequest(store.put(updatedBlock))
    return updatedBlock
  })
}

/**
 * Set active block (deactivates all others)
 */
export async function setActiveBlock(blockId: string): Promise<void> {
  await withWriteTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)

    // First, verify the block exists
    const targetBlock = await promisifyRequest(store.get(blockId))
    if (!targetBlock) {
      throw new DatabaseError(`Block not found: ${blockId}`, 'setActive', STORES.BLOCKS)
    }

    // Get all blocks and update their active status
    const allBlocks = await promisifyRequest(store.getAll())

    for (const block of allBlocks) {
      const isActive = block.id === blockId
      if (block.isActive !== isActive) {
        await promisifyRequest(store.put({
          ...block,
          isActive,
          lastModified: new Date(),
        }))
      }
    }
  })
}

/**
 * Delete block and all associated data
 */
export async function deleteBlock(blockId: string): Promise<void> {
  await withWriteTransaction([STORES.BLOCKS, STORES.TRADES, STORES.DAILY_LOGS, STORES.CALCULATIONS, STORES.REPORTING_LOGS], async (transaction) => {
    // Delete block
    const blocksStore = transaction.objectStore(STORES.BLOCKS)
    await promisifyRequest(blocksStore.delete(blockId))

    // Delete associated trades
    const tradesStore = transaction.objectStore(STORES.TRADES)
    const tradesIndex = tradesStore.index('blockId')
    const tradesRequest = tradesIndex.openCursor(IDBKeyRange.only(blockId))

    await new Promise<void>((resolve, reject) => {
      tradesRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      tradesRequest.onerror = () => reject(tradesRequest.error)
    })

    // Delete associated daily logs
    const dailyLogsStore = transaction.objectStore(STORES.DAILY_LOGS)
    const dailyLogsIndex = dailyLogsStore.index('blockId')
    const dailyLogsRequest = dailyLogsIndex.openCursor(IDBKeyRange.only(blockId))

    await new Promise<void>((resolve, reject) => {
      dailyLogsRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      dailyLogsRequest.onerror = () => reject(dailyLogsRequest.error)
    })

    // Delete associated reporting trades
    const reportingStore = transaction.objectStore(STORES.REPORTING_LOGS)
    const reportingIndex = reportingStore.index('blockId')
    const reportingRequest = reportingIndex.openCursor(IDBKeyRange.only(blockId))

    await new Promise<void>((resolve, reject) => {
      reportingRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      reportingRequest.onerror = () => reject(reportingRequest.error)
    })

    // Delete associated calculations
    const calculationsStore = transaction.objectStore(STORES.CALCULATIONS)
    const calculationsIndex = calculationsStore.index('blockId')
    const calculationsRequest = calculationsIndex.openCursor(IDBKeyRange.only(blockId))

    await new Promise<void>((resolve, reject) => {
      calculationsRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      calculationsRequest.onerror = () => reject(calculationsRequest.error)
    })
  })
}

/**
 * Get blocks count
 */
export async function getBlocksCount(): Promise<number> {
  return withReadTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    const result = await promisifyRequest(store.count())
    return result
  })
}

/**
 * Check if block name is unique
 */
export async function isBlockNameUnique(name: string, excludeId?: string): Promise<boolean> {
  return withReadTransaction(STORES.BLOCKS, async (transaction) => {
    const store = transaction.objectStore(STORES.BLOCKS)
    const index = store.index('name')
    const result = await promisifyRequest(index.getAll(name))

    if (excludeId) {
      return result.filter(block => block.id !== excludeId).length === 0
    }

    return result.length === 0
  })
}

/**
 * Update block processing status
 */
export async function updateProcessingStatus(
  blockId: string,
  status: ProcessedBlock['processingStatus'],
  error?: string
): Promise<void> {
  await updateBlock(blockId, {
    processingStatus: status,
    processingError: error,
    ...(status === 'completed' && { lastProcessedAt: new Date() }),
  })
}

/**
 * Update block statistics
 */
export async function updateBlockStats(
  blockId: string,
  portfolioStats: ProcessedBlock['portfolioStats'],
  strategyStats?: ProcessedBlock['strategyStats'],
  performanceMetrics?: ProcessedBlock['performanceMetrics']
): Promise<void> {
  await updateBlock(blockId, {
    portfolioStats,
    strategyStats,
    performanceMetrics,
  })
}

/**
 * Convert ProcessedBlock to legacy Block format (for backward compatibility)
 */
export function toLegacyBlock(processedBlock: ProcessedBlock): Block {
  return {
    id: processedBlock.id,
    name: processedBlock.name,
    description: processedBlock.description,
    isActive: processedBlock.isActive,
    created: processedBlock.created,
    lastModified: processedBlock.lastModified,
    tradeLog: {
      fileName: processedBlock.tradeLog.fileName,
      rowCount: processedBlock.tradeLog.processedRowCount,
      fileSize: processedBlock.tradeLog.fileSize,
    },
    dailyLog: processedBlock.dailyLog ? {
      fileName: processedBlock.dailyLog.fileName,
      rowCount: processedBlock.dailyLog.processedRowCount,
      fileSize: processedBlock.dailyLog.fileSize,
    } : undefined,
    stats: {
      totalPnL: processedBlock.portfolioStats?.totalPl || 0,
      winRate: processedBlock.portfolioStats?.winRate || 0,
      totalTrades: processedBlock.portfolioStats?.totalTrades || 0,
      avgWin: processedBlock.portfolioStats?.avgWin || 0,
      avgLoss: processedBlock.portfolioStats?.avgLoss || 0,
    },
  }
}
