"use client";

import { NoActiveBlock } from "@/components/no-active-block";
import { MarginChart } from "@/components/position-sizing/margin-chart";
import { MarginStatisticsTable } from "@/components/position-sizing/margin-statistics-table";
import { PortfolioSummary } from "@/components/position-sizing/portfolio-summary";
import { StrategyKellyTable } from "@/components/position-sizing/strategy-kelly-table";
import { StrategyAnalysis, StrategyResults } from "@/components/position-sizing/strategy-results";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  calculateKellyMetrics,
  calculateStrategyKellyMetrics,
  buildMarginTimeline,
  calculateMaxMarginPct,
  PortfolioStatsCalculator,
  getBlock,
  getDailyLogsByBlock,
  getTradesByBlockWithOptions,
  downloadCsv,
  downloadJson,
  generateExportFilename,
  toCsvRow,
} from "@tradeblocks/lib";
import type { MarginMode, DailyLogEntry, Trade } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { AlertCircle, Download, HelpCircle, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface RunConfig {
  startingCapital: number;
  portfolioKellyPct: number;
  marginMode: MarginMode;
  kellyValues: Record<string, number>;
}

type StrategySortOption =
  | "name-asc"
  | "winrate-desc"
  | "kelly-desc"
  | "applied-desc"
  | "capital-desc"
  | "trades-desc";

const normalizeKellyValue = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(200, Math.max(0, value));
  return Math.round(clamped);
};

