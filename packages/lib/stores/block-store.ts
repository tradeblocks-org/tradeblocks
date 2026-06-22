import { create } from "zustand";
import { PortfolioStatsCalculator } from "../calculations/portfolio-stats.ts";
import {
  deleteBlock as dbDeleteBlock,
  updateBlock as dbUpdateBlock,
  getAllBlocks,
  getBlock,
  getDailyLogsByBlock,
  getReportingTradesByBlock,
  updateBlockStats,
  storePerformanceSnapshotCache,
} from "../db/index.ts";
import {
  buildPerformanceSnapshot,
  type SnapshotProgress,
} from "../services/performance-snapshot.ts";
import type { ProcessedBlock } from "../models/block.ts";
import type { StrategyAlignment } from "../models/strategy-alignment.ts";

export interface Block {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  created: Date;
  lastModified: Date;
  tradeLog: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  dailyLog?: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  reportingLog?: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  dateRange?: {
    start: Date;
    end: Date;
  };
  stats: {
    totalPnL: number;
    winRate: number;
    totalTrades: number;
    avgWin: number;
    avgLoss: number;
  };
  strategyAlignment?: {
    mappings: StrategyAlignment[];
    updatedAt: Date;
  };
}

interface BlockStore {
  // State
  blocks: Block[];
  activeBlockId: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  isStuck: boolean;
  error: string | null;

  // Actions
  loadBlocks: () => Promise<void>;
  setActiveBlock: (blockId: string) => void;
  clearActiveBlock: () => void;
  addBlock: (block: Omit<Block, "created"> | Omit<Block, "id" | "created">) => Promise<void>;
  updateBlock: (id: string, updates: Partial<Block>) => Promise<void>;
  deleteBlock: (id: string) => Promise<void>;
  refreshBlock: (id: string) => Promise<void>;
  recalculateBlock: (
    id: string,
    onProgress?: (progress: SnapshotProgress) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  clearAllData: () => Promise<void>;
}

/**
 * Convert ProcessedBlock from DB to Block for UI
 */
function convertProcessedBlockToBlock(
  processedBlock: ProcessedBlock,
  tradeCount: number,
  dailyLogCount: number,
  reportingLogCount: number,
): Block {
  return {
    id: processedBlock.id,
    name: processedBlock.name || "Unnamed Block",
    description: processedBlock.description,
    isActive: false, // Will be set by active block logic
    created: processedBlock.created,
    lastModified: processedBlock.lastModified,
    tradeLog: {
      fileName: processedBlock.tradeLog?.fileName || "unknown.csv",
      rowCount: tradeCount,
      fileSize: processedBlock.tradeLog?.fileSize || 0,
    },
    dailyLog: processedBlock.dailyLog
      ? {
          fileName: processedBlock.dailyLog.fileName || "unknown.csv",
          rowCount: dailyLogCount,
          fileSize: processedBlock.dailyLog.fileSize || 0,
        }
      : undefined,
    reportingLog: processedBlock.reportingLog
      ? {
          fileName: processedBlock.reportingLog.fileName || "unknown.csv",
          rowCount: reportingLogCount,
          fileSize: processedBlock.reportingLog.fileSize || 0,
        }
      : undefined,
    strategyAlignment: processedBlock.strategyAlignment
      ? {
          mappings: processedBlock.strategyAlignment.mappings ?? [],
          updatedAt: new Date(processedBlock.strategyAlignment.updatedAt),
        }
      : undefined,
    dateRange: processedBlock.dateRange
      ? {
          start: new Date(processedBlock.dateRange.start),
          end: new Date(processedBlock.dateRange.end),
        }
      : undefined,
    stats: {
      totalPnL: 0, // Will be calculated from trades
      winRate: 0,
      totalTrades: tradeCount,
      avgWin: 0,
      avgLoss: 0,
    },
  };
}

// Timeout for detecting stuck loading state (30 seconds)
const LOAD_TIMEOUT_MS = 30000;

export const useBlockStore = create<BlockStore>((set, get) => ({
  // Initialize with empty state
  blocks: [],
  activeBlockId: null,
  isLoading: false,
  isInitialized: false,
  isStuck: false,
  error: null,

  // Load blocks from IndexedDB
  loadBlocks: async () => {
    const state = get();

    // Prevent multiple concurrent loads
    if (state.isLoading || state.isInitialized) {
      return;
    }

    set({ isLoading: true, error: null, isStuck: false });

    // Create timeout for stuck detection
    const timeoutRef: { id: ReturnType<typeof setTimeout> | null } = { id: null };
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutRef.id = setTimeout(() => reject(new Error("LOAD_TIMEOUT")), LOAD_TIMEOUT_MS);
    });

    // Main loading logic wrapped in a promise for racing
    const loadingPromise = (async () => {
      // Restore active block ID from localStorage
      const savedActiveBlockId = localStorage.getItem("tradeblocks-active-block-id");

      const processedBlocks = await getAllBlocks();
      const blocks: Block[] = [];

      // Import getTradesByBlockWithOptions
      const { getTradesByBlockWithOptions } = await import("../db/index.ts");

      // Convert each ProcessedBlock to Block with trade/daily log counts
      for (const processedBlock of processedBlocks) {
        try {
          // Use combineLegGroups setting from block config
          const combineLegGroups = processedBlock.analysisConfig?.combineLegGroups ?? false;

          const [trades, dailyLogs, reportingTrades] = await Promise.all([
            getTradesByBlockWithOptions(processedBlock.id, { combineLegGroups }),
            getDailyLogsByBlock(processedBlock.id),
            getReportingTradesByBlock(processedBlock.id),
          ]);

          // Calculate stats from trades
          const stats =
            trades.length > 0
              ? {
                  totalPnL: trades.reduce((sum, trade) => sum + trade.pl, 0),
                  winRate: (trades.filter((t) => t.pl > 0).length / trades.length) * 100,
                  totalTrades: trades.length,
                  avgWin:
                    trades.filter((t) => t.pl > 0).length > 0
                      ? trades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0) /
                        trades.filter((t) => t.pl > 0).length
                      : 0,
                  avgLoss:
                    trades.filter((t) => t.pl < 0).length > 0
                      ? trades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0) /
                        trades.filter((t) => t.pl < 0).length
                      : 0,
                }
              : {
                  totalPnL: 0,
                  winRate: 0,
                  totalTrades: 0,
                  avgWin: 0,
                  avgLoss: 0,
                };

          const block = convertProcessedBlockToBlock(
            processedBlock,
            trades.length,
            dailyLogs.length,
            reportingTrades.length,
          );
          block.stats = stats;

          // Mark as active if this was the previously active block
          block.isActive = block.id === savedActiveBlockId;

          blocks.push(block);
        } catch (blockError) {
          console.error(`Failed to load block ${processedBlock.id}:`, blockError);
          // Continue loading other blocks instead of failing completely
        }
      }

      // Set the active block ID if one was restored
      const activeBlockId =
        savedActiveBlockId && blocks.some((b) => b.id === savedActiveBlockId)
          ? savedActiveBlockId
          : null;

      set({ blocks, activeBlockId, isLoading: false, isInitialized: true });
    })();

