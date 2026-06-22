/**
 * Tests for Combined Trades Cache
 */
import "fake-indexeddb/auto";
import {
  Trade,
  storeCombinedTradesCache,
  getCombinedTradesCache,
  deleteCombinedTradesCache,
  hasCombinedTradesCache,
  invalidateBlockCaches,
  combineAllLegGroups,
  initializeDatabase,
  closeDatabase,
} from "@tradeblocks/lib";

// Helper to create mock trades
function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date("2024-01-15"),
    timeOpened: "09:30:00",
    openingPrice: 4500,
    legs: "CALL 4500",
    premium: 100,
    premiumPrecision: "dollars",
    closingPrice: 50,
    dateClosed: new Date("2024-01-20"),
    timeClosed: "15:00:00",
    avgClosingCost: 50,
    reasonForClose: "Profit Target",
    pl: 50,
    numContracts: 1,
    fundsAtClose: 100050,
    marginReq: 500,
    strategy: "Call",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
    closingShortLongRatio: 0,
    ...overrides,
  };
}

describe("Combined Trades Cache", () => {
  beforeEach(async () => {
    await initializeDatabase();
  });

  afterEach(async () => {
    closeDatabase();
  });

  describe("storeCombinedTradesCache", () => {
    it("should store combined trades in cache", async () => {
      const blockId = "test-block-1";
      const trades = [
        createMockTrade({ strategy: "Iron Condor" }),
        createMockTrade({ strategy: "Iron Condor" }),
      ];
      const combinedTrades = combineAllLegGroups(trades);

      await storeCombinedTradesCache(blockId, combinedTrades);

      const cached = await getCombinedTradesCache(blockId);
      expect(cached).not.toBeNull();
      expect(cached).toHaveLength(1); // Both trades combined into one
    });
  });

  describe("getCombinedTradesCache", () => {
    it("should return null for non-existent cache", async () => {
      const result = await getCombinedTradesCache("non-existent-block");
      expect(result).toBeNull();
    });

    it("should restore Date objects correctly", async () => {
      const blockId = "test-block-2";
      const trades = [createMockTrade()];
      const combinedTrades = combineAllLegGroups(trades);

      await storeCombinedTradesCache(blockId, combinedTrades);
      const cached = await getCombinedTradesCache(blockId);

      expect(cached).not.toBeNull();
      expect(cached![0].dateOpened).toBeInstanceOf(Date);
      expect(cached![0].dateClosed).toBeInstanceOf(Date);
    });
  });

  describe("deleteCombinedTradesCache", () => {
    it("should delete cached combined trades", async () => {
      const blockId = "test-block-3";
      const trades = [createMockTrade()];
      const combinedTrades = combineAllLegGroups(trades);

      await storeCombinedTradesCache(blockId, combinedTrades);
      expect(await hasCombinedTradesCache(blockId)).toBe(true);

      await deleteCombinedTradesCache(blockId);
      expect(await hasCombinedTradesCache(blockId)).toBe(false);
    });

    it("should not throw error when deleting non-existent cache", async () => {
      await expect(deleteCombinedTradesCache("non-existent-block")).resolves.not.toThrow();
    });
  });

  describe("hasCombinedTradesCache", () => {
    it("should return true when cache exists", async () => {
      const blockId = "test-block-4";
      const trades = [createMockTrade()];
      const combinedTrades = combineAllLegGroups(trades);

      await storeCombinedTradesCache(blockId, combinedTrades);
      expect(await hasCombinedTradesCache(blockId)).toBe(true);
    });

    it("should return false when cache does not exist", async () => {
      expect(await hasCombinedTradesCache("non-existent")).toBe(false);
    });
  });

  describe("invalidateBlockCaches", () => {
    it("should delete all caches for a block", async () => {
      const blockId = "test-block-5";
      const trades = [createMockTrade()];
      const combinedTrades = combineAllLegGroups(trades);

      await storeCombinedTradesCache(blockId, combinedTrades);
      expect(await hasCombinedTradesCache(blockId)).toBe(true);

      await invalidateBlockCaches(blockId);
      expect(await hasCombinedTradesCache(blockId)).toBe(false);
    });
  });

  describe("cache with multiple leg groups", () => {
    it("should correctly cache MEIC-style multi-leg trades", async () => {
      const blockId = "test-meic-block";

      // Simulate MEIC trades: two leg groups per entry timestamp
      const trades = [
        // First entry - call spread
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "CALL 4500/4510",
          premium: 50,
          pl: 25,
        }),
        // First entry - put spread (same timestamp)
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "PUT 4400/4390",
          premium: 50,
          pl: 25,
        }),
        // Second entry - call spread
        createMockTrade({
          dateOpened: new Date("2024-01-22"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "CALL 4600/4610",
          premium: 45,
          pl: 20,
        }),
        // Second entry - put spread (same timestamp)
        createMockTrade({
          dateOpened: new Date("2024-01-22"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "PUT 4500/4490",
          premium: 45,
          pl: 20,
        }),
      ];

      const combinedTrades = combineAllLegGroups(trades);

      // Should combine 4 trades into 2 (one per entry timestamp)
      expect(combinedTrades).toHaveLength(2);

      await storeCombinedTradesCache(blockId, combinedTrades);
      const cached = await getCombinedTradesCache(blockId);

      expect(cached).not.toBeNull();
      expect(cached).toHaveLength(2);

      // Verify combined P&L
      expect(cached![0].pl).toBe(50); // 25 + 25
      expect(cached![1].pl).toBe(40); // 20 + 20

      // Verify original trade count is preserved
      expect(cached![0].originalTradeCount).toBe(2);
      expect(cached![1].originalTradeCount).toBe(2);
    });
  });
});
