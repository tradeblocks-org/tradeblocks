"use client";

import { format } from "date-fns";
import { ChevronDown, ChevronRight, Download, History, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@tradeblocks/lib";
import type { WalkForwardAnalysis, WalkForwardOptimizationTarget } from "@tradeblocks/lib";

interface RunSwitcherProps {
  history: WalkForwardAnalysis[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onExport?: () => void;
}

const TARGET_LABELS: Record<WalkForwardOptimizationTarget, string> = {
  netPl: "Net Profit",
  profitFactor: "Profit Factor",
  sharpeRatio: "Sharpe Ratio",
  sortinoRatio: "Sortino Ratio",
  calmarRatio: "Calmar Ratio",
  cagr: "CAGR",
  avgDailyPl: "Avg Daily P/L",
  winRate: "Win Rate",
  minAvgCorrelation: "Min Correlation",
  minTailRisk: "Min Tail Risk",
  maxEffectiveFactors: "Max Eff Factors",
};

export function RunSwitcher({
  history,
  currentId,
  onSelect,
  onDelete,
  onExport,
}: RunSwitcherProps) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  if (!history || history.length === 0) return null;

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const handleDelete = async (id: string) => {
    const ok = window.confirm("Delete this run? This cannot be undone.");
    if (ok) await onDelete(id);
  };

  return (
    <div className="rounded-lg border bg-card/70">
      <div className="flex items-center gap-2 px-4 py-3 border-b text-sm font-medium">
        <History className="h-4 w-4 text-primary" />
        Run History
        <Badge variant="secondary" className="ml-auto text-xs">
          {history.length} {history.length === 1 ? "run" : "runs"}
        </Badge>
      </div>
      <div className="overflow-x-auto max-h-80">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="text-right">Windows</TableHead>
              <TableHead className="text-right">Efficiency</TableHead>
              <TableHead className="text-right">Robustness</TableHead>
              <TableHead className="w-32"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((analysis) => {
              const isActive = analysis.id === currentId;
              const isExpanded = Boolean(expandedRows[analysis.id]);
              const efficiency = (analysis.results.summary.degradationFactor * 100).toFixed(1);
              const robustness = (analysis.results.summary.robustnessScore * 100).toFixed(1);
              const targetLabel =
                TARGET_LABELS[analysis.config.optimizationTarget] ||
                analysis.config.optimizationTarget;

              return (
                <TableRowWithDetails
                  key={analysis.id}
                  analysis={analysis}
                  isActive={isActive}
                  isExpanded={isExpanded}
                  efficiency={efficiency}
                  robustness={robustness}
                  targetLabel={targetLabel}
                  onToggle={() => toggleRow(analysis.id)}
                  onSelect={() => onSelect(analysis.id)}
                  onDelete={() => handleDelete(analysis.id)}
                  onExport={isActive ? onExport : undefined}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface TableRowWithDetailsProps {
  analysis: WalkForwardAnalysis;
  isActive: boolean;
  isExpanded: boolean;
  efficiency: string;
  robustness: string;
  targetLabel: string;
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onExport?: () => void;
}

function TableRowWithDetails({
  analysis,
  isActive,
  isExpanded,
  efficiency,
  robustness,
  targetLabel,
  onToggle,
  onSelect,
  onDelete,
  onExport,
}: TableRowWithDetailsProps) {
  const config = analysis.config;

  // Build configuration summary badges
  const configBadges: Array<{ label: string; variant: "default" | "outline"; className?: string }> =
    [];

  // Window configuration
  configBadges.push({
    label: `${config.inSampleDays}d IS / ${config.outOfSampleDays}d OOS`,
    variant: "outline",
  });

  // 1-Lot normalization
  if (config.normalizeTo1Lot) {
    configBadges.push({
      label: "1-Lot Normalized",
      variant: "outline",
      className: "bg-amber-50 dark:bg-amber-950/30",
    });
  }

  // Strategy filter
  if (config.selectedStrategies && config.selectedStrategies.length > 0) {
    configBadges.push({
      label: `${config.selectedStrategies.length} Strategies`,
      variant: "outline",
      className: "bg-blue-50 dark:bg-blue-950/30",
    });
  }

  // Diversification constraints
  if (config.diversificationConfig?.enableCorrelationConstraint) {
    configBadges.push({
      label: `Corr ≤ ${config.diversificationConfig.maxCorrelationThreshold.toFixed(2)}`,
      variant: "outline",
      className: "bg-violet-50 dark:bg-violet-950/30",
    });
  }
  if (config.diversificationConfig?.enableTailRiskConstraint) {
    configBadges.push({
      label: `Tail ≤ ${config.diversificationConfig.maxTailDependenceThreshold.toFixed(2)}`,
      variant: "outline",
      className: "bg-violet-50 dark:bg-violet-950/30",
    });
  }

  // Strategy weight sweep
  if (config.strategyWeightSweep && config.strategyWeightSweep.configs.some((c) => c.enabled)) {
    configBadges.push({
      label: `Weight Sweep (${config.strategyWeightSweep.mode})`,
      variant: "outline",
      className: "bg-green-50 dark:bg-green-950/30",
    });
  }

  // Performance floor
  if (config.performanceFloor?.enableMinSharpe) {
    configBadges.push({
      label: `Min Sharpe: ${config.performanceFloor.minSharpeRatio.toFixed(2)}`,
      variant: "outline",
      className: "bg-orange-50 dark:bg-orange-950/30",
    });
  }
  if (config.performanceFloor?.enableMinProfitFactor) {
    configBadges.push({
      label: `Min PF: ${config.performanceFloor.minProfitFactor.toFixed(2)}`,
      variant: "outline",
      className: "bg-orange-50 dark:bg-orange-950/30",
    });
  }

  // Parameter ranges summary - config uses legacy 3-element ranges, all are enabled
  const enabledParams = Object.entries(config.parameterRanges || {});

  return (
    <>
      <TableRow className={cn(isActive && "bg-primary/5")}>
        <TableCell className="w-8">
          <button
            type="button"
            onClick={onToggle}
            className="p-1 hover:bg-muted rounded"
            aria-label={isExpanded ? "Collapse details" : "Expand details"}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </TableCell>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {isActive && (
              <span className="h-2 w-2 rounded-full bg-primary" title="Currently loaded" />
            )}
            {format(new Date(analysis.createdAt), "MMM d, yyyy")}
          </div>
          <div className="text-xs text-muted-foreground">
            {format(new Date(analysis.createdAt), "h:mm a")}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="uppercase text-[10px]">
            {targetLabel}
          </Badge>
        </TableCell>
        <TableCell className="text-right">{analysis.results.periods.length}</TableCell>
        <TableCell className="text-right">
          <span
            className={cn(
              parseFloat(efficiency) >= 70
                ? "text-emerald-600"
                : parseFloat(efficiency) >= 50
                  ? "text-amber-600"
                  : "text-rose-600",
            )}
          >
            {efficiency}%
          </span>
        </TableCell>
        <TableCell className="text-right">
          <span
            className={cn(
              parseFloat(robustness) >= 60
                ? "text-emerald-600"
                : parseFloat(robustness) >= 40
                  ? "text-amber-600"
                  : "text-rose-600",
            )}
          >
            {robustness}%
          </span>
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-2">
            {!isActive && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onSelect}>
                Load Results
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onExport && (
                  <DropdownMenuItem onClick={onExport}>
                    <Download className="mr-2 h-4 w-4" />
                    Export for Assistant
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete run
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30 p-0">
            <div className="p-4 space-y-3">
              {/* Configuration Badges */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Configuration</p>
                <div className="flex flex-wrap gap-2">
                  {configBadges.map((badge, idx) => (
                    <Badge
                      key={idx}
                      variant={badge.variant}
                      className={cn("text-[10px]", badge.className)}
                    >
                      {badge.label}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Parameter Ranges */}
              {enabledParams.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground">Parameter Ranges</p>
                  <div className="flex flex-wrap gap-2">
                    {enabledParams.map(([key, range]) => {
                      const prettyKey = (() => {
                        switch (key) {
                          case "kellyMultiplier":
                            return "Kelly";
                          case "fixedFractionPct":
                            return "Fixed %";
                          case "maxDrawdownPct":
                            return "Max DD";
                          case "maxDailyLossPct":
                            return "Daily Loss";
                          case "consecutiveLossLimit":
                            return "Consec Loss";
                          default:
                            return key;
                        }
                      })();
                      const [min, max, step] = range;
                      return (
                        <Badge key={key} variant="outline" className="text-[10px] bg-muted">
                          {prettyKey}: {min}–{max} (step {step})
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Strategy Weight Configs */}
              {config.strategyWeightSweep?.configs?.some((c) => c.enabled) && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Strategy Weight Sweeps
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {config.strategyWeightSweep.configs
                      .filter((c) => c.enabled)
                      .map((stratConfig) => {
                        const [min, max, step] = stratConfig.range;
                        return (
                          <Badge
                            key={stratConfig.strategy}
                            variant="outline"
                            className="text-[10px] bg-green-50 dark:bg-green-950/30"
                          >
                            {stratConfig.strategy}: {min}–{max}x (step {step})
                          </Badge>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Run Stats */}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t border-border/30">
                <span>
                  <strong className="text-foreground">
                    {analysis.results.stats.totalParameterTests.toLocaleString()}
                  </strong>{" "}
                  combinations tested
                </span>
                <span>
                  <strong className="text-foreground">
                    {analysis.results.stats.analyzedTrades.toLocaleString()}
                  </strong>{" "}
                  trades analyzed
                </span>
                <span>
                  <strong className="text-foreground">
                    {(analysis.results.stats.durationMs / 1000).toFixed(1)}s
                  </strong>{" "}
                  duration
                </span>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
