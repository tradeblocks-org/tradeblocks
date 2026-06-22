import { describe, it, expect } from "@jest/globals";

describe("Equity Curve and Drawdown Logic", () => {
  it("should demonstrate the current drawdown calculation bug", () => {
    // Simulate the current equity curve calculation
    function calculateEquityCurve(trades: Array<{ pl: number; date: string }>) {
      const sortedTrades = [...trades].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );

      let runningEquity = 100000; // Starting capital
      let highWaterMark = runningEquity;

      const curve = [
        {
          date: "2025-01-01",
          equity: runningEquity,
          highWaterMark,
        },
      ];

      sortedTrades.forEach((trade) => {
        runningEquity += trade.pl;
        highWaterMark = Math.max(highWaterMark, runningEquity); // BUG: Updates immediately

        curve.push({
          date: trade.date,
          equity: runningEquity,
          highWaterMark,
        });
      });

      return curve;
    }

    // Example scenario that causes the bug
    const trades = [
      { pl: 10000, date: "2025-01-02" }, // Equity: 110000, HWM: 110000
      { pl: -5000, date: "2025-01-03" }, // Equity: 105000, HWM: 110000 (correct)
      { pl: -20000, date: "2025-01-04" }, // Equity: 85000, HWM: 110000 (should be biggest DD)
      { pl: -10000, date: "2025-01-05" }, // Equity: 75000, HWM: 110000 (actual biggest DD)
    ];

    const equityCurve = calculateEquityCurve(trades);

    // Calculate drawdowns using current logic
    const drawdownData = equityCurve.map((point) => ({
      date: point.date,
      equity: point.equity,
      highWaterMark: point.highWaterMark,
      drawdownPct:
        point.highWaterMark > 0
          ? ((point.equity - point.highWaterMark) / point.highWaterMark) * 100
          : 0,
    }));

    console.log("Equity curve:", equityCurve);
    console.log("Drawdown data:", drawdownData);

    // Find max drawdown using current logic
    const maxDrawdownPoint = drawdownData.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    // The max drawdown should be at 75000 equity (-31.82% from 110000)
    // But let's see what we actually get
    expect(maxDrawdownPoint.equity).toBe(75000);
    expect(maxDrawdownPoint.drawdownPct).toBeCloseTo(-31.82, 2);
  });

  it("should show correct drawdown calculation", () => {
    // This is what the calculation SHOULD be
    const equityPoints = [
      { date: "2025-01-01", equity: 100000 },
      { date: "2025-01-02", equity: 110000 }, // New peak
      { date: "2025-01-03", equity: 105000 }, // 4.55% drawdown from 110000
      { date: "2025-01-04", equity: 85000 }, // 22.73% drawdown from 110000
      { date: "2025-01-05", equity: 75000 }, // 31.82% drawdown from 110000 (max)
    ];

    // Correct high water mark tracking
    let highWaterMark = 100000;
    const correctDrawdowns = equityPoints.map((point) => {
      highWaterMark = Math.max(highWaterMark, point.equity);
      const drawdownPct = ((point.equity - highWaterMark) / highWaterMark) * 100;

      return {
        date: point.date,
        equity: point.equity,
        highWaterMark,
        drawdownPct,
      };
    });

    const maxDD = correctDrawdowns.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    expect(maxDD.drawdownPct).toBeCloseTo(-31.82, 2);
    expect(maxDD.equity).toBe(75000);
  });
});
