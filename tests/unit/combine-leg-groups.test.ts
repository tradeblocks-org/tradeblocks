/**
 * Tests for combine-leg-groups utility
 *
 * Tests the functionality for combining multiple leg groups (e.g., MEIC strategies)
 * that share the same entry timestamp into single trade records.
 */

import { describe, it, expect } from "@jest/globals";
import { Trade } from "../../packages/lib/models/trade";
import {
  groupTradesByEntry,
  combineLegGroup,
  combineAllLegGroups,
  analyzeLegGroups,
} from "../../packages/lib/utils/combine-leg-groups";

describe("combine-leg-groups", () => {
  // Helper to create a test trade
  const createTrade = (overrides: Partial<Trade>): Trade => ({
    dateOpened: new Date("2025-10-07"),
    timeOpened: "10:15:00",
    openingPrice: 6742.78,
    legs: "1 Oct 7 6755 C STO 3.15 | 1 Oct 7 6835 C BTO 0.05",
    premium: 300,
    pl: 296.44,
    numContracts: 1,
    fundsAtClose: 103258.52,
    marginReq: 7365,
    strategy: "MEIC",
    openingCommissionsFees: 3.56,
    closingCommissionsFees: 0,
    openingShortLongRatio: 63,
    dateClosed: new Date("2025-10-07"),
    timeClosed: "16:00:00",
    reasonForClose: "Expired",
    closingPrice: 6714.59,
    avgClosingCost: 0,
    closingShortLongRatio: 1,
    gap: 5.86,
    movement: -3.36,
    maxProfit: 100,
    maxLoss: -15,
    ...overrides,
  });

  describe("groupTradesByEntry", () => {
    it("should group trades with same entry timestamp", () => {
      const trade1 = createTrade({ premium: 300, legs: "Call spread" });
      const trade2 = createTrade({ premium: 325, legs: "Put spread" });
      const trade3 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "09:32:00",
        premium: 335,
        legs: "Different time",
      });

      const groups = groupTradesByEntry([trade1, trade2, trade3]);

      expect(groups.size).toBe(2);

      const group1Key = "2025-10-07|10:15:00|MEIC";
      const group2Key = "2025-10-07|09:32:00|MEIC";

      expect(groups.get(group1Key)).toHaveLength(2);
      expect(groups.get(group2Key)).toHaveLength(1);
    });

    it("should create separate groups for different strategies", () => {
      const trade1 = createTrade({ strategy: "MEIC" });
      const trade2 = createTrade({ strategy: "Iron Condor" });

      const groups = groupTradesByEntry([trade1, trade2]);

      expect(groups.size).toBe(2);
    });

    it("should handle empty array", () => {
      const groups = groupTradesByEntry([]);
      expect(groups.size).toBe(0);
    });
  });

  describe("combineLegGroup", () => {
    it("should handle single trade", () => {
      const trade = createTrade({ premium: 300 });
      const combined = combineLegGroup([trade]);

      expect(combined.originalTradeCount).toBe(1);
      expect(combined.premium).toBe(300);
      expect(combined.combinedLegs).toHaveLength(1);
    });

    it("should combine two trades with same entry time", () => {
      const callSpread = createTrade({
        premium: 300,
        pl: 296.44,
        legs: "1 Oct 7 6755 C STO 3.15 | 1 Oct 7 6835 C BTO 0.05",
        dateClosed: new Date("2025-10-07"),
        timeClosed: "16:00:00",
        openingCommissionsFees: 3.56,
        closingCommissionsFees: 0,
        marginReq: 7365,
      });

      const putSpread = createTrade({
        premium: 325,
        pl: -355.12,
        legs: "1 Oct 7 6730 P STO 3.65 | 1 Oct 7 6650 P BTO 0.30",
        dateClosed: new Date("2025-10-07"),
        timeClosed: "10:36:00", // Earlier close time
        openingCommissionsFees: 3.56,
        closingCommissionsFees: 1.56,
        marginReq: 7365,
      });

      const combined = combineLegGroup([callSpread, putSpread]);

      expect(combined.originalTradeCount).toBe(2);
      expect(combined.premium).toBe(625); // 300 + 325
      expect(combined.pl).toBeCloseTo(-58.68, 2); // 296.44 + (-355.12)
      expect(combined.openingCommissionsFees).toBeCloseTo(7.12, 2); // 3.56 + 3.56
      expect(combined.closingCommissionsFees).toBeCloseTo(1.56, 2); // 0 + 1.56
      expect(combined.marginReq).toBe(7365); // max of both
      expect(combined.legs).toContain("6755 C STO");
      expect(combined.legs).toContain("6730 P STO");
      expect(combined.combinedLegs).toHaveLength(2);

      // Should use last closing time
      expect(combined.timeClosed).toBe("16:00:00");
    });

    it("should use maximum margin requirement", () => {
      const trade1 = createTrade({ marginReq: 5000 });
      const trade2 = createTrade({ marginReq: 7500 });
      const trade3 = createTrade({ marginReq: 6000 });

      const combined = combineLegGroup([trade1, trade2, trade3]);

      expect(combined.marginReq).toBe(7500);
    });

    it("should calculate weighted average closing price", () => {
      const trade1 = createTrade({
        premium: 100,
        closingPrice: 6700,
      });
      const trade2 = createTrade({
        premium: 200,
        closingPrice: 6800,
      });

      const combined = combineLegGroup([trade1, trade2]);

      // (100 * 6700 + 200 * 6800) / (100 + 200) = 6766.67
      expect(combined.closingPrice).toBeCloseTo(6766.67, 2);
    });

    it("should sum closing costs across trades", () => {
      const trade1 = createTrade({
        avgClosingCost: 100,
      });
      const trade2 = createTrade({
        avgClosingCost: 250,
      });

      const combined = combineLegGroup([trade1, trade2]);

      expect(combined.avgClosingCost).toBe(350);
    });

    it("should sum max profit values when available", () => {
      const trade1 = createTrade({ maxProfit: 100 });
      const trade2 = createTrade({ maxProfit: 150 });

      const combined = combineLegGroup([trade1, trade2]);

      expect(combined.maxProfit).toBe(250);
    });

    it("should derive max loss from highest margin requirement", () => {
      const trade1 = createTrade({ marginReq: 5000, maxLoss: -50 });
      const trade2 = createTrade({ marginReq: 7500, maxLoss: -75 });

      const combined = combineLegGroup([trade1, trade2]);

      expect(combined.maxLoss).toBe(-7500);
    });

    it("should handle undefined optional fields", () => {
      const trade1 = createTrade({ maxProfit: 100, maxLoss: undefined });
      const trade2 = createTrade({ maxProfit: undefined, maxLoss: -50 });

      const combined = combineLegGroup([trade1, trade2]);

      expect(combined.maxProfit).toBeUndefined();
      expect(combined.maxLoss).toBe(-7365);
    });

    it("should throw error for empty array", () => {
      expect(() => combineLegGroup([])).toThrow("Cannot combine empty trade group");
    });
  });

  describe("combineAllLegGroups", () => {
    it("should combine multiple groups and preserve chronological order", () => {
      // Group 1: 10:15:00
      const g1t1 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        premium: 300,
        legs: "Calls",
      });
      const g1t2 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        premium: 325,
        legs: "Puts",
      });

      // Group 2: 09:32:00 (earlier)
      const g2t1 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "09:32:00",
        premium: 335,
        legs: "Calls 2",
      });
      const g2t2 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "09:32:00",
        premium: 310,
        legs: "Puts 2",
      });

      const combined = combineAllLegGroups([g1t1, g1t2, g2t1, g2t2]);

      expect(combined).toHaveLength(2);
      // Should be sorted chronologically (09:32 before 10:15)
      expect(combined[0].timeOpened).toBe("09:32:00");
      expect(combined[1].timeOpened).toBe("10:15:00");

      expect(combined[0].premium).toBe(645); // 335 + 310
      expect(combined[1].premium).toBe(625); // 300 + 325
    });

    it("should handle single trades mixed with grouped trades", () => {
      const grouped1 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        premium: 300,
      });
      const grouped2 = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        premium: 325,
      });
      const single = createTrade({
        dateOpened: new Date("2025-10-08"),
        timeOpened: "10:15:00",
        premium: 400,
      });

      const combined = combineAllLegGroups([grouped1, grouped2, single]);

      expect(combined).toHaveLength(2);
      expect(combined[0].originalTradeCount).toBe(2);
      expect(combined[1].originalTradeCount).toBe(1);
    });
  });

  describe("analyzeLegGroups", () => {
    it("should provide statistics about leg grouping", () => {
      const trades = [
        // Group 1: 2 trades
        createTrade({ timeOpened: "10:15:00", premium: 300 }),
        createTrade({ timeOpened: "10:15:00", premium: 325 }),
        // Group 2: 2 trades
        createTrade({ timeOpened: "09:32:00", premium: 335 }),
        createTrade({ timeOpened: "09:32:00", premium: 310 }),
        // Group 3: single trade
        createTrade({ timeOpened: "11:00:00", premium: 400 }),
      ];

      const analysis = analyzeLegGroups(trades);

      expect(analysis.totalTrades).toBe(5);
      expect(analysis.uniqueEntries).toBe(3);
      expect(analysis.groupedEntries).toBe(2); // Two groups with multiple trades
      expect(analysis.maxGroupSize).toBe(2);
      expect(analysis.groupSizeDistribution[1]).toBe(1); // 1 single trade
      expect(analysis.groupSizeDistribution[2]).toBe(2); // 2 groups of 2 trades
    });

    it("should handle all single trades", () => {
      const trades = [
        createTrade({ timeOpened: "10:15:00" }),
        createTrade({ timeOpened: "10:30:00" }),
        createTrade({ timeOpened: "10:45:00" }),
      ];

      const analysis = analyzeLegGroups(trades);

      expect(analysis.totalTrades).toBe(3);
      expect(analysis.uniqueEntries).toBe(3);
      expect(analysis.groupedEntries).toBe(0);
      expect(analysis.maxGroupSize).toBe(1);
    });

    it("should handle empty array", () => {
      const analysis = analyzeLegGroups([]);

      expect(analysis.totalTrades).toBe(0);
      expect(analysis.uniqueEntries).toBe(0);
      expect(analysis.groupedEntries).toBe(0);
      expect(analysis.maxGroupSize).toBe(0);
    });
  });

  describe("MEIC real-world example", () => {
    it("should correctly combine MEIC iron condor legs", () => {
      // Based on actual MEIC test data: 2025-10-07 10:15:00
      const callSpread = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        openingPrice: 6742.78,
        legs: "1 Oct 7 6755 C STO 3.15 | 1 Oct 7 6835 C BTO 0.05",
        premium: 300,
        closingPrice: 6714.59,
        dateClosed: new Date("2025-10-07"),
        timeClosed: "16:00:00",
        avgClosingCost: 0,
        reasonForClose: "Expired",
        pl: 296.44,
        numContracts: 1,
        fundsAtClose: 103258.52,
        marginReq: 7365,
        strategy: "MEIC",
        openingCommissionsFees: 3.56,
        closingCommissionsFees: 0,
        openingShortLongRatio: 63,
        closingShortLongRatio: 1,
      });

      const putSpread = createTrade({
        dateOpened: new Date("2025-10-07"),
        timeOpened: "10:15:00",
        openingPrice: 6742.78, // Same opening price
        legs: "1 Oct 7 6730 P STO 3.65 | 1 Oct 7 6650 P BTO 0.30",
        premium: 325,
        closingPrice: 6733.95,
        dateClosed: new Date("2025-10-07"),
        timeClosed: "10:36:00", // Different close time (stop loss)
        avgClosingCost: 675,
        reasonForClose: "Stop Loss",
        pl: -355.12,
        numContracts: 1,
        fundsAtClose: 103302.2,
        marginReq: 7365,
        strategy: "MEIC",
        openingCommissionsFees: 3.56,
        closingCommissionsFees: 1.56,
        openingShortLongRatio: 12.17,
        closingShortLongRatio: 21.333,
      });

      const combined = combineLegGroup([callSpread, putSpread]);

      // Verify combined trade properties
      expect(combined.originalTradeCount).toBe(2);
      expect(combined.dateOpened).toEqual(new Date("2025-10-07"));
      expect(combined.timeOpened).toBe("10:15:00");
      expect(combined.strategy).toBe("MEIC");

      // Aggregated values
      expect(combined.premium).toBe(625); // 300 + 325
      expect(combined.pl).toBeCloseTo(-58.68, 2); // 296.44 - 355.12
      expect(combined.openingCommissionsFees).toBeCloseTo(7.12, 2);
      expect(combined.closingCommissionsFees).toBeCloseTo(1.56, 2);
      expect(combined.maxLoss).toBe(-7365);

      // Should use last close time (16:00:00 is after 10:36:00)
      expect(combined.timeClosed).toBe("16:00:00");
      expect(combined.dateClosed).toEqual(new Date("2025-10-07"));

      // Combined legs should include both spreads
      expect(combined.legs).toContain("6755 C STO");
      expect(combined.legs).toContain("6730 P STO");
      expect(combined.combinedLegs).toHaveLength(2);
    });
  });
});
