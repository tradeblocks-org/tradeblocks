export type FilterObjective = "totalPl" | "winRate";

export interface SuggestionEvidence {
  objective: FilterObjective;
  tradesKept: number;
  keptFraction: number;
  tradesRemoved: number;
  confidence: "high" | "medium" | "low";
  warnings: string[];
}

/** Both suggestion paths use the same admission and sample-size support rule. */
export function suggestionEvidence(
  objective: FilterObjective,
  winRateDelta: number,
  plDelta: number,
  kept: number,
  removed: number,
  minImprovementPct: number,
): SuggestionEvidence | null {
  if (
    !kept ||
    !removed ||
    (objective === "totalPl" ? plDelta <= 0 : winRateDelta < minImprovementPct)
  )
    return null;
  const keptFraction = kept / (kept + removed);
  const lowRetention = keptFraction < 0.2;
  return {
    objective,
    tradesKept: kept,
    keptFraction,
    tradesRemoved: removed,
    confidence: lowRetention
      ? "low"
      : removed >= 10 && kept >= 20
        ? "high"
        : removed >= 5 && kept >= 10
          ? "medium"
          : "low",
    warnings: lowRetention
      ? ["Low retention: fewer than 20% of covered trades kept; sample-size support capped at low."]
      : [],
  };
}

export function rankSuggestions(
  objective: FilterObjective,
  a: { winRateDelta: number; plDelta: number },
  b: { winRateDelta: number; plDelta: number },
): number {
  return objective === "totalPl"
    ? b.plDelta - a.plDelta || b.winRateDelta - a.winRateDelta
    : b.winRateDelta - a.winRateDelta || b.plDelta - a.plDelta;
}

export function objectiveOutput(objective: FilterObjective, minImprovementPct?: number) {
  return {
    objective,
    rankingRule:
      objective === "totalPl"
        ? "Positive P&L improvement, ranked by P&L improvement then win-rate gain"
        : "Win-rate gain >= minImprovementPct, ranked by win-rate gain then P&L improvement",
    supportNote:
      "confidence is sample-size support, not statistical confidence; keptFraction < 0.2 caps it at low",
    ...(objective === "totalPl" && minImprovementPct !== undefined
      ? {
          objectiveNote:
            "minImprovementPct is ignored under totalPl; only positive P&L improvement is admitted.",
        }
      : {}),
  };
}
