import { calculateKellyMetrics, Trade } from "@tradeblocks/lib";

describe("Kelly Calculator", () => {
  describe("calculateKellyMetrics", () => {
    test("should return correct win rate for 100% winning trades", () => {
      const trades: Trade[] = [
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-01"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 100,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 100100,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-02"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 200,
          premium: 200,
          numContracts: 1,
          fundsAtClose: 100300,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-03"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 150,
          premium: 150,
          numContracts: 1,
          fundsAtClose: 100450,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
      ];

      const metrics = calculateKellyMetrics(trades);

      expect(metrics.winRate).toBe(1.0); // 100% win rate
      expect(metrics.avgWin).toBe(150); // (100 + 200 + 150) / 3
      expect(metrics.avgLoss).toBe(0);
      expect(metrics.hasValidKelly).toBe(false); // Can't calculate Kelly without losses
      expect(metrics.fraction).toBe(0);
      expect(metrics.percent).toBe(0);
    });

    test("should return correct win rate for 100% losing trades", () => {
      const trades: Trade[] = [
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-01"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: -100,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 99900,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-02"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: -200,
          premium: 200,
          numContracts: 1,
          fundsAtClose: 99700,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
      ];

      const metrics = calculateKellyMetrics(trades);

      expect(metrics.winRate).toBe(0); // 0% win rate
      expect(metrics.avgWin).toBe(0);
      expect(metrics.avgLoss).toBe(150); // (100 + 200) / 2
      expect(metrics.hasValidKelly).toBe(false); // Can't calculate Kelly without wins
      expect(metrics.fraction).toBe(0);
      expect(metrics.percent).toBe(0);
    });

    test("should calculate valid Kelly with both wins and losses", () => {
      const trades: Trade[] = [
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-01"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 100,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 100100,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-02"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 200,
          premium: 200,
          numContracts: 1,
          fundsAtClose: 100300,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-03"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: -100,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 100200,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-04"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: -50,
          premium: 50,
          numContracts: 1,
          fundsAtClose: 100150,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
      ];

      const metrics = calculateKellyMetrics(trades);

      expect(metrics.winRate).toBe(0.5); // 2 wins out of 4 trades
      expect(metrics.avgWin).toBe(150); // (100 + 200) / 2
      expect(metrics.avgLoss).toBe(75); // (100 + 50) / 2
      expect(metrics.payoffRatio).toBe(2); // 150 / 75
      expect(metrics.hasValidKelly).toBe(true);

      // Kelly formula: (payoffRatio * winRate - lossRate) / payoffRatio
      // = (2 * 0.5 - 0.5) / 2 = 0.5 / 2 = 0.25
      expect(metrics.fraction).toBeCloseTo(0.25);
      expect(metrics.percent).toBeCloseTo(25);
    });

    test("should handle trades with zero P/L", () => {
      const trades: Trade[] = [
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-01"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 100,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 100100,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-02"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: 0,
          premium: 100,
          numContracts: 1,
          fundsAtClose: 100100,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
        {
          strategy: "Test",
          dateOpened: new Date("2024-01-03"),
          timeOpened: "09:30:00",
          openingPrice: 100,
          legs: "Test",
          pl: -50,
          premium: 50,
          numContracts: 1,
          fundsAtClose: 100050,
          marginReq: 1000,
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 1.0,
        } as Trade,
      ];

      const metrics = calculateKellyMetrics(trades);

      expect(metrics.winRate).toBeCloseTo(0.333, 2); // 1 win out of 3 trades
      expect(metrics.avgWin).toBe(100);
      expect(metrics.avgLoss).toBe(50);
      expect(metrics.hasValidKelly).toBe(true);
    });

    test("should return zero metrics for empty trades array", () => {
      const trades: Trade[] = [];
      const metrics = calculateKellyMetrics(trades);

      expect(metrics.winRate).toBe(0);
      expect(metrics.avgWin).toBe(0);
      expect(metrics.avgLoss).toBe(0);
      expect(metrics.hasValidKelly).toBe(false);
      expect(metrics.fraction).toBe(0);
      expect(metrics.percent).toBe(0);
    });
  });
});
