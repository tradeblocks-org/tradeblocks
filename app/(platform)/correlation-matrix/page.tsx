"use client";

import { NoActiveBlock } from "@/components/no-active-block";
import { ChartWrapper } from "@/components/performance-charts/chart-wrapper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  calculateCorrelationAnalytics,
  calculateCorrelationMatrix,
  getBlock,
  getTradesByBlockWithOptions,
  truncateStrategyName,
  downloadCsv,
  downloadJson,
  generateExportFilename,
  toCsvRow,
} from "@tradeblocks/lib";
import type {
  CorrelationAlignment,
  CorrelationDateBasis,
  CorrelationMethod,
  CorrelationMatrix,
  CorrelationNormalization,
  CorrelationTimePeriod,
  Trade,
} from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { AlertTriangle, Download, HelpCircle, Info } from "lucide-react";
import { useTheme } from "next-themes";
import type { Data, Layout } from "plotly.js";
import { useCallback, useEffect, useMemo, useState } from "react";

export default function CorrelationMatrixPage() {
  const { theme } = useTheme();
  const activeBlockId = useBlockStore((state) => state.blocks.find((b) => b.isActive)?.id);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<CorrelationMethod>("kendall");
  const [alignment, setAlignment] = useState<CorrelationAlignment>("shared");
  const [normalization, setNormalization] = useState<CorrelationNormalization>("raw");
  const [dateBasis, setDateBasis] = useState<CorrelationDateBasis>("opened");
  const [timePeriod, setTimePeriod] = useState<CorrelationTimePeriod>("daily");

  const DEFAULT_MIN_SAMPLES: Record<CorrelationTimePeriod, number> = {
    daily: 2,
    weekly: 5,
    monthly: 3,
  };

  const [minSamples, setMinSamples] = useState<number>(DEFAULT_MIN_SAMPLES.daily);
  const [minSamplesInput, setMinSamplesInput] = useState<string>(String(DEFAULT_MIN_SAMPLES.daily));

  const handleTimePeriodChange = (period: CorrelationTimePeriod) => {
    setTimePeriod(period);
    const defaultVal = DEFAULT_MIN_SAMPLES[period];
    setMinSamples(defaultVal);
    setMinSamplesInput(String(defaultVal));
  };

  const handleMinSamplesBlur = () => {
    const val = parseInt(minSamplesInput, 10);
    if (!isNaN(val) && val >= 1 && val <= 100) {
      setMinSamples(val);
      setMinSamplesInput(String(val));
    } else {
      setMinSamplesInput(String(minSamples));
    }
  };

  const analyticsContext = useMemo(
    () =>
      formatAnalyticsContext({
        method,
        alignment,
        normalization,
        dateBasis,
        timePeriod,
        minSamples,
      }),
    [method, alignment, normalization, dateBasis, timePeriod, minSamples],
  );

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
      } catch (error) {
        console.error("Failed to load trades:", error);
      } finally {
        setLoading(false);
      }
    }

    loadTrades();
  }, [activeBlockId]);

  const { correlationMatrix, analytics } = useMemo(() => {
    if (trades.length === 0) {
      return { correlationMatrix: null, analytics: null };
    }

    const matrix = calculateCorrelationMatrix(trades, {
      method,
      alignment,
      normalization,
      dateBasis,
      timePeriod,
    });
    const stats = calculateCorrelationAnalytics(matrix, minSamples);

    return { correlationMatrix: matrix, analytics: stats };
  }, [trades, method, alignment, normalization, dateBasis, timePeriod, minSamples]);

  const { plotData, layout } = useMemo(() => {
    if (!correlationMatrix) {
      return { plotData: [], layout: {} };
    }

    const { strategies, correlationData, sampleSizes } = correlationMatrix;
    const isDark = theme === "dark";

    // Truncate strategy names for axis labels
    const truncatedStrategies = strategies.map((s) => truncateStrategyName(s, 40));

    // Create heatmap with better contrast
    // Different colorscales for light and dark modes
    const colorscale = isDark
      ? [
          // Dark mode: Brighter, more vibrant colors
          [0, "#1e40af"], // Bright blue for -1
          [0.25, "#3b82f6"], // Medium bright blue for -0.5
          [0.45, "#93c5fd"], // Light blue approaching 0
          [0.5, "#334155"], // Neutral gray for 0
          [0.55, "#fca5a5"], // Light red leaving 0
          [0.75, "#ef4444"], // Medium bright red for 0.5
          [1, "#991b1b"], // Strong red for 1
        ]
      : [
          // Light mode: Darker, more saturated colors
          [0, "#053061"], // Strong dark blue for -1
          [0.25, "#2166ac"], // Medium blue for -0.5
          [0.45, "#d1e5f0"], // Light blue approaching 0
          [0.5, "#f7f7f7"], // White/light gray for 0
          [0.55, "#fddbc7"], // Light red leaving 0
          [0.75, "#d6604d"], // Medium red for 0.5
          [1, "#67001f"], // Strong dark red for 1
        ];

    // Mark cells with insufficient samples as null for display
    const displayMatrix = correlationData.map((row, i) =>
      row.map((val, j) => {
        if (i === j) return 1.0; // Diagonal always valid
        const n = sampleSizes[i][j];
        if (Number.isNaN(val) || n < minSamples) return null;
        return val;
      }),
    );

    // Text labels: show "—" for insufficient data
    const textLabels = correlationData.map((row, i) =>
      row.map((val, j) => {
        if (i === j) return "1.00";
        const n = sampleSizes[i][j];
        if (Number.isNaN(val) || n < minSamples) return "—";
        return val.toFixed(2);
      }),
    );

    // Text colors: gray for insufficient data cells
    const textColors = correlationData.map((row, i) =>
      row.map((val, j) => {
        const n = sampleSizes[i][j];
        if (Number.isNaN(val) || n < minSamples) {
          return isDark ? "#6b7280" : "#9ca3af"; // Gray
        }
        const absVal = Math.abs(val);
        if (isDark) {
          return absVal > 0.5 ? "#ffffff" : "#e2e8f0";
        } else {
          return absVal > 0.5 ? "#ffffff" : "#000000";
        }
      }),
    );

    // Custom data for hover tooltips
    const customdata = correlationData.map((row, yIndex) =>
      row.map((val, xIndex) => {
        const n = sampleSizes[yIndex][xIndex];
        const isInsufficient = Number.isNaN(val) || n < minSamples;
        return [strategies[yIndex], strategies[xIndex], n, isInsufficient];
      }),
    );

    // Build per-cell hover templates
    const hovertext = correlationData.map((row, i) =>
      row.map((val, j) => {
        const n = sampleSizes[i][j];
        const strat1 = strategies[i];
        const strat2 = strategies[j];
        if (i === j) {
          return `<b>${strat1}</b><br>n=${n} trading days`;
        }
        if (Number.isNaN(val) || n < minSamples) {
          return `<b>${strat1} ↔ ${strat2}</b><br>Insufficient data (n=${n}, requires ${minSamples})`;
        }
        return `<b>${strat1} ↔ ${strat2}</b><br>Correlation: ${val.toFixed(3)}<br>Sample size: n=${n}`;
      }),
    );

    const heatmapData = {
      z: displayMatrix,
      x: truncatedStrategies,
      y: truncatedStrategies,
      type: "heatmap" as const,
      colorscale,
      zmid: 0,
      zmin: -1,
      zmax: 1,
      text: textLabels as unknown as string,
      texttemplate: "%{text}",
      textfont: {
        size: 10,
        color: textColors as unknown as string,
      },
      hovertext: hovertext as unknown as string,
      hovertemplate: "%{hovertext}<extra></extra>",
      customdata,
      colorbar: {
        title: { text: "Correlation", side: "right" },
        tickmode: "linear",
        tick0: -1,
        dtick: 0.5,
      },
    };

    const heatmapLayout: Partial<Layout> = {
      xaxis: {
        side: "bottom",
        tickangle: -45,
        tickmode: "linear",
        automargin: true,
      },
      yaxis: {
        autorange: "reversed",
        tickmode: "linear",
        automargin: true,
      },
      margin: {
        l: 200,
        r: 100,
        t: 40,
        b: 200,
      },
    };

    return { plotData: [heatmapData as unknown as Data], layout: heatmapLayout };
  }, [correlationMatrix, theme, minSamples]);

  const isDark = theme === "dark";

  const activeBlock = useBlockStore((state) =>
    state.blocks.find((block) => block.id === activeBlockId),
  );

  const handleDownloadCsv = useCallback(() => {
    if (!correlationMatrix || !activeBlock) {
      return;
    }

    const lines = buildCorrelationCsvLines(correlationMatrix, {
      blockName: activeBlock.name,
      method,
      alignment,
      normalization,
      dateBasis,
      timePeriod,
      minSamples,
    });

    downloadCsv(lines, generateExportFilename(activeBlock.name, "correlation", "csv"));
  }, [
    correlationMatrix,
    method,
    alignment,
    normalization,
    dateBasis,
    timePeriod,
    minSamples,
    activeBlock,
  ]);

  const handleDownloadJson = useCallback(() => {
    if (!correlationMatrix || !activeBlock) {
      return;
    }

    const exportData = {
      exportedAt: new Date().toISOString(),
      block: {
        id: activeBlock.id,
        name: activeBlock.name,
      },
      settings: {
        method,
        alignment,
        normalization,
        dateBasis,
        timePeriod,
        minSamples,
      },
      strategies: correlationMatrix.strategies,
      correlationMatrix: correlationMatrix.correlationData,
      sampleSizes: correlationMatrix.sampleSizes,
      analytics: analytics
        ? {
            strongest: analytics.strongest,
            weakest: analytics.weakest,
            averageCorrelation: analytics.averageCorrelation,
            strategyCount: analytics.strategyCount,
            insufficientDataPairs: analytics.insufficientDataPairs,
          }
        : null,
    };

    downloadJson(exportData, generateExportFilename(activeBlock.name, "correlation", "json"));
  }, [
    correlationMatrix,
    analytics,
    method,
    alignment,
    normalization,
    dateBasis,
    timePeriod,
    minSamples,
    activeBlock,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">Loading correlation data...</div>
      </div>
    );
  }

  if (!activeBlockId) {
    return (
      <NoActiveBlock description="Please select a block from the sidebar to view strategy correlations." />
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">No trades available for correlation analysis</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <Card className="border-l-4 border-l-blue-500 dark:border-l-blue-400">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Info className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold">What does this show?</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This heatmap shows how your trading strategies move together. High positive
                correlation (+1.0) means strategies move in the same direction, while negative
                correlation (-1.0) means they move opposite. Low correlation (~0) indicates good
                diversification.
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-medium">
                    PEARSON
                  </Badge>
                  <span className="text-muted-foreground">Linear relationships</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-orange-500 bg-orange-500/10 text-orange-700 dark:text-orange-400 font-medium"
                  >
                    KENDALL/SPEARMAN
                  </Badge>
                  <span className="text-muted-foreground">
                    Rank-based (handles outliers better)
                  </span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Calculation Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {/* Method */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="method-select">Method</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Correlation Method</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Choose how to measure strategy relationships
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Kendall (recommended):</strong> Rank-based, robust to outliers.
                          Best for options strategies with non-linear payoffs.
                          <br />
                          <strong>Spearman:</strong> Another rank-based method, similar to Kendall
                          but faster for large datasets.
                          <br />
                          <strong>Pearson:</strong> Measures linear relationships. Best for normally
                          distributed returns.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={method}
                onValueChange={(value) => setMethod(value as "pearson" | "spearman" | "kendall")}
              >
                <SelectTrigger id="method-select">
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kendall">Kendall (Rank)</SelectItem>
                  <SelectItem value="spearman">Spearman (Rank)</SelectItem>
                  <SelectItem value="pearson">Pearson (Linear)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {method === "pearson" && "Linear correlation"}
                {method === "kendall" && "Rank-based, outlier-resistant"}
                {method === "spearman" && "Rank-based, fast"}
              </p>
            </div>

            {/* Alignment */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="alignment-select">Alignment</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Date Alignment</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          How to handle days when strategies don&apos;t trade
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Shared days (recommended):</strong> Only correlates on days where
                          both strategies traded. Avoids artificial zeros.
                          <br />
                          <strong>Zero-fill:</strong> Treats non-trading days as $0 P/L. Can distort
                          correlation for strategies that trade different frequencies.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={alignment}
                onValueChange={(value) => setAlignment(value as CorrelationAlignment)}
              >
                <SelectTrigger id="alignment-select">
                  <SelectValue placeholder="Alignment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">Shared days</SelectItem>
                  <SelectItem value="zero-pad">Zero-fill</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {alignment === "shared" && "Only common trading periods"}
                {alignment === "zero-pad" && "Fill missing periods with $0"}
              </p>
            </div>

            {/* Time Period */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="time-period-select">Time Period</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Time Period Aggregation
                        </h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          How to aggregate P&L before calculating correlations
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Daily:</strong> Correlate daily P&L (default).
                          <br />
                          <strong>Weekly:</strong> Sum P&L by ISO week, then correlate. Useful for
                          strategies that trade on different days but may compensate each other
                          weekly.
                          <br />
                          <strong>Monthly:</strong> Sum P&L by month. Shows longer-term correlation
                          patterns.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={timePeriod}
                onValueChange={(value) => handleTimePeriodChange(value as CorrelationTimePeriod)}
              >
                <SelectTrigger id="time-period-select">
                  <SelectValue placeholder="Time period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {timePeriod === "daily" && "Correlate daily P&L"}
                {timePeriod === "weekly" && "Sum by week, then correlate"}
                {timePeriod === "monthly" && "Sum by month, then correlate"}
              </p>
            </div>

            {/* Return basis */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="return-basis-select">Return Basis</Label>
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
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          How to scale returns for comparison
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Raw P/L:</strong> Absolute dollar returns (default).
                          <br />
                          <strong>Margin-normalized:</strong> Returns divided by margin requirement.
                          Better for comparing strategies with different capital requirements.
                          <br />
                          <strong>1-lot normalized:</strong> Per-contract basis. Divides P/L by
                          trade size (price × contracts) to show returns as if each trade was 1 lot.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={normalization}
                onValueChange={(value) => setNormalization(value as CorrelationNormalization)}
              >
                <SelectTrigger id="return-basis-select">
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

            {/* Date basis */}
            <div className="space-y-2">
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
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Which date to use for grouping trades
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          <strong>Opened date (recommended):</strong> Groups by when trades were
                          entered. Shows entry timing correlation.
                          <br />
                          <strong>Closed date:</strong> Groups by when trades were closed. Shows
                          exit timing and P/L realization correlation.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Select
                value={dateBasis}
                onValueChange={(value) => setDateBasis(value as CorrelationDateBasis)}
              >
                <SelectTrigger id="date-basis-select">
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

            {/* Min. Samples */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="min-samples-input">Min. Samples</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Minimum Sample Size</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Minimum shared periods required for valid correlation
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Correlations calculated with fewer shared periods than this threshold are
                          shown as &ldquo;—&rdquo; to indicate insufficient data. Higher thresholds
                          give more reliable correlations but may exclude more strategy pairs.
                          Default adjusts based on time period.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                id="min-samples-input"
                type="number"
                min={1}
                max={100}
                value={minSamplesInput}
                onChange={(e) => setMinSamplesInput(e.target.value)}
                onBlur={handleMinSamplesBlur}
                onKeyDown={(e) => e.key === "Enter" && handleMinSamplesBlur()}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Pairs with fewer shared periods show &ldquo;—&rdquo;
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Heatmap */}
      <ChartWrapper
        title="Correlation Heatmap"
        description="Visual representation of strategy correlations"
        tooltip={{
          flavor: "Measures how your trading strategies move together over time.",
          detailed:
            "Red colors indicate positive correlation (strategies tend to win/lose together), blue indicates negative correlation (strategies move opposite), and white indicates no correlation. Use this to identify diversification opportunities and understand portfolio risk.",
        }}
        data={plotData}
        layout={layout}
        style={{ height: "600px" }}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadCsv}
              disabled={!correlationMatrix}
            >
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadJson}
              disabled={!correlationMatrix}
            >
              <Download className="mr-2 h-4 w-4" />
              JSON
            </Button>
          </div>
        }
      />

      {/* Insufficient Data Warning */}
      {analytics && analytics.insufficientDataPairs > 0 && (
        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {analytics.insufficientDataPairs} Strategy Pair
                  {analytics.insufficientDataPairs > 1 ? "s Have" : " Has"} Insufficient Data
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  These pairs have fewer than {minSamples} shared trading days and are shown as
                  &ldquo;—&rdquo; in the heatmap. Lower the Min. Samples threshold to include them,
                  or use Zero-fill alignment.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Analysis */}
      {analytics && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Quick Analysis</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground">Strongest:</div>
                {Number.isNaN(analytics.strongest.value) ? (
                  <div className="text-2xl font-bold text-muted-foreground">—</div>
                ) : (
                  <>
                    <div
                      className="text-2xl font-bold"
                      style={{ color: isDark ? "#fca5a5" : "#dc2626" }}
                    >
                      {analytics.strongest.value.toFixed(2)}
                      <span className="text-sm font-normal text-muted-foreground ml-2">
                        (n={analytics.strongest.sampleSize})
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {analytics.strongest.pair[0]} ↔ {analytics.strongest.pair[1]}
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground">Weakest:</div>
                {Number.isNaN(analytics.weakest.value) ? (
                  <div className="text-2xl font-bold text-muted-foreground">—</div>
                ) : (
                  <>
                    <div
                      className="text-2xl font-bold"
                      style={{ color: isDark ? "#93c5fd" : "#2563eb" }}
                    >
                      {analytics.weakest.value.toFixed(2)}
                      <span className="text-sm font-normal text-muted-foreground ml-2">
                        (n={analytics.weakest.sampleSize})
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {analytics.weakest.pair[0]} ↔ {analytics.weakest.pair[1]}
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
                  <span>Average</span>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 cursor-help text-muted-foreground/70" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-0 overflow-hidden">
                      <div className="space-y-3">
                        <div className="bg-primary/5 border-b px-4 py-3">
                          <h4 className="text-sm font-semibold text-primary">
                            Average Correlation
                          </h4>
                        </div>
                        <div className="px-4 pb-4 space-y-3">
                          <p className="text-sm font-medium text-foreground leading-relaxed">
                            Signed mean of all off-diagonal correlations
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Positive values indicate strategies tend to move together on average.
                            Negative values suggest strategies tend to offset each other. Values
                            near zero indicate diverse, uncorrelated strategies.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
                <div className="text-2xl font-bold">
                  {Number.isNaN(analytics.averageCorrelation)
                    ? "—"
                    : analytics.averageCorrelation.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {analytics.strategyCount} strategies · {analyticsContext}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface CsvMeta {
  blockName: string;
  method: string;
  alignment: string;
  normalization: string;
  dateBasis: string;
  timePeriod: string;
  minSamples: number;
}

function buildCorrelationCsvLines(matrix: CorrelationMatrix, meta: CsvMeta): string[] {
  const lines: string[] = [];

  lines.push(toCsvRow(["Generated At", new Date().toISOString()]));
  lines.push(toCsvRow(["Block", meta.blockName]));
  lines.push(toCsvRow(["Method", meta.method]));
  lines.push(toCsvRow(["Alignment", meta.alignment]));
  lines.push(toCsvRow(["Return Basis", meta.normalization]));
  lines.push(toCsvRow(["Date Basis", meta.dateBasis]));
  lines.push(toCsvRow(["Time Period", meta.timePeriod]));
  lines.push(toCsvRow(["Min. Samples Threshold", meta.minSamples]));
  lines.push(toCsvRow(["Strategy Count", matrix.strategies.length]));

  lines.push("");
  lines.push(toCsvRow(["=== CORRELATION MATRIX ==="]));

  lines.push(toCsvRow(["Strategy", ...matrix.strategies]));
  matrix.correlationData.forEach((row, index) => {
    lines.push(
      toCsvRow([
        matrix.strategies[index],
        ...row.map((value) => (Number.isNaN(value) ? "N/A" : value.toFixed(6))),
      ]),
    );
  });

  lines.push("");
  const periodLabel =
    meta.timePeriod === "daily" ? "Days" : meta.timePeriod === "weekly" ? "Weeks" : "Months";
  lines.push(toCsvRow([`=== SAMPLE SIZES (Shared ${periodLabel}) ===`]));

  lines.push(toCsvRow(["Strategy", ...matrix.strategies]));
  matrix.sampleSizes.forEach((row, index) => {
    lines.push(toCsvRow([matrix.strategies[index], ...row.map((value) => String(value))]));
  });

  return lines;
}

interface AnalyticsContextArgs {
  method: CorrelationMethod;
  alignment: CorrelationAlignment;
  normalization: CorrelationNormalization;
  dateBasis: CorrelationDateBasis;
  timePeriod: CorrelationTimePeriod;
  minSamples: number;
}

function formatAnalyticsContext({
  method,
  alignment,
  normalization,
  dateBasis,
  timePeriod,
  minSamples,
}: AnalyticsContextArgs): string {
  const methodLabel =
    method === "pearson" ? "Pearson" : method === "spearman" ? "Spearman" : "Kendall";

  const alignmentLabel = alignment === "shared" ? "Shared periods" : "Zero-filled";

  const normalizationLabel =
    normalization === "raw"
      ? "Raw P/L"
      : normalization === "margin"
        ? "Margin-normalized"
        : "1-lot normalized";

  const dateLabel = dateBasis === "opened" ? "Opened dates" : "Closed dates";

  const timePeriodLabel =
    timePeriod === "daily" ? "Daily" : timePeriod === "weekly" ? "Weekly" : "Monthly";

  const minSamplesLabel = `n≥${minSamples}`;

  return [
    methodLabel,
    timePeriodLabel,
    alignmentLabel,
    normalizationLabel,
    dateLabel,
    minSamplesLabel,
  ].join(", ");
}
