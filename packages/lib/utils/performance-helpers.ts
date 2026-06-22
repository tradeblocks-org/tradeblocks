import type { Trade } from "../models/trade.ts";
import { groupTradesByEntry } from "./combine-leg-groups.ts";

export type GroupedOutcome = "all_losses" | "all_wins" | "mixed" | "neutral";

export interface GroupedLegEntry {
  id: string;
  dateOpened: string;
  timeOpened: string;
  strategy: string;
  legCount: number;
  positiveLegs: number;
  negativeLegs: number;
  outcome: GroupedOutcome;
  combinedPl: number;
  legPlValues: number[];
}

export interface GroupedLegSummary {
  totalEntries: number;
  allLosses: number;
  allWins: number;
  mixedOutcomes: number;
  neutral: number;
  totalAllLossMagnitude: number;
}

export interface GroupedLegOutcomes {
  entries: GroupedLegEntry[];
  summary: GroupedLegSummary;
}

export function classifyOutcome(
  positiveLegs: number,
  negativeLegs: number,
  legCount: number,
): GroupedOutcome {
  if (legCount <= 1) return "neutral";
  if (negativeLegs === legCount) return "all_losses";
  if (positiveLegs === legCount) return "all_wins";
  if (positiveLegs > 0 && negativeLegs > 0) return "mixed";
  return "neutral";
}

export function deriveGroupedLegOutcomes(rawTrades: Trade[]): GroupedLegOutcomes | null {
  if (rawTrades.length === 0) {
    return null;
  }

  const groups = groupTradesByEntry(rawTrades);
  const entries: GroupedLegEntry[] = [];

  let allLosses = 0;
  let allWins = 0;
  let mixedOutcomes = 0;
  let neutral = 0;
  let totalAllLossMagnitude = 0;

  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => {
      const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    const legPlValues = group.map((trade) => trade.pl);
    const positiveLegs = legPlValues.filter((pl) => pl > 0).length;
    const negativeLegs = legPlValues.filter((pl) => pl < 0).length;
    const combinedPl = legPlValues.reduce((sum, pl) => sum + pl, 0);
    const outcome = classifyOutcome(positiveLegs, negativeLegs, group.length);

    const entry: GroupedLegEntry = {
      id: key,
      dateOpened: sorted[0].dateOpened.toISOString(),
      timeOpened: sorted[0].timeOpened,
      strategy: sorted[0].strategy,
      legCount: group.length,
      positiveLegs,
      negativeLegs,
      outcome,
      combinedPl,
      legPlValues,
    };

    switch (outcome) {
      case "all_losses":
        allLosses += 1;
        totalAllLossMagnitude += Math.abs(combinedPl);
        break;
      case "all_wins":
        allWins += 1;
        break;
      case "mixed":
        mixedOutcomes += 1;
        break;
      default:
        neutral += 1;
    }

    entries.push(entry);
  }

  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => {
    const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
    if (dateCompare !== 0) return dateCompare;
    return a.timeOpened.localeCompare(b.timeOpened);
  });

  return {
    entries,
    summary: {
      totalEntries: entries.length,
      allLosses,
      allWins,
      mixedOutcomes,
      neutral,
      totalAllLossMagnitude,
    },
  };
}
