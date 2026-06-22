/**
 * Tests for async combine leg groups functionality
 */
import { Trade, combineAllLegGroupsAsync, CombineLegGroupsProgress } from "@tradeblocks/lib";

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

describe("combineAllLegGroupsAsync", () => {
  describe("basic functionality", () => {
    it("should combine trades with same entry timestamp", async () => {
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "CALL 4500",
          pl: 25,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          strategy: "MEIC",
          legs: "PUT 4400",
          pl: 30,
        }),
      ];

      const result = await combineAllLegGroupsAsync(trades);

      expect(result).toHaveLength(1);
      expect(result[0].pl).toBe(55); // 25 + 30
      expect(result[0].originalTradeCount).toBe(2);
    });

    it("should preserve single trades as-is", async () => {
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          pl: 100,
        }),
      ];

      const result = await combineAllLegGroupsAsync(trades);

      expect(result).toHaveLength(1);
      expect(result[0].pl).toBe(100);
      expect(result[0].originalTradeCount).toBe(1);
    });

    it("should handle empty array", async () => {
      const result = await combineAllLegGroupsAsync([]);
      expect(result).toHaveLength(0);
    });

    it("should sort result by date/time", async () => {
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-20"),
          timeOpened: "09:30:00",
          strategy: "A",
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          strategy: "B",
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-17"),
          timeOpened: "09:30:00",
          strategy: "C",
        }),
      ];

      const result = await combineAllLegGroupsAsync(trades);

      expect(result).toHaveLength(3);
      expect(result[0].strategy).toBe("B"); // Jan 15
      expect(result[1].strategy).toBe("C"); // Jan 17
      expect(result[2].strategy).toBe("A"); // Jan 20
    });
  });

  describe("progress reporting", () => {
    it("should call onProgress callback with progress updates", async () => {
      const trades = [
        createMockTrade({ dateOpened: new Date("2024-01-15"), timeOpened: "09:30:00" }),
        createMockTrade({ dateOpened: new Date("2024-01-16"), timeOpened: "09:30:00" }),
      ];

      const progressUpdates: CombineLegGroupsProgress[] = [];
      await combineAllLegGroupsAsync(trades, {
        onProgress: (progress) => progressUpdates.push({ ...progress }),
      });

      expect(progressUpdates.length).toBeGreaterThan(0);

      // Should start at 0%
      expect(progressUpdates[0].percent).toBe(0);

      // Should end at 100%
      expect(progressUpdates[progressUpdates.length - 1].percent).toBe(100);
      expect(progressUpdates[progressUpdates.length - 1].step).toBe("Complete");
    });

    it("should report grouping step", async () => {
      const trades = [createMockTrade()];

      const steps: string[] = [];
      await combineAllLegGroupsAsync(trades, {
        onProgress: (progress) => steps.push(progress.step),
      });

      expect(steps).toContain("Grouping trades by entry");
    });

    it("should report combining step", async () => {
      const trades = [createMockTrade()];

      const steps: string[] = [];
      await combineAllLegGroupsAsync(trades, {
        onProgress: (progress) => steps.push(progress.step),
      });

      expect(steps).toContain("Combining leg groups");
    });

    it("should report sorting step", async () => {
      const trades = [createMockTrade()];

      const steps: string[] = [];
      await combineAllLegGroupsAsync(trades, {
        onProgress: (progress) => steps.push(progress.step),
      });

      expect(steps).toContain("Sorting combined trades");
    });
  });

  describe("cancellation", () => {
    it("should throw AbortError when cancelled before starting", async () => {
      const trades = [createMockTrade()];
      const controller = new AbortController();
      controller.abort();

      await expect(combineAllLegGroupsAsync(trades, { signal: controller.signal })).rejects.toThrow(
        "Operation cancelled",
      );
    });

    it("should respect AbortSignal during processing", async () => {
      // Create enough trades to trigger yields (100+ groups)
      const trades: Trade[] = [];
      for (let i = 0; i < 150; i++) {
        trades.push(
          createMockTrade({
            dateOpened: new Date(`2024-01-${String(Math.floor(i / 5) + 1).padStart(2, "0")}`),
            timeOpened: `09:${String(i % 60).padStart(2, "0")}:00`,
            strategy: `Strategy${i}`,
          }),
        );
      }

      const controller = new AbortController();

      // Abort after first progress update
      let aborted = false;
      const promise = combineAllLegGroupsAsync(trades, {
        signal: controller.signal,
        onProgress: () => {
          if (!aborted) {
            aborted = true;
            controller.abort();
          }
        },
      });

      await expect(promise).rejects.toThrow("Operation cancelled");
    });

    it("should not call onProgress after cancellation", async () => {
      const trades: Trade[] = [];
      for (let i = 0; i < 150; i++) {
        trades.push(
          createMockTrade({
            dateOpened: new Date(`2024-01-${String(Math.floor(i / 5) + 1).padStart(2, "0")}`),
            timeOpened: `09:${String(i % 60).padStart(2, "0")}:00`,
            strategy: `Strategy${i}`,
          }),
        );
      }

      const controller = new AbortController();
      let progressCallsAfterAbort = 0;
      let abortedAt: number | null = null;

      try {
        await combineAllLegGroupsAsync(trades, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (abortedAt !== null) {
              progressCallsAfterAbort++;
            }
            if (progress.percent >= 10 && abortedAt === null) {
              abortedAt = progress.percent;
              controller.abort();
            }
          },
        });
      } catch {
        // Expected to throw
      }

      // There might be one more progress call before the cancellation is checked
      expect(progressCallsAfterAbort).toBeLessThanOrEqual(1);
    });
  });

  describe("large dataset handling", () => {
    it("should handle large number of trades without blocking", async () => {
      // Create 500 trades (should yield multiple times)
      const trades: Trade[] = [];
      for (let i = 0; i < 500; i++) {
        // Generate valid dates within 2024
        const month = (i % 12) + 1;
        const day = (i % 28) + 1; // Stay within valid day range for all months
        trades.push(
          createMockTrade({
            dateOpened: new Date(2024, month - 1, day), // Use Date constructor for valid dates
            timeOpened: `09:${String(i % 60).padStart(2, "0")}:00`,
            strategy: `Strategy${i % 10}`,
            pl: i * 10,
          }),
        );
      }

      const start = Date.now();
      const result = await combineAllLegGroupsAsync(trades);
      const elapsed = Date.now() - start;

      // Should complete (doesn't hang)
      expect(result.length).toBeGreaterThan(0);

      // Should complete in reasonable time (under 5 seconds even with yields)
      expect(elapsed).toBeLessThan(5000);
    });

    it("should yield at regular intervals for large datasets", async () => {
      // Create enough trades to trigger multiple yields
      const trades: Trade[] = [];
      for (let i = 0; i < 350; i++) {
        trades.push(
          createMockTrade({
            dateOpened: new Date(`2024-01-${String((i % 28) + 1).padStart(2, "0")}`),
            timeOpened: `${String(Math.floor(i / 60) + 9).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
            strategy: `S${i}`,
          }),
        );
      }

      let progressCalls = 0;
      await combineAllLegGroupsAsync(trades, {
        onProgress: () => {
          progressCalls++;
        },
      });

      // Should have multiple progress calls (yields every 100 groups + initial + sorting + complete)
      expect(progressCalls).toBeGreaterThan(3);
    });
  });
});
