import type { WalkForwardConfig, WalkForwardResults } from "../models/walk-forward.ts";
import type { Assessment, VerdictAssessment } from "./walk-forward-verdict.ts";

/**
 * Explanation for a single metric factor that contributed to the verdict.
 */
export interface VerdictFactor {
  metric: string;
  value: string;
  assessment: Assessment;
  explanation: string;
}

/**
 * Complete verdict explanation with headline, reasoning, and supporting factors.
 */
export interface VerdictExplanation {
  headline: string;
  reasoning: string[];
  factors: VerdictFactor[];
}

/**
 * A red flag detected in the WFA results.
 */
export interface RedFlag {
  severity: "warning" | "concern";
  title: string;
  description: string;
}

/**
 * A configuration observation that may affect interpretation.
 */
export interface ConfigurationObservation {
  severity: "info" | "warning";
  title: string;
  description: string;
}

/**
 * Generates a plain-language explanation of the WFA verdict.
 *
 * Returns a headline summarizing the verdict, reasoning bullets explaining why,
 * and factors breaking down each metric's contribution.
 */
export function generateVerdictExplanation(
  results: WalkForwardResults,
  assessment: VerdictAssessment,
): VerdictExplanation {
  const { summary, stats } = results;
  const efficiencyPct = summary.degradationFactor * 100;
  const stabilityPct = summary.parameterStability * 100;
  const consistencyPct = (stats.consistencyScore || 0) * 100;
  const periodCount = results.periods.length;

  // Generate headline based on overall assessment
  let headline: string;
  if (assessment.overall === "good") {
    headline = `Your strategy held up when tested on data it never saw. The edge appears real, not just luck.`;
  } else if (assessment.overall === "moderate") {
    headline = `Your strategy showed mixed results—sometimes it worked, sometimes it didn't. The edge might be real but context-dependent.`;
  } else {
    headline = `Your strategy performed significantly worse on new data than during optimization. This suggests the optimization may have found patterns specific to historical data.`;
  }

  // Generate reasoning bullets based on which metrics drove the verdict
  const reasoning: string[] = [];

  if (assessment.efficiency === "good") {
    reasoning.push(
      `Efficiency of ${efficiencyPct.toFixed(0)}% indicates the strategy retained most of its optimized performance on unseen data.`,
    );
  } else if (assessment.efficiency === "moderate") {
    reasoning.push(
      `Efficiency of ${efficiencyPct.toFixed(0)}% shows some performance decay, which is common but worth monitoring.`,
    );
  } else {
    reasoning.push(
      `Efficiency of ${efficiencyPct.toFixed(0)}% indicates significant performance loss on unseen data.`,
    );
  }

  if (assessment.consistency === "good") {
    reasoning.push(
      `${consistencyPct.toFixed(0)}% of windows were profitable, suggesting the strategy works across different market periods.`,
    );
  } else if (assessment.consistency === "moderate") {
    reasoning.push(
      `${consistencyPct.toFixed(0)}% of windows were profitable—performance varied between periods.`,
    );
  } else {
    reasoning.push(
      `Only ${consistencyPct.toFixed(0)}% of windows were profitable, indicating the strategy struggled in most periods.`,
    );
  }

  if (assessment.stability === "good") {
    reasoning.push(
      `Parameter stability of ${stabilityPct.toFixed(0)}% suggests optimal settings were consistent across windows.`,
    );
  } else if (assessment.stability === "moderate") {
    reasoning.push(
      `Parameter stability of ${stabilityPct.toFixed(0)}% shows some variation in optimal settings between windows.`,
    );
  } else {
    reasoning.push(
      `Parameter stability of ${stabilityPct.toFixed(0)}% indicates optimal settings varied significantly, which may suggest curve-fitting.`,
    );
  }

  // Generate factors with plain-language explanations
  const factors: VerdictFactor[] = [
    {
      metric: "Efficiency",
      value: `${efficiencyPct.toFixed(1)}%`,
      assessment: assessment.efficiency,
      explanation: getEfficiencyExplanation(efficiencyPct),
    },
    {
      metric: "Stability",
      value: `${stabilityPct.toFixed(1)}%`,
      assessment: assessment.stability,
      explanation: getStabilityExplanation(stabilityPct),
    },
    {
      metric: "Consistency",
      value: `${consistencyPct.toFixed(1)}%`,
      assessment: assessment.consistency,
      explanation: getConsistencyExplanation(consistencyPct, periodCount),
    },
  ];

  return {
    headline,
    reasoning,
    factors,
  };
}

