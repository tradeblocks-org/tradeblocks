"use client";

import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  HelpCircle,
  Lightbulb,
  Loader2,
  TrendingUp,
  BarChart3,
  TableIcon,
  Settings2,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WalkForwardAnalysisChart } from "@/components/walk-forward/analysis-chart";
import { WalkForwardPeriodSelector } from "@/components/walk-forward/period-selector";
import { RobustnessMetrics } from "@/components/walk-forward/robustness-metrics";
import { RunSwitcher } from "@/components/walk-forward/run-switcher";
import { WalkForwardAnalysis } from "@/components/walk-forward/walk-forward-analysis";
import { WalkForwardErrorBoundary } from "@/components/walk-forward/walk-forward-error-boundary";
import { WalkForwardSummary } from "@/components/walk-forward/walk-forward-summary";
import {
  getRecommendedParameters,
  formatParameterName,
  cn,
  downloadCsv,
  downloadFile,
  generateExportFilename,
} from "@tradeblocks/lib";
import type { WalkForwardOptimizationTarget, SkippedWindow } from "@tradeblocks/lib";
import { useBlockStore, useWalkForwardStore } from "@tradeblocks/lib/stores";

const TARGET_LABELS: Record<WalkForwardOptimizationTarget, string> = {
  netPl: "Net Profit",
  profitFactor: "Profit Factor",
  sharpeRatio: "Sharpe Ratio",
  sortinoRatio: "Sortino Ratio",
  calmarRatio: "Calmar Ratio",
  cagr: "CAGR",
  avgDailyPl: "Avg Daily P/L",
  winRate: "Win Rate",
  minAvgCorrelation: "Min Avg Correlation",
  minTailRisk: "Min Tail Risk",
  maxEffectiveFactors: "Max Effective Factors",
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function WalkForwardPage() {
  const activeBlock = useBlockStore((state) => {
    const activeId = state.activeBlockId;
    return activeId ? (state.blocks.find((block) => block.id === activeId) ?? null) : null;
  });
  const blockIsLoading = useBlockStore((state) => state.isLoading);
  const isInitialized = useBlockStore((state) => state.isInitialized);
  const loadBlocks = useBlockStore((state) => state.loadBlocks);

  const results = useWalkForwardStore((state) => state.results);
  const history = useWalkForwardStore((state) => state.history);
  const config = useWalkForwardStore((state) => state.config);
  const loadHistory = useWalkForwardStore((state) => state.loadHistory);
  const selectAnalysis = useWalkForwardStore((state) => state.selectAnalysis);
  const deleteAnalysis = useWalkForwardStore((state) => state.deleteAnalysis);
  const exportResultsAsCsv = useWalkForwardStore((state) => state.exportResultsAsCsv);
  const exportResultsAsJson = useWalkForwardStore((state) => state.exportResultsAsJson);

  const [showFailingOnly, setShowFailingOnly] = useState(false);
  const [showSkippedWindows, setShowSkippedWindows] = useState(false);
  const [minOosTrades, setMinOosTrades] = useState(0);
  const [periodRange, setPeriodRange] = useState<[number, number]>([1, 1]);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});

  const activeBlockId = activeBlock?.id ?? null;

  useEffect(() => {
    if (!isInitialized) {
      loadBlocks().catch(console.error);
    }
  }, [isInitialized, loadBlocks]);

  useEffect(() => {
    if (activeBlockId) {
      loadHistory(activeBlockId).catch(console.error);
    }
  }, [activeBlockId, loadHistory]);

  useEffect(() => {
    if (results?.results.periods?.length) {
      setPeriodRange([1, results.results.periods.length]);
    }
  }, [results?.results.periods?.length]);

  const targetMetricLabel =
    TARGET_LABELS[
      (results?.config.optimizationTarget ??
        config.optimizationTarget) as WalkForwardOptimizationTarget
    ] ?? "Net Profit";

  const formatMetricValue = (value: number) => {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const fractionDigits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;
    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  };

  const getEfficiencyStatus = (pct: number) => {
    if (pct >= 90) {
      return {
        label: "Robust",
        chipClass: "bg-emerald-50 text-emerald-700",
        icon: TrendingUp,
        iconClass: "text-emerald-600",
        action: "OOS almost mirrors IS. You can lean into this sizing with confidence.",
        lineColor: "#10b981",
      };
    }
    if (pct >= 70) {
      return {
        label: "Monitor",
        chipClass: "bg-amber-50 text-amber-700",
        icon: Activity,
        iconClass: "text-amber-600",
        action: "Slight degradation — keep the parameters but monitor drawdowns closely.",
        lineColor: "#f59e0b",
      };
    }
    return {
      label: "Attention",
      chipClass: "bg-rose-50 text-rose-700",
      icon: AlertTriangle,
      iconClass: "text-rose-600",
      action: "OOS fell off a cliff. Re-run optimization or throttle position sizes here.",
      lineColor: "#f43f5e",
    };
  };

  const periodSummaries = useMemo(() => {
    if (!results) return [];
    return results.results.periods.map((period, index) => {
      const degradation =
        period.targetMetricInSample !== 0
          ? period.targetMetricOutOfSample / period.targetMetricInSample
          : 0;

      const efficiencyPct = Number.isFinite(degradation) ? degradation * 100 : 0;
      const status = getEfficiencyStatus(efficiencyPct);

      // Separate strategy weights from other parameters
      const strategyWeights: Array<{ strategy: string; weight: number }> = [];
      const otherParameters: Array<{
        key: string;
        prettyKey: string;
        value: number;
        formattedValue: string;
      }> = [];

      Object.entries(period.optimalParameters).forEach(([key, value]) => {
        if (key.startsWith("strategy:")) {
          strategyWeights.push({
            strategy: key.replace("strategy:", ""),
            weight: value,
          });
        } else {
          const prettyKey = (() => {
            switch (key) {
              case "kellyMultiplier":
                return "Kelly Multiplier";
              case "fixedFractionPct":
                return "Fixed Fraction %";
              case "maxDrawdownPct":
                return "Max Drawdown %";
              case "maxDailyLossPct":
                return "Max Daily Loss %";
              case "consecutiveLossLimit":
                return "Consecutive Loss Limit";
              default:
                return key;
            }
          })();

          const formattedValue = key.toLowerCase().includes("pct")
            ? `${value.toFixed(2)}%`
            : value.toFixed(2);

          otherParameters.push({ key, prettyKey, value, formattedValue });
        }
      });

      // Legacy parameters array for backward compatibility
      const parameterSummary = otherParameters.map((p) => `${p.prettyKey}: ${p.formattedValue}`);

      return {
        kind: "period" as const,
        sortKey: new Date(period.inSampleStart).getTime(),
        label: `Period ${index + 1}`,
        inSampleRange: `${formatDate(period.inSampleStart)} → ${formatDate(period.inSampleEnd)}`,
        outSampleRange: `${formatDate(period.outOfSampleStart)} → ${formatDate(
          period.outOfSampleEnd,
        )}`,
        inSampleMetric: period.targetMetricInSample,
        outSampleMetric: period.targetMetricOutOfSample,
        efficiencyPct,
        status,
        oosDrawdown: period.outOfSampleMetrics.maxDrawdown,
        oosTrades: period.outOfSampleMetrics.totalTrades,
        parameters: parameterSummary,
        strategyWeights,
        diversificationMetrics: period.diversificationMetrics,
      };
    });
  }, [results]);

  // Build skipped window summaries for the unified timeline
  const skippedSummaries = useMemo(() => {
    if (!results) return [];
    return (results.results.skippedWindows ?? []).map((sw: SkippedWindow, index: number) => ({
      kind: "skipped" as const,
      sortKey: new Date(sw.inSampleStart).getTime(),
      label: `Skipped ${index + 1}`,
      inSampleRange: `${formatDate(sw.inSampleStart)} → ${formatDate(sw.inSampleEnd)}`,
      outSampleRange: `${formatDate(sw.outOfSampleStart)} → ${formatDate(sw.outOfSampleEnd)}`,
      reason: sw.reason,
      detail: sw.detail,
    }));
  }, [results]);

  const rangeFilteredSummaries = useMemo(() => {
    const [start, end] = periodRange;
    return periodSummaries.filter((_, idx) => {
      const n = idx + 1;
      return n >= start && n <= end;
    });
  }, [periodSummaries, periodRange]);

  const filteredPeriodSummaries = useMemo(() => {
    return rangeFilteredSummaries.filter((period) => {
      if (showFailingOnly && period.efficiencyPct >= 60) return false;
      if (minOosTrades > 0 && (period.oosTrades ?? 0) < minOosTrades) return false;
      return true;
    });
  }, [rangeFilteredSummaries, showFailingOnly, minOosTrades]);

  // Unified timeline: merge periods + skipped windows when toggle is on
  type PeriodEntry = (typeof periodSummaries)[number];
  type SkippedEntry = (typeof skippedSummaries)[number];
  type TimelineEntry = PeriodEntry | SkippedEntry;

  const timelineEntries = useMemo((): TimelineEntry[] => {
    if (!showSkippedWindows || skippedSummaries.length === 0) {
      return filteredPeriodSummaries;
    }
    const merged = [...filteredPeriodSummaries, ...skippedSummaries];
    merged.sort((a, b) => a.sortKey - b.sortKey);
    return merged;
  }, [filteredPeriodSummaries, skippedSummaries, showSkippedWindows]);

  const miniBars = useMemo(() => {
    return filteredPeriodSummaries.map((period) => {
      const isVal = period.inSampleMetric;
      const oosVal = period.outSampleMetric;
      const maxVal = Math.max(Math.abs(isVal), Math.abs(oosVal), 1);
      const isWidth = Math.min(100, (Math.abs(isVal) / maxVal) * 100);
      const oosWidth = Math.min(100, (Math.abs(oosVal) / maxVal) * 100);
      return {
        label: period.label,
        isVal,
        oosVal,
        isWidth,
        oosWidth,
        status: period.status,
        oosTrades: period.oosTrades,
        oosDrawdown: period.oosDrawdown,
      };
    });
  }, [filteredPeriodSummaries]);

  const periodCount = results?.results.periods.length ?? 0;

  const handleExport = (format: "csv" | "json") => {
    if (!activeBlock) return;
    const payload = format === "csv" ? exportResultsAsCsv() : exportResultsAsJson();
    if (!payload) return;

    const filename = generateExportFilename(activeBlock.name, "walk-forward", format);

    if (format === "csv") {
      downloadCsv(payload.split("\n"), filename);
    } else {
      // payload is already a JSON string from exportResultsAsJson
      downloadFile(payload, filename, "application/json");
    }
  };

  if (!isInitialized || blockIsLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading blocks...
        </div>
      </div>
    );
  }

  if (!activeBlock) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Select a Block</CardTitle>
          <CardDescription>
            Choose a block from the sidebar to configure walk-forward optimization.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Once a block is active you can orchestrate rolling in-sample/out-of-sample testing and
          visualize robustness.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <WalkForwardPeriodSelector
        blockId={activeBlockId}
        addon={
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                How it works
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Walk-Forward Analysis Guide</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-6 text-sm text-muted-foreground pt-2">
                    {/* What is Walk-Forward Analysis */}
                    <div className="space-y-2">
                      <h4 className="font-semibold text-foreground">
                        What is Walk-Forward Analysis?
                      </h4>
                      <p>
                        Walk-forward analysis tests whether your optimized strategy settings work on
                        data they&apos;ve never seen. It repeatedly:
                      </p>
                      <ol className="list-decimal list-inside space-y-1 pl-2">
                        <li>Optimizes on a training window (in-sample)</li>
                        <li>
                          Tests those settings on the next chunk of unseen data (out-of-sample)
                        </li>
                        <li>Moves forward in time and repeats</li>
                      </ol>
                    </div>

                    {/* Key Terms */}
                    <div className="space-y-2">
                      <h4 className="font-semibold text-foreground">Key Terms</h4>
                      <dl className="space-y-2 pl-2">
                        <div>
                          <dt className="font-medium text-foreground inline">In-Sample (IS): </dt>
                          <dd className="inline">
                            The historical period used to find optimal parameters. Think of it as
                            the &quot;training data.&quot;
                          </dd>
                        </div>
                        <div>
                          <dt className="font-medium text-foreground inline">
                            Out-of-Sample (OOS):{" "}
                          </dt>
                          <dd className="inline">
                            The forward period used to test those parameters. Think of it as
                            &quot;final exam data&quot; the optimizer never saw.
                          </dd>
                        </div>
                        <div>
                          <dt className="font-medium text-foreground inline">Efficiency: </dt>
                          <dd className="inline">
                            How much of your in-sample performance survived out-of-sample testing.
                            80% efficiency = 80% of gains held up.
                          </dd>
                        </div>
                        <div>
                          <dt className="font-medium text-foreground inline">Robustness: </dt>
                          <dd className="inline">
                            Whether results hold up consistently across different time periods, not
                            just one lucky stretch.
                          </dd>
                        </div>
                      </dl>
                    </div>

                    {/* What Good Results Look Like */}
                    <div className="space-y-2">
                      <h4 className="font-semibold text-foreground">What Good Results Look Like</h4>
                      <ul className="list-disc list-inside space-y-1 pl-2">
                        <li>
                          <span className="font-medium">Efficiency above 70%:</span> Your optimized
                          settings transfer well to new data
                        </li>
                        <li>
                          <span className="font-medium">Consistency above 60%:</span> Most windows
                          were profitable out-of-sample
                        </li>
                        <li>
                          <span className="font-medium">Stable parameters:</span> The
                          &quot;best&quot; settings didn&apos;t swing wildly between windows
                        </li>
                      </ul>
                    </div>

                    {/* Warning Signs */}
                    <div className="space-y-2">
                      <h4 className="font-semibold text-foreground">Warning Signs</h4>
                      <ul className="list-disc list-inside space-y-1 pl-2">
                        <li>
                          <span className="font-medium">Efficiency below 50%:</span> Settings that
                          worked in training failed on new data
                        </li>
                        <li>
                          <span className="font-medium">Low consistency:</span> Performance varies
                          wildly between windows
                        </li>
                        <li>
                          <span className="font-medium">Unstable parameters:</span> Optimal settings
                          change dramatically each period
                        </li>
                      </ul>
                    </div>

                    {/* Tips */}
                    <div className="space-y-2 border-t pt-4">
                      <h4 className="font-semibold text-foreground">Tips for This Page</h4>
                      <ul className="list-disc list-inside space-y-1 pl-2">
                        <li>
                          Pick in-sample / out-of-sample windows that match your timeframe and data
                          depth
                        </li>
                        <li>
                          Select an optimization target (Sharpe, Net Profit, etc.) that matches your
                          risk goals
                        </li>
                        <li>
                          Set parameter ranges for sizing and risk controls to sweep combinations
                        </li>
                        <li>
                          Run to see how optimal parameters shift across regimes and how OOS
                          performance holds up
                        </li>
                      </ul>
                    </div>
                  </div>
                </DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
        }
      />

      <RunSwitcher
        history={history}
        currentId={results?.id ?? null}
        onSelect={selectAnalysis}
        onDelete={deleteAnalysis}
        onExport={() => handleExport("json")}
      />

      {/* Results section wrapped in error boundary - config stays accessible on error */}
      {results && (
        <WalkForwardErrorBoundary>
          {/* Summary - high-level overview shown first when results exist */}
          <WalkForwardSummary results={results.results} />

          {/* Tab-based organization for detailed results */}
          <Tabs defaultValue="analysis" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="analysis" className="flex items-center gap-2">
                <Lightbulb className="h-4 w-4" />
                <span className="hidden sm:inline">Analysis</span>
              </TabsTrigger>
              <TabsTrigger value="details" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                <span className="hidden sm:inline">Detailed Metrics</span>
              </TabsTrigger>
              <TabsTrigger value="charts" className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                <span className="hidden sm:inline">Charts</span>
              </TabsTrigger>
              <TabsTrigger value="windows" className="flex items-center gap-2">
                <TableIcon className="h-4 w-4" />
                <span className="hidden sm:inline">Window Data</span>
              </TabsTrigger>
            </TabsList>

            {/* Analysis Tab */}
            <TabsContent value="analysis" className="mt-4">
              <WalkForwardAnalysis analysis={results} />
            </TabsContent>

            {/* Charts Tab */}
            <TabsContent value="charts" className="mt-4 space-y-4">
              <WalkForwardAnalysisChart
                periods={results.results.periods}
                targetMetricLabel={targetMetricLabel}
              />
            </TabsContent>

            {/* Window Data Tab */}
            <TabsContent value="windows" className="mt-4">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle>Window Table</CardTitle>
                      <CardDescription>
                        Scan retention, drawdowns, and samples quickly. Use filters to surface weak
                        slices.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={!results}
                        onClick={() => handleExport("csv")}
                        size="sm"
                      >
                        <Download className="mr-2 h-4 w-4" />
                        CSV
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!results}
                        onClick={() => handleExport("json")}
                        size="sm"
                      >
                        <Download className="mr-2 h-4 w-4" />
                        JSON
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 pt-2 text-sm">
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={showFailingOnly}
                        onCheckedChange={(v) => setShowFailingOnly(Boolean(v))}
                      />
                      <span className="text-muted-foreground">
                        Only failing windows (&lt;60% retention)
                      </span>
                    </label>
                    {skippedSummaries.length > 0 && (
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={showSkippedWindows}
                          onCheckedChange={(v) => setShowSkippedWindows(Boolean(v))}
                        />
                        <span className="text-muted-foreground">
                          Show skipped windows ({skippedSummaries.length})
                        </span>
                      </label>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">Min OOS trades</span>
                      <div className="w-32">
                        <Slider
                          min={0}
                          max={Math.max(...periodSummaries.map((p) => p.oosTrades ?? 0), 20)}
                          step={1}
                          value={[minOosTrades]}
                          onValueChange={(v) => setMinOosTrades(v[0] ?? 0)}
                        />
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {minOosTrades}
                      </Badge>
                    </div>
                    {periodCount > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">Window range</span>
                        <div className="w-44">
                          <Slider
                            min={1}
                            max={periodCount}
                            step={1}
                            value={[periodRange[0], periodRange[1]]}
                            onValueChange={(v) => {
                              if (!v || v.length < 2) return;
                              const [a, b] = v as [number, number];
                              setPeriodRange([Math.min(a, b), Math.max(a, b)]);
                            }}
                          />
                        </div>
                        <Badge variant="secondary" className="text-xs">
                          {periodRange[0]}–{periodRange[1]} / {periodCount}
                        </Badge>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {timelineEntries.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      {periodSummaries.length === 0
                        ? "Run the analysis to populate this table."
                        : "No windows match the current filters."}
                    </div>
                  ) : (
                    <div className="overflow-x-auto" style={{ maxHeight: 560 }}>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Window</TableHead>
                            <TableHead>IS Range</TableHead>
                            <TableHead>OOS Range</TableHead>
                            <TableHead className="text-right">OOS Retention</TableHead>
                            <TableHead className="text-right">Delta</TableHead>
                            <TableHead className="text-right">OOS Trades</TableHead>
                            <TableHead className="text-right">Max DD</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {timelineEntries.map((entry) => {
                            if (entry.kind === "skipped") {
                              const isTradeIssue =
                                entry.reason === "insufficient_is_trades" ||
                                entry.reason === "insufficient_oos_trades";
                              const reasonLabel = isTradeIssue
                                ? "Not enough trades"
                                : "No viable params";
                              const explanation = isTradeIssue
                                ? "This window didn\u2019t have enough trades to produce reliable statistics. Try lowering the minimum trade requirement or using wider windows."
                                : "Every parameter combination was rejected by risk checks, performance floors, or produced undefined metrics (e.g. zero drawdown \u2192 undefined Calmar). Try relaxing constraints or widening parameter ranges.";
                              return (
                                <TableRow
                                  key={entry.label}
                                  className="bg-amber-50/50 dark:bg-amber-950/10"
                                >
                                  <TableCell className="font-medium border-l-2 border-l-amber-400/60">
                                    <span className="text-amber-700 dark:text-amber-400 text-sm font-medium">
                                      Skipped
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {entry.inSampleRange}
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {entry.outSampleRange}
                                  </TableCell>
                                  <TableCell colSpan={4} className="text-sm">
                                    <HoverCard>
                                      <HoverCardTrigger asChild>
                                        <span className="inline-flex items-center gap-1.5 cursor-help text-amber-700 dark:text-amber-400">
                                          <AlertTriangle className="h-3.5 w-3.5" />
                                          {reasonLabel}
                                          <span className="text-muted-foreground font-normal">
                                            — {entry.detail}
                                          </span>
                                        </span>
                                      </HoverCardTrigger>
                                      <HoverCardContent className="w-80">
                                        <div className="space-y-2">
                                          <p className="text-sm font-medium">{reasonLabel}</p>
                                          <p className="text-xs text-muted-foreground leading-relaxed">
                                            {explanation}
                                          </p>
                                        </div>
                                      </HoverCardContent>
                                    </HoverCard>
                                  </TableCell>
                                  <TableCell />
                                </TableRow>
                              );
                            }

                            const period = entry;
                            const delta = period.outSampleMetric - period.inSampleMetric;
                            const deltaClass = delta >= 0 ? "text-emerald-600" : "text-rose-600";
                            const StatusIcon = period.status.icon;
                            const isOpen = Boolean(openDetails[period.label]);

                            return (
                              <React.Fragment key={period.label}>
                                <TableRow>
                                  <TableCell className="font-medium">
                                    <button
                                      className="inline-flex items-center gap-2 text-left font-semibold"
                                      onClick={() =>
                                        setOpenDetails((prev) => ({
                                          ...prev,
                                          [period.label]: !prev[period.label],
                                        }))
                                      }
                                    >
                                      {isOpen ? (
                                        <ChevronDown className="h-4 w-4" />
                                      ) : (
                                        <ChevronRight className="h-4 w-4" />
                                      )}
                                      {period.label}
                                    </button>
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {period.inSampleRange}
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {period.outSampleRange}
                                  </TableCell>
                                  <TableCell className="text-right font-semibold">
                                    {period.efficiencyPct.toFixed(1)}%
                                  </TableCell>
                                  <TableCell className={cn("text-right", deltaClass)}>
                                    {delta >= 0 ? "+" : ""}
                                    {formatMetricValue(delta)}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {period.oosTrades ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {period.oosDrawdown != null
                                      ? `${Math.abs(period.oosDrawdown).toFixed(2)}%`
                                      : "—"}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs",
                                        period.status.chipClass,
                                      )}
                                    >
                                      <StatusIcon className="h-3 w-3" />
                                      {period.status.label}
                                    </span>
                                  </TableCell>
                                </TableRow>
                                {isOpen && (
                                  <TableRow>
                                    <TableCell colSpan={9} className="bg-muted/30">
                                      <div className="p-4 space-y-4">
                                        {/* Performance Summary Row */}
                                        <div className="flex flex-wrap items-center gap-6">
                                          <span
                                            className={cn(
                                              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs",
                                              period.status.chipClass,
                                            )}
                                          >
                                            <period.status.icon className="h-3 w-3" />
                                            {period.status.label}
                                          </span>
                                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <span className="h-2 w-2 rounded-full bg-blue-500" />
                                            <span>IS</span>
                                            <span className="font-semibold text-foreground">
                                              {formatMetricValue(period.inSampleMetric)}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <span className="h-2 w-2 rounded-full bg-orange-500" />
                                            <span>OOS</span>
                                            <span className="font-semibold text-foreground">
                                              {formatMetricValue(period.outSampleMetric)}
                                            </span>
                                          </div>
                                          <div className="flex-1 min-w-[200px] max-w-[400px] space-y-1">
                                            <div
                                              className="h-2 rounded-full bg-blue-500/15"
                                              title="IS P&L scaled within this window"
                                            >
                                              <div
                                                className="h-2 rounded-full bg-blue-500"
                                                style={{
                                                  width: `${miniBars.find((m) => m.label === period.label)?.isWidth ?? 0}%`,
                                                }}
                                              />
                                            </div>
                                            <div
                                              className="h-2 rounded-full bg-orange-500/15"
                                              title="OOS P&L scaled within this window"
                                            >
                                              <div
                                                className="h-2 rounded-full bg-orange-500"
                                                style={{
                                                  width: `${miniBars.find((m) => m.label === period.label)?.oosWidth ?? 0}%`,
                                                }}
                                              />
                                            </div>
                                          </div>
                                        </div>

                                        {/* Winning Parameters - Full Width */}
                                        {period.parameters.length > 0 && (
                                          <div className="space-y-2">
                                            <p className="text-xs font-semibold text-muted-foreground">
                                              Winning Parameters
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                              {period.parameters.map((item) => (
                                                <div
                                                  key={`${period.label}-${item}`}
                                                  className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs"
                                                >
                                                  <span className="text-muted-foreground">
                                                    {item.split(":")[0]}:
                                                  </span>
                                                  <span className="font-semibold text-foreground">
                                                    {item.split(":").slice(1).join(":").trim()}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}

                                        {/* Strategy Weights */}
                                        {period.strategyWeights.length > 0 && (
                                          <div className="space-y-2">
                                            <p className="text-xs font-semibold text-muted-foreground">
                                              Strategy Weights
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                              {period.strategyWeights.map(
                                                ({ strategy, weight }) => (
                                                  <div
                                                    key={`${period.label}-strategy-${strategy}`}
                                                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 dark:bg-blue-950/30 px-2.5 py-1 text-xs"
                                                  >
                                                    <span
                                                      className="text-muted-foreground truncate max-w-[150px]"
                                                      title={strategy}
                                                    >
                                                      {strategy}:
                                                    </span>
                                                    <span className="font-semibold text-foreground">
                                                      {weight.toFixed(2)}x
                                                    </span>
                                                  </div>
                                                ),
                                              )}
                                            </div>
                                          </div>
                                        )}

                                        {/* Diversification Metrics */}
                                        {period.diversificationMetrics && (
                                          <div className="space-y-2">
                                            <p className="text-xs font-semibold text-muted-foreground">
                                              Diversification
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                              <div className="inline-flex items-center gap-1.5 rounded-md bg-violet-50 dark:bg-violet-950/30 px-2.5 py-1 text-xs">
                                                <span className="text-muted-foreground">
                                                  Correlation:
                                                </span>
                                                <span className="font-semibold text-foreground">
                                                  {period.diversificationMetrics.avgCorrelation.toFixed(
                                                    3,
                                                  )}
                                                </span>
                                              </div>
                                              <div className="inline-flex items-center gap-1.5 rounded-md bg-violet-50 dark:bg-violet-950/30 px-2.5 py-1 text-xs">
                                                <span className="text-muted-foreground">
                                                  Tail Risk:
                                                </span>
                                                <span className="font-semibold text-foreground">
                                                  {period.diversificationMetrics.avgTailDependence.toFixed(
                                                    3,
                                                  )}
                                                </span>
                                              </div>
                                              <div className="inline-flex items-center gap-1.5 rounded-md bg-violet-50 dark:bg-violet-950/30 px-2.5 py-1 text-xs">
                                                <span className="text-muted-foreground">
                                                  Eff Factors:
                                                </span>
                                                <span className="font-semibold text-foreground">
                                                  {period.diversificationMetrics.effectiveFactors.toFixed(
                                                    2,
                                                  )}
                                                </span>
                                              </div>
                                              <div className="inline-flex items-center gap-1.5 rounded-md bg-violet-50 dark:bg-violet-950/30 px-2.5 py-1 text-xs">
                                                <span className="text-muted-foreground">
                                                  High-Risk Pairs:
                                                </span>
                                                <span className="font-semibold text-foreground">
                                                  {(
                                                    period.diversificationMetrics.highRiskPairsPct *
                                                    100
                                                  ).toFixed(1)}
                                                  %
                                                </span>
                                              </div>
                                            </div>
                                          </div>
                                        )}

                                        {/* Footer Note */}
                                        <div className="text-[11px] text-muted-foreground/70 pt-1 border-t border-border/30">
                                          Bar length shows relative |P&L| within this window. Only
                                          the winning combo per window is stored.
                                        </div>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Detailed Metrics Tab */}
            <TabsContent value="details" className="mt-4 space-y-4">
              {/* Robustness Metrics - most important, first */}
              <RobustnessMetrics results={results.results} targetMetricLabel={targetMetricLabel} />

              {/* Parameter Observations - actionable info */}
              {(() => {
                const { params, hasSuggestions } = getRecommendedParameters(
                  results.results.periods,
                );
                if (!hasSuggestions) return null;
                return (
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-sm font-medium">
                          Parameter Observations
                        </CardTitle>
                        <HoverCard>
                          <HoverCardTrigger asChild>
                            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </HoverCardTrigger>
                          <HoverCardContent className="w-80">
                            <p className="text-sm">
                              These values represent the average optimal parameters found across all
                              walk-forward windows.
                              <strong className="block mt-2">Note:</strong> These are observations,
                              not recommendations. Market conditions change, and past optimal
                              parameters may not be ideal going forward.
                            </p>
                          </HoverCardContent>
                        </HoverCard>
                      </div>
                      <CardDescription className="text-xs">
                        Average values across {results.results.periods.length} optimization windows
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {Object.entries(params).map(([key, data]) => (
                          <div key={key} className="rounded-lg border bg-muted/30 p-3 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-muted-foreground">
                                {formatParameterName(key)}
                              </span>
                              {data.stable && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] h-4 px-1.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                >
                                  Stable
                                </Badge>
                              )}
                            </div>
                            <div className="text-lg font-semibold">{data.value}</div>
                            <div className="text-xs text-muted-foreground">
                              Range: {data.range[0]} – {data.range[1]}
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-4 pt-3 border-t">
                        Parameters marked as &quot;stable&quot; showed less than 30% variation
                        across windows.
                      </p>
                    </CardContent>
                  </Card>
                );
              })()}

              {/* Run Configuration - reference info, last */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Run Configuration</CardTitle>
                  <CardDescription className="text-xs">
                    Settings used for this walk-forward analysis
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {results.config.inSampleDays}d IS / {results.config.outOfSampleDays}d OOS
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      Target: {targetMetricLabel}
                    </Badge>
                    {results.config.normalizeTo1Lot && (
                      <Badge variant="outline" className="text-xs bg-amber-50 dark:bg-amber-950/30">
                        1-Lot Normalized
                      </Badge>
                    )}
                    {results.config.selectedStrategies &&
                      results.config.selectedStrategies.length > 0 && (
                        <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/30">
                          {results.config.selectedStrategies.length} Strategies Selected
                        </Badge>
                      )}
                    {results.config.diversificationConfig?.enableCorrelationConstraint && (
                      <Badge
                        variant="outline"
                        className="text-xs bg-violet-50 dark:bg-violet-950/30"
                      >
                        Correlation ≤{" "}
                        {results.config.diversificationConfig.maxCorrelationThreshold.toFixed(2)}
                      </Badge>
                    )}
                    {results.config.diversificationConfig?.enableTailRiskConstraint && (
                      <Badge
                        variant="outline"
                        className="text-xs bg-violet-50 dark:bg-violet-950/30"
                      >
                        Tail Risk ≤{" "}
                        {results.config.diversificationConfig.maxTailDependenceThreshold.toFixed(2)}
                      </Badge>
                    )}
                    {results.config.strategyWeightSweep &&
                      results.config.strategyWeightSweep.configs.some((c) => c.enabled) && (
                        <Badge
                          variant="outline"
                          className="text-xs bg-green-50 dark:bg-green-950/30"
                        >
                          Strategy Weight Sweep ({results.config.strategyWeightSweep.mode})
                        </Badge>
                      )}
                    {results.config.performanceFloor?.enableMinSharpe && (
                      <Badge
                        variant="outline"
                        className="text-xs bg-orange-50 dark:bg-orange-950/30"
                      >
                        Min Sharpe: {results.config.performanceFloor.minSharpeRatio.toFixed(2)}
                      </Badge>
                    )}
                    {results.config.performanceFloor?.enableMinProfitFactor && (
                      <Badge
                        variant="outline"
                        className="text-xs bg-orange-50 dark:bg-orange-950/30"
                      >
                        Min PF: {results.config.performanceFloor.minProfitFactor.toFixed(2)}
                      </Badge>
                    )}
                    {results.config.performanceFloor?.enablePositiveNetPl && (
                      <Badge
                        variant="outline"
                        className="text-xs bg-orange-50 dark:bg-orange-950/30"
                      >
                        Positive P/L Required
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </WalkForwardErrorBoundary>
      )}
    </div>
  );
}
