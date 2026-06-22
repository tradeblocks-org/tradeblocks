import { describe, it, expect } from "@jest/globals";

describe("Drawdown Calculation", () => {
  it("should calculate drawdown percentage correctly", () => {
    // Test data simulating equity curve
    const equityCurve = [
      { date: "2025-01-01", equity: 100000, highWaterMark: 100000 },
      { date: "2025-01-02", equity: 105000, highWaterMark: 105000 },
      { date: "2025-01-03", equity: 110000, highWaterMark: 110000 },
      { date: "2025-01-04", equity: 95000, highWaterMark: 110000 }, // 13.64% drawdown
      { date: "2025-01-05", equity: 85000, highWaterMark: 110000 }, // 22.73% drawdown (max)
      { date: "2025-01-06", equity: 90000, highWaterMark: 110000 }, // 18.18% drawdown
    ];

    // Calculate drawdown data using the current formula
    const drawdownData = equityCurve.map((point) => ({
      date: point.date,
      drawdownPct: ((point.equity - point.highWaterMark) / point.highWaterMark) * 100,
    }));

    // Expected values
    expect(drawdownData[0].drawdownPct).toBe(0); // No drawdown at start
    expect(drawdownData[1].drawdownPct).toBe(0); // New high
    expect(drawdownData[2].drawdownPct).toBe(0); // New high
    expect(drawdownData[3].drawdownPct).toBeCloseTo(-13.64, 2); // First drawdown
    expect(drawdownData[4].drawdownPct).toBeCloseTo(-22.73, 2); // Max drawdown
    expect(drawdownData[5].drawdownPct).toBeCloseTo(-18.18, 2); // Recovery but still in drawdown

    // Find maximum drawdown point (most negative value)
    const maxDrawdownPoint = drawdownData.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    expect(maxDrawdownPoint.date).toBe("2025-01-05");
    expect(maxDrawdownPoint.drawdownPct).toBeCloseTo(-22.73, 2);
  });

  it("should handle edge cases in drawdown calculation", () => {
    // Test with zero high water mark
    const zeroEquityCurve = [{ date: "2025-01-01", equity: 0, highWaterMark: 0 }];

    const zeroDrawdownData = zeroEquityCurve.map((point) => ({
      date: point.date,
      drawdownPct:
        point.highWaterMark > 0
          ? ((point.equity - point.highWaterMark) / point.highWaterMark) * 100
          : 0,
    }));

    expect(zeroDrawdownData[0].drawdownPct).toBe(0);

    // Test with only positive equity values (no drawdown)
    const positiveEquityCurve = [
      { date: "2025-01-01", equity: 100000, highWaterMark: 100000 },
      { date: "2025-01-02", equity: 105000, highWaterMark: 105000 },
      { date: "2025-01-03", equity: 110000, highWaterMark: 110000 },
    ];

    const positiveDrawdownData = positiveEquityCurve.map((point) => ({
      date: point.date,
      drawdownPct: ((point.equity - point.highWaterMark) / point.highWaterMark) * 100,
    }));

    expect(positiveDrawdownData.every((point) => point.drawdownPct === 0)).toBe(true);
  });
});