/**
 * Detects concerning patterns or red flags in WFA results.
 *
 * Returns an array of red flags with severity and descriptions.
 * An empty array indicates no concerning patterns were found.
 */
export function detectRedFlags(results: WalkForwardResults): RedFlag[] {
  const flags: RedFlag[] = [];
  const { summary, stats, periods } = results;

  const efficiencyPct = summary.degradationFactor * 100;
  const stabilityPct = summary.parameterStability * 100;
  const consistencyPct = (stats.consistencyScore || 0) * 100;

  // WFE < 50% - concerning
  if (efficiencyPct < 50) {
    flags.push({
      severity: "concern",
      title: "Low efficiency",
      description: `Efficiency of ${efficiencyPct.toFixed(0)}% means the strategy lost more than half its performance on unseen data. This often indicates overfitting to historical patterns.`,
    });
  }

  // WFE > 120% - warning (unusual, investigate)
  if (efficiencyPct > 120) {
    flags.push({
      severity: "warning",
      title: "Unusually high efficiency",
      description: `Efficiency of ${efficiencyPct.toFixed(0)}% means out-of-sample performance exceeded in-sample. While possible, this is unusual—verify there's no data overlap between training and test windows.`,
    });
  }

  // Check efficiency variance across windows (CV > 0.5 is concerning)
  if (periods.length >= 3) {
    const efficiencies = periods.map((p) => {
      if (p.targetMetricInSample === 0) return 0;
      return p.targetMetricOutOfSample / p.targetMetricInSample;
    });
    const mean = efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;
    const variance =
      efficiencies.reduce((sum, e) => sum + Math.pow(e - mean, 2), 0) / efficiencies.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0;

    if (cv > 0.5) {
      flags.push({
        severity: "concern",
        title: "Inconsistent efficiency",
        description: `Efficiency varied widely between windows (CV: ${(cv * 100).toFixed(0)}%). This suggests the strategy's performance is highly dependent on specific market conditions.`,
      });
    }
  }

  // Consistency < 50% - concerning
  if (consistencyPct < 50) {
    flags.push({
      severity: "concern",
      title: "More losing than winning windows",
      description: `Only ${consistencyPct.toFixed(0)}% of windows were profitable. The strategy failed in more periods than it succeeded.`,
    });
  }

  // Stability < 50% - warning
  if (stabilityPct < 50) {
    flags.push({
      severity: "warning",
      title: "Parameter instability",
      description: `Parameter stability of ${stabilityPct.toFixed(0)}% indicates optimal settings changed significantly between windows. This may suggest the strategy is chasing noise rather than stable patterns.`,
    });
  }

  // Degradation cascade - check if later windows performing worse
  if (periods.length >= 6) {
    const firstThree = periods.slice(0, 3);
    const lastThree = periods.slice(-3);

    const firstThreeAvg = firstThree.reduce((sum, p) => sum + p.targetMetricOutOfSample, 0) / 3;
    const lastThreeAvg = lastThree.reduce((sum, p) => sum + p.targetMetricOutOfSample, 0) / 3;

    // Only flag if first three had positive performance and last three dropped by >30%
    if (firstThreeAvg > 0 && lastThreeAvg < firstThreeAvg * 0.7) {
      flags.push({
        severity: "warning",
        title: "Performance degradation over time",
        description: `Recent windows performed notably worse than earlier ones. This may indicate market conditions have evolved past the strategy's edge.`,
      });
    }
  }

  return flags;
}

/**
 * Generates 2-3 observation sentences about the WFA results.
 *
 * Uses "suggests", "indicates", "may mean" language to frame observations
 * rather than recommendations.
 */
