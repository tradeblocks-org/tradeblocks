"use client";

import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@tradeblocks/lib";
import type { WalkForwardResults } from "@tradeblocks/lib";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";
import { assessResults, type Assessment } from "@tradeblocks/lib";

interface WalkForwardSummaryProps {
  results: WalkForwardResults;
}

const overallStyles: Record<
  Assessment,
  {
    border: string;
    bg: string;
    text: string;
    icon: typeof CheckCircle2;
  }
> = {
  good: {
    border: "border-l-emerald-500",
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  moderate: {
    border: "border-l-amber-500",
    bg: "bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-400",
    icon: AlertTriangle,
  },
  concerning: {
    border: "border-l-rose-500",
    bg: "bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-400",
    icon: XCircle,
  },
};

const summaryMessages: Record<Assessment, string> = {
  good: "Results held up well when tested on new data.",
  moderate: "Results showed mixed performance across different time periods.",
  concerning: "Results may not generalize—consider adjusting your WFA configuration.",
};

function getEfficiencyLabel(pct: number): string {
  return `${Math.round(pct)}% of performance held up`;
}

function getStabilityLabel(assessment: Assessment): string {
  switch (assessment) {
    case "good":
      return "Parameters were stable";
    case "moderate":
      return "Parameters were variable";
    case "concerning":
      return "Parameters were unstable";
  }
}

function getConsistencyLabel(consistencyPct: number, windowCount: number): string {
  const profitableCount = Math.round((consistencyPct / 100) * windowCount);
  return `${profitableCount} of ${windowCount} windows were profitable`;
}

export function WalkForwardSummary({ results }: WalkForwardSummaryProps) {
  // Handle empty periods - show informative message instead of crashing
  if (results.periods.length === 0) {
    return (
      <Card className="border-l-4 border-l-amber-500">
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-amber-700 dark:text-amber-400">
                No Windows Generated
              </h2>
              <p className="text-sm text-muted-foreground">
                The analysis completed but no windows met the criteria.
              </p>
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 p-4 space-y-2">
            <p className="text-sm font-medium">Try adjusting your configuration:</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Reduce in-sample or out-of-sample window sizes</li>
              <li>Lower the minimum trade requirements</li>
              <li>Relax performance floor thresholds (min Sharpe, min PF)</li>
              <li>Check if the selected date range has sufficient data</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    );
  }

  const assessment = assessResults(results);
  const style = overallStyles[assessment.overall];
  const Icon = style.icon;

  const efficiencyPct = results.summary.degradationFactor * 100;
  const consistencyPct = (results.stats.consistencyScore || 0) * 100;
  const windowCount = results.periods.length;

  // Count skipped window reasons
  const skippedWindows = results.skippedWindows ?? [];
  const skippedCount = skippedWindows.length;
  const insufficientTradesCount = skippedWindows.filter(
    (w) => w.reason === "insufficient_is_trades" || w.reason === "insufficient_oos_trades",
  ).length;
  const noViableParamsCount = skippedWindows.filter((w) => w.reason === "no_viable_params").length;

  return (
    <Card className={cn("border-l-4", style.border)}>
      <CardContent className="pt-6 space-y-6">
        {/* Large visual status indicator and summary */}
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
              style.bg,
              style.text,
            )}
          >
            <Icon className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className={cn("text-lg font-semibold", style.text)}>
                {assessment.overall === "good"
                  ? "Looking Good"
                  : assessment.overall === "moderate"
                    ? "Mixed Results"
                    : "Needs Attention"}
              </h2>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help hover:text-muted-foreground transition-colors" />
                </HoverCardTrigger>
                <HoverCardContent className="w-96 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">
                        What Walk-Forward Analysis Tests
                      </h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Did the optimized parameters work on data they never saw?
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Walk-forward analysis splits your trading history into training windows
                        (in-sample) and testing windows (out-of-sample). During training, the
                        optimizer finds the best parameters. Those parameters are then tested on the
                        next chunk of unseen data—simulating what happens when you trade live with
                        optimized settings. If performance holds up on unseen data, the results are
                        robust. If it collapses, the optimization may have fit to noise rather than
                        a real edge.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-sm text-muted-foreground">{summaryMessages[assessment.overall]}</p>
            {skippedCount > 0 && (
              <p className="text-xs text-muted-foreground/80">
                {skippedCount} window{skippedCount !== 1 ? "s" : ""} skipped
                {" ("}
                {[
                  insufficientTradesCount > 0 && `${insufficientTradesCount} insufficient trades`,
                  noViableParamsCount > 0 && `${noViableParamsCount} no viable params`,
                ]
                  .filter(Boolean)
                  .join(", ")}
                {")"}
              </p>
            )}
          </div>
        </div>

        {/* Three key metrics in horizontal row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricCard
            label="Efficiency"
            value={getEfficiencyLabel(efficiencyPct)}
            assessment={assessment.efficiency}
            tooltip="Compares out-of-sample performance to in-sample. High efficiency means your optimized settings worked well on new data."
          />
          <MetricCard
            label="Stability"
            value={getStabilityLabel(assessment.stability)}
            assessment={assessment.stability}
            tooltip="How much the optimal parameters changed across different time periods. Stable parameters suggest a consistent strategy."
          />
          <MetricCard
            label="Consistency"
            value={getConsistencyLabel(consistencyPct, windowCount)}
            assessment={assessment.consistency}
            tooltip="What fraction of out-of-sample windows were profitable. Higher means the optimized parameters worked across different market conditions."
          />
        </div>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  assessment,
  tooltip,
}: {
  label: string;
  value: string;
  assessment: Assessment;
  tooltip: string;
}) {
  const colorClass =
    assessment === "good"
      ? "text-emerald-700 dark:text-emerald-400"
      : assessment === "moderate"
        ? "text-amber-700 dark:text-amber-400"
        : "text-rose-700 dark:text-rose-400";

  const bgClass =
    assessment === "good"
      ? "bg-emerald-500/5"
      : assessment === "moderate"
        ? "bg-amber-500/5"
        : "bg-rose-500/5";

  return (
    <div className={cn("rounded-lg p-3 space-y-1", bgClass)}>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
          </HoverCardTrigger>
          <HoverCardContent className="w-64">
            <p className="text-sm">{tooltip}</p>
          </HoverCardContent>
        </HoverCard>
      </div>
      <p className={cn("text-sm font-medium", colorClass)}>{value}</p>
    </div>
  );
}
