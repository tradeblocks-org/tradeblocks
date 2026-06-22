"use client";

import { MetricCard } from "@/components/metric-card";
import { TailRiskAnalysisResult } from "@tradeblocks/lib";

interface TailRiskSummaryCardsProps {
  result: TailRiskAnalysisResult;
}

export function TailRiskSummaryCards({ result }: TailRiskSummaryCardsProps) {
  const {
    strategies,
    tradingDaysUsed,
    effectiveFactors,
    analytics,
    tailThreshold,
    varianceThreshold,
  } = result;

  const avgJointRisk = analytics.averageJointTailRisk;
  const highPairsPct = analytics.highRiskPairsPct * 100;
  const factorRatio = strategies.length > 0 ? effectiveFactors / strategies.length : 1;

  // Determine if values indicate good (positive) or bad (negative) risk
  const isFactorGood = factorRatio >= 0.3; // More factors = better diversification
  const isJointRiskGood = avgJointRisk < 0.3;
  const isHighPairsGood = highPairsPct < 20;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard
        title="Strategies"
        value={strategies.length}
        subtitle={`${tradingDaysUsed.toLocaleString()} trading days`}
        tooltip={{
          flavor: "Number of unique strategies included in the tail risk analysis.",
          detailed:
            "All strategies in the selected block are analyzed. The trading days count shows how many unique dates had at least one trade across all strategies.",
        }}
      />

      <MetricCard
        title="Effective Factors"
        value={effectiveFactors}
        subtitle={`of ${strategies.length} strategies (${(factorRatio * 100).toFixed(0)}% diversification)`}
        isPositive={isFactorGood}
        tooltip={{
          flavor: `Number of independent risk factors needed to explain ${(varianceThreshold * 100).toFixed(0)}% of portfolio tail risk.`,
          detailed:
            "Lower numbers mean more concentrated risk - your strategies share common tail risk factors. Higher numbers (closer to total strategy count) indicate better tail risk diversification. A portfolio with 20 strategies but only 3 effective factors has highly correlated tail risk.",
        }}
      />

      <MetricCard
        title="Avg Joint Tail Risk"
        value={`${(avgJointRisk * 100).toFixed(0)}%`}
        subtitle={
          avgJointRisk < 0.3
            ? "Good diversification"
            : avgJointRisk < 0.5
              ? "Moderate tail risk"
              : "High tail concentration"
        }
        isPositive={isJointRiskGood}
        tooltip={{
          flavor: `Average probability that strategies have extreme losses together.`,
          detailed: `When one strategy is in its worst ${(tailThreshold * 100).toFixed(0)}% of days, this shows the average probability that another strategy is also in its worst ${(tailThreshold * 100).toFixed(0)}%. Values above 0.5 indicate strategies tend to blow up together on market stress days. Values below 0.3 suggest good tail diversification.`,
        }}
      />

      <MetricCard
        title="High Risk Pairs"
        value={`${highPairsPct.toFixed(0)}%`}
        subtitle={
          highPairsPct < 20
            ? "Few concentrated pairs"
            : highPairsPct < 40
              ? "Some concentrated pairs"
              : "Many concentrated pairs"
        }
        isPositive={isHighPairsGood}
        tooltip={{
          flavor: "Percentage of strategy pairs with joint tail risk greater than 0.5.",
          detailed:
            "These pairs have more than 50% chance of losing together on extreme days. A high percentage here means much of your portfolio is exposed to correlated tail risk. Look at the heatmap to identify which specific pairs have the highest joint tail risk.",
        }}
      />
    </div>
  );
}
