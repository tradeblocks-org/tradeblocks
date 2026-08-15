/**
 * "Match OO stress test" preset derivation and the percentage-mode divergence
 * notice. The preset must land on exactly the three OO-validated settings
 * (Individual Trades sampling, guarantee injection, historical-dollar sizing)
 * from ANY starting configuration and touch nothing else; the divergence
 * notice must appear only for enabled injection under Percentage Returns.
 */

import {
  applyOoStressPreset,
  describePercentageStressDivergence,
  matchesOoStressPreset,
  OO_STRESS_PRESET,
  type OoStressPresetSettings,
} from "@/app/(platform)/risk-simulator/oo-stress-preset";

const RESAMPLE_METHODS = ["trades", "daily", "percentage"] as const;
const INJECTION_MODES = ["probabilistic", "guarantee"] as const;
const LOSS_SIZINGS = ["absolute", "relative"] as const;

function allConfigurations(): OoStressPresetSettings[] {
  const configs: OoStressPresetSettings[] = [];
  for (const resampleMethod of RESAMPLE_METHODS) {
    for (const worstCaseMode of INJECTION_MODES) {
      for (const worstCaseSizing of LOSS_SIZINGS) {
        configs.push({ resampleMethod, worstCaseMode, worstCaseSizing });
      }
    }
  }
  return configs;
}

describe("applyOoStressPreset", () => {
  it("lands on the three target settings from every starting configuration", () => {
    for (const config of allConfigurations()) {
      expect(applyOoStressPreset(config)).toEqual({
        resampleMethod: "trades",
        worstCaseMode: "guarantee",
        worstCaseSizing: "absolute",
      });
    }
  });

  it("touches nothing beyond the three preset fields", () => {
    const config = {
      resampleMethod: "percentage" as const,
      worstCaseMode: "probabilistic" as const,
      worstCaseSizing: "relative" as const,
      worstCasePercentage: 7,
      worstCaseBasedOn: "historical",
      numSimulations: 2500,
      simulationLength: 670,
      seed: 42,
    };
    const next = applyOoStressPreset(config);
    expect(next.worstCasePercentage).toBe(7);
    expect(next.worstCaseBasedOn).toBe("historical");
    expect(next.numSimulations).toBe(2500);
    expect(next.simulationLength).toBe(670);
    expect(next.seed).toBe(42);
    expect(Object.keys(next).sort()).toEqual(Object.keys(config).sort());
  });

  it("does not mutate the input", () => {
    const config: OoStressPresetSettings = {
      resampleMethod: "percentage",
      worstCaseMode: "probabilistic",
      worstCaseSizing: "relative",
    };
    applyOoStressPreset(config);
    expect(config).toEqual({
      resampleMethod: "percentage",
      worstCaseMode: "probabilistic",
      worstCaseSizing: "relative",
    });
  });

  it("is idempotent: an already-matching configuration is returned unchanged", () => {
    expect(applyOoStressPreset({ ...OO_STRESS_PRESET })).toEqual(OO_STRESS_PRESET);
  });
});

describe("matchesOoStressPreset", () => {
  it("is true exactly when all three settings hold the preset values", () => {
    for (const config of allConfigurations()) {
      const expected =
        config.resampleMethod === "trades" &&
        config.worstCaseMode === "guarantee" &&
        config.worstCaseSizing === "absolute";
      expect(matchesOoStressPreset(config)).toBe(expected);
    }
  });

  it("is true after applying the preset from every starting configuration", () => {
    for (const config of allConfigurations()) {
      expect(matchesOoStressPreset(applyOoStressPreset(config))).toBe(true);
    }
  });
});

describe("describePercentageStressDivergence", () => {
  it("names relative exposure, the milder read, and the preset for enabled percentage mode", () => {
    const text = describePercentageStressDivergence({
      worstCaseEnabled: true,
      resampleMethod: "percentage",
    });
    expect(text).toMatch(/relative exposure/);
    expect(text).toMatch(/share of the account at the time/);
    expect(text).toMatch(/milder than Option Omega/);
    expect(text).toMatch(/Match OO stress test/);
  });

  it("is null when injection is disabled", () => {
    expect(
      describePercentageStressDivergence({
        worstCaseEnabled: false,
        resampleMethod: "percentage",
      }),
    ).toBeNull();
  });

  it("is null for the dollar sampling methods", () => {
    for (const resampleMethod of ["trades", "daily"] as const) {
      expect(
        describePercentageStressDivergence({ worstCaseEnabled: true, resampleMethod }),
      ).toBeNull();
    }
  });
});
