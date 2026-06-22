"use client";

import { MultiSelect } from "@/components/multi-select";
import { NoActiveBlock } from "@/components/no-active-block";
import {
  DrawdownDistributionChart,
  ReturnDistributionChart,
} from "@/components/risk-simulator/distribution-charts";
import { StatisticsCards } from "@/components/risk-simulator/statistics-cards";
import { TradingFrequencyCard } from "@/components/risk-simulator/trading-frequency-card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  runMonteCarloSimulation,
  PortfolioStatsCalculator,
  getBlock,
  getDailyLogsByBlock,
  getTradesByBlockWithOptions,
  getDefaultSimulationPeriod,
  percentageToTrades,
  timeToTrades,
  downloadCsv,
  downloadJson,
  generateExportFilename,
  toCsvRow,
  estimateTradesPerYear,
} from "@tradeblocks/lib";
import type {
  MonteCarloParams,
  MonteCarloResult,
  DailyLogEntry,
  Trade,
  TimeUnit,
} from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { Download, HelpCircle, Loader2, Play, RotateCcw } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import type { Data } from "plotly.js";
import { useEffect, useMemo, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export default function RiskSimulatorPage() {
  const { activeBlockId, blocks } = useBlockStore();
  const activeBlock = blocks.find((b) => b.id === activeBlockId);

  // Simulation parameters
  const [numSimulations, setNumSimulations] = useState(1000);
  const [simulationPeriodValue, setSimulationPeriodValue] = useState(1);
  const [simulationPeriodUnit, setSimulationPeriodUnit] = useState<TimeUnit>("years");
  const [resamplePercentage, setResamplePercentage] = useState(100);
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const [initialCapital, setInitialCapital] = useState(100000);
  const [tradesPerYear, setTradesPerYear] = useState(252);
  const [resampleMethod, setResampleMethod] = useState<"trades" | "daily" | "percentage">(
    "percentage",
  );
  const [useFixedSeed, setUseFixedSeed] = useState(true);
  const [seedValue, setSeedValue] = useState(42);
  const [normalizeTo1Lot, setNormalizeTo1Lot] = useState(false);

  // Worst-case scenario parameters
  const [worstCaseEnabled, setWorstCaseEnabled] = useState(false);
  const [worstCasePercentage, setWorstCasePercentage] = useState(5);
  const [worstCaseMode, setWorstCaseMode] = useState<"pool" | "guarantee">("pool");
  const [worstCaseBasedOn, setWorstCaseBasedOn] = useState<"simulation" | "historical">(
    "simulation",
  );
  const [worstCaseSizing, setWorstCaseSizing] = useState<"absolute" | "relative">("relative");

  // Chart display options
  const [scaleType, setScaleType] = useState<"linear" | "log">("linear");
  const [showIndividualPaths, setShowIndividualPaths] = useState(false);

  // Simulation state
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Get available strategies from active block
  const [trades, setTrades] = useState<Trade[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLogEntry[]>([]);
  const availableStrategies = useMemo(() => {
    const strategies = new Set(trades.map((t) => t.strategy).filter(Boolean));
    return Array.from(strategies);
  }, [trades]);

  // Helper function for MultiSelect options
  const getStrategyOptions = () => {
    return availableStrategies.map((strategy) => ({
      label: strategy,
      value: strategy,
    }));
  };

  const tradesForWorstCase = useMemo(() => {
    if (selectedStrategies.length > 0) {
      const selected = new Set(selectedStrategies);
      return trades.filter((trade) => selected.has(trade.strategy || ""));
    }
    return trades;
  }, [selectedStrategies, trades]);

  // Auto-calculate trades per year from actual data
  const calculatedTradesPerYear = useMemo(() => {
    if (trades.length < 2) return 252; // Default

    // Get date range
    const sortedTrades = [...trades].sort(
      (a, b) => a.dateOpened.getTime() - b.dateOpened.getTime(),
    );
    const firstDate = sortedTrades[0].dateOpened;
    const lastDate = sortedTrades[sortedTrades.length - 1].dateOpened;

    // Calculate years elapsed
    const daysElapsed = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
    const yearsElapsed = daysElapsed / 365.25;

    if (yearsElapsed < 0.01) return 252; // Too short to calculate

    // Calculate average trades per year
    const avgTradesPerYear = Math.round(trades.length / yearsElapsed);
    return Math.max(10, avgTradesPerYear); // At least 10
  }, [trades]);

  // Auto-calculate initial capital from trades data (prefer daily logs when available)
  const calculatedInitialCapital = useMemo(() => {
    if (trades.length === 0) return 100000; // Default
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(
      trades,
      dailyLogs.length > 0 ? dailyLogs : undefined,
    );
    return initialCapital > 0 ? initialCapital : 100000;
  }, [trades, dailyLogs]);

  // Load trades and daily logs when active block changes
  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!activeBlockId) {
        if (!cancelled) {
          setTrades([]);
          setDailyLogs([]);
        }
        return;
      }

      try {
        const processedBlock = await getBlock(activeBlockId);
        const combineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;

        const [loadedTrades, loadedDailyLogs] = await Promise.all([
          getTradesByBlockWithOptions(activeBlockId, { combineLegGroups }),
          getDailyLogsByBlock(activeBlockId),
        ]);

        if (!cancelled) {
          setTrades(loadedTrades);
          setDailyLogs(loadedDailyLogs);
        }
      } catch (error) {
        console.error("Failed to load block data:", error);
        if (!cancelled) {
          setTrades([]);
          setDailyLogs([]);
        }
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, [activeBlockId]);

  // Update tradesPerYear and initialCapital when calculated values change
  useEffect(() => {
    const fallbackTradesPerYear = calculatedTradesPerYear > 0 ? calculatedTradesPerYear : 252;
    setTradesPerYear(fallbackTradesPerYear);
    setInitialCapital(calculatedInitialCapital);
    // Set default simulation period based on trading frequency
    const defaults = getDefaultSimulationPeriod(fallbackTradesPerYear);
    setSimulationPeriodValue(defaults.value);
    setSimulationPeriodUnit(defaults.unit);
    // Default to using the full history unless the user opts in to recency weighting
    setResamplePercentage(100);
  }, [calculatedTradesPerYear, calculatedInitialCapital, trades.length]);

  // Calculate actual values from user-friendly inputs
  const simulationLength = useMemo(() => {
    return timeToTrades(simulationPeriodValue, simulationPeriodUnit, tradesPerYear);
  }, [simulationPeriodValue, simulationPeriodUnit, tradesPerYear]);

  const worstCaseSimulationBudget = useMemo(() => {
    if (!worstCaseEnabled || simulationLength <= 0) {
      return 0;
    }
    const requested = Math.ceil((simulationLength * worstCasePercentage) / 100);
    return Math.min(simulationLength, Math.max(1, requested));
  }, [worstCaseEnabled, simulationLength, worstCasePercentage]);

  const historicalWorstCaseRequest = useMemo(() => {
    if (!worstCaseEnabled || worstCaseBasedOn !== "historical" || tradesForWorstCase.length === 0) {
      return 0;
    }

    const counts = tradesForWorstCase.reduce((acc, trade) => {
      const strategy = trade.strategy || "Unknown";
      acc.set(strategy, (acc.get(strategy) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());

    let totalRequested = 0;
    for (const count of counts.values()) {
      totalRequested += Math.max(1, Math.round((count * worstCasePercentage) / 100));
    }
    return totalRequested;
  }, [tradesForWorstCase, worstCaseBasedOn, worstCaseEnabled, worstCasePercentage]);

  const shouldShowHistoricalCapHint =
    worstCaseEnabled &&
    worstCaseBasedOn === "historical" &&
    historicalWorstCaseRequest > worstCaseSimulationBudget &&
    worstCaseSimulationBudget > 0;

  const runSimulation = async () => {
    if (!activeBlockId || trades.length === 0) {
      setError("No active block or trades available");
      return;
    }

    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      // Give React a chance to render the loading state before crunching numbers
      await new Promise((resolve) => setTimeout(resolve, 16));
      // Filter trades by selected strategies if any are selected
      const filteredTrades =
        selectedStrategies.length > 0
          ? trades.filter((t) => selectedStrategies.includes(t.strategy || ""))
          : trades;

      const isStrategyFiltered = filteredTrades.length !== trades.length;

      if (filteredTrades.length === 0) {
        setError("No trades match the selected strategies");
        setIsRunning(false);
        return;
      }

      // Calculate resample window based on filtered trades
      const resampleWindow =
        resamplePercentage === 100
          ? undefined
          : percentageToTrades(resamplePercentage, filteredTrades.length);

      // IMPORTANT: For percentage mode with filtered strategies from multi-strategy portfolios,
      // we need to provide the historical initial capital to avoid contamination from
      // other strategies' P&L in fundsAtClose values.
      //
      // The user's initialCapital in the UI represents what they want to START with for
      // the simulation. We use this same value to reconstruct the capital trajectory
      // when calculating percentage returns for filtered strategies.
      let historicalInitialCapital: number | undefined;
      if (isStrategyFiltered && resampleMethod === "percentage") {
        // We're excluding at least one strategy. Use the UI's initial capital
        // so percentage returns are reconstructed from only the filtered P&L.
        historicalInitialCapital = initialCapital;
      }

      const effectiveTradesPerYear = isStrategyFiltered
        ? estimateTradesPerYear(filteredTrades, tradesPerYear)
        : tradesPerYear;

      const effectiveSimulationLength = isStrategyFiltered
        ? Math.max(
            1,
            timeToTrades(simulationPeriodValue, simulationPeriodUnit, effectiveTradesPerYear),
          )
        : simulationLength;

      const params: MonteCarloParams = {
        numSimulations,
        simulationLength: effectiveSimulationLength,
        resampleWindow,
        resampleMethod,
        initialCapital,
        historicalInitialCapital, // Only set when simulating a subset of strategies
        strategy: undefined, // We pre-filter trades instead
        tradesPerYear: effectiveTradesPerYear,
        randomSeed: useFixedSeed ? seedValue : undefined,
        normalizeTo1Lot,
        worstCaseEnabled,
        worstCasePercentage,
        worstCaseMode,
        worstCaseBasedOn,
        worstCaseSizing,
      };

      const simulationResult = runMonteCarloSimulation(filteredTrades, params);
      setResult(simulationResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setIsRunning(false);
    }
  };

  const resetSimulation = () => {
    setResult(null);
    setError(null);
  };

  // Export functions
  const exportAsJson = () => {
    if (!result || !activeBlock) return;

    const exportData = {
      exportedAt: new Date().toISOString(),
      block: {
        id: activeBlock.id,
        name: activeBlock.name,
      },
      parameters: {
        numSimulations: result.parameters.numSimulations,
        simulationLength: result.parameters.simulationLength,
        resampleWindow: result.parameters.resampleWindow,
        resampleMethod: result.parameters.resampleMethod,
        initialCapital: result.parameters.initialCapital,
        tradesPerYear: result.parameters.tradesPerYear,
        randomSeed: result.parameters.randomSeed,
        normalizeTo1Lot: result.parameters.normalizeTo1Lot,
        worstCaseEnabled: result.parameters.worstCaseEnabled,
        worstCasePercentage: result.parameters.worstCasePercentage,
        worstCaseMode: result.parameters.worstCaseMode,
        worstCaseBasedOn: result.parameters.worstCaseBasedOn,
        worstCaseSizing: result.parameters.worstCaseSizing,
      },
      percentiles: {
        steps: result.percentiles.steps,
        p5: result.percentiles.p5,
        p25: result.percentiles.p25,
        p50: result.percentiles.p50,
        p75: result.percentiles.p75,
        p95: result.percentiles.p95,
      },
      statistics: {
        meanFinalValue: result.statistics.meanFinalValue,
        medianFinalValue: result.statistics.medianFinalValue,
        stdFinalValue: result.statistics.stdFinalValue,
        meanTotalReturn: result.statistics.meanTotalReturn,
        medianTotalReturn: result.statistics.medianTotalReturn,
        meanAnnualizedReturn: result.statistics.meanAnnualizedReturn,
        medianAnnualizedReturn: result.statistics.medianAnnualizedReturn,
        meanMaxDrawdown: result.statistics.meanMaxDrawdown,
        medianMaxDrawdown: result.statistics.medianMaxDrawdown,
        meanSharpeRatio: result.statistics.meanSharpeRatio,
        probabilityOfProfit: result.statistics.probabilityOfProfit,
        valueAtRisk: result.statistics.valueAtRisk,
      },
      actualResamplePoolSize: result.actualResamplePoolSize,
      selectedStrategies: selectedStrategies.length > 0 ? selectedStrategies : "all",
    };

    downloadJson(exportData, generateExportFilename(activeBlock.name, "monte-carlo", "json"));
  };

  const exportAsCsv = () => {
    if (!result || !activeBlock) return;

    const lines: string[] = [];

    // Metadata section
    lines.push("# Monte Carlo Simulation Export");
    lines.push(toCsvRow(["Block", activeBlock.name]));
    lines.push(toCsvRow(["Exported At", new Date().toISOString()]));
    lines.push(toCsvRow(["Number of Simulations", result.parameters.numSimulations]));
    lines.push(toCsvRow(["Simulation Length (trades)", result.parameters.simulationLength]));
    lines.push(toCsvRow(["Resample Method", result.parameters.resampleMethod]));
    lines.push(toCsvRow(["Initial Capital", `$${result.parameters.initialCapital}`]));
    lines.push(toCsvRow(["Trades Per Year", result.parameters.tradesPerYear]));
    lines.push(toCsvRow(["Random Seed", result.parameters.randomSeed ?? "none"]));
    lines.push(toCsvRow(["Normalize to 1-Lot", result.parameters.normalizeTo1Lot]));
    lines.push(toCsvRow(["Worst-Case Enabled", result.parameters.worstCaseEnabled]));
    if (result.parameters.worstCaseEnabled) {
      lines.push(toCsvRow(["Worst-Case Percentage", `${result.parameters.worstCasePercentage}%`]));
      lines.push(toCsvRow(["Worst-Case Mode", result.parameters.worstCaseMode]));
    }
    lines.push(
      toCsvRow([
        "Selected Strategies",
        selectedStrategies.length > 0 ? selectedStrategies.join("; ") : "All",
      ]),
    );
    lines.push("");

    // Statistics section
    lines.push("# Summary Statistics");
    lines.push("Metric,Value");
    lines.push(toCsvRow(["Mean Final Value", `$${result.statistics.meanFinalValue.toFixed(2)}`]));
    lines.push(
      toCsvRow(["Median Final Value", `$${result.statistics.medianFinalValue.toFixed(2)}`]),
    );
    lines.push(toCsvRow(["Std Dev Final Value", `$${result.statistics.stdFinalValue.toFixed(2)}`]));
    lines.push(
      toCsvRow(["Mean Total Return", `${(result.statistics.meanTotalReturn * 100).toFixed(2)}%`]),
    );
    lines.push(
      toCsvRow([
        "Median Total Return",
        `${(result.statistics.medianTotalReturn * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(
      toCsvRow([
        "Mean Annualized Return",
        `${(result.statistics.meanAnnualizedReturn * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(
      toCsvRow([
        "Median Annualized Return",
        `${(result.statistics.medianAnnualizedReturn * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(
      toCsvRow(["Mean Max Drawdown", `${(result.statistics.meanMaxDrawdown * 100).toFixed(2)}%`]),
    );
    lines.push(
      toCsvRow([
        "Median Max Drawdown",
        `${(result.statistics.medianMaxDrawdown * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(toCsvRow(["Mean Sharpe Ratio", result.statistics.meanSharpeRatio.toFixed(2)]));
    lines.push(
      toCsvRow([
        "Probability of Profit",
        `${(result.statistics.probabilityOfProfit * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(
      toCsvRow(["VaR (5th percentile)", `${(result.statistics.valueAtRisk.p5 * 100).toFixed(2)}%`]),
    );
    lines.push(
      toCsvRow([
        "VaR (10th percentile)",
        `${(result.statistics.valueAtRisk.p10 * 100).toFixed(2)}%`,
      ]),
    );
    lines.push(
      toCsvRow([
        "VaR (25th percentile)",
        `${(result.statistics.valueAtRisk.p25 * 100).toFixed(2)}%`,
      ]),
    );
    lines.push("");

    // Percentile trajectories (cumulative returns as decimals, e.g., 0.50 = 50% return)
    lines.push("# Percentile Trajectories (Cumulative Returns)");
    lines.push("Trade #,P5 Return,P25 Return,P50 Return (Median),P75 Return,P95 Return");
    for (let i = 0; i < result.percentiles.steps.length; i++) {
      lines.push(
        toCsvRow([
          result.percentiles.steps[i],
          result.percentiles.p5[i].toFixed(2),
          result.percentiles.p25[i].toFixed(2),
          result.percentiles.p50[i].toFixed(2),
          result.percentiles.p75[i].toFixed(2),
          result.percentiles.p95[i].toFixed(2),
        ]),
      );
    }

    downloadCsv(lines, generateExportFilename(activeBlock.name, "monte-carlo", "csv"));
  };

  if (!activeBlockId) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to run Monte Carlo simulations." />
    );
  }

  if (trades.length < 10) {
    return (
      <div className="container mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Risk Simulator</h1>
          <p className="text-muted-foreground">
            Monte Carlo projections using your actual trading history
          </p>
        </div>
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">
            Insufficient trades for Monte Carlo simulation. Need at least 10 trades, found{" "}
            {trades.length}.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Trading Frequency Card */}
      <TradingFrequencyCard trades={trades} tradesPerYear={calculatedTradesPerYear} />

      {/* Controls */}
      <Card className="p-6">
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Simulation Parameters</h2>
            <HoverCard>
              <HoverCardTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
              </HoverCardTrigger>
              <HoverCardContent className="w-80 p-0 overflow-hidden">
                <div className="space-y-3">
                  <div className="bg-primary/5 border-b px-4 py-3">
                    <h4 className="text-sm font-semibold text-primary">
                      Monte Carlo Risk Simulator
                    </h4>
                  </div>
                  <div className="px-4 pb-4 space-y-3">
                    <p className="text-sm font-medium text-foreground leading-relaxed">
                      Build thousands of possible futures from your trading blocks by reshuffling
                      actual trade results.
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Each simulation randomly samples from your historical performance to project
                      potential outcomes. This helps understand risk ranges and probability
                      distributions, but doesn&apos;t predict actual future results. Use these
                      projections to stress-test your strategy and understand downside scenarios.
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>

          {/* Row 1: Main Parameters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Column 1 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="num-simulations">Number of Simulations</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Number of Simulations
                        </h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          How many different future scenarios to generate from your trading history.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          More simulations produce smoother probability distributions and more
                          reliable statistics. 1,000 simulations provide good results for most
                          strategies. Use 5,000+ for publication-quality analysis or when you need
                          high precision in tail risk estimates.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                id="num-simulations"
                type="number"
                value={numSimulations}
                onChange={(e) => setNumSimulations(parseInt(e.target.value) || 1000)}
                min={100}
                max={10000}
                step={100}
              />
              <p className="text-xs text-muted-foreground">100-10,000 simulations</p>
            </div>

            {/* Column 2 - Simulation Period */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="sim-period">Simulation Period</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Simulation Period</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          How far into the future to project your portfolio performance.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Choose a timeframe in familiar units (days, months, or years). The
                          simulator converts this to the number of trades based on your historical
                          trading frequency. Longer periods show a wider range of possible outcomes
                          as uncertainty compounds over time.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <div className="flex gap-2">
                <Input
                  id="sim-period"
                  type="number"
                  value={simulationPeriodValue}
                  onChange={(e) => setSimulationPeriodValue(parseFloat(e.target.value) || 1)}
                  min={0.1}
                  max={10}
                  step={0.1}
                  className="flex-1"
                />
                <Select
                  value={simulationPeriodUnit}
                  onValueChange={(v) => setSimulationPeriodUnit(v as TimeUnit)}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="days">Days</SelectItem>
                    <SelectItem value="months">Months</SelectItem>
                    <SelectItem value="years">Years</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                ≈ {simulationLength.toLocaleString()} trades at your pace
              </p>
            </div>

            {/* Column 3 - Trades Per Year */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="trades-per-year">Trades Per Year</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Trades Per Year</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Expected annual trading frequency used to annualize returns and volatility
                          metrics.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          This value is auto-detected from your historical trading pace and affects
                          how performance metrics like CAGR and Sharpe Ratio are calculated. Higher
                          values compound returns faster but should reflect a sustainable trading
                          frequency.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                id="trades-per-year"
                type="number"
                value={tradesPerYear}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10);
                  if (Number.isFinite(next) && next > 0) {
                    setTradesPerYear(next);
                  }
                }}
                min={10}
                max={5000}
                step={5}
              />
              <p className="text-xs text-muted-foreground">
                Auto-detected pace ≈ {calculatedTradesPerYear.toLocaleString()} trades/year.
              </p>
            </div>

            {/* Column 4 - Initial Capital */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="initial-capital">Initial Capital ($)</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Initial Capital</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Starting portfolio value from which all simulations begin.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          This value is auto-detected from your actual starting capital when you
                          began trading. You can adjust it to simulate different account sizes or to
                          project how your strategy would perform with more or less capital. The
                          simulator applies your historical return patterns to this starting
                          balance.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                id="initial-capital"
                type="number"
                value={initialCapital}
                onChange={(e) => setInitialCapital(parseInt(e.target.value) || 100000)}
                min={1000}
                max={10000000}
                step={1000}
              />
              <p className="text-xs text-muted-foreground">Starting portfolio value</p>
            </div>
          </div>

          {/* Row 2: Strategy Filter */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>Strategy Filter</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Strategy Filter</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Select which strategies to include in the Monte Carlo simulation.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Leave empty to simulate using all strategies combined. Select specific
                        strategies to analyze their isolated performance or test strategy
                        combinations. This is useful for comparing individual strategy risk profiles
                        or evaluating portfolio diversification effects.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <MultiSelect
              options={getStrategyOptions()}
              onValueChange={setSelectedStrategies}
              placeholder="All strategies"
              maxCount={3}
              className="w-full"
            />
          </div>

          {/* Sampling Method and Normalization - Info Card */}
          <Card className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
            <CardContent className="pt-6">
              <div className="flex gap-3">
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                    <HelpCircle className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm text-blue-900 dark:text-blue-100">
                    Choosing the Right Sampling Method & Normalization
                  </h3>
                  <div className="text-xs text-blue-800 dark:text-blue-200 space-y-2">
                    <p>
                      <strong>Percentage Returns:</strong> Best for most traders, especially those
                      using percentage-based position sizing or compounding strategies.
                      Automatically accounts for growing equity. Enable normalization if you trade
                      varying contract sizes.
                    </p>
                    <p>
                      <strong>Fixed Sizing Modes:</strong> Use <strong>Individual Trades</strong> or{" "}
                      <strong>Daily Returns</strong> only if you always trade fixed dollar amounts.
                      Enable normalization to compare across different lot sizes.
                    </p>
                    <p className="pt-2 border-t border-blue-200 dark:border-blue-800">
                      <strong>💡 Tip:</strong> If you&apos;re unsure, stick with Percentage Returns.
                      It prevents unrealistic drawdown calculations and matches how most traders
                      actually size positions.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Sampling Method and Normalization */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Sampling Method</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Sampling Method</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Choose how to resample from your trading history.
                        </p>
                        <div className="space-y-2 text-xs text-muted-foreground">
                          <p>
                            <strong className="text-foreground">Individual Trades (Fixed):</strong>{" "}
                            Resamples dollar P&L values from individual trades. Best for strategies
                            with fixed position sizes.
                          </p>
                          <p>
                            <strong className="text-foreground">Daily Returns (Fixed):</strong>{" "}
                            Groups trades by day and resamples daily P&L totals. Better for
                            concurrent positions, but still uses fixed dollar amounts.
                          </p>
                          <p>
                            <strong className="text-foreground">
                              Percentage Returns (Compounding):
                            </strong>{" "}
                            Converts each trade to a percentage return based on capital at trade
                            time, then applies those percentages during simulation.{" "}
                            <strong className="text-primary">
                              Essential for compounding strategies
                            </strong>{" "}
                            where position sizes scale with equity. Prevents unrealistic drawdowns
                            from large late-stage trades appearing early in simulations.
                          </p>
                        </div>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={resampleMethod}
                onValueChange={(value) =>
                  setResampleMethod(value as "trades" | "daily" | "percentage")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage Returns (Compounding)</SelectItem>
                  <SelectItem value="trades">Individual Trades (Fixed Sizing)</SelectItem>
                  <SelectItem value="daily">Daily Returns (Fixed Sizing)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                How to resample from your trade history
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Label>Normalize to 1-Lot</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Normalize to 1-Lot</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Scale trade P&L to a per-contract basis for consistent risk analysis.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          If you trade multiple contracts per position (e.g., 5-lot or 10-lot
                          positions), enable this to normalize all trades to 1-lot equivalents. This
                          prevents inflated drawdowns and allows fair comparison across different
                          position sizes. The simulator will divide each trade&apos;s P&L by its
                          contract quantity to get per-contract performance.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <div className="flex items-center gap-4">
                <Switch
                  id="normalize-1lot"
                  checked={normalizeTo1Lot}
                  onCheckedChange={setNormalizeTo1Lot}
                />
                <Label htmlFor="normalize-1lot" className="cursor-pointer">
                  Scale trades to per-contract values
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                {normalizeTo1Lot
                  ? "Scaling each trade by its contract quantity"
                  : "Using actual trade P&L values"}
              </p>
            </div>
          </div>

          {/* Worst-Case Scenario Injection */}
          <Card>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Label className="text-base font-semibold">Worst-Case Scenario Testing</Label>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-96 p-0 overflow-hidden">
                      <div className="space-y-3">
                        <div className="bg-primary/5 border-b px-4 py-3">
                          <h4 className="text-sm font-semibold text-primary">
                            Worst-Case Scenario Testing
                          </h4>
                        </div>
                        <div className="px-4 pb-4 space-y-3">
                          <p className="text-sm font-medium text-foreground leading-relaxed">
                            Inject synthetic maximum-loss trades to stress-test your portfolio
                            against catastrophic scenarios.
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            For each strategy, this creates trades that lose the full allocated
                            margin (worst possible outcome). If a strategy does not report margin,
                            we fall back to its recorded max loss (or largest historical loser) so
                            the stress still reflects that strategy&apos;s risk.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>

                {/* Enable Toggle */}
                <div className="flex items-center gap-4">
                  <Switch
                    id="worst-case-enabled"
                    checked={worstCaseEnabled}
                    onCheckedChange={setWorstCaseEnabled}
                  />
                  <Label htmlFor="worst-case-enabled" className="cursor-pointer font-medium">
                    Enable worst-case maximum-loss trades
                  </Label>
                </div>

                {worstCaseEnabled && (
                  <div className="space-y-4 pl-6 border-l-2 border-primary/20">
                    {/* Percentage Slider */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm font-medium">Percentage of max-loss trades</Label>
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-72 p-0 overflow-hidden">
                            <div className="space-y-3">
                              <div className="bg-primary/5 border-b px-4 py-3">
                                <h4 className="text-sm font-semibold text-primary">
                                  Percentage of Max-Loss Trades
                                </h4>
                              </div>
                              <div className="px-4 pb-4">
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                  Controls how many max-loss trades are created. In pool mode,
                                  they&apos;re added to the resample pool. In guarantee mode,
                                  they&apos;re forced into every simulation. Loss size is scaled to
                                  your starting capital by default so 1% really means “a 1% hit to
                                  the account per strategy.” Disable that below if you want to
                                  inject the raw historical dollar margins instead. When margin data
                                  is missing, we automatically use that strategy&apos;s largest
                                  recorded loss so the test still reflects its downside.
                                </p>
                              </div>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                      </div>
                      <div className="flex items-center gap-4">
                        <Slider
                          value={[worstCasePercentage]}
                          onValueChange={(values) => setWorstCasePercentage(values[0])}
                          min={1}
                          max={20}
                          step={1}
                          className="flex-1"
                        />
                        <div className="w-16 text-right font-medium">{worstCasePercentage}%</div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {worstCaseBasedOn === "simulation" ? (
                          <>
                            Exactly {worstCasePercentage}% of the simulation horizon (≈{" "}
                            {worstCaseSimulationBudget} synthetic trades) split evenly across
                            strategies.
                          </>
                        ) : (
                          <>
                            Weighted by each strategy&apos;s historical trade count, but capped at{" "}
                            {worstCasePercentage}% of the simulation (≈ {worstCaseSimulationBudget}{" "}
                            trades) so the &quot;Force {worstCasePercentage}%&quot; promise stays
                            accurate.
                          </>
                        )}
                      </p>
                      {shouldShowHistoricalCapHint && (
                        <p className="text-[11px] text-amber-600">
                          ℹ️ Weighting by historical data would create ~{historicalWorstCaseRequest}{" "}
                          synthetic trades, but we&apos;re capping it at {worstCaseSimulationBudget}{" "}
                          trades ({worstCasePercentage}% of your {simulationLength}-trade
                          simulation) to keep the percentage accurate. The budget is distributed
                          fairly across strategies.
                        </p>
                      )}
                    </div>

                    {/* Injection Mode */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm font-medium">Injection mode</Label>
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-80 p-0 overflow-hidden">
                            <div className="space-y-3">
                              <div className="bg-primary/5 border-b px-4 py-3">
                                <h4 className="text-sm font-semibold text-primary">
                                  Injection Modes
                                </h4>
                              </div>
                              <div className="px-4 pb-4 space-y-3">
                                <div>
                                  <p className="text-xs font-medium text-foreground">
                                    Add to resample pool:
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Max-loss trades are added to the pool and sampled randomly. They
                                    may appear 0, 1, or multiple times per simulation. More
                                    conservative approach.
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-foreground">
                                    Guarantee in every simulation:
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Each simulation MUST include the exact percentage of max-loss
                                    trades. We swap out baseline draws (instead of appending) so the
                                    simulation horizon stays the same while the losses are randomly
                                    interspersed.
                                  </p>
                                </div>
                              </div>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-pool"
                            name="worst-case-mode"
                            checked={worstCaseMode === "pool"}
                            onChange={() => setWorstCaseMode("pool")}
                            className="cursor-pointer"
                            aria-label="worst-case-pool"
                          />
                          <Label
                            htmlFor="worst-case-pool"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Add to pool (may randomly appear)
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-guarantee"
                            name="worst-case-mode"
                            checked={worstCaseMode === "guarantee"}
                            onChange={() => setWorstCaseMode("guarantee")}
                            className="cursor-pointer"
                            aria-label="worst-case-guarantee"
                          />
                          <Label
                            htmlFor="worst-case-guarantee"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Force {worstCasePercentage}% into every simulation
                          </Label>
                        </div>
                      </div>
                    </div>

                    {/* Loss Sizing */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm font-medium">Loss sizing</Label>
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-80 p-0 overflow-hidden">
                            <div className="space-y-3">
                              <div className="bg-primary/5 border-b px-4 py-3">
                                <h4 className="text-sm font-semibold text-primary">
                                  How max-loss size is calculated
                                </h4>
                              </div>
                              <div className="px-4 pb-4 space-y-3 text-xs text-muted-foreground leading-relaxed">
                                <p>
                                  <span className="font-medium text-foreground">
                                    Scale to account size (recommended):
                                  </span>
                                  &nbsp;Uses each strategy&apos;s worst observed loss as a
                                  percentage of account capital, then applies it to your current
                                  starting capital. A 1% slider therefore means “1% of the account”
                                  instead of “historical dollars.”
                                </p>
                                <p>
                                  <span className="font-medium text-foreground">
                                    Use historical dollars:
                                  </span>
                                  &nbsp;Injects the raw worst-case dollar amount from the trade log.
                                  Pick this if you want to replay the exact historical blow-ups and
                                  you&apos;re confident those dollar figures match today&apos;s
                                  allocations.
                                </p>
                              </div>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-sizing-relative"
                            name="worst-case-sizing"
                            checked={worstCaseSizing === "relative"}
                            onChange={() => setWorstCaseSizing("relative")}
                            className="cursor-pointer"
                            aria-label="worst-case-sizing-relative"
                          />
                          <Label
                            htmlFor="worst-case-sizing-relative"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Scale to account size
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-sizing-absolute"
                            name="worst-case-sizing"
                            checked={worstCaseSizing === "absolute"}
                            onChange={() => setWorstCaseSizing("absolute")}
                            className="cursor-pointer"
                            aria-label="worst-case-sizing-absolute"
                          />
                          <Label
                            htmlFor="worst-case-sizing-absolute"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Use historical dollars
                          </Label>
                        </div>
                      </div>
                    </div>

                    {/* Percentage Basis */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm font-medium">Percentage based on</Label>
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-80 p-0 overflow-hidden">
                            <div className="space-y-3">
                              <div className="bg-primary/5 border-b px-4 py-3">
                                <h4 className="text-sm font-semibold text-primary">
                                  Percentage Calculation Basis
                                </h4>
                              </div>
                              <div className="px-4 pb-4 space-y-3">
                                <div>
                                  <p className="text-xs font-medium text-foreground">
                                    Simulation length (recommended):
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Percentage is based on the simulation length. For example, 5% of
                                    a 500-trade simulation would add ~25 max-loss trades (divided
                                    evenly across strategies). More intuitive for stress testing.
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-foreground">
                                    Historical data count:
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Percentage is based on historical trade count per strategy. With
                                    large datasets, this can inject many worst-case trades. Better
                                    for proportional historical analysis.
                                  </p>
                                </div>
                              </div>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-simulation"
                            name="worst-case-based-on"
                            checked={worstCaseBasedOn === "simulation"}
                            onChange={() => setWorstCaseBasedOn("simulation")}
                            className="cursor-pointer"
                            aria-label="worst-case-simulation"
                          />
                          <Label
                            htmlFor="worst-case-simulation"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Simulation length
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="worst-case-historical"
                            name="worst-case-based-on"
                            checked={worstCaseBasedOn === "historical"}
                            onChange={() => setWorstCaseBasedOn("historical")}
                            className="cursor-pointer"
                            aria-label="worst-case-historical"
                          />
                          <Label
                            htmlFor="worst-case-historical"
                            className="cursor-pointer text-sm font-normal"
                          >
                            Historical data count
                          </Label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Advanced Settings */}
          <Accordion type="single" collapsible>
            <AccordionItem value="advanced">
              <AccordionTrigger>Advanced Settings</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-6 pt-4">
                  {/* Use Recent Data Slider */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Label>Use Recent Data</Label>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">
                                Use Recent Data
                              </h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              <p className="text-sm font-medium text-foreground leading-relaxed">
                                Weight simulations toward your most recent trading performance.
                              </p>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                Set to 100% to use your entire trading history, or reduce to focus
                                on recent trades. For example, 25% uses only your most recent
                                quarter of trades. This is useful when your strategy has evolved,
                                market conditions have changed, or you want to stress-test against
                                recent volatility patterns.
                              </p>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <div className="flex items-center gap-4">
                      <Slider
                        value={[resamplePercentage]}
                        onValueChange={(values) => setResamplePercentage(values[0])}
                        min={10}
                        max={100}
                        step={5}
                        className="flex-1"
                      />
                      <div className="w-16 text-right font-medium">{resamplePercentage}%</div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Using{" "}
                      {resamplePercentage === 100
                        ? "all"
                        : `last ${Math.round(resamplePercentage)}%`}{" "}
                      of available trades
                    </p>
                  </div>

                  {/* Random Seed */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Random Seed</Label>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-0 overflow-hidden">
                          <div className="space-y-3">
                            <div className="bg-primary/5 border-b px-4 py-3">
                              <h4 className="text-sm font-semibold text-primary">Random Seed</h4>
                            </div>
                            <div className="px-4 pb-4 space-y-3">
                              <p className="text-sm font-medium text-foreground leading-relaxed">
                                Control whether simulations produce identical or varied results
                                across runs.
                              </p>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                Enable fixed seed to get reproducible results - the same simulation
                                parameters will always produce identical outputs. This is essential
                                for comparing different scenarios (like various position sizes or
                                time periods) on equal footing. Disable for truly random simulations
                                that vary each time you run them.
                              </p>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="use-seed"
                          checked={useFixedSeed}
                          onCheckedChange={setUseFixedSeed}
                        />
                        <Label htmlFor="use-seed" className="cursor-pointer">
                          Use Fixed Seed
                        </Label>
                      </div>
                      {useFixedSeed && (
                        <Input
                          type="number"
                          value={seedValue}
                          onChange={(e) => setSeedValue(parseInt(e.target.value) || 42)}
                          min={0}
                          max={999999}
                          className="w-24"
                        />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Enable for reproducible results</p>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Action Buttons */}
          <div className="flex gap-4">
            <Button
              onClick={runSimulation}
              disabled={isRunning}
              className="gap-2"
              aria-busy={isRunning}
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isRunning ? "Running Simulation..." : "Run Simulation"}
            </Button>
            <Button onClick={resetSimulation} variant="outline" className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={exportAsCsv} disabled={!result}>
                <Download className="mr-2 h-4 w-4" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={exportAsJson} disabled={!result}>
                <Download className="mr-2 h-4 w-4" />
                JSON
              </Button>
            </div>
          </div>

          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive rounded-md">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
      </Card>

      {/* Results */}
      {isRunning ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-primary/40 p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div className="text-sm font-medium text-foreground">
            Generating simulation results...
          </div>
          <p className="text-xs text-muted-foreground">
            We&apos;ll show updated charts as soon as the calculations finish.
          </p>
        </Card>
      ) : result ? (
        <>
          {/* Equity Curve Chart */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Portfolio Growth Projections</h2>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setScaleType("linear")}
                    className={`px-3 py-1 text-sm rounded ${
                      scaleType === "linear"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    Linear
                  </button>
                  <button
                    onClick={() => setScaleType("log")}
                    className={`px-3 py-1 text-sm rounded ${
                      scaleType === "log"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    Log
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="show-paths"
                    checked={showIndividualPaths}
                    onCheckedChange={setShowIndividualPaths}
                  />
                  <Label htmlFor="show-paths" className="cursor-pointer text-sm">
                    Show Individual Paths
                  </Label>
                </div>
              </div>
            </div>
            <EquityCurveChart
              result={result}
              initialCapital={initialCapital}
              scaleType={scaleType}
              showIndividualPaths={showIndividualPaths}
            />
          </Card>

          {/* Statistics Cards */}
          <StatisticsCards result={result} />

          {/* Distribution Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ReturnDistributionChart result={result} />
            <DrawdownDistributionChart result={result} />
          </div>
        </>
      ) : null}
    </div>
  );
}

// Equity Curve Chart Component
function EquityCurveChart({
  result,
  initialCapital,
  scaleType,
  showIndividualPaths,
}: {
  result: MonteCarloResult;
  initialCapital: number;
  scaleType: "linear" | "log";
  showIndividualPaths: boolean;
}) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const { data, layout } = useMemo(() => {
    const { percentiles, simulations } = result;

    // Convert percentiles to portfolio values
    const toPortfolioValue = (arr: number[]) => arr.map((v) => initialCapital * (1 + v));

    const traces: Data[] = [];

    // Show individual simulation paths if requested
    if (showIndividualPaths) {
      const pathsToShow = Math.min(20, simulations.length);
      const opacity = Math.max(0.1, Math.min(0.4, 20 / simulations.length));

      for (let i = 0; i < pathsToShow; i++) {
        traces.push({
          x: percentiles.steps,
          y: toPortfolioValue(simulations[i].equityCurve),
          type: "scatter",
          mode: "lines",
          line: {
            color: isDark ? `rgba(100, 116, 139, ${opacity})` : `rgba(148, 163, 184, ${opacity})`,
            width: 1,
          },
          showlegend: false,
          hoverinfo: "skip",
        });
      }
    }

    // P5-P95 filled area (light gray)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPortfolioValue(percentiles.p5), ...toPortfolioValue(percentiles.p95).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(128,128,128,0.1)" : "rgba(128,128,128,0.1)",
      line: { width: 0 },
      showlegend: true,
      name: "5th-95th Percentile",
      hoverinfo: "skip",
    });

    // P25-P75 filled area (light blue)
    traces.push({
      x: [...percentiles.steps, ...percentiles.steps.slice().reverse()],
      y: [...toPortfolioValue(percentiles.p25), ...toPortfolioValue(percentiles.p75).reverse()],
      type: "scatter",
      mode: "none",
      fill: "toself",
      fillcolor: isDark ? "rgba(59, 130, 246, 0.2)" : "rgba(59, 130, 246, 0.2)",
      line: { width: 0 },
      showlegend: true,
      name: "25th-75th Percentile",
      hoverinfo: "skip",
    });

    // Median line
    traces.push({
      x: percentiles.steps,
      y: toPortfolioValue(percentiles.p50),
      type: "scatter",
      mode: "lines",
      name: "Median (50th)",
      line: { color: "#3b82f6", width: 2.5 },
      hovertemplate: "<b>Median</b><br>Trade: %{x}<br>Value: $%{y:,.0f}<extra></extra>",
    });

    // Initial capital line
    traces.push({
      x: percentiles.steps,
      y: new Array(percentiles.steps.length).fill(initialCapital),
      type: "scatter",
      mode: "lines",
      line: { color: "#ef4444", dash: "dash", width: 1.5 },
      name: "Initial Capital",
      hoverinfo: "skip",
    });

    const plotLayout = {
      paper_bgcolor: isDark ? "#020817" : "#ffffff",
      plot_bgcolor: isDark ? "#020817" : "#ffffff",
      font: {
        family:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        size: 12,
        color: isDark ? "#f8fafc" : "#0f172a",
      },
      xaxis: {
        title: { text: "Number of Trades" },
        showgrid: true,
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        automargin: true,
      },
      yaxis: {
        title: { text: "Portfolio Value ($)", standoff: 40 },
        showgrid: true,
        gridcolor: isDark ? "#334155" : "#e2e8f0",
        linecolor: isDark ? "#475569" : "#cbd5e1",
        tickcolor: isDark ? "#475569" : "#cbd5e1",
        zerolinecolor: isDark ? "#475569" : "#cbd5e1",
        type: scaleType,
        automargin: true,
      },
      hovermode: "closest" as const,
      showlegend: true,
      legend: {
        orientation: "h" as const,
        yanchor: "bottom" as const,
        y: 1.02,
        xanchor: "right" as const,
        x: 1,
        font: {
          color: isDark ? "#f8fafc" : "#0f172a",
        },
      },
      autosize: true,
      height: 600,
      margin: {
        l: 80,
        r: 40,
        t: 60,
        b: 60,
      },
    };

    return { data: traces, layout: plotLayout };
  }, [result, initialCapital, scaleType, showIndividualPaths, isDark]);

  return (
    <div className="w-full">
      <Plot
        data={data}
        layout={layout}
        config={{ displayModeBar: true, displaylogo: false, responsive: true }}
        style={{ width: "100%", height: "600px" }}
        useResizeHandler
      />
    </div>
  );
}
