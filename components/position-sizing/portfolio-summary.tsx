/**
 * Portfolio Kelly summary card showing aggregate metrics
 */

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Separator } from "@/components/ui/separator";
import { KellyMetrics } from "@tradeblocks/lib";
import { HelpCircle } from "lucide-react";

interface PortfolioSummaryProps {
  portfolioMetrics: KellyMetrics;
  weightedAppliedPct: number;
  startingCapital: number;
  appliedCapital: number;
}

export function PortfolioSummary({
  portfolioMetrics,
  weightedAppliedPct,
  startingCapital,
  appliedCapital,
}: PortfolioSummaryProps) {
  const portfolioColor =
    portfolioMetrics.percent > 0
      ? "default"
      : portfolioMetrics.percent < 0
        ? "destructive"
        : "secondary";

  const payoffDisplay =
    isFinite(portfolioMetrics.payoffRatio) && portfolioMetrics.payoffRatio > 0
      ? `${portfolioMetrics.payoffRatio.toFixed(2)}x`
      : "--";

  return (
    <Card className="p-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Portfolio Kelly</h2>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">Portfolio Kelly</h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm font-medium text-foreground leading-relaxed">
                      Aggregated Kelly criterion across all strategies, weighted by trade count.
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Shows the mathematical optimal allocation percentage. The portfolio Kelly
                      emerges from the weighted combination of individual strategy Kelly
                      percentages. Strategies with more trades have greater influence on the overall
                      portfolio allocation.
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={portfolioColor} className="text-base px-3 py-1">
              FULL KELLY {portfolioMetrics.percent.toFixed(1)}%
            </Badge>
            <Badge variant="outline" className="text-base px-3 py-1">
              WEIGHTED APPLIED {weightedAppliedPct.toFixed(1)}%
            </Badge>
          </div>
        </div>

        <Separator />

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">Win Rate</p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Win Rate</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Percentage of trades that were profitable.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Percentage of trades that were profitable across your entire portfolio. Win
                        rate alone doesn&apos;t determine profitability—the Kelly formula considers
                        both win rate and payoff ratio together.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-lg font-semibold">{(portfolioMetrics.winRate * 100).toFixed(1)}%</p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">Avg Win/Loss Ratio</p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Avg Win/Loss Ratio</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Average winning trade divided by average losing trade.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        A ratio above 1.0 means your average win exceeds your average loss. Higher
                        ratios allow for profitable trading even with lower win rates. This is a key
                        component of the Kelly criterion calculation.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-lg font-semibold">{payoffDisplay}</p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">Average Win</p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Average Win</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Mean profit from winning trades across your portfolio.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Larger average wins relative to losses create positive expectancy even with
                        modest win rates. This metric helps determine the optimal Kelly percentage
                        for position sizing.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-lg font-semibold text-green-600">
              ${portfolioMetrics.avgWin.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">Average Loss</p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Average Loss</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Mean loss from losing trades across your portfolio.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Keeping losses small relative to wins is a key component of long-term
                        trading success. This metric balances with average win to determine your
                        optimal position size via the Kelly criterion.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-lg font-semibold text-red-600">
              -$
              {portfolioMetrics.avgLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>

        <Separator />

        {/* Capital Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <p className="text-sm text-muted-foreground whitespace-nowrap">Starting capital:</p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Starting Capital</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        The capital base for all percentage calculations.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        This is your initial account value or available trading capital. All Kelly
                        percentages and allocation amounts are calculated relative to this starting
                        amount.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-sm font-medium">${startingCapital.toLocaleString()}</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <p className="text-sm text-muted-foreground whitespace-nowrap">
                Weighted applied capital:
              </p>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">
                        Weighted Applied Capital
                      </h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        How much capital is actually deployed after Kelly adjustments.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Calculated as starting capital × weighted applied % after Kelly. This
                        reflects how much of your starting capital would be put to work under the
                        current settings across all strategies.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <p className="text-sm font-medium">
              ${appliedCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
