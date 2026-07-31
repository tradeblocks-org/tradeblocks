import type { TimeUnit } from "@tradeblocks/lib";

export interface HorizonNoticeInput {
  /** True while the horizon still matches the loaded history exactly */
  isAtDefault: boolean;
  /** Horizon in trades, after converting whatever unit the user picked */
  simulationLength: number;
  /** Trades in the history currently in scope, after the strategy filter */
  historyTradeCount: number;
  /** Unit the user picked */
  unit: TimeUnit;
  /** Plain-English time equivalent of the horizon at the user's trading pace */
  paceText: string;
}

function formatTradeCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "trade" : "trades"}`;
}

/**
 * Helper text under the simulation-period input.
 *
 * A horizon typed by hand is kept even when the strategy filter changes the
 * history, because comparing several sleeves at one fixed horizon is a real
 * workflow. That makes it possible for the horizon to no longer match the
 * history behind it, so when it doesn't, the text says so and names the
 * current history instead of leaving the mismatch invisible.
 */
export function describeSimulationHorizon(input: HorizonNoticeInput): string {
  const { isAtDefault, simulationLength, historyTradeCount, unit, paceText } = input;

  if (isAtDefault) {
    return `Matches your history (${formatTradeCount(simulationLength)} ≈ ${paceText})`;
  }

  const horizonText =
    unit === "trades"
      ? `${simulationLength.toLocaleString()} trades ≈ ${paceText}`
      : `≈ ${simulationLength.toLocaleString()} trades at your pace`;

  if (simulationLength === historyTradeCount) {
    return horizonText;
  }

  return `Manual horizon: ${horizonText} — your history is ${formatTradeCount(historyTradeCount)}`;
}
