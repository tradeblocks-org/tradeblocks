/**
 * "Match OO stress test" preset for the Worst-Case Scenario Testing panel.
 *
 * With matching configurations the simulator reproduces Option Omega's
 * fixed-count stress results (validated side by side on a reference log:
 * P95 within 0.06%, median within 1.3%). That configuration is Individual
 * Trades sampling + guarantee-mode injection + historical-dollar loss sizing.
 * The preset is a shortcut to those three settings, not a mode: it never
 * touches the injection percentage, basis, horizon, simulation count, or
 * seed, and every control stays editable after pressing it.
 *
 * Percentage-mode injection answers a different question — it stresses the
 * worst RELATIVE exposure (each loss sized as a share of the account at the
 * time), while OO stresses a fixed dollar amount. On a log whose account
 * grew substantially the two read very differently, which is why the
 * percentage-mode divergence notice below names this preset as the
 * OO-comparable path.
 */

export interface OoStressPresetSettings {
  resampleMethod: "trades" | "daily" | "percentage";
  worstCaseMode: "probabilistic" | "guarantee";
  worstCaseSizing: "absolute" | "relative";
}

export const OO_STRESS_PRESET: OoStressPresetSettings = {
  resampleMethod: "trades",
  worstCaseMode: "guarantee",
  worstCaseSizing: "absolute",
};

export function matchesOoStressPreset(settings: OoStressPresetSettings): boolean {
  return (
    settings.resampleMethod === OO_STRESS_PRESET.resampleMethod &&
    settings.worstCaseMode === OO_STRESS_PRESET.worstCaseMode &&
    settings.worstCaseSizing === OO_STRESS_PRESET.worstCaseSizing
  );
}

/**
 * Returns a copy of the settings with exactly the three preset fields set to
 * their OO-validated values and every other field untouched.
 */
export function applyOoStressPreset<T extends OoStressPresetSettings>(settings: T): T {
  return { ...settings, ...OO_STRESS_PRESET };
}

export interface PercentageStressDivergenceInput {
  worstCaseEnabled: boolean;
  resampleMethod: "trades" | "daily" | "percentage";
}

/**
 * Honest divergence notice for percentage-mode injection, shown only when
 * injection is enabled with Percentage Returns sampling. Null everywhere else.
 */
export function describePercentageStressDivergence(
  input: PercentageStressDivergenceInput,
): string | null {
  if (!input.worstCaseEnabled || input.resampleMethod !== "percentage") {
    return null;
  }
  return (
    "With Percentage Returns, each injected loss is sized as a share of the account at the " +
    "time it lands — this stresses your worst relative exposure, so on an account that grew " +
    "a lot it will read milder than Option Omega's fixed-dollar stress. For the " +
    "OO-comparable result, use the “Match OO stress test” preset."
  );
}