export function generateInsights(
  results: WalkForwardResults,
  assessment: VerdictAssessment,
): string[] {
  const insights: string[] = [];
  const { summary, stats, periods } = results;

  const efficiencyPct = summary.degradationFactor * 100;
  const consistencyPct = (stats.consistencyScore || 0) * 100;
  const periodCount = periods.length;

  // Overall insight based on verdict
  if (assessment.overall === "good") {
    insights.push(
      `Results held up across ${periodCount} windows, suggesting the strategy captures patterns that persist in different market conditions.`,
    );
  } else if (assessment.overall === "moderate") {
    insights.push(
      `Performance varied between windows, which may indicate the strategy works better in certain market conditions than others.`,
    );
  } else {
    insights.push(
      `The significant drop from training to testing periods suggests the optimization may have found patterns specific to historical data rather than repeatable edges.`,
    );
  }

  // Efficiency-specific insight
  if (efficiencyPct >= 80) {
    insights.push(
      `Retaining ${efficiencyPct.toFixed(0)}% of in-sample performance indicates the optimized settings generalize well to new data.`,
    );
  } else if (efficiencyPct >= 50 && efficiencyPct < 80) {
    insights.push(
      `Some performance decay from in-sample to out-of-sample is expected. An efficiency of ${efficiencyPct.toFixed(0)}% suggests the core edge may be real but with room for improvement.`,
    );
  }

  // Consistency insight if notable
  if (consistencyPct >= 70 && periodCount >= 4) {
    insights.push(
      `Profitability in ${consistencyPct.toFixed(0)}% of windows across ${periodCount} periods suggests the strategy has broad applicability rather than relying on specific market regimes.`,
    );
  } else if (consistencyPct < 50 && periodCount >= 4) {
    insights.push(
      `Struggling in most windows may indicate the strategy is suited to particular conditions. Identifying those conditions could help determine when to deploy it.`,
    );
  }

  // Limit to 3 insights
  return insights.slice(0, 3);
}

// Helper functions for plain-language explanations

function getEfficiencyExplanation(efficiencyPct: number): string {
  if (efficiencyPct >= 80) {
    return "Strategy held up well—optimization found patterns that repeat on new data.";
  }
  if (efficiencyPct >= 60) {
    return "Strategy lost some edge but remained profitable—some decay is normal.";
  }
  if (efficiencyPct >= 50) {
    return "Strategy lost about half its edge—may be fragile in live trading.";
  }
  return "Strategy performed much worse on new data—likely overfit to historical patterns.";
}

function getStabilityExplanation(stabilityPct: number): string {
  if (stabilityPct >= 70) {
    return "Optimal settings stayed similar across periods—parameters found genuine patterns.";
  }
  if (stabilityPct >= 50) {
    return "Some variation in optimal settings—normal for adaptive strategies.";
  }
  return "Settings varied widely between periods—strategy may be chasing noise.";
}

function getConsistencyExplanation(consistencyPct: number, periodCount: number): string {
  if (consistencyPct >= 70) {
    return `Profitable in most of the ${periodCount} windows—worked across different market conditions.`;
  }
  if (consistencyPct >= 50) {
    return `Worked in some windows, not others—may need filtering for market conditions.`;
  }
  return `Failed more often than it succeeded—strategy may need refinement.`;
}

/**
 * Validates configuration settings BEFORE running analysis.
 *
 * Returns guidance about potential configuration issues so users can
 * adjust settings before investing time in a run. Unlike detectConfigurationObservations,
 * this function runs without results - it's purely about configuration choices.
 *
 * @param config - The WFA configuration to validate
 * @returns Array of observations about configuration choices
 */
