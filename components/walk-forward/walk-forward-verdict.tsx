"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@tradeblocks/lib";
import type { WalkForwardResults } from "@tradeblocks/lib";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  TrendingUp,
  Shield,
  Settings2,
} from "lucide-react";
import {
  assessResults,
  getRecommendedParameters,
  formatParameterName,
  type Assessment,
} from "@tradeblocks/lib";

interface WalkForwardVerdictProps {
  results: WalkForwardResults;
  targetMetricLabel: string;
}

const assessmentStyles: Record<
  Assessment,
  { bg: string; text: string; icon: typeof CheckCircle2 }
> = {
  good: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  moderate: {
    bg: "bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-400",
    icon: AlertTriangle,
  },
  concerning: {
    bg: "bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-400",
    icon: XCircle,
  },
};

export function WalkForwardVerdict({ results, targetMetricLabel }: WalkForwardVerdictProps) {
  const assessment = assessResults(results);
  const { params, hasSuggestions } = getRecommendedParameters(results.periods);
  const style = assessmentStyles[assessment.overall];
  const Icon = style.icon;

  return (
    <div className="space-y-4">
      {/* Main Verdict Card */}
      <Card
        className={cn("border-l-4", {
          "border-l-emerald-500": assessment.overall === "good",
          "border-l-amber-500": assessment.overall === "moderate",
          "border-l-rose-500": assessment.overall === "concerning",
        })}
      >
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                style.bg,
                style.text,
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="space-y-2 flex-1">
              <h3 className={cn("text-base font-semibold", style.text)}>{assessment.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {assessment.description}
              </p>

              {/* Component Assessment Badges */}
              <div className="flex flex-wrap gap-3 pt-2">
                <AssessmentBadge
                  label="Efficiency"
                  assessment={assessment.efficiency}
                  tooltip={`How well out-of-sample ${targetMetricLabel} held up compared to in-sample optimization.`}
                />
                <AssessmentBadge
                  label="Stability"
                  assessment={assessment.stability}
                  tooltip="How consistent the optimal parameters were across different time windows."
                />
                <AssessmentBadge
                  label="Consistency"
                  assessment={assessment.consistency}
                  tooltip="Percentage of windows where out-of-sample performance stayed non-negative."
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recommended Parameters */}
      {hasSuggestions && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Parameter Observations</CardTitle>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80">
                  <p className="text-sm">
                    These values represent the average optimal parameters found across all
                    walk-forward windows.
                    <strong className="block mt-2">Note:</strong> These are observations, not
                    recommendations. Market conditions change, and past optimal parameters may not
                    be ideal going forward.
                  </p>
                </HoverCardContent>
              </HoverCard>
            </div>
            <CardDescription className="text-xs">
              Average values across {results.periods.length} optimization windows
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(params).map(([key, data]) => (
                <ParameterSuggestion
                  key={key}
                  name={formatParameterName(key)}
                  value={data.value}
                  range={data.range}
                  stable={data.stable}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-4 pt-3 border-t">
              Parameters marked as &quot;stable&quot; showed less than 30% variation across windows.
              Higher stability suggests the parameter value may be more reliable, but always
              validate against current market conditions.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Interpretation Guide */}
      <Card className="border-dashed">
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Understanding These Results</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <TrendingUp className="h-4 w-4 text-blue-500" />
                <span>Efficiency Ratio</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Measures how much of your in-sample performance carried over to out-of-sample
                testing. 80%+ suggests a real edge; below 60% may indicate the optimization fit to
                noise.
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Shield className="h-4 w-4 text-violet-500" />
                <span>Parameter Stability</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Shows how much optimal parameters jumped around between windows. Stable parameters
                (70%+) suggest more reliable results.
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span>Consistency Score</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Percentage of windows where out-of-sample performance was positive. High consistency
                (70%+) means the optimized parameters adapt well to new data.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AssessmentBadge({
  label,
  assessment,
  tooltip,
}: {
  label: string;
  assessment: Assessment;
  tooltip: string;
}) {
  const style = assessmentStyles[assessment];
  const assessmentLabel =
    assessment === "good" ? "Good" : assessment === "moderate" ? "Mixed" : "Low";

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Badge
          variant="outline"
          className={cn("cursor-help text-xs gap-1.5", style.bg, style.text, "border-transparent")}
        >
          {label}: {assessmentLabel}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-64">
        <p className="text-sm">{tooltip}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

function ParameterSuggestion({
  name,
  value,
  range,
  stable,
}: {
  name: string;
  value: number;
  range: [number, number];
  stable: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{name}</span>
        {stable && (
          <Badge
            variant="secondary"
            className="text-[10px] h-4 px-1.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          >
            Stable
          </Badge>
        )}
      </div>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">
        Range: {range[0]} – {range[1]}
      </div>
    </div>
  );
}
