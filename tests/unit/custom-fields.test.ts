/**
 * Custom Fields Tests
 *
 * Tests for importing custom columns from trade/daily log CSVs
 * and joining daily custom fields to trades during enrichment.
 */

import {
  TradeProcessor,
  DailyLogProcessor,
  enrichTrades,
  extractCustomFieldNames,
  getFieldsByCategoryWithCustom,
  Trade,
  DailyLogEntry,
} from "@tradeblocks/lib";

describe("Custom Fields", () => {
  describe("Trade Processor - Custom Columns", () => {
    // Helper to create a valid trade CSV row with all required columns
    const makeTradeRow = (customValues: Record<string, string> = {}) => {
      const base = {
        "Date Opened": "2024-01-15",
        "Time Opened": "09:31:00",
        "Opening Price": "1.50",
        Legs: "SPY Put",
        Premium: "150",
        "Closing Price": "1.00",
        "Date Closed": "2024-01-16",
        "Time Closed": "10:00:00",
        "Avg. Closing Cost": "1.00",
        "Reason For Close": "Profit Target",
        "P/L": "50",
        "No. of Contracts": "1",
        "Funds at Close": "10050",
        "Margin Req.": "5000",
        Strategy: "Iron Condor",
        "Opening Commissions + Fees": "1.50",
        "Closing Commissions + Fees": "1.50",
        "Opening Short/Long Ratio": "1.5",
        ...customValues,
      };
      return base;
    };

    const rowToCSV = (rows: Record<string, string>[]) => {
      const headers = Object.keys(rows[0]);
      const lines = rows.map((row) => headers.map((h) => row[h]).join(","));
      return [headers.join(","), ...lines].join("\n");
    };

    it("should preserve extra columns as customFields", async () => {
      const rows = [
        makeTradeRow({ dayOpenVix: "15.5", myCustomSignal: "BUY" }),
        makeTradeRow({ "Date Opened": "2024-01-16", dayOpenVix: "16.2", myCustomSignal: "SELL" }),
      ];
      const csvContent = rowToCSV(rows);

      const processor = new TradeProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.trades.length).toBe(2);

      // Check first trade has custom fields
      expect(result.trades[0].customFields).toBeDefined();
      expect(result.trades[0].customFields?.dayOpenVix).toBe(15.5); // Numeric
      expect(result.trades[0].customFields?.myCustomSignal).toBe("BUY"); // String

      // Check second trade
      expect(result.trades[1].customFields?.dayOpenVix).toBe(16.2);
      expect(result.trades[1].customFields?.myCustomSignal).toBe("SELL");
    });

    it("should not create customFields if no extra columns exist", async () => {
      const rows = [makeTradeRow()];
      const csvContent = rowToCSV(rows);

      const processor = new TradeProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].customFields).toBeUndefined();
    });

    it("should handle empty custom field values", async () => {
      const rows = [makeTradeRow({ customField: "" })];
      const csvContent = rowToCSV(rows);

      const processor = new TradeProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.trades.length).toBe(1);
      // Empty values should not be included in customFields
      expect(result.trades[0].customFields).toBeUndefined();
    });

    it("should auto-detect numeric custom fields with currency symbols", async () => {
      const rows = [makeTradeRow({ priceTarget: "$500.00" })];
      const csvContent = rowToCSV(rows);

      const processor = new TradeProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].customFields?.priceTarget).toBe(500); // Parsed as number
    });
  });

  describe("Daily Log Processor - Custom Columns", () => {
    it("should preserve extra columns as customFields", async () => {
      const csvContent = `Date,Net Liquidity,Current Funds,Withdrawn,Trading Funds,P/L,P/L %,Drawdown %,vixOpen,spyOpen
2024-01-15,100000,95000,0,95000,500,0.5,-1.0,15.5,480.25
2024-01-16,100500,95500,0,95500,500,0.5,-0.5,16.2,478.50`;

      const processor = new DailyLogProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.entries.length).toBe(2);

      // Check first entry has custom fields
      expect(result.entries[0].customFields).toBeDefined();
      expect(result.entries[0].customFields?.vixOpen).toBe(15.5);
      expect(result.entries[0].customFields?.spyOpen).toBe(480.25);

      // Check second entry
      expect(result.entries[1].customFields?.vixOpen).toBe(16.2);
      expect(result.entries[1].customFields?.spyOpen).toBe(478.5);
    });

    it("should not create customFields if no extra columns exist", async () => {
      const csvContent = `Date,Net Liquidity,Current Funds,Withdrawn,Trading Funds,P/L,P/L %,Drawdown %
2024-01-15,100000,95000,0,95000,500,0.5,-1.0`;

      const processor = new DailyLogProcessor();
      const result = await processor.processCSVContent(csvContent);

      expect(result.entries.length).toBe(1);
      expect(result.entries[0].customFields).toBeUndefined();
    });
  });

  describe("Enrich Trades - Daily Custom Fields Join", () => {
    it("should join daily custom fields to trades by date", () => {
      const trades: Trade[] = [
        createMockTrade({ dateOpened: new Date("2024-01-15T00:00:00Z") }),
        createMockTrade({ dateOpened: new Date("2024-01-16T00:00:00Z") }),
      ];

      const dailyLogs: DailyLogEntry[] = [
        createMockDailyLog({
          date: new Date("2024-01-15T00:00:00Z"),
          customFields: { vixOpen: 15.5, spyOpen: 480.25 },
        }),
        createMockDailyLog({
          date: new Date("2024-01-16T00:00:00Z"),
          customFields: { vixOpen: 16.2, spyOpen: 478.5 },
        }),
      ];

      const enriched = enrichTrades(trades, { dailyLogs });

      expect(enriched[0].dailyCustomFields).toBeDefined();
      expect(enriched[0].dailyCustomFields?.vixOpen).toBe(15.5);
      expect(enriched[0].dailyCustomFields?.spyOpen).toBe(480.25);

      expect(enriched[1].dailyCustomFields?.vixOpen).toBe(16.2);
      expect(enriched[1].dailyCustomFields?.spyOpen).toBe(478.5);
    });

    it("should handle trades with no matching daily log", () => {
      const trades: Trade[] = [
        createMockTrade({ dateOpened: new Date("2024-01-15T00:00:00Z") }),
        createMockTrade({ dateOpened: new Date("2024-01-17T00:00:00Z") }), // No daily log for this date
      ];

      const dailyLogs: DailyLogEntry[] = [
        createMockDailyLog({
          date: new Date("2024-01-15T00:00:00Z"),
          customFields: { vixOpen: 15.5 },
        }),
        createMockDailyLog({
          date: new Date("2024-01-16T00:00:00Z"),
          customFields: { vixOpen: 16.2 },
        }),
      ];

      const enriched = enrichTrades(trades, { dailyLogs });

      expect(enriched[0].dailyCustomFields?.vixOpen).toBe(15.5);
      expect(enriched[1].dailyCustomFields).toBeUndefined(); // No match
    });

    it("should handle daily logs without custom fields", () => {
      const trades: Trade[] = [createMockTrade({ dateOpened: new Date("2024-01-15T00:00:00Z") })];

      const dailyLogs: DailyLogEntry[] = [
        createMockDailyLog({ date: new Date("2024-01-15T00:00:00Z") }), // No customFields
      ];

      const enriched = enrichTrades(trades, { dailyLogs });

      expect(enriched[0].dailyCustomFields).toBeUndefined();
    });

    it("should work without daily logs option", () => {
      const trades: Trade[] = [createMockTrade({ dateOpened: new Date("2024-01-15T00:00:00Z") })];

      const enriched = enrichTrades(trades);

      expect(enriched[0].dailyCustomFields).toBeUndefined();
    });
  });

  describe("Extract Custom Field Names", () => {
    it("should extract unique custom field names from trades", () => {
      const trades: Array<{
        customFields?: Record<string, number | string>;
        dailyCustomFields?: Record<string, number | string>;
      }> = [
        { customFields: { fieldA: 1, fieldB: "x" }, dailyCustomFields: { dailyA: 10 } },
        { customFields: { fieldA: 2, fieldC: 3 }, dailyCustomFields: { dailyA: 20, dailyB: 30 } },
        { customFields: undefined, dailyCustomFields: undefined },
      ];

      const { tradeFields, dailyFields } = extractCustomFieldNames(trades);

      expect(tradeFields).toEqual(["fieldA", "fieldB", "fieldC"]);
      expect(dailyFields).toEqual(["dailyA", "dailyB"]);
    });

    it("should return empty arrays if no custom fields", () => {
      const trades = [{ customFields: undefined, dailyCustomFields: undefined }];

      const { tradeFields, dailyFields } = extractCustomFieldNames(trades);

      expect(tradeFields).toEqual([]);
      expect(dailyFields).toEqual([]);
    });
  });

  describe("Get Fields By Category With Custom", () => {
    it("should include custom fields categories when trades have custom fields", () => {
      const trades = [{ customFields: { myField: 1 }, dailyCustomFields: { dailyField: 10 } }];

      const fieldsByCategory = getFieldsByCategoryWithCustom(trades);

      // Should have custom and dailyCustom categories
      expect(fieldsByCategory.has("custom")).toBe(true);
      expect(fieldsByCategory.has("dailyCustom")).toBe(true);

      const customFields = fieldsByCategory.get("custom");
      expect(customFields?.length).toBe(1);
      expect(customFields?.[0].field).toBe("custom.myField");
      expect(customFields?.[0].label).toBe("myField");

      const dailyFields = fieldsByCategory.get("dailyCustom");
      expect(dailyFields?.length).toBe(1);
      expect(dailyFields?.[0].field).toBe("daily.dailyField");
      expect(dailyFields?.[0].label).toBe("dailyField");
    });

    it("should not include custom categories when no custom fields exist", () => {
      const trades = [{ customFields: undefined, dailyCustomFields: undefined }];

      const fieldsByCategory = getFieldsByCategoryWithCustom(trades);

      expect(fieldsByCategory.has("custom")).toBe(false);
      expect(fieldsByCategory.has("dailyCustom")).toBe(false);
    });
  });
});

// Helper functions
function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date("2024-01-15T00:00:00Z"),
    timeOpened: "09:31:00",
    openingPrice: 1.5,
    legs: "SPY Put",
    premium: 150,
    pl: 50,
    numContracts: 1,
    fundsAtClose: 10050,
    marginReq: 5000,
    strategy: "Iron Condor",
    openingCommissionsFees: 1.5,
    closingCommissionsFees: 1.5,
    openingShortLongRatio: 1.5,
    ...overrides,
  };
}

function createMockDailyLog(overrides: Partial<DailyLogEntry> = {}): DailyLogEntry {
  return {
    date: new Date("2024-01-15T00:00:00Z"),
    netLiquidity: 100000,
    currentFunds: 95000,
    withdrawn: 0,
    tradingFunds: 95000,
    dailyPl: 500,
    dailyPlPct: 0.5,
    drawdownPct: -1.0,
    ...overrides,
  };
}
