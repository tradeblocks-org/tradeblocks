/** @jest-environment node */

/**
 * IndexedDB Integration Tests with Data Loader
 *
 * Tests the full data loading pipeline with fake-indexeddb
 */

import "fake-indexeddb/auto";
import { DataLoader, IndexedDBAdapter } from "../../packages/lib/processing/data-loader";
import { initializeDatabase, deleteDatabase, STORES } from "../../packages/lib/db/index";
import * as tradesStore from "../../packages/lib/db/trades-store";
import * as dailyLogsStore from "../../packages/lib/db/daily-logs-store";
import { Trade } from "../../packages/lib/models/trade";
// import { DailyLogEntry } from '../../lib/models/daily-log';

describe("IndexedDB Integration with Data Loader", () => {
  let db: IDBDatabase;

  beforeAll(async () => {
    // Initialize the database
    db = await initializeDatabase();
  });

  afterAll(async () => {
    // Clean up
    await deleteDatabase();
  });

  beforeEach(async () => {
    // Clear all data before each test
    await clearAllData();
  });

  async function clearAllData() {
    const blockIds = ["test-block-1", "test-block-2", "test-block-3"];
    for (const blockId of blockIds) {
      await tradesStore.deleteTradesByBlock(blockId);
      await dailyLogsStore.deleteDailyLogsByBlock(blockId);
    }
  }

  describe("Database Initialization", () => {
    test("should create all required object stores", () => {
      expect(db.objectStoreNames.contains(STORES.BLOCKS)).toBe(true);
      expect(db.objectStoreNames.contains(STORES.TRADES)).toBe(true);
      expect(db.objectStoreNames.contains(STORES.DAILY_LOGS)).toBe(true);
      expect(db.objectStoreNames.contains(STORES.CALCULATIONS)).toBe(true);
    });

    test("should have correct indexes on trades store", async () => {
      const transaction = db.transaction([STORES.TRADES], "readonly");
      const store = transaction.objectStore(STORES.TRADES);

      expect(store.indexNames.contains("blockId")).toBe(true);
      expect(store.indexNames.contains("dateOpened")).toBe(true);
      expect(store.indexNames.contains("strategy")).toBe(true);
      expect(store.indexNames.contains("composite_block_date")).toBe(true);
    });
  });

  describe("Trade Storage Operations", () => {
    const mockTrades: Trade[] = [
      {
        dateOpened: new Date("2024-01-01"),
        timeOpened: "10:00:00",
        openingPrice: 100,
        legs: "CALL",
        premium: 500,
        pl: 100,
        numContracts: 1,
        fundsAtClose: 10100,
        marginReq: 1000,
        strategy: "Test Strategy",
        openingCommissionsFees: 1,
        closingCommissionsFees: 1,
        openingShortLongRatio: 0.5,
        closingShortLongRatio: 0.5,
        openingVix: 15,
        closingVix: 14,
        gap: 0,
        movement: 1,
        maxProfit: 200,
        maxLoss: -100,
      },
      {
        dateOpened: new Date("2024-01-02"),
        timeOpened: "11:00:00",
        openingPrice: 101,
        legs: "PUT",
        premium: 600,
        pl: -50,
        numContracts: 2,
        fundsAtClose: 10050,
        marginReq: 2000,
        strategy: "Test Strategy",
        openingCommissionsFees: 2,
        closingCommissionsFees: 2,
        openingShortLongRatio: 0.6,
        closingShortLongRatio: 0.4,
        openingVix: 14,
        closingVix: 16,
        gap: 1,
        movement: -2,
        maxProfit: 300,
        maxLoss: -200,
      },
    ];

    test("should store and retrieve trades by block", async () => {
      const blockId = "test-block-1";

      // Store trades
      await tradesStore.addTrades(blockId, mockTrades);

      // Retrieve trades
      const retrieved = await tradesStore.getTradesByBlock(blockId);

      expect(retrieved).toHaveLength(2);
      expect(retrieved[0].pl).toBe(100);
      expect(retrieved[1].pl).toBe(-50);
      expect(retrieved[0].blockId).toBe(blockId);
    });

    test("should handle multiple blocks independently", async () => {
      const block1 = "test-block-1";
      const block2 = "test-block-2";

      // Store different trades in different blocks
      await tradesStore.addTrades(block1, [mockTrades[0]]);
      await tradesStore.addTrades(block2, [mockTrades[1]]);

      // Retrieve from each block
      const trades1 = await tradesStore.getTradesByBlock(block1);
      const trades2 = await tradesStore.getTradesByBlock(block2);

      expect(trades1).toHaveLength(1);
      expect(trades2).toHaveLength(1);
      expect(trades1[0].pl).toBe(100);
      expect(trades2[0].pl).toBe(-50);
    });

    test("should get trade count by block", async () => {
      const blockId = "test-block-1";

      await tradesStore.addTrades(blockId, mockTrades);
      const count = await tradesStore.getTradeCountByBlock(blockId);

      expect(count).toBe(2);
    });

    test("should get unique strategies", async () => {
      const blockId = "test-block-1";
      const tradesWithStrategies: Trade[] = [
        { ...mockTrades[0], strategy: "Strategy A" },
        { ...mockTrades[1], strategy: "Strategy B" },
        { ...mockTrades[0], strategy: "Strategy A" }, // Duplicate
      ];

      await tradesStore.addTrades(blockId, tradesWithStrategies);
      const strategies = await tradesStore.getStrategiesByBlock(blockId);

      expect(strategies).toEqual(["Strategy A", "Strategy B"]);
    });

    test("should delete trades by block", async () => {
      const blockId = "test-block-1";

      await tradesStore.addTrades(blockId, mockTrades);
      let count = await tradesStore.getTradeCountByBlock(blockId);
      expect(count).toBe(2);

      await tradesStore.deleteTradesByBlock(blockId);
      count = await tradesStore.getTradeCountByBlock(blockId);
      expect(count).toBe(0);
    });
  });

  describe("DataLoader with IndexedDBAdapter", () => {
    test("should load and store data using IndexedDB adapter", async () => {
      const adapter = new IndexedDBAdapter();
      const loader = new DataLoader({
        environmentAdapter: new (
          await import("../../packages/lib/processing/data-loader")
        ).NodeAdapter(),
        storageAdapter: adapter,
      });

      const blockId = "test-block-3";
      const csvContent = `"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees","Opening Short/Long Ratio","Closing Short/Long Ratio","Opening VIX","Closing VIX","Gap","Movement","Max Profit","Max Loss"
"2024-01-01","10:00:00",100,"CALL",500,110,"2024-01-02","15:00:00",110,"Target",100,1,10100,1000,"IndexedDB Test",1,1,0.5,0.5,15,15,0,0,200,-200
"2024-01-02","11:00:00",101,"PUT",600,99,"2024-01-03","14:00:00",99,"Stop",-50,2,10050,2000,"IndexedDB Test",2,2,0.6,0.4,16,14,1,-1,300,-300`;

      // Load and store
      const result = await loader.loadBlockData(blockId, csvContent);

      expect(result.trades.data).toHaveLength(2);
      expect(result.trades.errors).toHaveLength(0);

      // Verify data was stored in IndexedDB
      const storedTrades = await tradesStore.getTradesByBlock(blockId);
      expect(storedTrades).toHaveLength(2);
      expect(storedTrades[0].strategy).toBe("IndexedDB Test");

      // Retrieve using loader
      const retrieved = await loader.getBlockData(blockId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.trades).toHaveLength(2);

      // Clear using loader
      await loader.clearBlockData(blockId);
      const count = await tradesStore.getTradeCountByBlock(blockId);
      expect(count).toBe(0);
    });

    test("should handle concurrent operations", async () => {
      const adapter = new IndexedDBAdapter();
      const loader = new DataLoader({
        environmentAdapter: new (
          await import("../../packages/lib/processing/data-loader")
        ).NodeAdapter(),
        storageAdapter: adapter,
      });

      const blocks = ["block-1", "block-2", "block-3"];
      const csvContent = `"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees","Opening Short/Long Ratio","Closing Short/Long Ratio","Opening VIX","Closing VIX","Gap","Movement","Max Profit","Max Loss"
"2024-01-01","10:00:00",100,"CALL",500,110,"2024-01-02","15:00:00",110,"Target",100,1,10100,1000,"Concurrent Test",1,1,0.5,0.5,15,15,0,0,200,-200`;

      // Load data for multiple blocks concurrently
      const promises = blocks.map((blockId) => loader.loadBlockData(blockId, csvContent));

      const results = await Promise.all(promises);

      // Verify all succeeded
      results.forEach((result) => {
        expect(result.trades.data).toHaveLength(1);
        expect(result.trades.errors).toHaveLength(0);
      });

      // Verify all blocks have data
      for (const blockId of blocks) {
        const count = await tradesStore.getTradeCountByBlock(blockId);
        expect(count).toBe(1);
      }
    });
  });

  describe("Trade Statistics", () => {
    test("should calculate trade statistics correctly", async () => {
      const blockId = "test-stats-block";
      const trades: Trade[] = [
        {
          dateOpened: new Date("2024-01-01"),
          timeOpened: "10:00:00",
          openingPrice: 100,
          legs: "CALL",
          premium: 500,
          pl: 150,
          numContracts: 1,
          fundsAtClose: 10150,
          marginReq: 1000,
          strategy: "Strategy A",
          openingCommissionsFees: 5,
          closingCommissionsFees: 5,
          openingShortLongRatio: 0.5,
        },
        {
          dateOpened: new Date("2024-01-05"),
          timeOpened: "11:00:00",
          openingPrice: 105,
          legs: "PUT",
          premium: 600,
          pl: -75,
          numContracts: 2,
          fundsAtClose: 10075,
          marginReq: 2000,
          strategy: "Strategy B",
          openingCommissionsFees: 10,
          closingCommissionsFees: 10,
          openingShortLongRatio: 0.6,
        },
        {
          dateOpened: new Date("2024-01-03"),
          timeOpened: "14:00:00",
          openingPrice: 102,
          legs: "SPREAD",
          premium: 400,
          pl: 200,
          numContracts: 1,
          fundsAtClose: 10350,
          marginReq: 1500,
          strategy: "Strategy A",
          openingCommissionsFees: 7,
          closingCommissionsFees: 7,
          openingShortLongRatio: 0.4,
        },
      ];

      await tradesStore.addTrades(blockId, trades);
      const stats = await tradesStore.getTradeStatistics(blockId);

      expect(stats.totalTrades).toBe(3);
      expect(stats.totalPl).toBe(275); // 150 - 75 + 200
      expect(stats.winningTrades).toBe(2);
      expect(stats.losingTrades).toBe(1);
      expect(stats.totalCommissions).toBe(44); // 5+5+10+10+7+7
      expect(stats.strategies).toEqual(["Strategy A", "Strategy B"]);
      expect(stats.dateRange.start).toEqual(new Date("2024-01-01"));
      expect(stats.dateRange.end).toEqual(new Date("2024-01-05"));
    });
  });

  describe("CSV Export", () => {
    test("should export trades to CSV format", async () => {
      const blockId = "test-export-block";
      const trades: Trade[] = [
        {
          dateOpened: new Date("2024-01-01"),
          timeOpened: "10:00:00",
          openingPrice: 100,
          legs: "CALL",
          premium: 500,
          pl: 100,
          numContracts: 1,
          fundsAtClose: 10100,
          marginReq: 1000,
          strategy: "Export Test",
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 0.5,
        },
      ];

      await tradesStore.addTrades(blockId, trades);
      const csv = await tradesStore.exportTradesToCSV(blockId);

      expect(csv).toContain("Date Opened");
      expect(csv).toContain("Export Test");
      expect(csv).toContain("100"); // P/L

      // The date might be in different formats depending on timezone
      // Just check that there's a date-like string in the CSV
      const datePattern = /\d{4}-\d{2}-\d{2}|GMT|202[34]/;
      expect(datePattern.test(csv)).toBe(true);

      // Check it's valid CSV format
      const lines = csv.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2); // Header + at least one data row
      expect(lines[0]).toContain("Strategy");
    });
  });
});
