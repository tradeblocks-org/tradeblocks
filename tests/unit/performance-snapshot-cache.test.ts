/**
 * Tests for Performance Snapshot Cache
 */
import "fake-indexeddb/auto";
import {
  Trade,
  DailyLogEntry,
  storePerformanceSnapshotCache,
  getPerformanceSnapshotCache,
  deletePerformanceSnapshotCache,
  hasPerformanceSnapshotCache,
  buildPerformanceSnapshot,
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

// Helper to create mock daily log entries
function createMockDailyLog(overrides: Partial<DailyLogEntry> = {}): DailyLogEntry {
  return {
    date: new Date("2024-01-15"),
    netLiquidity: 100000,
    currentFunds: 95000,
    withdrawn: 0,
    tradingFunds: 95000,
    dailyPl: 100,
    dailyPlPct: 0.1,
    drawdownPct: 0,
    ...overrides,
  };
}

describe("Performance Snapshot Cache", () => {
  beforeEach(async () => {
    await initializeDatabase();
  });

  afterEach(async () => {
    closeDatabase();
  });

  describe("storePerformanceSnapshotCache", () => {
    it("should store performance snapshot in cache", async () => {
      const blockId = "test-block-1";
      const trades = [
        createMockTrade({ strategy: "Iron Condor", pl: 100 }),
        createMockTrade({ strategy: "Iron Condor", pl: -50 }),
      ];
      const dailyLogs = [
        createMockDailyLog({ date: new Date("2024-01-15"), netLiquidity: 100000 }),
        createMockDailyLog({ date: new Date("2024-01-16"), netLiquidity: 100100 }),
      ];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        dailyLogs,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);

      const cached = await getPerformanceSnapshotCache(blockId);
      expect(cached).not.toBeNull();
      expect(cached!.portfolioStats).toBeDefined();
      expect(cached!.filteredTrades).toHaveLength(2);
    });
  });

  describe("getPerformanceSnapshotCache", () => {
    it("should return null for non-existent cache", async () => {
      const result = await getPerformanceSnapshotCache("non-existent-block");
      expect(result).toBeNull();
    });

    it("should restore Date objects correctly", async () => {
      const blockId = "test-block-2";
      const trades = [createMockTrade()];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);
      const cached = await getPerformanceSnapshotCache(blockId);

      expect(cached).not.toBeNull();
      expect(cached!.filteredTrades[0].dateOpened).toBeInstanceOf(Date);
      expect(cached!.filteredTrades[0].dateClosed).toBeInstanceOf(Date);
      expect(cached!.calculatedAt).toBeInstanceOf(Date);
    });

    it("should return correct portfolio stats", async () => {
      const blockId = "test-block-3";
      const trades = [
        createMockTrade({ pl: 100 }),
        createMockTrade({ pl: -30 }),
        createMockTrade({ pl: 50 }),
      ];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);
      const cached = await getPerformanceSnapshotCache(blockId);

      expect(cached).not.toBeNull();
      expect(cached!.portfolioStats.totalTrades).toBe(3);
      // netPl accounts for commissions: (100 - 30 + 50) - (2 * 3 trades) = 114
      expect(cached!.portfolioStats.netPl).toBeCloseTo(114, 2);
    });
  });

  describe("deletePerformanceSnapshotCache", () => {
    it("should delete cached performance snapshot", async () => {
      const blockId = "test-block-4";
      const trades = [createMockTrade()];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);
      expect(await hasPerformanceSnapshotCache(blockId)).toBe(true);

      await deletePerformanceSnapshotCache(blockId);
      expect(await hasPerformanceSnapshotCache(blockId)).toBe(false);
    });

    it("should not throw error when deleting non-existent cache", async () => {
      await expect(deletePerformanceSnapshotCache("non-existent-block")).resolves.not.toThrow();
    });
  });

  describe("hasPerformanceSnapshotCache", () => {
    it("should return true when cache exists", async () => {
      const blockId = "test-block-5";
      const trades = [createMockTrade()];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);
      expect(await hasPerformanceSnapshotCache(blockId)).toBe(true);
    });

    it("should return false when cache does not exist", async () => {
      expect(await hasPerformanceSnapshotCache("non-existent")).toBe(false);
    });
  });

  describe("cache with chart data", () => {
    it("should correctly cache and restore chart data", async () => {
      const blockId = "test-chart-block";

      // Create trades spanning multiple dates for richer chart data
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          dateClosed: new Date("2024-01-16"),
          pl: 100,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-17"),
          dateClosed: new Date("2024-01-18"),
          pl: -50,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-19"),
          dateClosed: new Date("2024-01-20"),
          pl: 75,
        }),
      ];

      const dailyLogs = [
        createMockDailyLog({ date: new Date("2024-01-15"), netLiquidity: 100000 }),
        createMockDailyLog({ date: new Date("2024-01-16"), netLiquidity: 100100 }),
        createMockDailyLog({ date: new Date("2024-01-17"), netLiquidity: 100050 }),
        createMockDailyLog({ date: new Date("2024-01-18"), netLiquidity: 100125 }),
      ];

      const snapshot = await buildPerformanceSnapshot({
        trades,
        dailyLogs,
        normalizeTo1Lot: false,
      });

      await storePerformanceSnapshotCache(blockId, snapshot);
      const cached = await getPerformanceSnapshotCache(blockId);

      expect(cached).not.toBeNull();
      expect(cached!.chartData).toBeDefined();

      // Verify key chart data arrays exist
      expect(cached!.chartData.equityCurve).toBeDefined();
      expect(cached!.chartData.monthlyReturns).toBeDefined();
    });
  });

  describe("cache overwrite behavior", () => {
    it("should overwrite existing cache with new data", async () => {
      const blockId = "test-overwrite-block";

      // First snapshot with one trade
      const firstTrades = [createMockTrade({ pl: 100 })];
      const firstSnapshot = await buildPerformanceSnapshot({
        trades: firstTrades,
        normalizeTo1Lot: false,
      });
      await storePerformanceSnapshotCache(blockId, firstSnapshot);

      let cached = await getPerformanceSnapshotCache(blockId);
      expect(cached!.filteredTrades).toHaveLength(1);
      // netPl accounts for commissions: 100 - (1 opening + 1 closing fee) = 98
      expect(cached!.portfolioStats.netPl).toBeCloseTo(98, 2);

      // Second snapshot with two trades
      const secondTrades = [createMockTrade({ pl: 200 }), createMockTrade({ pl: -50 })];
      const secondSnapshot = await buildPerformanceSnapshot({
        trades: secondTrades,
        normalizeTo1Lot: false,
      });
      await storePerformanceSnapshotCache(blockId, secondSnapshot);

      cached = await getPerformanceSnapshotCache(blockId);
      expect(cached!.filteredTrades).toHaveLength(2);
      // netPl accounts for commissions: (200 - 50) - (2 * 2 trades) = 146
      expect(cached!.portfolioStats.netPl).toBeCloseTo(146, 2);
    });
  });
});
