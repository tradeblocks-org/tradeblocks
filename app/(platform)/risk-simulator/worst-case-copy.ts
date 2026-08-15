/**
 * Mode-aware captions for the worst-case injection budget.
 *
 * Guarantee mode forces an exact count into every simulation, so its captions
 * may promise "exactly" and "force". Probabilistic mode replaces each
 * simulated slot at the literal chance the percentage field states, so its
 * captions speak in per-slot-chance and average terms — nothing is forced.
 */

export interface WorstCaseBudgetCopyInput {
  mode: "probabilistic" | "guarantee";
  basedOn: "simulation" | "historical";
  /** The worst-case percentage the user typed (0-100) */
  percentage: number;
  /** Synthetic-trade budget for the run (expected count in probabilistic mode) */
  budget: number;
}

export function describeWorstCaseBudget({
  mode,
  basedOn,
  percentage,
  budget,
}: WorstCaseBudgetCopyInput): string {
  if (basedOn === "simulation") {
    if (mode === "probabilistic") {
      return (
        `Each simulated trade has a literal ${percentage}% chance of becoming a max-loss event ` +
        `(≈ ${budget} per simulation on average), with the loss sizes split evenly across strategies.`
      );
    }
    return (
      `Exactly ${percentage}% of the simulation horizon (≈ ${budget} synthetic trades) ` +
      `split evenly across strategies.`
    );
  }

  if (mode === "probabilistic") {
    return (
      `Loss values are weighted by each strategy's historical trade count; each simulated trade ` +
      `keeps a literal ${percentage}% replacement chance (≈ ${budget} per simulation on average).`
    );
  }
  return (
    `Weighted by each strategy's historical trade count, but capped at ${percentage}% of the ` +
    `simulation (≈ ${budget} trades) so the "Force ${percentage}%" promise stays accurate.`
  );
}
