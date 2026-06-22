/**
 * Field Value Extraction Tests
 *
 * Tests to ensure all places that extract field values from trades
 * handle all field types consistently:
 * - Standard fields (e.g., "openingVix", "pl")
 * - Custom trade fields (e.g., "custom.myField")
 * - Daily custom fields (e.g., "daily.vixOpen")
 * - Static dataset fields (e.g., "SPX OHLC.close", "VIX.high")
 *
 * This test exists because we've had bugs where new code paths
 * forgot to handle static dataset fields. If you're adding a new
 * place that reads field values, add it to this test.
 */

import {
  EnrichedTrade,
  getEnrichedTradeValue,
  applyFilters,
  getFieldRange,
  createFilterCondition,
  FilterConfig,
} from "@tradeblocks/lib";

// Create a mock enriched trade with all field types populated
function createMockEnrichedTrade(): EnrichedTrade {
  return {
    // Required Trade fields
    dateOpened: new Date("2024-01-15"),
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

    // Standard enriched fields
    openingVix: 15.5,
    closingVix: 14.2,
    rom: 1.0,
    plPct: 33.3,
    tradeNumber: 1,

    // Custom trade fields
    customFields: {
      myCustomSignal: "BUY",
      customNumeric: 42,
    },

    // Daily custom fields
    dailyCustomFields: {
      dailyVixOpen: 15.0,
      dailyNote: "Fed meeting",
    },

    // Static dataset fields - this is the key one that was being missed
    staticDatasetFields: {
      "SPX OHLC": {
        open: 5800,
        high: 5850,
        low: 5780,
        close: 5820,
      },
      VIX: {
        open: 15.0,
        high: 16.0,
        low: 14.5,
        close: 15.2,
      },
    },
  };
}

describe("Field Value Extraction Consistency", () => {
  const trade = createMockEnrichedTrade();
  const trades = [trade];

  describe("getEnrichedTradeValue (enriched-trade.ts)", () => {
    it("should extract standard fields", () => {
      expect(getEnrichedTradeValue(trade, "openingVix")).toBe(15.5);
      expect(getEnrichedTradeValue(trade, "pl")).toBe(50);
      expect(getEnrichedTradeValue(trade, "rom")).toBe(1.0);
    });

    it("should extract custom trade fields", () => {
      expect(getEnrichedTradeValue(trade, "custom.customNumeric")).toBe(42);
    });

    it("should extract daily custom fields", () => {
      expect(getEnrichedTradeValue(trade, "daily.dailyVixOpen")).toBe(15.0);
    });

    it("should extract static dataset fields", () => {
      expect(getEnrichedTradeValue(trade, "SPX OHLC.close")).toBe(5820);
      expect(getEnrichedTradeValue(trade, "SPX OHLC.high")).toBe(5850);
      expect(getEnrichedTradeValue(trade, "VIX.close")).toBe(15.2);
    });

    it("should return null for non-existent fields", () => {
      expect(getEnrichedTradeValue(trade, "nonExistent")).toBe(null);
      expect(getEnrichedTradeValue(trade, "custom.nonExistent")).toBe(null);
      expect(getEnrichedTradeValue(trade, "daily.nonExistent")).toBe(null);
      expect(getEnrichedTradeValue(trade, "NonExistentDataset.column")).toBe(null);
    });
  });

  describe("applyFilters (flexible-filter.ts)", () => {
    const createConfig = (field: string, value: number): FilterConfig => ({
      logic: "and",
      conditions: [
        {
          ...createFilterCondition(),
          field,
          operator: "gt",
          value,
          enabled: true,
        },
      ],
    });

    it("should filter by standard fields", () => {
      const result = applyFilters(trades, createConfig("openingVix", 15));
      expect(result.matchCount).toBe(1);

      const noMatch = applyFilters(trades, createConfig("openingVix", 20));
      expect(noMatch.matchCount).toBe(0);
    });

    it("should filter by custom trade fields", () => {
      const result = applyFilters(trades, createConfig("custom.customNumeric", 40));
      expect(result.matchCount).toBe(1);

      const noMatch = applyFilters(trades, createConfig("custom.customNumeric", 50));
      expect(noMatch.matchCount).toBe(0);
    });

    it("should filter by daily custom fields", () => {
      const result = applyFilters(trades, createConfig("daily.dailyVixOpen", 14));
      expect(result.matchCount).toBe(1);

      const noMatch = applyFilters(trades, createConfig("daily.dailyVixOpen", 16));
      expect(noMatch.matchCount).toBe(0);
    });

    it("should filter by static dataset fields", () => {
      // SPX OHLC.close is 5820
      const result = applyFilters(trades, createConfig("SPX OHLC.close", 5800));
      expect(result.matchCount).toBe(1);

      const noMatch = applyFilters(trades, createConfig("SPX OHLC.close", 6000));
      expect(noMatch.matchCount).toBe(0);

      // VIX.high is 16.0
      const vixResult = applyFilters(trades, createConfig("VIX.high", 15));
      expect(vixResult.matchCount).toBe(1);
    });
  });

  describe("getFieldRange (flexible-filter.ts)", () => {
    it("should get range for standard fields", () => {
      const range = getFieldRange(trades, "openingVix");
      expect(range).not.toBeNull();
      expect(range?.min).toBe(15.5);
      expect(range?.max).toBe(15.5);
    });

    it("should get range for custom trade fields", () => {
      const range = getFieldRange(trades, "custom.customNumeric");
      expect(range).not.toBeNull();
      expect(range?.min).toBe(42);
    });

    it("should get range for daily custom fields", () => {
      const range = getFieldRange(trades, "daily.dailyVixOpen");
      expect(range).not.toBeNull();
      expect(range?.min).toBe(15.0);
    });

    it("should get range for static dataset fields", () => {
      const range = getFieldRange(trades, "SPX OHLC.close");
      expect(range).not.toBeNull();
      expect(range?.min).toBe(5820);
      expect(range?.max).toBe(5820);
    });
  });
});

/**
 * IMPORTANT: When adding a new place that extracts field values from trades,
 * add a test section here to ensure it handles all field types.
 *
 * Known places that extract field values:
 * 1. getEnrichedTradeValue() in lib/models/enriched-trade.ts
 * 2. getTradeFieldValue() in lib/calculations/flexible-filter.ts
 * 3. Charts that read trade values (scatter-chart.tsx, custom-chart.tsx, etc.)
 *    - These use getEnrichedTradeValue internally
 *
 * The pattern for handling static dataset fields:
 *   if (field.includes('.') && !field.startsWith('custom.') && !field.startsWith('daily.')) {
 *     const [datasetName, columnName] = field.split('.')
 *     value = trade.staticDatasetFields?.[datasetName]?.[columnName]
 *   }
 */
