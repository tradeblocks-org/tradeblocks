/**
 * Unit tests for walk-forward-interpretation.ts
 *
 * Focuses on validatePreRunConfiguration which checks config BEFORE analysis runs.
 */
import { validatePreRunConfiguration, WalkForwardConfig } from "@tradeblocks/lib";

// Helper to create a valid config with overrides
function makeConfig(overrides: Partial<WalkForwardConfig> = {}): WalkForwardConfig {
  return {
    inSampleDays: 45,
    outOfSampleDays: 15,
    stepSizeDays: 15,
    optimizationTarget: "netPl",
    parameterRanges: { kellyMultiplier: [0.5, 1.5, 0.25] },
    minInSampleTrades: 15,
    minOutOfSampleTrades: 5,
    ...overrides,
  };
}

describe("validatePreRunConfiguration", () => {
  describe("short window warning", () => {
    it("should warn when inSampleDays < 21", () => {
      const config = makeConfig({ inSampleDays: 14 });
      const observations = validatePreRunConfiguration(config);

      const shortWindowObs = observations.find((o) => o.title.includes("Short in-sample"));
      expect(shortWindowObs).toBeDefined();
      expect(shortWindowObs?.severity).toBe("warning");
      expect(shortWindowObs?.title).toContain("14d");
    });

    it("should not warn when inSampleDays = 21", () => {
      const config = makeConfig({ inSampleDays: 21 });
      const observations = validatePreRunConfiguration(config);

      const shortWindowObs = observations.find((o) => o.title.includes("Short in-sample"));
      expect(shortWindowObs).toBeUndefined();
    });

    it("should not warn when inSampleDays > 21", () => {
      const config = makeConfig({ inSampleDays: 45 });
      const observations = validatePreRunConfiguration(config);

      const shortWindowObs = observations.find((o) => o.title.includes("Short in-sample"));
      expect(shortWindowObs).toBeUndefined();
    });
  });

  describe("aggressive IS/OOS ratio", () => {
    it("should show info when ratio < 2 (e.g., 14:14 = 1:1)", () => {
      const config = makeConfig({ inSampleDays: 14, outOfSampleDays: 14 });
      const observations = validatePreRunConfiguration(config);

      const ratioObs = observations.find((o) => o.title.includes("ratio"));
      expect(ratioObs).toBeDefined();
      expect(ratioObs?.severity).toBe("info");
      expect(ratioObs?.title).toContain("1.0:1");
    });

    it("should show info when ratio < 2 (e.g., 30:20 = 1.5:1)", () => {
      const config = makeConfig({ inSampleDays: 30, outOfSampleDays: 20 });
      const observations = validatePreRunConfiguration(config);

      const ratioObs = observations.find((o) => o.title.includes("ratio"));
      expect(ratioObs).toBeDefined();
      expect(ratioObs?.severity).toBe("info");
      expect(ratioObs?.title).toContain("1.5:1");
    });

    it("should not show info when ratio = 2 (e.g., 30:15)", () => {
      const config = makeConfig({ inSampleDays: 30, outOfSampleDays: 15 });
      const observations = validatePreRunConfiguration(config);

      const ratioObs = observations.find((o) => o.title.includes("ratio"));
      expect(ratioObs).toBeUndefined();
    });

    it("should not show info when ratio > 2 (e.g., 45:15 = 3:1)", () => {
      const config = makeConfig({ inSampleDays: 45, outOfSampleDays: 15 });
      const observations = validatePreRunConfiguration(config);

      const ratioObs = observations.find((o) => o.title.includes("ratio"));
      expect(ratioObs).toBeUndefined();
    });
  });

  describe("long window info", () => {
    it("should show info when inSampleDays > 90", () => {
      const config = makeConfig({ inSampleDays: 120 });
      const observations = validatePreRunConfiguration(config);

      const longWindowObs = observations.find((o) => o.title.includes("Long in-sample"));
      expect(longWindowObs).toBeDefined();
      expect(longWindowObs?.severity).toBe("info");
      expect(longWindowObs?.title).toContain("120d");
    });

    it("should not show info when inSampleDays = 90", () => {
      const config = makeConfig({ inSampleDays: 90 });
      const observations = validatePreRunConfiguration(config);

      const longWindowObs = observations.find((o) => o.title.includes("Long in-sample"));
      expect(longWindowObs).toBeUndefined();
    });

    it("should not show info when inSampleDays < 90", () => {
      const config = makeConfig({ inSampleDays: 60 });
      const observations = validatePreRunConfiguration(config);

      const longWindowObs = observations.find((o) => o.title.includes("Long in-sample"));
      expect(longWindowObs).toBeUndefined();
    });
  });

  describe("low trade requirements", () => {
    it("should warn when minInSampleTrades < 10", () => {
      const config = makeConfig({ minInSampleTrades: 5 });
      const observations = validatePreRunConfiguration(config);

      const lowISTradesObs = observations.find((o) => o.title.includes("Low min IS trades"));
      expect(lowISTradesObs).toBeDefined();
      expect(lowISTradesObs?.severity).toBe("warning");
      expect(lowISTradesObs?.title).toContain("5");
    });

    it("should not warn when minInSampleTrades = 10", () => {
      const config = makeConfig({ minInSampleTrades: 10 });
      const observations = validatePreRunConfiguration(config);

      const lowISTradesObs = observations.find((o) => o.title.includes("Low min IS trades"));
      expect(lowISTradesObs).toBeUndefined();
    });

    it("should warn when minOutOfSampleTrades < 5", () => {
      const config = makeConfig({ minOutOfSampleTrades: 2 });
      const observations = validatePreRunConfiguration(config);

      const lowOOSTradesObs = observations.find((o) => o.title.includes("Low min OOS trades"));
      expect(lowOOSTradesObs).toBeDefined();
      expect(lowOOSTradesObs?.severity).toBe("warning");
      expect(lowOOSTradesObs?.title).toContain("2");
    });

    it("should not warn when minOutOfSampleTrades = 5", () => {
      const config = makeConfig({ minOutOfSampleTrades: 5 });
      const observations = validatePreRunConfiguration(config);

      const lowOOSTradesObs = observations.find((o) => o.title.includes("Low min OOS trades"));
      expect(lowOOSTradesObs).toBeUndefined();
    });

    it("should use defaults when minTrades are undefined", () => {
      // Default is 15 IS and 5 OOS, so should not warn
      const config = makeConfig({ minInSampleTrades: undefined, minOutOfSampleTrades: undefined });
      const observations = validatePreRunConfiguration(config);

      const lowISTradesObs = observations.find((o) => o.title.includes("Low min IS trades"));
      const lowOOSTradesObs = observations.find((o) => o.title.includes("Low min OOS trades"));
      expect(lowISTradesObs).toBeUndefined();
      expect(lowOOSTradesObs).toBeUndefined();
    });
  });

  describe("multiple observations", () => {
    it("should return multiple observations when multiple issues exist", () => {
      // 14 IS, 14 OOS, 5 min IS, 2 min OOS
      // Should trigger: short window (14<21), aggressive ratio (1:1<2), low IS trades (5<10), low OOS trades (2<5)
      const config = makeConfig({
        inSampleDays: 14,
        outOfSampleDays: 14,
        minInSampleTrades: 5,
        minOutOfSampleTrades: 2,
      });
      const observations = validatePreRunConfiguration(config);

      expect(observations.length).toBe(4);
      expect(observations.filter((o) => o.severity === "warning").length).toBe(3);
      expect(observations.filter((o) => o.severity === "info").length).toBe(1);
    });

    it("should return empty array for well-configured setup", () => {
      // 45:15 ratio (3:1), 15 min IS, 5 min OOS - all within bounds
      const config = makeConfig({
        inSampleDays: 45,
        outOfSampleDays: 15,
        minInSampleTrades: 15,
        minOutOfSampleTrades: 5,
      });
      const observations = validatePreRunConfiguration(config);

      expect(observations).toHaveLength(0);
    });
  });
});