export function validatePreRunConfiguration(config: WalkForwardConfig): ConfigurationObservation[] {
  const observations: ConfigurationObservation[] = [];
  const { inSampleDays, outOfSampleDays, minInSampleTrades, minOutOfSampleTrades } = config;

  // 1. Short window warning: inSampleDays < 21
  if (inSampleDays < 21) {
    observations.push({
      severity: "warning",
      title: `Short in-sample window (${inSampleDays}d)`,
      description: `Windows shorter than 21 days may amplify noise over signal. The optimizer might find patterns that don't persist. Consider 30+ days for more reliable results.`,
    });
  }

  // 2. Aggressive IS/OOS ratio: < 2:1
  const ratio = inSampleDays / outOfSampleDays;
  if (ratio < 2) {
    observations.push({
      severity: "info",
      title: `Aggressive IS/OOS ratio (${ratio.toFixed(1)}:1)`,
      description: `Using nearly equal training and testing periods is more demanding. Typical ratios are 2:1 to 4:1, giving the optimizer more data to find stable patterns.`,
    });
  }

  // 3. Very long windows: inSampleDays > 90
  if (inSampleDays > 90) {
    observations.push({
      severity: "info",
      title: `Long in-sample window (${inSampleDays}d)`,
      description: `Windows longer than 90 days may include stale market regimes. Parameters optimized over long periods might not reflect current conditions.`,
    });
  }

  // 4. Low trade requirements: minInSampleTrades < 10 OR minOutOfSampleTrades < 5
  const minIS = minInSampleTrades ?? 15;
  const minOOS = minOutOfSampleTrades ?? 5;

  if (minIS < 10) {
    observations.push({
      severity: "warning",
      title: `Low min IS trades (${minIS})`,
      description: `Optimizing with fewer than 10 trades per window produces statistically unreliable results. Consider 10-15+ trades for meaningful optimization.`,
    });
  }

  if (minOOS < 5) {
    observations.push({
      severity: "warning",
      title: `Low min OOS trades (${minOOS})`,
      description: `Validating with fewer than 5 trades per window makes out-of-sample results noisy. Consider 5-10 trades for reliable validation.`,
    });
  }

  return observations;
}

/**
 * Detects configuration patterns that may affect result interpretation.
 *
 * Returns observations about the WFA configuration that help users
 * distinguish strategy issues from configuration issues.
 */
export function detectConfigurationObservations(
  config: WalkForwardConfig,
  results: WalkForwardResults,
): ConfigurationObservation[] {
  const observations: ConfigurationObservation[] = [];
  const { inSampleDays, outOfSampleDays } = config;
  const periodCount = results.periods.length;
  const windowSize = inSampleDays + outOfSampleDays;

  // Short IS window (warning): inSampleDays < 21
  if (inSampleDays < 21) {
    observations.push({
      severity: "warning",
      title: `In-sample window is short (${inSampleDays}d)`,
      description: `With only ${inSampleDays} days of training data per window, the optimizer may not have enough information to find robust patterns. Consider increasing to 30+ days.`,
    });
  }

  // Short OOS window (warning): outOfSampleDays < 7
  if (outOfSampleDays < 7) {
    observations.push({
      severity: "warning",
      title: `Out-of-sample window is short (${outOfSampleDays}d)`,
      description: `With only ${outOfSampleDays} days of testing data, results may be noisy. A longer testing period (14+ days) provides more confidence.`,
    });
  }

  // Aggressive IS/OOS ratio (warning): inSampleDays / outOfSampleDays > 4
  const ratio = inSampleDays / outOfSampleDays;
  if (ratio > 4) {
    observations.push({
      severity: "warning",
      title: `High IS/OOS ratio (${ratio.toFixed(1)}:1)`,
      description: `Using ${ratio.toFixed(1)} times more training data than testing data increases overfitting risk. Ratios of 2:1 to 3:1 are more balanced.`,
    });
  }

  // Many windows from short data (info): periods >= 10 && windowSize < 30
  if (periodCount >= 10 && windowSize < 30) {
    observations.push({
      severity: "info",
      title: `Many short windows (${periodCount} windows of ${windowSize}d each)`,
      description: `Running many short windows can produce noisy results. Each window may capture different market regimes.`,
    });
  }

  // Few periods (info): periods < 4
  if (periodCount < 4) {
    observations.push({
      severity: "info",
      title: `Limited test periods (${periodCount} windows)`,
      description: `With only ${periodCount} periods, the sample size is small. Results may not generalize well to other time periods.`,
    });
  }

  return observations;
}