    try {
      await Promise.race([loadingPromise, timeoutPromise]);
      // Clear timeout on success to prevent unhandled rejection
      if (timeoutRef.id) clearTimeout(timeoutRef.id);
    } catch (error) {
      // Clear timeout to prevent duplicate errors
      if (timeoutRef.id) clearTimeout(timeoutRef.id);
      console.error("Failed to load blocks:", error);

      // Check if this was a timeout
      if (error instanceof Error && error.message === "LOAD_TIMEOUT") {
        set({
          isStuck: true,
          isLoading: false,
          isInitialized: true,
        });
      } else {
        set({
          error: error instanceof Error ? error.message : "Failed to load blocks",
          isLoading: false,
          isInitialized: true,
        });
      }
    }
  },

  // Actions
  setActiveBlock: (blockId: string) => {
    // Save to localStorage for persistence
    localStorage.setItem("tradeblocks-active-block-id", blockId);

    set((state) => ({
      blocks: state.blocks.map((block) => ({
        ...block,
        isActive: block.id === blockId,
      })),
      activeBlockId: blockId,
    }));
  },

  clearActiveBlock: () => {
    // Remove from localStorage
    localStorage.removeItem("tradeblocks-active-block-id");

    set((state) => ({
      blocks: state.blocks.map((block) => ({
        ...block,
        isActive: false,
      })),
      activeBlockId: null,
    }));
  },

  addBlock: async (blockData) => {
    try {
      const newBlock: Block = {
        ...blockData,
        id: "id" in blockData ? blockData.id : crypto.randomUUID(), // Use provided ID or generate new one
        created: new Date(),
        lastModified: new Date(),
      };

      // Debug logging
      if (newBlock.isActive) {
        console.log("Adding new active block:", newBlock.id, newBlock.name);
      }

      // Update state properly handling active block logic
      set((state) => {
        if (newBlock.isActive) {
          // If new block is active, deactivate all others and set new one as active
          localStorage.setItem("tradeblocks-active-block-id", newBlock.id);
          console.log("Set active block in localStorage:", newBlock.id);
          return {
            blocks: [...state.blocks.map((b) => ({ ...b, isActive: false })), newBlock],
            activeBlockId: newBlock.id,
          };
        } else {
          // If new block is not active, just add it
          return {
            blocks: [...state.blocks, newBlock],
          };
        }
      });

      // If the new block is active, refresh it to load trades/daily logs
      if (newBlock.isActive) {
        console.log("Refreshing active block data for:", newBlock.id);
        // Use setTimeout to ensure the block is added to the state first
        setTimeout(async () => {
          try {
            await get().refreshBlock(newBlock.id);
            console.log("Block refreshed successfully");
          } catch (refreshError) {
            console.error("Failed to refresh block:", refreshError);
          }
        }, 100);
      }
    } catch (error) {
      console.error("Failed to add block:", error);
      set({
        error: error instanceof Error ? error.message : "Failed to add block",
      });
    }
  },

  updateBlock: async (id: string, updates: Partial<Block>) => {
    try {
      // Update in IndexedDB
      await dbUpdateBlock(id, {
        name: updates.name,
        description: updates.description,
        // Add other updatable fields as needed
      });

      // Update local state
      set((state) => ({
        blocks: state.blocks.map((block) =>
          block.id === id ? { ...block, ...updates, lastModified: new Date() } : block,
        ),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update block",
      });
    }
  },

  deleteBlock: async (id: string) => {
    try {
      // Delete from IndexedDB
      await dbDeleteBlock(id);

      // Update local state
      set((state) => {
        const remainingBlocks = state.blocks.filter((block) => block.id !== id);
        const wasActive = state.activeBlockId === id;

        // If we deleted the active block, clear localStorage
        if (wasActive) {
          localStorage.removeItem("tradeblocks-active-block-id");
        }

        return {
          blocks: remainingBlocks,
          // If we deleted the active block, clear the active state
          activeBlockId: wasActive ? null : state.activeBlockId,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete block",
      });
    }
  },

  refreshBlock: async (id: string) => {
    try {
      const processedBlock = await getBlock(id);
      if (!processedBlock) return;

      // Use combineLegGroups setting from block config
      const combineLegGroups = processedBlock.analysisConfig?.combineLegGroups ?? false;
      const { getTradesByBlockWithOptions } = await import("../db/index.ts");

      const [trades, dailyLogs, reportingTrades] = await Promise.all([
        getTradesByBlockWithOptions(id, { combineLegGroups }),
        getDailyLogsByBlock(id),
        getReportingTradesByBlock(id),
      ]);

      // Calculate fresh stats
      const stats =
        trades.length > 0
          ? {
              totalPnL: trades.reduce((sum, trade) => sum + trade.pl, 0),
              winRate: (trades.filter((t) => t.pl > 0).length / trades.length) * 100,
              totalTrades: trades.length,
              avgWin:
                trades.filter((t) => t.pl > 0).length > 0
                  ? trades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0) /
                    trades.filter((t) => t.pl > 0).length
                  : 0,
              avgLoss:
                trades.filter((t) => t.pl < 0).length > 0
                  ? trades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0) /
                    trades.filter((t) => t.pl < 0).length
                  : 0,
            }
          : {
              totalPnL: 0,
              winRate: 0,
              totalTrades: 0,
              avgWin: 0,
              avgLoss: 0,
            };

      const updatedBlock = convertProcessedBlockToBlock(
        processedBlock,
        trades.length,
        dailyLogs.length,
        reportingTrades.length,
      );
      updatedBlock.stats = stats;

      // Update in store
      set((state) => ({
        blocks: state.blocks.map((block) =>
          block.id === id ? { ...updatedBlock, isActive: block.isActive } : block,
        ),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to refresh block",
      });
    }
  },

  recalculateBlock: async (
    id: string,
    onProgress?: (progress: SnapshotProgress) => void,
    signal?: AbortSignal,
  ) => {
    try {
      console.log("Recalculating block:", id);
      set({ error: null });

      // Get the block and its data
      const processedBlock = await getBlock(id);
      if (!processedBlock) {
        throw new Error("Block not found");
      }

      // Use combineLegGroups setting from block config
      const combineLegGroups = processedBlock.analysisConfig?.combineLegGroups ?? false;
      const { getTradesByBlockWithOptions } = await import("../db/index.ts");

      const [trades, dailyLogs, reportingTrades] = await Promise.all([
        getTradesByBlockWithOptions(id, { combineLegGroups }),
        getDailyLogsByBlock(id),
        getReportingTradesByBlock(id),
      ]);

      console.log(
        `Recalculating stats for ${trades.length} trades and ${dailyLogs.length} daily logs`,
      );

      // Recalculate all stats using the current calculation engine
      const calculator = new PortfolioStatsCalculator();

      const portfolioStats = calculator.calculatePortfolioStats(trades, dailyLogs);
      const strategyStats = calculator.calculateStrategyStats(trades);

      // Update ProcessedBlock stats in database
      await updateBlockStats(id, portfolioStats, strategyStats);

      // Build and cache performance snapshot for instant page loads
      console.log("Building performance snapshot cache...");
      const snapshot = await buildPerformanceSnapshot({
        trades,
        dailyLogs,
        normalizeTo1Lot: false,
        onProgress,
        signal,
      });
      await storePerformanceSnapshotCache(id, snapshot);
      console.log("Performance snapshot cached successfully");

      // Update lastModified timestamp
      await dbUpdateBlock(id, { lastModified: new Date() });

      // Calculate basic stats for the UI (Block interface)
      const basicStats = {
        totalPnL: portfolioStats.totalPl,
        winRate: portfolioStats.winRate * 100, // Convert to percentage for Block interface
        totalTrades: portfolioStats.totalTrades,
        avgWin: portfolioStats.avgWin,
        avgLoss: portfolioStats.avgLoss,
      };

      // Create updated block for store
      const updatedBlock = convertProcessedBlockToBlock(
        processedBlock,
        trades.length,
        dailyLogs.length,
        reportingTrades.length,
      );
      updatedBlock.stats = basicStats;
      updatedBlock.lastModified = new Date();

      // Update in store
      set((state) => ({
        blocks: state.blocks.map((block) =>
          block.id === id ? { ...updatedBlock, isActive: block.isActive } : block,
        ),
      }));

      console.log(
        "Block recalculation completed successfully. Initial capital:",
        portfolioStats.initialCapital,
      );
    } catch (error) {
      console.error("Failed to recalculate block:", error);
      set({
        error: error instanceof Error ? error.message : "Failed to recalculate block",
      });
    }
  },

  // Clear all data and reload (for recovery from corrupted state)
  clearAllData: async () => {
    // Helper to delete a database with timeout (won't hang on corruption)
    const safeDeleteDb = (dbName: string, timeoutMs = 3000): Promise<void> => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn(`Deletion of ${dbName} timed out - will complete after reload`);
          resolve();
        }, timeoutMs);

        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => {
          clearTimeout(timeout);
          resolve();
        };
        req.onerror = () => {
          clearTimeout(timeout);
          resolve();
        }; // Don't block on error
        req.onblocked = () => {
          clearTimeout(timeout);
          resolve();
        }; // Will complete after reload
      });
    };

    try {
      // Clear localStorage first (this is synchronous and always works)
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith("tradeblocks-") ||
            key.startsWith("block-stats:") ||
            key.startsWith("comparison:") ||
            key.startsWith("performance:") ||
            key.startsWith("current-") ||
            key.startsWith("daily-log-") ||
            key.startsWith("portfolio-"))
        ) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));

      // Also clear sessionStorage
      sessionStorage.clear();

      // Delete the main TradeBlocksDB
      const { deleteDatabase } = await import("../db/index.ts");
      await deleteDatabase();

      // Also delete the cache database if it exists
      await safeDeleteDb("tradeblocks-cache");

      // Force reload with cache bypass
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear database:", error);
      // Even if delete fails, reload anyway - the blocked deletion will
      // complete once the page unloads and all connections are closed
      window.location.reload();
    }
  },
}));
