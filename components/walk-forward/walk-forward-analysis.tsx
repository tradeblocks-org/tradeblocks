"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@tradeblocks/lib";
import type { WalkForwardAnalysis as WalkForwardAnalysisType } from "@tradeblocks/lib";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Lightbulb,
  Settings2,
} from "lucide-react";
import { assessResults, type Assessment } from "@tradeblocks/lib";
import {
  generateVerdictExplanation,
  detectRedFlags,
  generateInsights,
  detectConfigurationObservations,
} from "@tradeblocks/lib";

interface WalkForwardAnalysisProps {
  analysis: WalkForwardAnalysisType;
}

const verdictStyles: Record<
  Assessment,
  {
    bg: string;
    text: string;
    icon: typeof CheckCircle2;
    headline: string;
  }
> = {
  good: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
    headline: "Looking Good",
  },
  moderate: {
    bg: "bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-400",
    icon: AlertTriangle,
    headline: "Mixed Results",
  },
  concerning: {
    bg: "bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-400",
    icon: XCircle,
    headline: "Needs Attention",
  },
};

const assessmentBadgeStyles: Record<Assessment, string> = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  moderate: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  concerning: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
};

const assessmentLabels: Record<Assessment, string> = {
  good: "Good",
  moderate: "Mixed",
  concerning: "Low",
};

export function WalkForwardAnalysis({ analysis }: WalkForwardAnalysisProps) {
  const { config, results } = analysis;
  const hasEmptyPeriods = results.periods.length === 0;

  // Always call useMemo to satisfy React hooks rules, but handle empty case gracefully
  const interpretationData = useMemo(() => {
    // Return empty/null data for empty periods case
    if (results.periods.length === 0) {
      return null;
    }
    const assessment = assessResults(results);
    return {
      assessment,
      explanation: generateVerdictExplanation(results, assessment),
      redFlags: detectRedFlags(results),
      insights: generateInsights(results, assessment),
      configObservations: detectConfigurationObservations(config, results),
    };
  }, [config, results]);

  // Handle empty periods - show informative message instead of crashing
  if (hasEmptyPeriods) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analysis</CardTitle>
          <CardDescription>Understanding your walk-forward results</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-semibold text-amber-700 dark:text-amber-400">
                No Data to Analyze
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The analysis completed but produced no windows to evaluate. This typically happens
                when your configuration is too restrictive for the available data.
              </p>
            </div>
          </div>
          <div className="border-t pt-4 space-y-3">
            <h4 className="text-sm font-semibold">Common Causes</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-muted-foreground/40 select-none mt-0.5">-</span>
                <span>
                  <strong>Window sizes too large:</strong> Try shorter in-sample or out-of-sample
                  periods
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted-foreground/40 select-none mt-0.5">-</span>
                <span>
                  <strong>Performance floors too strict:</strong> Lower min Sharpe or profit factor
                  thresholds
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted-foreground/40 select-none mt-0.5">-</span>
                <span>
                  <strong>Insufficient trades:</strong> Ensure your block has enough trades for the
                  selected windows
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted-foreground/40 select-none mt-0.5">-</span>
                <span>
                  <strong>All combos filtered:</strong> Every parameter combination may have failed
                  the IS performance checks
                </span>
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Safe to assert non-null after the empty check
  const { assessment, explanation, redFlags, insights, configObservations } = interpretationData!;
  const style = verdictStyles[assessment.overall];
  const Icon = style.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Analysis</CardTitle>
        <CardDescription>Understanding your walk-forward results</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Main Verdict Section */}
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex h-14 w-14 shrink-0 items-center justify-center rounded-xl",
              style.bg,
              style.text,
            )}
          >
            <Icon className="h-7 w-7" />
          </div>
          <div className="space-y-2">
            <h3 className={cn("text-xl font-semibold", style.text)}>{style.headline}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{explanation.headline}</p>
          </div>
        </div>

        {/* Why This Verdict Section */}
        <div className="border-t pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">Why This Verdict</h4>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80">
                <p className="text-sm">
                  These three factors determine the overall assessment. Each measures a different
                  aspect of how well your strategy performed on unseen data.
                </p>
              </HoverCardContent>
            </HoverCard>
          </div>

          <div className="space-y-3">
            {explanation.factors.map((factor) => (
              <div
                key={factor.metric}
                className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4"
              >
                <div className="flex items-center gap-2 sm:w-40 shrink-0">
                  <span className="text-sm font-medium">{factor.metric}</span>
                  <Badge
                    variant="outline"
                    className={cn("text-xs", assessmentBadgeStyles[factor.assessment])}
                  >
                    {assessmentLabels[factor.assessment]}
                  </Badge>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold tabular-nums">{factor.value}</span>
                  <span className="text-sm text-muted-foreground">{factor.explanation}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Configuration Notes Section (Conditional) */}
        {configObservations.length > 0 && (
          <div className="border-t pt-6 space-y-4">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Configuration Notes</h4>
            </div>

            <div className="space-y-3">
              {configObservations.map((obs, index) => {
                const isWarning = obs.severity === "warning";
                const bgClass = isWarning
                  ? "bg-amber-500/5 border-amber-500/20"
                  : "bg-slate-500/5 border-slate-500/20";
                const textClass = isWarning
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-slate-700 dark:text-slate-400";

                return (
                  <div key={index} className={cn("rounded-lg border p-3", bgClass)}>
                    <p className={cn("text-sm font-medium", textClass)}>{obs.title}</p>
                    <p className="text-sm text-muted-foreground mt-1">{obs.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Things to Note Section (Conditional) */}
        {redFlags.length > 0 && (
          <div className="border-t pt-6 space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <h4 className="text-sm font-semibold">Things to Note</h4>
            </div>

            <div className="space-y-3">
              {redFlags.map((flag, index) => {
                const isConcern = flag.severity === "concern";
                const bgClass = isConcern
                  ? "bg-rose-500/5 border-rose-500/20"
                  : "bg-amber-500/5 border-amber-500/20";
                const textClass = isConcern
                  ? "text-rose-700 dark:text-rose-400"
                  : "text-amber-700 dark:text-amber-400";

                return (
                  <div key={index} className={cn("rounded-lg border p-3", bgClass)}>
                    <p className={cn("text-sm font-medium", textClass)}>{flag.title}</p>
                    <p className="text-sm text-muted-foreground mt-1">{flag.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* What This Suggests Section */}
        <div className="border-t pt-6 space-y-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">What This Suggests</h4>
          </div>

          <ul className="space-y-2">
            {insights.map((insight, index) => (
              <li key={index} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/40 select-none mt-0.5">-</span>
                <span>{insight}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
