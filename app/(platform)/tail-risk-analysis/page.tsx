"use client";

import { NoActiveBlock } from "@/components/no-active-block";
import { MarginalContributionChart } from "@/components/tail-risk/marginal-contribution-chart";
import { ScreePlotChart } from "@/components/tail-risk/scree-plot-chart";
import { TailDependenceHeatmap } from "@/components/tail-risk/tail-dependence-heatmap";
import { TailRiskSummaryCards } from "@/components/tail-risk/tail-risk-summary-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  performTailRiskAnalysis,
  getBlock,
  getTradesByBlockWithOptions,
  downloadCsv,
  downloadJson,
  generateExportFilename,
  toCsvRow,
} from "@tradeblocks/lib";
import type { TailRiskAnalysisOptions, TailRiskAnalysisResult, Trade } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertTriangle,
  CalendarIcon,
  ChevronDown,
  Download,
  HelpCircle,
  TrendingDown,
} from "lucide-react";
import { cn } from "@tradeblocks/lib";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";

export default function TailRiskAnalysisPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const activeBlockId = useBlockStore((state) => state.blocks.find((b) => b.isActive)?.id);
  const activeBlock = useBlockStore((state) => state.blocks.find((b) => b.isActive));

  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  // Analysis options
  const [tailThreshold, setTailThreshold] = useState(0.1);
  const [tailThresholdInput, setTailThresholdInput] = useState("10");
  const [varianceThreshold, setVarianceThreshold] = useState(0.8);
  const [varianceThresholdInput, setVarianceThresholdInput] = useState("80");
  const [normalization, setNormalization] = useState<"raw" | "margin" | "notional">("raw");
  const [dateBasis, setDateBasis] = useState<"opened" | "closed">("opened");
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  // Load trades
  useEffect(() => {
    async function loadTrades() {
      if (!activeBlockId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const processedBlock = await getBlock(activeBlockId);
        const combineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;
        const loadedTrades = await getTradesByBlockWithOptions(activeBlockId, {
          combineLegGroups,
        });
        setTrades(loadedTrades);

        // Reset strategy filter when block changes
        setSelectedStrategies([]);
      } catch (error) {
        console.error("Failed to load trades:", error);
      } finally {
        setLoading(false);
      }
    }

    loadTrades();
  }, [activeBlockId]);

  // Get unique strategies from trades
  const availableStrategies = useMemo(() => {
    const strategies = new Set<string>();
    for (const trade of trades) {
      if (trade.strategy && trade.strategy.trim() !== "") {
        strategies.add(trade.strategy);
      }
    }
    return Array.from(strategies).sort();
  }, [trades]);

  // Perform analysis
  const analysisResult = useMemo((): TailRiskAnalysisResult | null => {
    if (trades.length === 0) {
      return null;
    }

    const options: TailRiskAnalysisOptions = {
      tailThreshold,
      varianceThreshold,
      normalization,
      dateBasis,
      strategyFilter: selectedStrategies.length > 0 ? selectedStrategies : undefined,
      dateRange:
        dateRange?.from || dateRange?.to ? { from: dateRange.from, to: dateRange.to } : undefined,
    };

    try {
      return performTailRiskAnalysis(trades, options);
    } catch (error) {
      console.error("Tail risk analysis failed:", error);
      return null;
    }
  }, [
    trades,
    tailThreshold,
    varianceThreshold,
    normalization,
    dateBasis,
    selectedStrategies,
    dateRange,
  ]);

  // Export handlers
  const handleDownloadCsv = useCallback(() => {
    if (!analysisResult || !activeBlock) return;

    const lines = buildTailRiskCsvLines(analysisResult, {
      blockName: activeBlock.name,
      tailThreshold,
      normalization,
      dateBasis,
      dateRange:
        dateRange?.from || dateRange?.to ? { from: dateRange.from, to: dateRange.to } : undefined,
    });

    downloadCsv(lines, generateExportFilename(activeBlock.name, "tail-risk", "csv"));
  }, [analysisResult, activeBlock, tailThreshold, normalization, dateBasis, dateRange]);

  const handleDownloadJson = useCallback(() => {
    if (!analysisResult || !activeBlock) return;

    const { strategies } = analysisResult;

    // Convert matrices to labeled objects for readability
    const labeledJointTailRisk: Record<string, Record<string, number>> = {};
    const labeledCopulaCorrelation: Record<string, Record<string, number>> = {};

    for (let i = 0; i < strategies.length; i++) {
      labeledJointTailRisk[strategies[i]] = {};
      labeledCopulaCorrelation[strategies[i]] = {};
      for (let j = 0; j < strategies.length; j++) {
        labeledJointTailRisk[strategies[i]][strategies[j]] =
          analysisResult.jointTailRiskMatrix[i][j];
        labeledCopulaCorrelation[strategies[i]][strategies[j]] =
          analysisResult.copulaCorrelationMatrix[i][j];
      }
    }

    // Convert eigenvalues to labeled array
    const labeledEigenvalues = analysisResult.eigenvalues.map((value, i) => ({
      factor: i + 1,
      eigenvalue: value,
      cumulativeVarianceExplained: analysisResult.explainedVariance[i],
    }));

    const exportData = {
      exportedAt: new Date().toISOString(),
      block: {
        id: activeBlock.id,
        name: activeBlock.name,
      },
      settings: {
        tailThreshold,
        tailThresholdDescription: `Bottom ${(tailThreshold * 100).toFixed(0)}% of daily returns considered "tail" events`,
        varianceThreshold,
        varianceThresholdDescription: `${(varianceThreshold * 100).toFixed(0)}% cumulative variance threshold for effective factors`,
        normalization,
        dateBasis,
        dateRange:
          dateRange?.from || dateRange?.to
            ? {
                from: dateRange?.from?.toISOString(),
                to: dateRange?.to?.toISOString(),
              }
            : "all",
      },
      summary: {
        strategiesAnalyzed: strategies.length,
        tradingDaysUsed: analysisResult.tradingDaysUsed,
        effectiveRiskFactors: analysisResult.effectiveFactors,
        effectiveFactorsDescription: `${analysisResult.effectiveFactors} independent risk factors explain ${(analysisResult.varianceThreshold * 100).toFixed(0)}%+ of tail risk variance`,
        averageJointTailRisk: analysisResult.analytics.averageJointTailRisk,
        highRiskPairsPct: analysisResult.analytics.highRiskPairsPct,
        highestJointTailRisk: analysisResult.analytics.highestJointTailRisk,
        lowestJointTailRisk: analysisResult.analytics.lowestJointTailRisk,
      },
      jointTailRiskMatrix: labeledJointTailRisk,
      jointTailRiskDescription:
        "Probability that strategy B has an extreme loss day given strategy A has an extreme loss day. Values above 0.5 indicate strategies tend to lose together on bad days.",
      copulaCorrelationMatrix: labeledCopulaCorrelation,
      copulaCorrelationDescription:
        "Correlation computed using Kendall's tau (rank-based) mapped to Pearson via sin transform. Captures dependence structure independent of marginal distributions with guaranteed positive semi-definite matrix.",
      factorAnalysis: labeledEigenvalues,
      factorAnalysisDescription:
        "Eigenvalue decomposition showing how many independent risk factors drive tail behavior. Fewer effective factors = more concentrated tail risk.",
      marginalContributions: analysisResult.marginalContributions,
      marginalContributionsDescription:
        "Each strategy's contribution to portfolio tail risk. tailRiskContribution shows % of total tail risk; concentrationScore shows loading on first principal factor.",
    };

    downloadJson(exportData, generateExportFilename(activeBlock.name, "tail-risk", "json"));
  }, [
    analysisResult,
    activeBlock,
    tailThreshold,
    varianceThreshold,
    normalization,
    dateBasis,
    dateRange,
  ]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">Loading tail risk analysis...</div>
      </div>
    );
  }

  // No block selected
  if (!activeBlockId) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to analyze tail risk." />
    );
  }

  // No trades
  if (trades.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">No trades available for tail risk analysis</div>
      </div>
    );
  }

  // Insufficient data warning
  const insufficientData =
    analysisResult && (analysisResult.tradingDaysUsed < 30 || analysisResult.strategies.length < 2);

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <Card className="border-l-4 border-l-amber-500 dark:border-l-amber-400">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <TrendingDown className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold">What is Tail Risk Analysis?</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Regular correlation (Pearson) measures average co-movement, but options strategies
                often behave differently in the tails. Two strategies can appear uncorrelated
                day-to-day but still blow up together on big market moves. This analysis uses{" "}
                <strong>Gaussian copula</strong> methods with <strong>Kendall&apos;s tau</strong> to
                measure <strong>joint tail risk</strong> - the probability that strategies have
                extreme losses together.
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="font-medium bg-blue-500/10 text-blue-700 dark:text-blue-400"
                  >
                    LOW JOINT RISK
                  </Badge>
                  <span className="text-muted-foreground">Good diversification in stress</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-red-500 bg-red-500/10 text-red-700 dark:text-red-400 font-medium"
                  >
                    HIGH JOINT RISK
                  </Badge>
                  <span className="text-muted-foreground">Strategies blow up together</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Analysis Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Row 1: Date Range, Strategies, Return Basis, Date Basis */}
          <div className="flex flex-col sm:flex-row gap-6">
            {/* Date Range */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Date Range</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-64">
                    <p className="text-sm">
                      Filter trades to a specific date range for the analysis.
                    </p>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[240px] justify-start text-left font-normal",
                      !dateRange && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dateRange?.from ? (
                      dateRange.to ? (
                        <>
                          {format(dateRange.from, "LLL dd, y")} -{" "}
                          {format(dateRange.to, "LLL dd, y")}
                        </>
                      ) : (
                        format(dateRange.from, "LLL dd, y")
                      )
                    ) : (
                      <span>All time</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <DateRangePicker date={dateRange} onDateChange={setDateRange} />
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                {dateRange?.from || dateRange?.to
                  ? "Filtered date range"
                  : "Using all available data"}
              </p>
            </div>

            {/* Strategy Filter */}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Label>Strategies</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-64">
                    <p className="text-sm">
                      Filter to specific strategies. Leave empty to include all.
                    </p>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <MultiSelect
                options={availableStrategies.map((s) => ({
                  value: s,
                  label: s,
                }))}
                defaultValue={selectedStrategies}
                onValueChange={setSelectedStrategies}
                placeholder="All strategies"
              />
              <p className="text-xs text-muted-foreground">
                {selectedStrategies.length === 0
                  ? `${availableStrategies.length} available`
                  : `${selectedStrategies.length} selected`}
              </p>
            </div>

            {/* Return Basis */}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="normalization-select">Return Basis</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Return Normalization</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Raw P/L:</strong> Absolute dollar returns.
                          <br />
                          <strong>Margin-normalized:</strong> Returns divided by margin requirement.
                          <br />
                          <strong>1-lot normalized:</strong> Per-contract basis.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={normalization}
                onValueChange={(value) => setNormalization(value as "raw" | "margin" | "notional")}
              >
                <SelectTrigger id="normalization-select" className="w-full">
                  <SelectValue placeholder="Return basis" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw">Raw P/L</SelectItem>
                  <SelectItem value="margin">Margin-normalized</SelectItem>
                  <SelectItem value="notional">1-lot normalized</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {normalization === "raw" && "Absolute dollar amounts"}
                {normalization === "margin" && "P/L ÷ Margin required"}
                {normalization === "notional" && "Per-contract returns"}
              </p>
            </div>

            {/* Date Basis */}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="date-basis-select">Date Basis</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Date Basis</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Opened date:</strong> Groups by when trades were entered.
                          <br />
                          <strong>Closed date:</strong> Groups by when trades were closed.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={dateBasis}
                onValueChange={(value) => setDateBasis(value as "opened" | "closed")}
              >
                <SelectTrigger id="date-basis-select" className="w-full">
                  <SelectValue placeholder="Date basis" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opened">Opened date</SelectItem>
                  <SelectItem value="closed">Closed date</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {dateBasis === "opened" && "Group by entry date"}
                {dateBasis === "closed" && "Group by exit date"}
              </p>
            </div>
          </div>

          {/* Row 2: Tail Threshold, Variance Threshold */}
          <div className="flex flex-col sm:flex-row gap-6">
            {/* Tail Threshold */}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Label>Tail Threshold</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Tail Threshold</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Defines what counts as an &quot;extreme&quot; day
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          A 10% threshold means the worst 10% of days are considered
                          &quot;tail&quot; events. Lower thresholds (5%) capture more extreme events
                          but have less data. Higher thresholds (20%) have more data but capture
                          less extreme behavior.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  value={[tailThreshold * 100]}
                  onValueChange={([val]) => {
                    setTailThreshold(val / 100);
                    setTailThresholdInput(String(val));
                  }}
                  min={1}
                  max={50}
                  step={1}
                  className="flex-1"
                />
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    value={tailThresholdInput}
                    onChange={(e) => setTailThresholdInput(e.target.value)}
                    onBlur={() => {
                      const val = parseFloat(tailThresholdInput);
                      if (!isNaN(val) && val >= 1 && val <= 50) {
                        setTailThreshold(val / 100);
                        setTailThresholdInput(String(val));
                      } else {
                        setTailThresholdInput(String(tailThreshold * 100));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-16 h-8 text-center"
                    min={1}
                    max={50}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Bottom {(tailThreshold * 100).toFixed(0)}% of days considered &quot;tail&quot;
                events
              </p>
            </div>

            {/* Variance Threshold */}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Label>Variance Threshold</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Variance Threshold</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Cumulative variance for &quot;effective factors&quot;
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          80% is standard in PCA literature. Use 90% for more conservative risk
                          analysis (captures more factors). Lower values (70%) show fewer factors
                          but may miss important risk sources.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  value={[varianceThreshold * 100]}
                  onValueChange={([val]) => {
                    setVarianceThreshold(val / 100);
                    setVarianceThresholdInput(String(val));
                  }}
                  min={50}
                  max={99}
                  step={1}
                  className="flex-1"
                />
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    value={varianceThresholdInput}
                    onChange={(e) => setVarianceThresholdInput(e.target.value)}
                    onBlur={() => {
                      const val = parseFloat(varianceThresholdInput);
                      if (!isNaN(val) && val >= 50 && val <= 99) {
                        setVarianceThreshold(val / 100);
                        setVarianceThresholdInput(String(val));
                      } else {
                        setVarianceThresholdInput(String(varianceThreshold * 100));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-16 h-8 text-center"
                    min={50}
                    max={99}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Factors explaining {(varianceThreshold * 100).toFixed(0)}% of variance
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Insufficient Data Warning */}
      {insufficientData && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-700 dark:text-amber-400">Insufficient Data</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {analysisResult!.tradingDaysUsed < 30 &&
                    `Only ${analysisResult!.tradingDaysUsed} shared trading days found. At least 30 days recommended for reliable tail risk estimation. `}
                  {analysisResult!.strategies.length < 2 &&
                    `Only ${analysisResult!.strategies.length} strategy found. Need at least 2 strategies for correlation analysis.`}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Insufficient Tail Observations Warning */}
      {analysisResult && analysisResult.insufficientDataPairs > 0 && (
        <Card className="border-blue-500/50 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-blue-700 dark:text-blue-400">
                  {analysisResult.insufficientDataPairs} Strategy Pair
                  {analysisResult.insufficientDataPairs > 1 ? "s Have" : " Has"} Insufficient Tail
                  Data
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  With a {(tailThreshold * 100).toFixed(0)}% tail threshold and your current data,
                  some strategy pairs don&apos;t have enough shared extreme days to calculate
                  reliable joint tail risk.{" "}
                  <strong>
                    Try increasing the tail threshold to{" "}
                    {Math.min(50, Math.round(tailThreshold * 100) + 5)}-
                    {Math.min(50, Math.round(tailThreshold * 100) + 10)}%
                  </strong>{" "}
                  to include more observations. These pairs are shown as &quot;N/A&quot; in the
                  heatmap.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {analysisResult && analysisResult.strategies.length >= 2 && (
        <>
          {/* Summary Cards */}
          <TailRiskSummaryCards result={analysisResult} />

          {/* Charts */}
          <Tabs defaultValue="heatmap">
            <TabsList>
              <TabsTrigger value="heatmap">Joint Tail Risk</TabsTrigger>
              <TabsTrigger value="factors">Factor Analysis</TabsTrigger>
              <TabsTrigger value="contributions">Contributions</TabsTrigger>
            </TabsList>

            <TabsContent value="heatmap" className="mt-4 space-y-4">
              <TailDependenceHeatmap
                result={analysisResult}
                actions={
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleDownloadCsv}>
                      <Download className="mr-2 h-4 w-4" />
                      CSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDownloadJson}>
                      <Download className="mr-2 h-4 w-4" />
                      JSON
                    </Button>
                  </div>
                }
              />
              <HeatmapInterpretation result={analysisResult} />
            </TabsContent>

            <TabsContent value="factors" className="mt-4 space-y-4">
              <ScreePlotChart result={analysisResult} />
              <FactorInterpretation result={analysisResult} />
            </TabsContent>

            <TabsContent value="contributions" className="mt-4 space-y-4">
              <MarginalContributionChart result={analysisResult} />
              <ContributionInterpretation result={analysisResult} />
            </TabsContent>
          </Tabs>

          {/* Quick Insights */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Quick Insights</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">
                    Highest Joint Tail Risk:
                  </div>
                  <div
                    className="text-2xl font-bold"
                    style={{ color: isDark ? "#f87171" : "#dc2626" }}
                  >
                    {analysisResult.analytics.highestJointTailRisk.value.toFixed(2)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {analysisResult.analytics.highestJointTailRisk.pair[0]} ↔{" "}
                    {analysisResult.analytics.highestJointTailRisk.pair[1]}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">
                    Lowest Joint Tail Risk:
                  </div>
                  <div
                    className="text-2xl font-bold"
                    style={{ color: isDark ? "#4ade80" : "#16a34a" }}
                  >
                    {analysisResult.analytics.lowestJointTailRisk.value.toFixed(2)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {analysisResult.analytics.lowestJointTailRisk.pair[0]} ↔{" "}
                    {analysisResult.analytics.lowestJointTailRisk.pair[1]}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">
                    Top Risk Contributor:
                  </div>
                  <div className="text-2xl font-bold">
                    {analysisResult.marginalContributions[0]?.tailRiskContribution.toFixed(1)}%
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {analysisResult.marginalContributions[0]?.strategy}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// Interpretation Components
function HeatmapInterpretation({ result }: { result: TailRiskAnalysisResult }) {
  const [open, setOpen] = useState(false);
  const { analytics, strategies } = result;
  const avgRisk = analytics.averageJointTailRisk;
  const highPct = analytics.highRiskPairsPct * 100;

  // Determine overall assessment
  let assessment: "good" | "moderate" | "concerning";
  let assessmentText: string;
  if (avgRisk < 0.3) {
    assessment = "good";
    assessmentText = "Your strategies show good tail diversification.";
  } else if (avgRisk < 0.5) {
    assessment = "moderate";
    assessmentText = "Your strategies have moderate tail concentration.";
  } else {
    assessment = "concerning";
    assessmentText = "Your strategies tend to lose together on bad days.";
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
                How to Read This Heatmap
              </CardTitle>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  open ? "rotate-180" : ""
                }`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h4 className="font-medium text-sm">What the Numbers Mean</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>
                    <span className="font-medium text-blue-600 dark:text-blue-400">0.0 - 0.3</span>:
                    Low joint tail risk. These strategies rarely have bad days together.
                  </li>
                  <li>
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      0.3 - 0.5
                    </span>
                    : Moderate. Some overlap in extreme losses.
                  </li>
                  <li>
                    <span className="font-medium text-orange-600 dark:text-orange-400">
                      0.5 - 0.7
                    </span>
                    : High. Often lose together on bad days.
                  </li>
                  <li>
                    <span className="font-medium text-red-600 dark:text-red-400">0.7 - 1.0</span>:
                    Very high. Almost always lose together on extreme days.
                  </li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Your Portfolio Assessment</h4>
                <div
                  className={`p-3 rounded-md text-sm ${
                    assessment === "good"
                      ? "bg-green-500/10 text-green-700 dark:text-green-400"
                      : assessment === "moderate"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-red-500/10 text-red-700 dark:text-red-400"
                  }`}
                >
                  <p className="font-medium">{assessmentText}</p>
                  <p className="mt-1 text-xs opacity-80">
                    Average joint tail risk: {(avgRisk * 100).toFixed(0)}% | {highPct.toFixed(0)}%
                    of your {strategies.length} strategy pairs have &gt;50% chance of losing
                    together on extreme days.
                  </p>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-3">
              <strong>Example:</strong> A value of 0.85 between Strategy A and B means: when
              Strategy A is in its worst 10% of days, there&apos;s an 85% chance Strategy B is also
              having a bad day. This is different from regular correlation - two strategies can
              appear uncorrelated day-to-day but still blow up together during market stress.
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function FactorInterpretation({ result }: { result: TailRiskAnalysisResult }) {
  const [open, setOpen] = useState(false);
  const { effectiveFactors, strategies, explainedVariance, varianceThreshold } = result;
  const diversificationRatio = effectiveFactors / strategies.length;
  const thresholdPct = (varianceThreshold * 100).toFixed(0);

  let assessment: "good" | "moderate" | "concerning";
  let assessmentText: string;
  if (diversificationRatio >= 0.5) {
    assessment = "good";
    assessmentText =
      "Good diversification - your strategies represent many independent risk sources.";
  } else if (diversificationRatio >= 0.25) {
    assessment = "moderate";
    assessmentText =
      "Moderate concentration - several strategies share similar tail risk exposure.";
  } else {
    assessment = "concerning";
    assessmentText = "High concentration - most of your tail risk comes from a few common factors.";
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
                How to Read the Factor Analysis
              </CardTitle>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  open ? "rotate-180" : ""
                }`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h4 className="font-medium text-sm">What This Shows</h4>
                <p className="text-sm text-muted-foreground">
                  You have{" "}
                  <span className="font-semibold text-foreground">
                    {strategies.length} strategies
                  </span>
                  , but they really represent{" "}
                  <span className="font-semibold text-foreground">
                    {effectiveFactors} independent risk factors
                  </span>{" "}
                  (the number needed to explain {thresholdPct}% of tail risk variance).
                </p>
                <p className="text-sm text-muted-foreground">
                  Think of it like this: if you have 20 strategies but only 5 effective factors,
                  those 20 strategies are really just 5 different &quot;bets&quot; that will win or
                  lose together.
                </p>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Your Portfolio</h4>
                <div
                  className={`p-3 rounded-md text-sm ${
                    assessment === "good"
                      ? "bg-green-500/10 text-green-700 dark:text-green-400"
                      : assessment === "moderate"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-red-500/10 text-red-700 dark:text-red-400"
                  }`}
                >
                  <p className="font-medium">{assessmentText}</p>
                  <p className="mt-1 text-xs opacity-80">
                    {effectiveFactors} factors explain{" "}
                    {(explainedVariance[effectiveFactors - 1] * 100).toFixed(0)}% of tail risk in
                    your {strategies.length} strategies. Ratio:{" "}
                    {(diversificationRatio * 100).toFixed(0)}%
                  </p>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-3">
              <strong>Reading the chart:</strong> Blue bars show eigenvalues (variance captured per
              factor). Orange line shows cumulative variance explained. The green dashed line at{" "}
              {thresholdPct}% marks where &quot;effective factors&quot; is counted - the first
              factor where the orange line crosses {thresholdPct}%.
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function ContributionInterpretation({ result }: { result: TailRiskAnalysisResult }) {
  const [open, setOpen] = useState(false);
  const { marginalContributions, strategies } = result;

  // Find strategies that provide diversification (low avg tail dependence)
  const diversifiers = marginalContributions.filter((c) => c.avgTailDependence < 0.5).slice(0, 3);
  const concentrators = marginalContributions.filter((c) => c.avgTailDependence >= 0.7).slice(0, 3);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
                How to Read the Contributions
              </CardTitle>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  open ? "rotate-180" : ""
                }`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h4 className="font-medium text-sm">What This Shows</h4>
                <p className="text-sm text-muted-foreground">
                  Each strategy&apos;s contribution to overall portfolio tail risk. Strategies with{" "}
                  <span className="font-semibold text-foreground">higher bars</span> contribute more
                  to the portfolio&apos;s tendency to have big losing days.
                </p>
                <p className="text-sm text-muted-foreground">
                  A strategy with high contribution isn&apos;t necessarily &quot;bad&quot; - it
                  means removing it would reduce tail risk more than removing a low-contribution
                  strategy.
                </p>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Actionable Insights</h4>
                {diversifiers.length > 0 && (
                  <div className="p-2 rounded-md bg-green-500/10 text-sm">
                    <span className="font-medium text-green-700 dark:text-green-400">
                      Best diversifiers:
                    </span>
                    <span className="text-green-700/80 dark:text-green-400/80">
                      {" "}
                      {diversifiers.map((c) => c.strategy).join(", ")}
                    </span>
                  </div>
                )}
                {concentrators.length > 0 && (
                  <div className="p-2 rounded-md bg-amber-500/10 text-sm">
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      Most correlated in tails:
                    </span>
                    <span className="text-amber-700/80 dark:text-amber-400/80">
                      {" "}
                      {concentrators.map((c) => c.strategy).join(", ")}
                    </span>
                  </div>
                )}
                {diversifiers.length === 0 && concentrators.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    All {strategies.length} strategies have similar tail risk profiles.
                  </p>
                )}
              </div>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-3">
              <strong>Tip:</strong> If you&apos;re looking to reduce portfolio tail risk, consider
              reducing allocation to the highest-bar strategies, or adding more strategies similar
              to the lowest-bar ones (which tend to behave differently during stress).
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

interface CsvMeta {
  blockName: string;
  tailThreshold: number;
  normalization: string;
  dateBasis: string;
  dateRange?: { from?: Date; to?: Date };
}

function buildTailRiskCsvLines(result: TailRiskAnalysisResult, meta: CsvMeta): string[] {
  const lines: string[] = [];

  lines.push(toCsvRow(["Generated At", new Date().toISOString()]));
  lines.push(toCsvRow(["Block", meta.blockName]));
  lines.push(toCsvRow(["Tail Threshold", `${(meta.tailThreshold * 100).toFixed(0)}%`]));
  lines.push(toCsvRow(["Return Basis", meta.normalization]));
  lines.push(toCsvRow(["Date Basis", meta.dateBasis]));
  lines.push(
    toCsvRow([
      "Date Range",
      meta.dateRange?.from || meta.dateRange?.to
        ? `${meta.dateRange.from ? format(meta.dateRange.from, "yyyy-MM-dd") : "start"} to ${meta.dateRange.to ? format(meta.dateRange.to, "yyyy-MM-dd") : "end"}`
        : "All time",
    ]),
  );
  lines.push(toCsvRow(["Strategies", result.strategies.length]));
  lines.push(toCsvRow(["Trading Days", result.tradingDaysUsed]));
  lines.push(toCsvRow(["Effective Factors", result.effectiveFactors]));
  lines.push(toCsvRow(["Avg Joint Tail Risk", result.analytics.averageJointTailRisk.toFixed(4)]));

  lines.push("");
  lines.push(toCsvRow(["--- Joint Tail Risk Matrix ---"]));
  lines.push(toCsvRow(["Strategy", ...result.strategies]));
  result.jointTailRiskMatrix.forEach((row, index) => {
    lines.push(toCsvRow([result.strategies[index], ...row.map((v) => v.toFixed(4))]));
  });

  lines.push("");
  lines.push(toCsvRow(["--- Marginal Contributions ---"]));
  lines.push(
    toCsvRow([
      "Strategy",
      "Tail Risk Contribution %",
      "Concentration Score",
      "Avg Joint Tail Risk",
    ]),
  );
  result.marginalContributions.forEach((c) => {
    lines.push(
      toCsvRow([
        c.strategy,
        c.tailRiskContribution.toFixed(2),
        c.concentrationScore.toFixed(4),
        c.avgTailDependence.toFixed(4),
      ]),
    );
  });

  lines.push("");
  lines.push(toCsvRow(["--- Eigenvalue Analysis ---"]));
  lines.push(toCsvRow(["Factor", "Eigenvalue", "Cumulative Variance %"]));
  result.eigenvalues.forEach((ev, i) => {
    lines.push(
      toCsvRow([`Factor ${i + 1}`, ev.toFixed(4), (result.explainedVariance[i] * 100).toFixed(2)]),
    );
  });

  return lines;
}
