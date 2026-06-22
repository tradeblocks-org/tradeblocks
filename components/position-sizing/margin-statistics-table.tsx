/**
 * Margin Utilization Analysis table showing how Kelly settings affect margin requirements
 */

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StrategyAnalysis } from "./strategy-results";
import { HelpCircle } from "lucide-react";

interface MarginStatistic {
  name: string;
  historicalMax: number;
  kellyPct: number;
  projectedMargin: number;
  allocated: number;
  isPortfolio: boolean;
}

interface MarginStatisticsTableProps {
  portfolioMaxMarginPct: number;
  portfolioKellyPct: number;
  weightedAppliedPct: number;
  strategyAnalysis: StrategyAnalysis[];
}

export function MarginStatisticsTable({
  portfolioMaxMarginPct,
  portfolioKellyPct,
  weightedAppliedPct,
  strategyAnalysis,
}: MarginStatisticsTableProps) {
  // Build statistics
  const statistics: MarginStatistic[] = [];

  // Portfolio row
  if (portfolioMaxMarginPct > 0 && portfolioKellyPct > 0) {
    statistics.push({
      name: "Portfolio",
      historicalMax: portfolioMaxMarginPct,
      kellyPct: portfolioKellyPct,
      projectedMargin: portfolioMaxMarginPct * (portfolioKellyPct / 100),
      allocated: weightedAppliedPct,
      isPortfolio: true,
    });
  }

  // Strategy rows
  for (const analysis of strategyAnalysis) {
    if (analysis.maxMarginPct > 0 && analysis.inputPct > 0) {
      const projectedMargin =
        analysis.maxMarginPct * (portfolioKellyPct / 100) * (analysis.inputPct / 100);
      statistics.push({
        name: analysis.name,
        historicalMax: analysis.maxMarginPct,
        kellyPct: analysis.inputPct,
        projectedMargin,
        allocated: analysis.appliedPct,
        isPortfolio: false,
      });
    }
  }

  // Sort strategies by projected margin (descending)
  const portfolioStats = statistics.filter((s) => s.isPortfolio);
  const strategyStats = statistics
    .filter((s) => !s.isPortfolio)
    .sort((a, b) => b.projectedMargin - a.projectedMargin);

  if (statistics.length === 0) {
    return null;
  }

  return (
    <Card className="p-6">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">📊 Margin Utilization Analysis</h3>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">
                      Margin Utilization Analysis
                    </h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm font-medium text-foreground leading-relaxed">
                      Analyzes how your Kelly settings affect margin requirements across strategies.
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This table helps you understand the capital requirements for each strategy at
                      your chosen Kelly fraction. Compare projected margin needs against allocated
                      capital to ensure you have sufficient margin for your position sizing
                      strategy.
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <p className="text-xs text-muted-foreground">
            How your Kelly settings affect margin requirements
          </p>
        </div>

        {/* Explanation */}
        <Alert>
          <div className="text-xs space-y-2">
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong>Historical Max:</strong> Highest margin usage observed historically.
              </li>
              <li>
                <strong>Projected Margin:</strong> Historical max × portfolio Kelly × strategy
                Kelly. Example: 80% × 50% × 50% ≈ 20%.
              </li>
              <li>
                <strong>Allocated:</strong> Kelly edge × portfolio Kelly × strategy Kelly (what
                fraction of capital you&apos;re actually sizing to this strategy).
              </li>
            </ul>
          </div>
        </Alert>

        {/* Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">Strategy</TableHead>
                <TableHead className="text-right w-[17.5%]">
                  <div className="flex items-center justify-end gap-1">
                    Historical Max
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">Historical Max</h4>
                          </div>
                          <div className="px-4 pb-4 space-y-3">
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              Highest margin usage observed historically.
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              Peak margin requirement as % of starting capital when trades were
                              actually placed. This represents the maximum capital commitment that
                              was needed at any point in your trading history.
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                </TableHead>
                <TableHead className="text-right w-[17.5%]">
                  <div className="flex items-center justify-end gap-1">
                    Kelly %
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">Kelly %</h4>
                          </div>
                          <div className="px-4 pb-4 space-y-3">
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              Strategy-level Kelly multiplier (portfolio slider applies globally on
                              top of this).
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              This is the per-strategy knob on top of the portfolio Kelly fraction.
                              Example: 25% here with a 50% portfolio Kelly means the strategy
                              ultimately runs at 12.5% of full Kelly.
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                </TableHead>
                <TableHead className="text-right w-[17.5%]">
                  <div className="flex items-center justify-end gap-1">
                    Projected Margin
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">Projected Margin</h4>
                          </div>
                          <div className="px-4 pb-4 space-y-3">
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              Expected margin requirement at your Kelly fraction.
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              Calculated as Historical Max × (Portfolio Kelly % / 100) × (Strategy
                              Kelly % / 100). Example: 80% historical max × 50% portfolio × 50%
                              strategy ≈ 20%. This estimates how much margin you&apos;ll need once
                              both multipliers are applied.
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                </TableHead>
                <TableHead className="text-right w-[17.5%]">
                  <div className="flex items-center justify-end gap-1">
                    Allocated
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">Allocated</h4>
                          </div>
                          <div className="px-4 pb-4 space-y-3">
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              Capital allocated to this strategy after portfolio + strategy Kelly
                              multipliers.
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              Calculated as Optimal Kelly × (Portfolio Kelly % / 100) × (Strategy
                              Kelly % / 100). That final percentage is how much of starting capital
                              is earmarked for the strategy at your current risk settings.
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Portfolio row */}
              {portfolioStats.map((stat) => (
                <TableRow key={stat.name} className="font-semibold">
                  <TableCell className="max-w-[200px]">
                    <div className="truncate" title={stat.name}>
                      {stat.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{stat.historicalMax.toFixed(1)}%</TableCell>
                  <TableCell className="text-right">{stat.kellyPct.toFixed(0)}%</TableCell>
                  <TableCell
                    className={`text-right ${
                      stat.projectedMargin <= stat.allocated ? "text-blue-600" : "text-orange-600"
                    }`}
                  >
                    {stat.projectedMargin.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right">{stat.allocated.toFixed(1)}%</TableCell>
                </TableRow>
              ))}

              {/* Strategy rows */}
              {strategyStats.map((stat) => (
                <TableRow key={stat.name}>
                  <TableCell className="text-sm max-w-[200px]">
                    <div className="truncate" title={stat.name}>
                      {stat.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {stat.historicalMax.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right text-sm">{stat.kellyPct.toFixed(0)}%</TableCell>
                  <TableCell
                    className={`text-right text-sm ${
                      stat.projectedMargin <= stat.allocated ? "text-blue-600" : "text-orange-600"
                    }`}
                  >
                    {stat.projectedMargin.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right text-sm">{stat.allocated.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Color coding explanation */}
        <Alert>
          <AlertDescription className="text-xs">
            <strong>Color coding:</strong> <span className="text-blue-600 font-medium">Blue</span> =
            Expected margin ≤ Allocated capital (good).{" "}
            <span className="text-orange-600 font-medium">Orange</span> = Expected margin &gt;
            Allocated capital (may need more capital or lower Kelly %).
          </AlertDescription>
        </Alert>
      </div>
    </Card>
  );
}
