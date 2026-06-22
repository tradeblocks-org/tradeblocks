/** @jest-environment node */

/**
 * Tests for Data Loader
 */

import {
  DataLoader,
  MemoryAdapter,
  NodeAdapter,
  BrowserAdapter,
} from "../../packages/lib/processing/data-loader";
import { CsvTestDataLoader } from "../data/csv-loader";
import { PortfolioStatsCalculator } from "../../packages/lib/calculations/portfolio-stats";

describe("Data Loader", () => {
  describe("Environment Adapters", () => {
    test("NodeAdapter should handle string content", async () => {
      const adapter = new NodeAdapter();
      expect(adapter.isAvailable()).toBe(true); // In Jest/Node environment

      const content = "test,data\n1,2";
      const result = await adapter.readFile(content);
      expect(result).toBe(content);
    });

    test("NodeAdapter should handle ArrayBuffer", async () => {
      const adapter = new NodeAdapter();
      const text = "test,data\n1,2";
      const buffer = new TextEncoder().encode(text);
      const result = await adapter.readFile(buffer.buffer);
      expect(result).toBe(text);
    });

    test("BrowserAdapter availability", () => {
      const adapter = new BrowserAdapter();
      // In Node/Jest environment, FileReader is not available
      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe("Memory Storage Adapter", () => {
    test("should store and retrieve trades", async () => {
      const adapter = new MemoryAdapter();
      const blockId = "test-block";
      const trades = [
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
        },
      ];

      await adapter.storeTrades(blockId, trades);
      const retrieved = await adapter.getTrades(blockId);

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].pl).toBe(100);
    });

    test("should clear block data", async () => {
      const adapter = new MemoryAdapter();
      const blockId = "test-block";

      await adapter.storeTrades(blockId, []);
      await adapter.clear(blockId);

      const trades = await adapter.getTrades(blockId);
      expect(trades).toHaveLength(0);
    });
  });

  describe("DataLoader with Testing Setup", () => {
    test("should create testing instance", () => {
      const loader = DataLoader.createForTesting({ useMemoryStorage: true });
      expect(loader).toBeDefined();
    });

    test("should load trades from CSV string", async () => {
      const loader = DataLoader.createForTesting();
      const csvContent = `"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees","Opening Short/Long Ratio","Closing Short/Long Ratio","Opening VIX","Closing VIX","Gap","Movement","Max Profit","Max Loss"
"2024-01-01","10:00:00",100,"CALL",500,110,"2024-01-02","15:00:00",110,"Target",100,1,10100,1000,"Test Strategy",1,1,0.5,0.5,15,15,0,0,200,-200`;

      const result = await loader.loadTrades(csvContent);

      expect(result.data).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.data[0].pl).toBe(100);
      expect(result.data[0].strategy).toBe("Test Strategy");
    });

    test("should handle invalid CSV gracefully", async () => {
      const loader = DataLoader.createForTesting();
      const invalidCsv = "not,a,valid,csv";

      const result = await loader.loadTrades(invalidCsv);

      expect(result.data).toHaveLength(0);
      expect(result.stats.validRows).toBe(0);
    });
  });

  describe("CSV Test Data Loader Integration", () => {
    test("should load test data (mock or CSV)", async () => {
      const result = await CsvTestDataLoader.loadTestData();

      expect(result.trades).toBeDefined();
      expect(result.trades.length).toBeGreaterThan(0);
      expect(result.sources).toBeDefined();
      expect(["csv", "mock"]).toContain(result.sources.trades);
    });

    test("should store and retrieve test data", async () => {
      const blockId = "integration-test-block";

      // Load and store
      const stored = await CsvTestDataLoader.loadAndStoreTestData(blockId);
      expect(stored.trades.length).toBeGreaterThan(0);
      expect(stored.blockId).toBe(blockId);

      // Retrieve
      const retrieved = await CsvTestDataLoader.getStoredTestData(blockId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.trades.length).toBe(stored.trades.length);

      // Clear
      await CsvTestDataLoader.clearStoredTestData(blockId);
      const cleared = await CsvTestDataLoader.getStoredTestData(blockId);
      expect(cleared?.trades.length).toBe(0);
    });

    test("should work with portfolio stats calculator", async () => {
      const { trades } = await CsvTestDataLoader.loadTestData();
      const calculator = new PortfolioStatsCalculator();

      const stats = calculator.calculatePortfolioStats(trades);

      expect(stats).toBeDefined();
      expect(stats.totalTrades).toBe(trades.length);
      expect(stats.totalPl).toBeDefined();
      expect(stats.winRate).toBeGreaterThanOrEqual(0);
      expect(stats.winRate).toBeLessThanOrEqual(1);
    });
  });

  describe("Data Loader with Block Storage", () => {
    test("should load and store block data", async () => {
      const loader = DataLoader.createForTesting({ useMemoryStorage: true });
      const blockId = "test-block-123";

      const csvContent = `"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees","Opening Short/Long Ratio","Closing Short/Long Ratio","Opening VIX","Closing VIX","Gap","Movement","Max Profit","Max Loss"
"2024-01-01","10:00:00",100,"CALL",500,110,"2024-01-02","15:00:00",110,"Target",100,1,10100,1000,"Test Strategy",1,1,0.5,0.5,15,15,0,0,200,-200
"2024-01-02","11:00:00",101,"PUT",600,99,"2024-01-03","14:00:00",99,"Stop",-50,2,10050,2000,"Test Strategy",1,1,0.5,0.5,16,14,0,0,300,-300`;

      // Load and store
      const result = await loader.loadBlockData(blockId, csvContent);

      expect(result.trades.data).toHaveLength(2);
      expect(result.trades.errors).toHaveLength(0);

      // Retrieve stored data
      const stored = await loader.getBlockData(blockId);

      expect(stored).not.toBeNull();
      expect(stored?.trades).toHaveLength(2);
      expect(stored?.trades[0].pl).toBe(100);
      expect(stored?.trades[1].pl).toBe(-50);

      // Clear
      await loader.clearBlockData(blockId);
      const cleared = await loader.getBlockData(blockId);
      expect(cleared?.trades).toHaveLength(0);
    });

    test("should calculate date range correctly", async () => {
      const loader = DataLoader.createForTesting();

      const csvContent = `"Date Opened","Time Opened","Opening Price","Legs","Premium","Closing Price","Date Closed","Time Closed","Avg. Closing Cost","Reason For Close","P/L","No. of Contracts","Funds at Close","Margin Req.","Strategy","Opening Commissions + Fees","Closing Commissions + Fees","Opening Short/Long Ratio","Closing Short/Long Ratio","Opening VIX","Closing VIX","Gap","Movement","Max Profit","Max Loss"
"2024-01-01","10:00:00",100,"CALL",500,110,"2024-01-02","15:00:00",110,"Target",100,1,10100,1000,"Test Strategy",1,1,0.5,0.5,15,15,0,0,200,-200
"2024-01-15","11:00:00",101,"PUT",600,99,"2024-01-16","14:00:00",99,"Stop",-50,2,10050,2000,"Test Strategy",1,1,0.5,0.5,16,14,0,0,300,-300`;

      const result = await loader.loadTrades(csvContent);

      expect(result.stats.dateRange).toBeDefined();
      expect(result.stats.dateRange?.start).toEqual(new Date("2024-01-01"));
      expect(result.stats.dateRange?.end).toEqual(new Date("2024-01-15"));
    });
  });

  describe("Error Handling", () => {
    test("should handle empty CSV", async () => {
      const loader = DataLoader.createForTesting();
      const result = await loader.loadTrades("");

      expect(result.data).toHaveLength(0);
      expect(result.stats.totalRows).toBe(0);
    });

    test("should handle malformed CSV", async () => {
      const loader = DataLoader.createForTesting();
      const malformed = 'this is not,\nvalid csv data\n"unclosed quote';

      const result = await loader.loadTrades(malformed);

      expect(result.data).toHaveLength(0);
      expect(result.stats.invalidRows).toBeGreaterThanOrEqual(0);
    });

    test("should surface missing required trade headers", async () => {
      const loader = DataLoader.createForTesting();
      const csvContent = '"Date Opened","P/L"\n"2024-01-01",100';

      const result = await loader.loadTrades(csvContent);

      expect(result.data).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain("Missing required trade log columns");
    });

    test("should return null when no storage adapter", async () => {
      const loader = DataLoader.createForTesting({ useMemoryStorage: false });
      const data = await loader.getBlockData("any-block");

      expect(data).toBeNull();
    });
  });

  describe("CSV Data Validation", () => {
    test("should validate Monday JFSP trades if CSV exists", async () => {
      const { trades, sources } = await CsvTestDataLoader.loadTestData();

      console.log(`Loaded from: ${sources.trades}`);
      console.log(`Total trades: ${trades.length}`);

      if (sources.trades === "csv") {
        // If we have CSV data, check for Monday JFSP
        const mondayJfsp = trades.filter((t) => t.strategy === "Monday JFSP");
        console.log(`Monday JFSP trades: ${mondayJfsp.length}`);

        if (mondayJfsp.length > 0) {
          // Calculate stats for Monday JFSP
          const calculator = new PortfolioStatsCalculator();
          const stats = calculator.calculatePortfolioStats(mondayJfsp);

          expect(stats.totalTrades).toBe(mondayJfsp.length);
          expect(stats.maxWinStreak).toBeGreaterThanOrEqual(0);
          expect(stats.maxLossStreak).toBeGreaterThanOrEqual(0);

          console.log(`Monday JFSP Stats:`);
          console.log(`  Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
          console.log(`  Max Win Streak: ${stats.maxWinStreak}`);
          console.log(`  Max Loss Streak: ${stats.maxLossStreak}`);
        }
      } else {
        // Using mock data
        expect(trades.length).toBeGreaterThan(0);
        console.log("Using mock data for testing");
      }
    });
  });
});
