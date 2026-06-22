"use client";

/**
 * What-If Filter Explorer
 *
 * A shared component for exploring hypothetical filter ranges on trade data.
 * Used by threshold chart, histogram, and other single-axis analysis charts.
 *
 * Features:
 * - Dual-range slider for selecting X-axis value range
 * - Optimization strategies (maximize P/L, best avg with min % trades)
 * - Real-time stats: kept/excluded trades, avg metrics, total P/L
 */

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { EnrichedTrade, getEnrichedTradeValue } from "@tradeblocks/lib";
import { ThresholdMetric, getFieldInfo } from "@tradeblocks/lib";
import { formatMinutesToTime } from "@tradeblocks/lib";
import { ArrowUp, ArrowDown, Sparkles, ChevronDown, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type OptimizeStrategy = "maxTotalPl" | "bestAvgCustom" | "reset";

interface TradeWithData {
  trade: EnrichedTrade;
  xValue: number;
  pl: number;
  plPct: number;
  rom: number;
}

export interface WhatIfResults {
  rangeMin: number;
  rangeMax: number;
  totalTrades: number;
  keptTrades: number;
  excludedTrades: number;
  keptPct: number;
  allAvg: number;
  keptAvg: number;
  excludedAvg: number;
  improvement: number;
  allTotalPl: number;
  keptTotalPl: number;
  excludedTotalPl: number;
}

interface WhatIfExplorerProps {
  trades: EnrichedTrade[];
  xAxisField: string;
  metric: ThresholdMetric; // 'pl', 'plPct', or 'rom'
  className?: string;
  /** Callback when range changes - can be used for chart highlighting */
  onRangeChange?: (min: number, max: number) => void;
}

export function WhatIfExplorer({
  trades,
  xAxisField,
  metric,
  className,
  onRangeChange,
}: WhatIfExplorerProps) {
  // Build trade data with X values and metrics
  const tradesWithData = useMemo((): TradeWithData[] => {
    return trades
      .map((trade) => {
        const xValue = getEnrichedTradeValue(trade, xAxisField);
        return {
          trade,
          xValue,
          pl: trade.pl ?? 0,
          plPct: trade.premiumEfficiency ?? 0,
          rom: trade.rom ?? 0,
        };
      })
      .filter((t): t is TradeWithData => t.xValue !== null);
  }, [trades, xAxisField]);

  // Get min/max X values from the data
  const { dataMinX, dataMaxX } = useMemo(() => {
    if (tradesWithData.length === 0) {
      return { dataMinX: 0, dataMaxX: 1 };
    }
    const values = tradesWithData.map((t) => t.xValue);
    return {
      dataMinX: Math.min(...values),
      dataMaxX: Math.max(...values),
    };
  }, [tradesWithData]);

  // Range slider state
  const [rangeValues, setRangeValues] = useState<[number, number]>([dataMinX, dataMaxX]);

  // Minimum % of trades to keep for "Best Avg" optimization
  const [minKeptPct, setMinKeptPct] = useState(50);
  const [minKeptPctInput, setMinKeptPctInput] = useState("50");

  // Update range when data changes
  useEffect(() => {
    if (tradesWithData.length > 0) {
      setRangeValues([dataMinX, dataMaxX]);
    }
  }, [tradesWithData.length, dataMinX, dataMaxX]);

  // Notify parent of range changes
  useEffect(() => {
    onRangeChange?.(rangeValues[0], rangeValues[1]);
  }, [rangeValues, onRangeChange]);

  // Calculate what-if results based on current range
  const whatIfResults = useMemo((): WhatIfResults | null => {
    if (tradesWithData.length === 0) return null;

    // Get metric value for a trade
    const getMetricValue = (t: TradeWithData) => {
      switch (metric) {
        case "rom":
          return t.rom;
        case "plPct":
          return t.plPct;
        default:
          return t.pl;
      }
    };

    // Filter trades by range
    const [minVal, maxVal] = rangeValues;
    const keptTrades = tradesWithData.filter((t) => t.xValue >= minVal && t.xValue <= maxVal);
    const excludedTrades = tradesWithData.filter((t) => t.xValue < minVal || t.xValue > maxVal);

    // Calculate metrics (averages based on selected metric)
    const allAvg =
      tradesWithData.length > 0
        ? tradesWithData.reduce((sum, t) => sum + getMetricValue(t), 0) / tradesWithData.length
        : 0;
    const keptAvg =
      keptTrades.length > 0
        ? keptTrades.reduce((sum, t) => sum + getMetricValue(t), 0) / keptTrades.length
        : 0;
    const excludedAvg =
      excludedTrades.length > 0
        ? excludedTrades.reduce((sum, t) => sum + getMetricValue(t), 0) / excludedTrades.length
        : 0;

    // Calculate total P/L $ amounts
    const allTotalPl = tradesWithData.reduce((sum, t) => sum + t.pl, 0);
    const keptTotalPl = keptTrades.reduce((sum, t) => sum + t.pl, 0);
    const excludedTotalPl = excludedTrades.reduce((sum, t) => sum + t.pl, 0);

    return {
      rangeMin: minVal,
      rangeMax: maxVal,
      totalTrades: tradesWithData.length,
      keptTrades: keptTrades.length,
      excludedTrades: excludedTrades.length,
      keptPct: (keptTrades.length / tradesWithData.length) * 100,
      allAvg,
      keptAvg,
      excludedAvg,
      improvement: keptAvg - allAvg,
      allTotalPl,
      keptTotalPl,
      excludedTotalPl,
    };
  }, [tradesWithData, rangeValues, metric]);

  // Optimization function
  const findOptimalRange = useCallback(
    (strategy: OptimizeStrategy): [number, number] | null => {
      if (tradesWithData.length < 3) return null;

      const xValues = tradesWithData.map((t) => t.xValue);
      const uniqueX = [...new Set(xValues)].sort((a, b) => a - b);

      if (uniqueX.length < 2) return null;

      // Get metric value based on current selection
      const getMetricValue = (t: TradeWithData) => {
        switch (metric) {
          case "rom":
            return t.rom;
          case "plPct":
            return t.plPct;
          default:
            return t.pl;
        }
      };

      // Helper to evaluate a range
      const evaluateRange = (minX: number, maxX: number) => {
        const kept = tradesWithData.filter((t) => t.xValue >= minX && t.xValue <= maxX);
        if (kept.length === 0) return { keptCount: 0, keptPct: 0, totalPl: 0, avgMetric: 0 };

        const totalPl = kept.reduce((sum, t) => sum + t.pl, 0);
        const avgMetric = kept.reduce((sum, t) => sum + getMetricValue(t), 0) / kept.length;
        const keptPct = (kept.length / tradesWithData.length) * 100;

        return { keptCount: kept.length, keptPct, totalPl, avgMetric };
      };

      let bestRange: [number, number] | null = null;
      let bestScore = -Infinity;

      // Try all combinations of start/end points from unique X values
      // For performance, sample if there are too many unique values
      const sampleSize = Math.min(uniqueX.length, 30);
      const step = Math.max(1, Math.floor(uniqueX.length / sampleSize));
      const sampledX = uniqueX.filter((_, i) => i % step === 0 || i === uniqueX.length - 1);

      for (let i = 0; i < sampledX.length; i++) {
        for (let j = i; j < sampledX.length; j++) {
          const minX = sampledX[i];
          const maxX = sampledX[j];
          const result = evaluateRange(minX, maxX);

          let score: number;

          switch (strategy) {
            case "maxTotalPl":
              // Maximize total P/L, with slight penalty for excluding too many trades
              score = result.totalPl * (0.5 + 0.5 * (result.keptPct / 100));
              break;

            case "bestAvgCustom":
              // Best average metric while keeping at least minKeptPct% of trades
              if (result.keptPct < minKeptPct) continue;
              score = result.avgMetric;
              break;

            default:
              continue;
          }

          if (score > bestScore) {
            bestScore = score;
            bestRange = [minX, maxX];
          }
        }
      }

      return bestRange;
    },
    [tradesWithData, metric, minKeptPct],
  );

  // Handle optimize button click
  const handleOptimize = useCallback(
    (strategy: OptimizeStrategy) => {
      if (strategy === "reset") {
        setRangeValues([dataMinX, dataMaxX]);
        return;
      }

      const optimalRange = findOptimalRange(strategy);
      if (optimalRange) {
        setRangeValues(optimalRange);
      }
    },
    [findOptimalRange, dataMinX, dataMaxX],
  );

  // Get field info for display
  const xInfo = getFieldInfo(xAxisField);
  const fieldLabel = xInfo?.label ?? xAxisField;
  const metricLabel = metric === "rom" ? "ROM" : metric === "plPct" ? "P/L %" : "P/L";
  const isTimeField = xAxisField === "timeOfDayMinutes";

  // Format X value based on field type
  const formatXValue = (v: number) => {
    if (isTimeField) {
      return formatMinutesToTime(v);
    }
    return v.toFixed(2);
  };

  // Format metric value
  const formatMetric = (v: number | null) => {
    if (v === null) return "N/A";
    if (metric === "pl") return `$${v.toFixed(0)}`;
    return `${v.toFixed(1)}%`;
  };

  if (!whatIfResults) return null;

  return (
    <div className={`mt-3 p-3 bg-muted/30 rounded-lg border text-sm ${className ?? ""}`}>
      <div className="font-medium mb-3">What-If Filter Explorer</div>

      {/* Range Slider with Optimize */}
      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">
            Keep trades where {fieldLabel} is between:
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">
              {formatXValue(whatIfResults.rangeMin)} - {formatXValue(whatIfResults.rangeMax)}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs gap-1">
                  <Sparkles className="h-3 w-3" />
                  Optimize
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => handleOptimize("maxTotalPl")}>
                  Maximize Total P/L
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5">
                  <div className="text-xs text-muted-foreground mb-1.5">
                    Best Avg (keep min % of trades)
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={minKeptPctInput}
                      onChange={(e) => setMinKeptPctInput(e.target.value)}
                      onBlur={() => {
                        const val = parseInt(minKeptPctInput, 10);
                        if (!isNaN(val) && val >= 10 && val <= 100) {
                          setMinKeptPct(val);
                          setMinKeptPctInput(String(val));
                        } else {
                          setMinKeptPctInput(String(minKeptPct));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const val = parseInt(minKeptPctInput, 10);
                          if (!isNaN(val) && val >= 10 && val <= 100) {
                            setMinKeptPct(val);
                            setMinKeptPctInput(String(val));
                            handleOptimize("bestAvgCustom");
                          }
                        }
                      }}
                      className="h-7 w-16 text-xs"
                      min={10}
                      max={100}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => handleOptimize("bestAvgCustom")}
                    >
                      Apply
                    </Button>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleOptimize("reset")}
                  className="text-muted-foreground"
                >
                  <RotateCcw className="h-3 w-3 mr-2" />
                  Reset to Full Range
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <Slider
          value={rangeValues}
          onValueChange={(v) => setRangeValues(v as [number, number])}
          min={dataMinX}
          max={dataMaxX}
          step={(dataMaxX - dataMinX) / 100 || 0.01}
          className="w-full"
        />
      </div>

      {/* Results Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-3 border-t">
        {/* Filter info */}
        <div>
          <div className="text-muted-foreground text-xs">{fieldLabel} Range</div>
          <div className="font-medium">
            {formatXValue(whatIfResults.rangeMin)} - {formatXValue(whatIfResults.rangeMax)}
          </div>
        </div>

        {/* Kept trades */}
        <div>
          <div className="text-muted-foreground text-xs flex items-center gap-1">
            <ArrowUp className="h-3 w-3 text-green-500" />
            In Range ({whatIfResults.keptTrades} trades)
          </div>
          <div
            className={`font-medium ${
              whatIfResults.keptAvg > 0
                ? "text-green-600 dark:text-green-400"
                : whatIfResults.keptAvg < 0
                  ? "text-red-600 dark:text-red-400"
                  : ""
            }`}
          >
            Avg {metricLabel}: {formatMetric(whatIfResults.keptAvg)}
          </div>
        </div>

        {/* Excluded trades */}
        <div>
          <div className="text-muted-foreground text-xs flex items-center gap-1">
            <ArrowDown className="h-3 w-3 text-red-500" />
            Outside ({whatIfResults.excludedTrades} trades)
          </div>
          <div
            className={`font-medium ${
              whatIfResults.excludedAvg > 0
                ? "text-green-600 dark:text-green-400"
                : whatIfResults.excludedAvg < 0
                  ? "text-red-600 dark:text-red-400"
                  : ""
            }`}
          >
            Avg {metricLabel}: {formatMetric(whatIfResults.excludedAvg)}
          </div>
        </div>

        {/* Impact */}
        <div>
          <div className="text-muted-foreground text-xs">vs All Trades</div>
          <div
            className={`font-medium ${
              whatIfResults.improvement > 0
                ? "text-green-600 dark:text-green-400"
                : whatIfResults.improvement < 0
                  ? "text-red-600 dark:text-red-400"
                  : ""
            }`}
          >
            {whatIfResults.improvement > 0 ? "+" : ""}
            {formatMetric(whatIfResults.improvement)}
          </div>
        </div>
      </div>

      {/* Total P/L Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t">
        <div>
          <div className="text-muted-foreground text-xs">Total P/L (All)</div>
          <div
            className={`font-medium ${whatIfResults.allTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            $
            {whatIfResults.allTotalPl.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Total P/L (In Range)</div>
          <div
            className={`font-medium ${whatIfResults.keptTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            $
            {whatIfResults.keptTotalPl.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Total P/L (Outside)</div>
          <div
            className={`font-medium ${whatIfResults.excludedTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            $
            {whatIfResults.excludedTotalPl.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">P/L Change if Filtered</div>
          <div
            className={`font-medium ${-whatIfResults.excludedTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            {-whatIfResults.excludedTotalPl >= 0 ? "+" : ""}$
            {(-whatIfResults.excludedTotalPl).toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="mt-3 pt-2 border-t text-xs text-muted-foreground">
        Keeping {whatIfResults.keptPct.toFixed(0)}% of trades ({whatIfResults.keptTrades} of{" "}
        {whatIfResults.totalTrades}). All trades avg: {formatMetric(whatIfResults.allAvg)}
      </div>
    </div>
  );
}

export default WhatIfExplorer;
