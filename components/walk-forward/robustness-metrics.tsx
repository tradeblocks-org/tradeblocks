"use client";

import { MetricCard } from "@/components/metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { HelpCircle } from "lucide-react";
import type { WalkForwardPeriodResult, WalkForwardResults } from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

interface RobustnessMetricsProps {
  results: WalkForwardResults | null;
  targetMetricLabel: string;
}

export function RobustnessMetrics({ results, targetMetricLabel }: RobustnessMetricsProps) {
  // targetMetricLabel kept in interface for API stability; not currently used in tooltips
  void targetMetricLabel;

  if (!results) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Execute a walk-forward run to unlock robustness insights.
        </CardContent>
      </Card>
    );
  }

  const { summary, stats } = results;
  const efficiencyPct = summary.avgInSamplePerformance !== 0 ? summary.degradationFactor * 100 : 0;

  // Calculate percentage-based delta: (OOS - IS) / |IS| * 100
  // This shows how much performance changed as a percentage of the in-sample baseline
  const avgDeltaPct =
    summary.avgInSamplePerformance !== 0
      ? (stats.averagePerformanceDelta / Math.abs(summary.avgInSamplePerformance)) * 100
      : 0;

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        title="Efficiency Ratio"
        value={Number.isFinite(efficiencyPct) ? efficiencyPct : 0}
        format="percentage"
        tooltip={{
          flavor: "How much of your optimized performance survived real-world testing.",
          detailed: `If you achieved $1,000 during optimization and $800 on new data, efficiency is 80%. Values above 70% suggest robust results. Below 50% is a red flag—the optimized parameters may not generalize beyond the training data.`,
        }}
        isPositive={efficiencyPct >= 90}
      />
      <MetricCard
        title="Parameter Stability"
        value={summary.parameterStability * 100}
        format="percentage"
        tooltip={{
          flavor: "Whether the 'best' settings stayed similar across different time periods.",
          detailed:
            "If optimal parameters swing wildly (e.g., Kelly 0.3 one window, 1.5 the next), the results may be unreliable. High stability (70%+) means you can use a single set of parameters with confidence.",
        }}
        isPositive={summary.parameterStability >= 0.7}
      />
      <MetricCard
        title="Consistency Score"
        value={(stats.consistencyScore || 0) * 100}
        format="percentage"
        tooltip={{
          flavor: "How often results stayed profitable across different time periods.",
          detailed:
            "If you tested 10 windows and 7 were profitable out-of-sample, consistency is 70%. High consistency (60%+) suggests the optimized parameters adapt well to different market conditions. Low consistency means performance varies wildly—some periods win big, others lose.",
        }}
        isPositive={stats.consistencyScore >= 0.6}
      />
      <MetricCard
        title="Avg Performance Delta"
        value={Number.isFinite(avgDeltaPct) ? avgDeltaPct : 0}
        subtitle={`% change from in-sample`}
        format="percentage"
        tooltip={{
          flavor: "How much performance dropped when tested on new data.",
          detailed:
            "This shows the gap between optimization results and real-world testing. A value near 0% means performance held steady on new data. Negative values (like -15%) mean out-of-sample performance was 15% worse. Large negative drops (beyond -20%) often indicate the optimization fit to noise rather than a real edge.",
        }}
        isPositive={avgDeltaPct >= -10}
      />
      <MetricCard
        title="Robustness Score"
        value={summary.robustnessScore * 100}
        format="percentage"
        tooltip={{
          flavor: "A combined quality score for comparing different analysis runs.",
          detailed:
            "Blends efficiency, parameter stability, and consistency into one number. Useful for quickly comparing runs with different settings—higher is better. Don't fixate on the absolute number; use it to see if changes improved or hurt overall robustness.",
        }}
        className="md:col-span-2 lg:col-span-4"
        isPositive={summary.robustnessScore >= 0.6}
      />

      {/* Diversification Metrics - only shown when diversification analysis was enabled */}
      {(summary.avgCorrelationAcrossPeriods !== undefined ||
        summary.avgTailDependenceAcrossPeriods !== undefined ||
        summary.avgEffectiveFactors !== undefined) && (
        <Card className="md:col-span-2 lg:col-span-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Diversification Metrics</CardTitle>
            <CardDescription className="text-xs">
              Average values across all walk-forward periods
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-3">
              {summary.avgCorrelationAcrossPeriods !== undefined && (
                <MetricCard
                  title="Avg Correlation"
                  value={summary.avgCorrelationAcrossPeriods}
                  format="decimal"
                  decimalPlaces={3}
                  tooltip={{
                    flavor: "Average pairwise correlation between strategies across all periods.",
                    detailed:
                      "Lower values indicate better diversification. Values below 0.5 are generally good; below 0.3 is excellent.",
                  }}
                  isPositive={summary.avgCorrelationAcrossPeriods < 0.5}
                />
              )}
              {summary.avgTailDependenceAcrossPeriods !== undefined && (
                <TailDependenceMetric
                  avgTailDependence={summary.avgTailDependenceAcrossPeriods}
                  periods={results.periods}
                />
              )}
              {summary.avgEffectiveFactors !== undefined && (
                <MetricCard
                  title="Effective Factors"
                  value={summary.avgEffectiveFactors}
                  format="decimal"
                  decimalPlaces={2}
                  tooltip={{
                    flavor: "Average number of independent risk factors across all periods.",
                    detailed:
                      "Higher values indicate better diversification. Close to the number of strategies means each contributes unique risk/return.",
                  }}
                  isPositive={summary.avgEffectiveFactors >= 2}
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Special component for tail dependence that handles insufficient data state
 */
function TailDependenceMetric({
  avgTailDependence,
  periods,
}: {
  avgTailDependence: number;
  periods: WalkForwardPeriodResult[];
}) {
  // Check if all periods have insufficient tail data
  const periodsWithDiversification = periods.filter((p) => p.diversificationMetrics);
  const hasInsufficientData = periodsWithDiversification.every((p) => {
    const metrics = p.diversificationMetrics;
    if (!metrics) return true;
    // If insufficientTailDataPairs equals totalPairs, no valid data exists
    return (
      metrics.insufficientTailDataPairs !== undefined &&
      metrics.totalPairs !== undefined &&
      metrics.insufficientTailDataPairs >= metrics.totalPairs
    );
  });

  // Also check if avgTailDependence is 0 and maxTailDependence is 0 across all periods
  // This catches older results that don't have the new fields
  const allZeroTailMetrics =
    avgTailDependence === 0 &&
    periodsWithDiversification.every(
      (p) =>
        p.diversificationMetrics?.avgTailDependence === 0 &&
        p.diversificationMetrics?.maxTailDependence === 0 &&
        p.diversificationMetrics?.maxTailDependencePair?.[0] === "" &&
        p.diversificationMetrics?.maxTailDependencePair?.[1] === "",
    );

  const showInsufficientData = hasInsufficientData || allZeroTailMetrics;

  if (showInsufficientData) {
    return (
      <div className={cn("rounded-lg p-4 space-y-1", "bg-muted/50")}>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Avg Tail Dependence</span>
          <HoverCard>
            <HoverCardTrigger asChild>
              <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
            </HoverCardTrigger>
            <HoverCardContent className="w-80">
              <div className="space-y-2">
                <p className="text-sm font-medium">Insufficient tail data</p>
                <p className="text-xs text-muted-foreground">
                  Tail dependence requires strategies to have simultaneous extreme losses on shared
                  trading days. With short OOS windows or sparse trading schedules, there may not be
                  enough co-occurring tail events to calculate meaningful estimates.
                </p>
                <p className="text-xs text-muted-foreground">
                  <strong>Try:</strong> Longer OOS windows, higher tail threshold (e.g., 25%), or
                  strategies that trade more frequently on overlapping days.
                </p>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
        <p className="text-sm font-medium text-muted-foreground/70">Insufficient data</p>
      </div>
    );
  }

  return (
    <MetricCard
      title="Avg Tail Dependence"
      value={avgTailDependence}
      format="decimal"
      decimalPlaces={3}
      tooltip={{
        flavor: "Average joint tail risk between strategies across all periods.",
        detailed:
          "Measures how often strategies experience extreme losses together. Lower is better.",
      }}
      isPositive={avgTailDependence < 0.4}
    />
  );
}
