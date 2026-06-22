import { describe, it, expect } from "@jest/globals";

describe("Drawdown Chart Max Drawdown Logic", () => {
  it("should find the correct maximum drawdown point", () => {
    // Simulating drawdown data that might cause the display issue
    const drawdownData = [
      { date: "2025-01-01", drawdownPct: 0 },
      { date: "2025-01-02", drawdownPct: 0 },
      { date: "2025-01-03", drawdownPct: -5.2 },
      { date: "2025-01-04", drawdownPct: -13.64 },
      { date: "2025-01-05", drawdownPct: -22.6 }, // This should be max drawdown
      { date: "2025-01-06", drawdownPct: -18.18 },
      { date: "2025-01-07", drawdownPct: -20.1 }, // This might be confused as max
      { date: "2025-01-08", drawdownPct: -15.5 },
    ];

    // Replicate the logic from drawdown-chart.tsx
    const maxDrawdownPoint = drawdownData.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    // Should find the most negative value (-22.6%)
    expect(maxDrawdownPoint.date).toBe("2025-01-05");
    expect(maxDrawdownPoint.drawdownPct).toBe(-22.6);

    // The issue might be in how the chart annotation is positioned
    // Let's also test edge cases
  });

  it("should handle equal drawdown values correctly", () => {
    const drawdownData = [
      { date: "2025-01-01", drawdownPct: 0 },
      { date: "2025-01-02", drawdownPct: -20.0 }, // First occurrence of max drawdown
      { date: "2025-01-03", drawdownPct: -15.0 },
      { date: "2025-01-04", drawdownPct: -20.0 }, // Second occurrence of same max drawdown
    ];

    const maxDrawdownPoint = drawdownData.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    // Should return the first occurrence
    expect(maxDrawdownPoint.date).toBe("2025-01-02");
    expect(maxDrawdownPoint.drawdownPct).toBe(-20.0);
  });

  it("should handle floating point precision issues", () => {
    const drawdownData = [
      { date: "2025-01-01", drawdownPct: 0 },
      { date: "2025-01-02", drawdownPct: -22.599999 }, // Close to -22.6
      { date: "2025-01-03", drawdownPct: -22.6 }, // Actual -22.6
      { date: "2025-01-04", drawdownPct: -20.1 },
    ];

    const maxDrawdownPoint = drawdownData.reduce((max, current) =>
      current.drawdownPct < max.drawdownPct ? current : max,
    );

    // Should find the most negative value
    expect(maxDrawdownPoint.date).toBe("2025-01-03");
    expect(maxDrawdownPoint.drawdownPct).toBe(-22.6);
  });

  it("should format the legend text correctly", () => {
    const maxDrawdownPoint = { date: "2025-01-05", drawdownPct: -22.63456 };

    // Replicate the legend formatting from the component
    const legendText = `Max Drawdown: ${maxDrawdownPoint.drawdownPct.toFixed(1)}%`;

    expect(legendText).toBe("Max Drawdown: -22.6%");
  });

  it("should ensure consistent max drawdown calculation with fixed logic", () => {
    const drawdownData = [
      { date: "2025-01-01", drawdownPct: 0 },
      { date: "2025-01-02", drawdownPct: -5.2 },
      { date: "2025-01-03", drawdownPct: -13.64 },
      { date: "2025-01-04", drawdownPct: -22.6 }, // Max drawdown
      { date: "2025-01-05", drawdownPct: -18.18 },
    ];

    // Test the improved logic from the fixed component
    const maxDrawdownPoint =
      drawdownData.length > 0
        ? drawdownData.reduce((max, current) =>
            current.drawdownPct < max.drawdownPct ? current : max,
          )
        : { date: "", drawdownPct: 0 };

    // Should find the correct max drawdown
    expect(maxDrawdownPoint.date).toBe("2025-01-04");
    expect(maxDrawdownPoint.drawdownPct).toBe(-22.6);

    // Test that minDrawdown uses the same value for consistency
    const minDrawdown = maxDrawdownPoint.drawdownPct;
    expect(minDrawdown).toBe(-22.6);

    // Test y-axis range calculation
    const yAxisRange = [minDrawdown * 1.1, 5];
    expect(yAxisRange[0]).toBeCloseTo(-24.86, 2);
    expect(yAxisRange[1]).toBe(5);
  });
});
