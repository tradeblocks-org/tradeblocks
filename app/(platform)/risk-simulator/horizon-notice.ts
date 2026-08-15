import type { TimeUnit } from "@tradeblocks/lib";

export interface HorizonNoticeInput {
  /**
   * True once the user has typed a horizon by hand.
   *
   * This flag is the single source of truth for whether the horizon still
   * follows the loaded history. Comparing the horizon to the current default
   * would be a second, disagreeing answer: a hand-typed horizon that happens to
   * equal the history now in scope is still a manual horizon, because the next
   * history change will not move it.
   */
  horizonEdited: boolean;
  /** Horizon in trades, after converting whatever unit the user picked */
  simulationLength: number;
  /** Trades in the history currently in scope, after the strategy filter */
  historyTradeCount: number;
  /** Unit the user picked */
  unit: TimeUnit;
  /** Plain-English time equivalent of the horizon at the user's trading pace */
  paceText: string;
}

export interface HorizonNotice {
  /** True while the horizon still follows the loaded history */
  followsHistory: boolean;
  /** Helper text under the simulation-period input */
  text: string;
}

function formatTradeCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "trade" : "trades"}`;
}

/**
 * Helper text under the simulation-period input, plus whether the horizon is
 * still following the history.
 *
 * A horizon typed by hand is kept even when the strategy filter changes the
 * history, because comparing several sleeves at one fixed horizon is a real
 * workflow. That makes it possible for the horizon to no longer match the
 * history behind it, so when it doesn't, the text says so and names the
 * current history instead of leaving the mismatch invisible.
 */
export function describeSimulationHorizon(input: HorizonNoticeInput): HorizonNotice {
  const { horizonEdited, simulationLength, historyTradeCount, unit, paceText } = input;

  if (!horizonEdited) {
    return {
      followsHistory: true,
      text: `Matches your history (${formatTradeCount(simulationLength)} ≈ ${paceText})`,
    };
  }

  const horizonText =
    unit === "trades"
      ? `${simulationLength.toLocaleString()} trades ≈ ${paceText}`
      : `≈ ${simulationLength.toLocaleString()} trades at your pace`;

  if (simulationLength === historyTradeCount) {
    return { followsHistory: false, text: horizonText };
  }

  return {
    followsHistory: false,
    text: `Manual horizon: ${horizonText} — your history is ${formatTradeCount(historyTradeCount)}`,
  };
}