export default function PositionSizingPage() {
  const { activeBlockId, blocks } = useBlockStore();
  const activeBlock = blocks.find((b) => b.id === activeBlockId);

  // State
  const [trades, setTrades] = useState<Trade[]>([]);
  const [dailyLog, setDailyLog] = useState<DailyLogEntry[]>([]);
  const [startingCapital, setStartingCapital] = useState(100000);
  const [portfolioKellyPct, setPortfolioKellyPct] = useState(100);
  const [portfolioKellyInput, setPortfolioKellyInput] = useState("100");
  const [marginMode, setMarginMode] = useState<MarginMode>("fixed");
  const [kellyValues, setKellyValues] = useState<Record<string, number>>({});
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set());
  const [lastRunConfig, setLastRunConfig] = useState<RunConfig | null>(null);
  const [allStrategiesKellyPct, setAllStrategiesKellyPct] = useState(100);
  const [strategySort, setStrategySort] = useState<StrategySortOption>("name-asc");

  // Load trades and daily log when active block changes
  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!activeBlockId) {
        if (!cancelled) {
          setTrades([]);
          setDailyLog([]);
          setSelectedStrategies(new Set());
          setKellyValues({});
          setPortfolioKellyPct(100);
          setPortfolioKellyInput("100");
          setLastRunConfig(null);
        }
        return;
      }

      try {
        const processedBlock = await getBlock(activeBlockId);
        const combineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;

        const [loadedTrades, loadedDailyLog] = await Promise.all([
          getTradesByBlockWithOptions(activeBlockId, { combineLegGroups }),
          getDailyLogsByBlock(activeBlockId),
        ]);

        if (cancelled) return;

        setTrades(loadedTrades);
        setDailyLog(loadedDailyLog);

        // Auto-detect starting capital (prefer daily log when available)
        const calculatedCapital = PortfolioStatsCalculator.calculateInitialCapital(
          loadedTrades,
          loadedDailyLog.length > 0 ? loadedDailyLog : undefined,
        );
        setStartingCapital(calculatedCapital > 0 ? calculatedCapital : 100000);

        // Initialize all strategies as selected with 100%
        const strategies = new Set(loadedTrades.map((t) => t.strategy || "Uncategorized"));
        setSelectedStrategies(strategies);

        const initialValues: Record<string, number> = {};
        strategies.forEach((s) => {
          initialValues[s] = 100;
        });
        setKellyValues(initialValues);
        setPortfolioKellyPct(100);
        setPortfolioKellyInput("100");
        setLastRunConfig(null);
      } catch (error) {
        console.error("Failed to load block data:", error);
        if (!cancelled) {
          setTrades([]);
          setDailyLog([]);
          setSelectedStrategies(new Set());
          setKellyValues({});
          setPortfolioKellyPct(100);
          setPortfolioKellyInput("100");
          setLastRunConfig(null);
        }
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, [activeBlockId]);

  // Get unique strategies with trade counts
  const strategyData = useMemo(() => {
    const strategyMap = new Map<string, number>();

    for (const trade of trades) {
      const strategy = trade.strategy || "Uncategorized";
      strategyMap.set(strategy, (strategyMap.get(strategy) || 0) + 1);
    }

    return Array.from(strategyMap.entries())
      .map(([name, tradeCount]) => ({ name, tradeCount }))
      .sort((a, b) => b.tradeCount - a.tradeCount || a.name.localeCompare(b.name));
  }, [trades]);

  // Calculate results when user clicks "Run Allocation"
  const runAllocation = () => {
    commitPortfolioKellyInput();
    const snapshotKellyValues: Record<string, number> = {};
    strategyData.forEach((strategy) => {
      const value = kellyValues[strategy.name];
      snapshotKellyValues[strategy.name] = normalizeKellyValue(
        typeof value === "number" ? value : 100,
      );
    });

    setLastRunConfig({
      startingCapital,
      portfolioKellyPct,
      marginMode,
      kellyValues: snapshotKellyValues,
    });
  };

  // Results calculations using the last run configuration
  const results = useMemo(() => {
    if (!lastRunConfig || trades.length === 0) return null;

    const {
      startingCapital: runStartingCapital,
      portfolioKellyPct: runPortfolioKellyPct,
      marginMode: runMarginMode,
      kellyValues: runKellyValues,
    } = lastRunConfig;

    // Calculate portfolio-level Kelly metrics with starting capital for validation
    const portfolioMetrics = calculateKellyMetrics(trades, runStartingCapital);

    // Calculate per-strategy Kelly metrics with starting capital for validation
    const strategyMetricsMap = calculateStrategyKellyMetrics(trades, runStartingCapital);

    // Get strategy names sorted by trade count
    const strategyNames = strategyData.map((s) => s.name);

    // Build margin timeline
    const marginTimeline = buildMarginTimeline(
      trades,
      strategyNames,
      runStartingCapital,
      runMarginMode,
      dailyLog.length > 0 ? dailyLog : undefined,
    );

    // Calculate portfolio max margin
    const portfolioMaxMarginPct =
      marginTimeline.portfolioPct.length > 0 ? Math.max(...marginTimeline.portfolioPct) : 0;

    // Calculate strategy analysis
    const strategyAnalysis: StrategyAnalysis[] = [];
    let totalAppliedWeight = 0;
    const totalTrades = trades.length;

    for (const strategy of strategyData) {
      const metrics = strategyMetricsMap.get(strategy.name)!;
      const inputPct = runKellyValues[strategy.name] ?? 100;

      // Use normalized Kelly when available (more accurate for position sizing)
      const effectiveKellyPct = metrics.normalizedKellyPct ?? metrics.percent;

      // Apply BOTH Portfolio Kelly and Strategy Kelly multipliers
      const appliedPct = effectiveKellyPct * (runPortfolioKellyPct / 100) * (inputPct / 100);
      const maxMarginPct = calculateMaxMarginPct(marginTimeline, strategy.name);
      const allocationPct = maxMarginPct * (runPortfolioKellyPct / 100) * (inputPct / 100);
      const allocationDollars = (runStartingCapital * allocationPct) / 100;

      strategyAnalysis.push({
        name: strategy.name,
        tradeCount: strategy.tradeCount,
        kellyMetrics: metrics,
        inputPct,
        appliedPct,
        maxMarginPct,
        allocationPct,
        allocationDollars,
      });

      if (strategy.tradeCount > 0) {
        totalAppliedWeight += appliedPct * strategy.tradeCount;
      }
    }

    const weightedAppliedPct = totalTrades > 0 ? totalAppliedWeight / totalTrades : 0;
    const appliedCapital = (runStartingCapital * weightedAppliedPct) / 100;

    return {
      portfolioMetrics,
      strategyAnalysis,
      marginTimeline,
      strategyNames,
      weightedAppliedPct,
      appliedCapital,
      portfolioMaxMarginPct,
      config: {
        startingCapital: runStartingCapital,
        portfolioKellyPct: runPortfolioKellyPct,
      },
    };
  }, [lastRunConfig, trades, dailyLog, strategyData]);

  const hasPendingChanges = useMemo(() => {
    if (!lastRunConfig) {
      return false;
    }

    if (lastRunConfig.startingCapital !== startingCapital) {
      return true;
    }

    if (lastRunConfig.portfolioKellyPct !== portfolioKellyPct) {
      return true;
    }

    if (lastRunConfig.marginMode !== marginMode) {
      return true;
    }

    const allKeys = new Set([
      ...Object.keys(lastRunConfig.kellyValues),
      ...Object.keys(kellyValues),
    ]);

    for (const key of allKeys) {
      const lastValue = lastRunConfig.kellyValues[key] ?? 100;
      const currentValue = kellyValues[key] ?? 100;
      if (lastValue !== currentValue) {
        return true;
      }
    }

    return false;
  }, [lastRunConfig, startingCapital, portfolioKellyPct, marginMode, kellyValues]);

  const sortedStrategies = useMemo(() => {
    if (!results) {
      return [];
    }

    const strategies = [...results.strategyAnalysis];

    const compareByName = (a: StrategyAnalysis, b: StrategyAnalysis) =>
      a.name.localeCompare(b.name);

    strategies.sort((a, b) => {
      switch (strategySort) {
        case "winrate-desc": {
          const diff = (b.kellyMetrics.winRate ?? 0) - (a.kellyMetrics.winRate ?? 0);
          return diff !== 0 ? diff : compareByName(a, b);
        }
        case "kelly-desc": {
          const aKelly = a.kellyMetrics.normalizedKellyPct ?? a.kellyMetrics.percent ?? 0;
          const bKelly = b.kellyMetrics.normalizedKellyPct ?? b.kellyMetrics.percent ?? 0;
          const diff = bKelly - aKelly;
          return diff !== 0 ? diff : compareByName(a, b);
        }
        case "applied-desc": {
          const diff = b.appliedPct - a.appliedPct;
          return diff !== 0 ? diff : compareByName(a, b);
        }
        case "capital-desc": {
          const diff = b.allocationDollars - a.allocationDollars;
          return diff !== 0 ? diff : compareByName(a, b);
        }
        case "trades-desc": {
          const diff = b.tradeCount - a.tradeCount;
          return diff !== 0 ? diff : compareByName(a, b);
        }
        case "name-asc":
        default:
          return compareByName(a, b);
      }
    });

    return strategies;
  }, [results, strategySort]);

  // Handlers
  const handleKellyChange = (strategy: string, value: number) => {
    const normalized = normalizeKellyValue(value);
    setKellyValues((prev) => ({ ...prev, [strategy]: normalized }));
  };

  const handleSelectionChange = (strategy: string, selected: boolean) => {
    setSelectedStrategies((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(strategy);
      } else {
        next.delete(strategy);
      }
      return next;
    });
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      setSelectedStrategies(new Set(strategyData.map((s) => s.name)));
    } else {
      setSelectedStrategies(new Set());
    }
  };

  const handlePortfolioKellyInputChange = (value: string) => {
    // Allow users to clear the field while editing
    setPortfolioKellyInput(value);

    const numericValue = Number(value);
    if (value === "" || Number.isNaN(numericValue)) {
      return;
    }

    // Update numeric state eagerly so pending-change detection stays responsive
    const normalized = normalizeKellyValue(numericValue);
    if (normalized !== portfolioKellyPct) {
      setPortfolioKellyPct(normalized);
    }
  };

  const commitPortfolioKellyInput = () => {
    const numericValue = Number(portfolioKellyInput);
    const normalized = Number.isNaN(numericValue)
      ? portfolioKellyPct
      : normalizeKellyValue(numericValue);

    setPortfolioKellyPct(normalized);
    setPortfolioKellyInput(normalized.toString());
  };

  // Export functions
  const exportAsJson = () => {
    if (!results || !activeBlock) return;

    const exportData = {
      exportedAt: new Date().toISOString(),
      block: {
        id: activeBlock.id,
        name: activeBlock.name,
      },
      configuration: {
        startingCapital: results.config.startingCapital,
        portfolioKellyPct: results.config.portfolioKellyPct,
        marginMode,
        strategyKellyMultipliers: lastRunConfig?.kellyValues || {},
      },
      portfolioSummary: {
        kellyPercent: results.portfolioMetrics.percent,
        normalizedKellyPercent: results.portfolioMetrics.normalizedKellyPct,
        winRate: results.portfolioMetrics.winRate,
        winLossRatio: results.portfolioMetrics.payoffRatio,
        tradeCount: trades.length,
        weightedAppliedPct: results.weightedAppliedPct,
        appliedCapital: results.appliedCapital,
        portfolioMaxMarginPct: results.portfolioMaxMarginPct,
      },
      strategyAnalysis: results.strategyAnalysis.map((s) => ({
        name: s.name,
        tradeCount: s.tradeCount,
        kellyPercent: s.kellyMetrics.percent,
        normalizedKellyPercent: s.kellyMetrics.normalizedKellyPct,
        winRate: s.kellyMetrics.winRate,
        winLossRatio: s.kellyMetrics.payoffRatio,
        inputPct: s.inputPct,
        appliedPct: s.appliedPct,
        maxMarginPct: s.maxMarginPct,
        allocationPct: s.allocationPct,
        allocationDollars: s.allocationDollars,
      })),
      marginTimeline: {
        dates: results.marginTimeline.dates,
        portfolioPct: results.marginTimeline.portfolioPct,
        byStrategy: Object.fromEntries(results.marginTimeline.strategyPct),
      },
    };

    downloadJson(exportData, generateExportFilename(activeBlock.name, "position-sizing", "json"));
  };

  const exportAsCsv = () => {
    if (!results || !activeBlock) return;

    const lines: string[] = [];

    // Metadata
    lines.push("# Position Sizing Export");
    lines.push(toCsvRow(["Block", activeBlock.name]));
    lines.push(toCsvRow(["Exported", new Date().toISOString()]));
    lines.push(toCsvRow(["Starting Capital", results.config.startingCapital]));
    lines.push(toCsvRow(["Portfolio Kelly %", results.config.portfolioKellyPct]));
    lines.push(toCsvRow(["Margin Mode", marginMode]));
    lines.push("");

    // Portfolio Summary
    lines.push("# Portfolio Summary");
    lines.push(toCsvRow(["Metric", "Value"]));
    lines.push(toCsvRow(["Kelly %", results.portfolioMetrics.percent?.toFixed(2) ?? "N/A"]));
    lines.push(
      toCsvRow([
        "Normalized Kelly %",
        results.portfolioMetrics.normalizedKellyPct?.toFixed(2) ?? "N/A",
      ]),
    );
    lines.push(
      toCsvRow(["Win Rate", `${((results.portfolioMetrics.winRate ?? 0) * 100).toFixed(2)}%`]),
    );
    lines.push(
      toCsvRow(["Win/Loss Ratio", results.portfolioMetrics.payoffRatio?.toFixed(2) ?? "N/A"]),
    );
    lines.push(toCsvRow(["Trade Count", trades.length]));
    lines.push(toCsvRow(["Weighted Applied %", results.weightedAppliedPct.toFixed(2)]));
    lines.push(toCsvRow(["Applied Capital", `$${results.appliedCapital.toFixed(2)}`]));
    lines.push(toCsvRow(["Portfolio Max Margin %", results.portfolioMaxMarginPct.toFixed(2)]));
    lines.push("");

    // Strategy Analysis
    lines.push("# Strategy Analysis");
    lines.push(
      toCsvRow([
        "Strategy",
        "Trades",
        "Kelly %",
        "Normalized Kelly %",
        "Win Rate",
        "Input %",
        "Applied %",
        "Max Margin %",
        "Allocation %",
        "Allocation $",
      ]),
    );
    for (const s of results.strategyAnalysis) {
      lines.push(
        toCsvRow([
          s.name,
          s.tradeCount,
          s.kellyMetrics.percent?.toFixed(2) ?? "N/A",
          s.kellyMetrics.normalizedKellyPct?.toFixed(2) ?? "N/A",
          `${((s.kellyMetrics.winRate ?? 0) * 100).toFixed(2)}%`,
          s.inputPct,
          s.appliedPct.toFixed(2),
          s.maxMarginPct.toFixed(2),
          s.allocationPct.toFixed(2),
          s.allocationDollars.toFixed(2),
        ]),
      );
    }

    downloadCsv(lines, generateExportFilename(activeBlock.name, "position-sizing", "csv"));
  };

  // Empty state
  if (!activeBlockId) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to run position sizing analysis." />
    );
  }

  if (trades.length === 0) {
    return (
      <div className="container mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Position Sizing</h1>
          <p className="text-muted-foreground">Optimize capital allocation using Kelly criterion</p>
        </div>
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">
            No trades available in the active block. Upload trades to perform position sizing
            analysis.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* How to Use This Page */}
      <Card className="p-6">
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">How to Use This Page</h2>
          <p className="text-sm text-muted-foreground">
            Use this page to explore how Kelly-driven sizing could shape your backtests before you
            commit to a new allocation.
          </p>
          <ul className="space-y-2 text-sm text-muted-foreground list-disc list-inside">
            <li>
              Set your starting capital and portfolio-level Kelly fraction to mirror the account you
              plan to backtest.
            </li>
            <li>
              Review each strategy card and adjust the Kelly % to reflect conviction, correlation,
              or capital limits.
            </li>
            <li>
              Run Allocation to surface portfolio Kelly metrics, applied capital, and projected
              margin demand so you can translate findings into your backtest position rules.
            </li>
            <li>
              Iterate often—capture settings that feel sustainable, then take those parameters into
              your backtests for validation.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground italic">
            Nothing here is a directive to size larger or smaller; it is a sandbox for
            stress-testing ideas with real trade history before you backtest or deploy.
          </p>
        </div>
      </Card>

      {/* Configuration Card */}
      <Card className="p-6">
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Configuration</h2>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">
                      Kelly Criterion Position Sizing
                    </h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm font-medium text-foreground leading-relaxed">
                      Calculate optimal position sizes based on your trading edge.
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      The Kelly criterion determines the mathematically optimal percentage of
                      capital to risk based on win rate and payoff ratio. Adjust the Kelly
                      multiplier to be more conservative (50% = half Kelly) or aggressive (100% =
                      full Kelly).
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>

          {/* Global Settings */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <Label htmlFor="starting-capital">Starting Capital ($)</Label>
              <Input
                id="starting-capital"
                type="number"
                value={startingCapital}
                onChange={(e) => setStartingCapital(parseInt(e.target.value) || 100000)}
                min={1000}
                step={1000}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="portfolio-kelly">Portfolio Kelly Fraction (%)</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Kelly Fraction Multiplier
                        </h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Global risk multiplier applied to ALL strategies before their individual
                          Kelly %.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Works as a two-layer system with Strategy Kelly %:
                        </p>
                        <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                          <li>25% = Very Conservative (1/4 Kelly)</li>
                          <li>50% = Conservative (half Kelly - recommended)</li>
                          <li>100% = Full Kelly (aggressive)</li>
                        </ul>
                        <div className="text-xs text-muted-foreground space-y-1 mt-2">
                          <p className="font-medium">Formula:</p>
                          <p className="font-mono text-[10px] bg-muted/50 p-1 rounded">
                            Allocation = Base Kelly × Portfolio % × Strategy %
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground italic border-l-2 border-primary/20 pl-2">
                          Example: Base Kelly 40%, Portfolio 25%, Strategy 50% = 40% × 0.25 × 0.50 =
                          5% of capital
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                id="portfolio-kelly"
                type="number"
                value={portfolioKellyInput}
                onChange={(e) => handlePortfolioKellyInputChange(e.target.value)}
                onBlur={commitPortfolioKellyInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitPortfolioKellyInput();
                  }
                }}
                min={0}
                max={200}
                step={1}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Margin Calculation Mode</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Margin Calculation Mode
                        </h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3 text-xs text-muted-foreground leading-relaxed">
                        <p className="text-sm text-foreground">
                          Choose how the simulator scales capital requirements when trades stack.
                        </p>
                        <ul className="list-disc list-inside space-y-1">
                          <li>
                            <span className="font-medium text-foreground">Fixed Capital:</span> Uses
                            your starting balance as a constant baseline. Pick this when you size
                            positions with a flat dollar amount per trade.
                          </li>
                          <li>
                            <span className="font-medium text-foreground">Compounding:</span>{" "}
                            Recalculates margin against current equity so requirements grow or
                            shrink with account performance.
                          </li>
                        </ul>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <RadioGroup
                value={marginMode}
                onValueChange={(value) => setMarginMode(value as MarginMode)}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="fixed" id="fixed" />
                  <Label htmlFor="fixed" className="font-normal cursor-pointer">
                    Fixed Capital
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="compounding" id="compounding" />
                  <Label htmlFor="compounding" className="font-normal cursor-pointer">
                    Compounding
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>

          {/* Strategy Kelly Table */}
          <div className="space-y-3">
            <Label>Strategy Kelly Multipliers</Label>
            <StrategyKellyTable
              strategies={strategyData}
              kellyValues={kellyValues}
              selectedStrategies={selectedStrategies}
              onKellyChange={handleKellyChange}
              onSelectionChange={handleSelectionChange}
              onSelectAll={handleSelectAll}
            />
          </div>

          {/* Quick Actions */}
          <div className="space-y-4">
            {/* Slider to set all selected strategies */}
            {selectedStrategies.size > 0 && (
              <div className="space-y-3 p-4 border rounded-md bg-muted/30">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    Apply Kelly % to {selectedStrategies.size} selected{" "}
                    {selectedStrategies.size === 1 ? "strategy" : "strategies"}
                  </Label>
                  <span className="text-sm font-semibold text-primary">
                    {allStrategiesKellyPct}%
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <Slider
                    value={[allStrategiesKellyPct]}
                    onValueChange={(values) =>
                      setAllStrategiesKellyPct(normalizeKellyValue(values[0]))
                    }
                    min={0}
                    max={200}
                    step={1}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const newValues: Record<string, number> = {};
                      selectedStrategies.forEach((strategy) => {
                        newValues[strategy] = normalizeKellyValue(allStrategiesKellyPct);
                      });
                      setKellyValues((prev) => ({ ...prev, ...newValues }));
                    }}
                  >
                    Apply
                  </Button>
                </div>
                <div className="flex gap-2 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(25))}
                    className="hover:text-foreground"
                  >
                    25%
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(50))}
                    className="hover:text-foreground"
                  >
                    50%
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(75))}
                    className="hover:text-foreground"
                  >
                    75%
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(100))}
                    className="hover:text-foreground"
                  >
                    100%
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(125))}
                    className="hover:text-foreground"
                  >
                    125%
                  </button>
                  <span>•</span>
                  <button
                    type="button"
                    onClick={() => setAllStrategiesKellyPct(normalizeKellyValue(150))}
                    className="hover:text-foreground"
                  >
                    150%
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  const resetValues: Record<string, number> = {};
                  strategyData.forEach((s) => {
                    resetValues[s.name] = 100;
                  });
                  setKellyValues(resetValues);
                  setAllStrategiesKellyPct(100);
                }}
              >
                Reset All to 100%
              </Button>
              <Button onClick={runAllocation} className="ml-auto gap-2">
                <Play className="h-4 w-4" />
                Run Allocation
              </Button>
              <Button variant="outline" size="sm" onClick={exportAsCsv} disabled={!results}>
                <Download className="mr-2 h-4 w-4" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={exportAsJson} disabled={!results}>
                <Download className="mr-2 h-4 w-4" />
                JSON
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Results */}
      {results && (
        <>
          {hasPendingChanges && (
            <Alert variant="default" className="gap-2 border-dashed border-primary/40 bg-primary/5">
              <AlertCircle className="h-4 w-4 text-primary" aria-hidden={true} />
              <AlertTitle className="text-sm font-semibold">Pending changes</AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                Current results reflect the last run with $
                {results.config.startingCapital.toLocaleString()} starting capital at{" "}
                {results.config.portfolioKellyPct}% portfolio Kelly. Click Run Allocation to refresh
                with your latest settings.
              </AlertDescription>
            </Alert>
          )}

          <PortfolioSummary
            portfolioMetrics={results.portfolioMetrics}
            weightedAppliedPct={results.weightedAppliedPct}
            startingCapital={results.config.startingCapital}
            appliedCapital={results.appliedCapital}
          />

          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold">Strategy Analysis</h2>
              <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground">
                <span className="uppercase tracking-wide">Sort</span>
                <Select
                  value={strategySort}
                  onValueChange={(value) => setStrategySort(value as StrategySortOption)}
                >
                  <SelectTrigger size="sm" className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name-asc">Name (A → Z)</SelectItem>
                    <SelectItem value="winrate-desc">Win Rate (High → Low)</SelectItem>
                    <SelectItem value="kelly-desc">Kelly % (High → Low)</SelectItem>
                    <SelectItem value="applied-desc">Applied % (High → Low)</SelectItem>
                    <SelectItem value="capital-desc">Allocation $ (High → Low)</SelectItem>
                    <SelectItem value="trades-desc">Trades (High → Low)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <StrategyResults
              strategies={sortedStrategies}
              startingCapital={results.config.startingCapital}
            />
          </div>

          <MarginChart
            marginTimeline={results.marginTimeline}
            strategyNames={results.strategyNames}
          />

          <MarginStatisticsTable
            portfolioMaxMarginPct={results.portfolioMaxMarginPct}
            portfolioKellyPct={results.config.portfolioKellyPct}
            weightedAppliedPct={results.weightedAppliedPct}
            strategyAnalysis={results.strategyAnalysis}
          />
        </>
      )}
    </div>
  );
}
