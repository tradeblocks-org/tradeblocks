"use client";

/**
 * What-If Filter Explorer 2D
 *
 * A multi-dimensional What-If Explorer for scatter plots.
 * Allows filtering on X axis and one or more Y axes with rectangular region selection.
 *
 * Features:
 * - Range sliders for X axis and multiple Y axes
 * - Results grid showing in-range vs out-of-range stats
 * - Optimization strategies: per-axis, combined, and "optimize all Y axes"
 * - Detailed stats: count, avg metric, win rate, total P/L
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
import { Sparkles, ChevronDown, RotateCcw, Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type OptimizeStrategy = "maxTotalPl" | "bestAvgCustom" | "reset";
type OptimizeTarget = "x" | "y" | "all" | number; // number = specific Y axis index

interface TradeWithData {
  trade: EnrichedTrade;
  xValue: number;
  yValues: number[]; // One value per Y axis
  pl: number;
  plPct: number;
  rom: number;
  isWinner: boolean;
}

interface QuadrantStats {
  count: number;
  avgMetric: number;
  winRate: number;
  totalPl: number;
}

export interface WhatIfResults2D {
  xRangeMin: number;
  xRangeMax: number;
  yRanges: Array<{ min: number; max: number }>;
  totalTrades: number;
  // Stats
  inRange: QuadrantStats; // All criteria met (kept)
  outOfRange: QuadrantStats; // At least one criterion not met
  // Summary
  keptPct: number;
  allAvg: number;
  allTotalPl: number;
  keptTotalPl: number;
  improvement: number;
}

export interface YAxisConfig {
  field: string;
  label: string;
}

/** Y-axis range with reference for Plotly shapes */
export interface YAxisRange {
  min: number;
  max: number;
  yref: string; // "y", "y2", or "y3"
}

interface WhatIfExplorer2DProps {
  trades: EnrichedTrade[];
  xAxisField: string;
  /** Array of Y axis configurations - can be 1 to 3 Y axes */
  yAxes: YAxisConfig[];
  metric: ThresholdMetric; // 'pl', 'plPct', or 'rom'
  className?: string;
  /** Callback when range changes - for chart highlighting (all Y axes) */
  onRangeChange?: (xMin: number, xMax: number, yRanges: YAxisRange[]) => void;
}

function calculateStats(trades: TradeWithData[], metric: ThresholdMetric): QuadrantStats {
  if (trades.length === 0) {
    return { count: 0, avgMetric: 0, winRate: 0, totalPl: 0 };
  }

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

  const totalPl = trades.reduce((sum, t) => sum + t.pl, 0);
  const avgMetric = trades.reduce((sum, t) => sum + getMetricValue(t), 0) / trades.length;
  const winCount = trades.filter((t) => t.isWinner).length;
  const winRate = (winCount / trades.length) * 100;

  return { count: trades.length, avgMetric, winRate, totalPl };
}

export function WhatIfExplorer2D({
  trades,
  xAxisField,
  yAxes,
  metric,
  className,
  onRangeChange,
}: WhatIfExplorer2DProps) {
  // Build trade data with X and Y values
  const tradesWithData = useMemo((): TradeWithData[] => {
    return trades
      .map((trade) => {
        const xValue = getEnrichedTradeValue(trade, xAxisField);
        const yValues = yAxes.map((yAxis) => getEnrichedTradeValue(trade, yAxis.field));

        // Only include if X and ALL Y values are valid
        const hasAllValues = xValue !== null && yValues.every((v) => v !== null);

        if (!hasAllValues) return null;

        return {
          trade,
          xValue: xValue as number,
          yValues: yValues as number[],
          pl: trade.pl ?? 0,
          plPct: trade.premiumEfficiency ?? 0,
          rom: trade.rom ?? 0,
          isWinner: (trade.pl ?? 0) > 0,
        };
      })
      .filter((t): t is TradeWithData => t !== null);
  }, [trades, xAxisField, yAxes]);

  // Get min/max for X axis and each Y axis
  const axisRanges = useMemo(() => {
    if (tradesWithData.length === 0) {
      return {
        x: { min: 0, max: 1 },
        y: yAxes.map(() => ({ min: 0, max: 1 })),
      };
    }

    const xValues = tradesWithData.map((t) => t.xValue);
    const yRanges = yAxes.map((_, i) => {
      const values = tradesWithData.map((t) => t.yValues[i]);
      return {
        min: Math.min(...values),
        max: Math.max(...values),
      };
    });

    return {
      x: { min: Math.min(...xValues), max: Math.max(...xValues) },
      y: yRanges,
    };
  }, [tradesWithData, yAxes]);

  // Range slider state for X axis
  const [xRangeValues, setXRangeValues] = useState<[number, number]>([
    axisRanges.x.min,
    axisRanges.x.max,
  ]);

  // Range slider state for each Y axis
  const [yRangeValues, setYRangeValues] = useState<Array<[number, number]>>(
    yAxes.map((_, i) => [axisRanges.y[i]?.min ?? 0, axisRanges.y[i]?.max ?? 1]),
  );

  // Minimum % of trades to keep for "Best Avg" optimization
  const [minKeptPct, setMinKeptPct] = useState(50);
  const [minKeptPctInput, setMinKeptPctInput] = useState("50");

  // Update ranges when data or axes change
  useEffect(() => {
    if (tradesWithData.length > 0) {
      setXRangeValues([axisRanges.x.min, axisRanges.x.max]);
      setYRangeValues(yAxes.map((_, i) => [axisRanges.y[i]?.min ?? 0, axisRanges.y[i]?.max ?? 1]));
    }
  }, [tradesWithData.length, axisRanges, yAxes]);

  // Notify parent of range changes (all Y axes for chart highlighting)
  useEffect(() => {
    if (yRangeValues.length > 0) {
      // Build Y ranges with their Plotly axis references
      const yRanges: YAxisRange[] = yRangeValues.map((range, index) => ({
        min: range[0],
        max: range[1],
        yref: index === 0 ? "y" : `y${index + 1}`, // "y", "y2", "y3"
      }));
      onRangeChange?.(xRangeValues[0], xRangeValues[1], yRanges);
    }
  }, [xRangeValues, yRangeValues, onRangeChange]);

  // Calculate what-if results based on current ranges
  const whatIfResults = useMemo((): WhatIfResults2D | null => {
    if (tradesWithData.length === 0) return null;

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

    const [xMin, xMax] = xRangeValues;

    // Classify trades: in range (all criteria met) vs out of range
    const inRange: TradeWithData[] = [];
    const outOfRange: TradeWithData[] = [];

    for (const t of tradesWithData) {
      const xInRange = t.xValue >= xMin && t.xValue <= xMax;
      const yInRange = t.yValues.every((v, i) => {
        const [yMin, yMax] = yRangeValues[i] ?? [0, Infinity];
        return v >= yMin && v <= yMax;
      });

      if (xInRange && yInRange) {
        inRange.push(t);
      } else {
        outOfRange.push(t);
      }
    }

    // Calculate stats
    const inRangeStats = calculateStats(inRange, metric);
    const outOfRangeStats = calculateStats(outOfRange, metric);

    // Overall stats
    const allAvg =
      tradesWithData.reduce((sum, t) => sum + getMetricValue(t), 0) / tradesWithData.length;
    const allTotalPl = tradesWithData.reduce((sum, t) => sum + t.pl, 0);

    return {
      xRangeMin: xMin,
      xRangeMax: xMax,
      yRanges: yRangeValues.map(([min, max]) => ({ min, max })),
      totalTrades: tradesWithData.length,
      inRange: inRangeStats,
      outOfRange: outOfRangeStats,
      keptPct: (inRange.length / tradesWithData.length) * 100,
      allAvg,
      allTotalPl,
      keptTotalPl: inRangeStats.totalPl,
      improvement: inRangeStats.avgMetric - allAvg,
    };
  }, [tradesWithData, xRangeValues, yRangeValues, metric]);

  // Optimization for a single axis
  const findOptimalRange1D = useCallback(
    (
      axisIndex: number, // -1 for X, 0+ for Y axes
      strategy: OptimizeStrategy,
    ): [number, number] | null => {
      if (tradesWithData.length < 3) return null;

      const values =
        axisIndex === -1
          ? tradesWithData.map((t) => t.xValue)
          : tradesWithData.map((t) => t.yValues[axisIndex]);
      const uniqueVals = [...new Set(values)].sort((a, b) => a - b);

      if (uniqueVals.length < 2) return null;

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

      // Sample if too many unique values
      const sampleSize = Math.min(uniqueVals.length, 30);
      const step = Math.max(1, Math.floor(uniqueVals.length / sampleSize));
      const sampledVals = uniqueVals.filter(
        (_, i) => i % step === 0 || i === uniqueVals.length - 1,
      );

      // Get current ranges for OTHER axes (to constrain filtering)
      const [currentXMin, currentXMax] = xRangeValues;
      const currentYRanges = yRangeValues;

      const evaluateRange = (min: number, max: number) => {
        const kept = tradesWithData.filter((t) => {
          // Check the axis being optimized
          const val = axisIndex === -1 ? t.xValue : t.yValues[axisIndex];
          if (val < min || val > max) return false;

          // Check other axes with their current ranges
          if (axisIndex !== -1) {
            // X must be in range
            if (t.xValue < currentXMin || t.xValue > currentXMax) return false;
          }

          // Other Y axes must be in range
          for (let i = 0; i < t.yValues.length; i++) {
            if (i === axisIndex) continue; // Skip the axis being optimized
            const [yMin, yMax] = currentYRanges[i] ?? [0, Infinity];
            if (t.yValues[i] < yMin || t.yValues[i] > yMax) return false;
          }

          // If optimizing Y, X must also be in range
          if (axisIndex >= 0) {
            if (t.xValue < currentXMin || t.xValue > currentXMax) return false;
          }

          return true;
        });

        if (kept.length === 0) return { keptCount: 0, keptPct: 0, totalPl: 0, avgMetric: 0 };

        const totalPl = kept.reduce((sum, t) => sum + t.pl, 0);
        const avgMetric = kept.reduce((sum, t) => sum + getMetricValue(t), 0) / kept.length;
        const keptPct = (kept.length / tradesWithData.length) * 100;

        return { keptCount: kept.length, keptPct, totalPl, avgMetric };
      };

      let bestRange: [number, number] | null = null;
      let bestScore = -Infinity;

      for (let i = 0; i < sampledVals.length; i++) {
        for (let j = i; j < sampledVals.length; j++) {
          const minVal = sampledVals[i];
          const maxVal = sampledVals[j];
          const result = evaluateRange(minVal, maxVal);

          let score: number;
          switch (strategy) {
            case "maxTotalPl":
              score = result.totalPl * (0.5 + 0.5 * (result.keptPct / 100));
              break;
            case "bestAvgCustom":
              if (result.keptPct < minKeptPct) continue;
              score = result.avgMetric;
              break;
            default:
              continue;
          }

          if (score > bestScore) {
            bestScore = score;
            bestRange = [minVal, maxVal];
          }
        }
      }

      return bestRange;
    },
    [tradesWithData, metric, minKeptPct, xRangeValues, yRangeValues],
  );

  // Optimization for all axes together using coordinate descent
  // This is much more efficient than brute force - O(n * iterations) vs O(n^axes)
  const findOptimalRangeAll = useCallback(
    (strategy: OptimizeStrategy): { x: [number, number]; y: Array<[number, number]> } | null => {
      if (tradesWithData.length < 3) return null;

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

      // Sample unique values for each axis
      const getSampledValues = (values: number[], maxSamples = 25) => {
        const unique = [...new Set(values)].sort((a, b) => a - b);
        if (unique.length <= maxSamples) return unique;
        const step = Math.max(1, Math.floor(unique.length / maxSamples));
        return unique.filter((_, i) => i % step === 0 || i === unique.length - 1);
      };

      const sampledX = getSampledValues(tradesWithData.map((t) => t.xValue));
      const sampledYs = yAxes.map((_, i) =>
        getSampledValues(tradesWithData.map((t) => t.yValues[i])),
      );

      if (sampledX.length < 2 || sampledYs.some((s) => s.length < 2)) return null;

      // Evaluate a complete set of ranges
      const evaluateRanges = (xRange: [number, number], yRanges: Array<[number, number]>) => {
        const kept = tradesWithData.filter((t) => {
          if (t.xValue < xRange[0] || t.xValue > xRange[1]) return false;
          return t.yValues.every((v, i) => v >= yRanges[i][0] && v <= yRanges[i][1]);
        });

        if (kept.length === 0)
          return { keptCount: 0, keptPct: 0, totalPl: 0, avgMetric: 0, score: -Infinity };

        const totalPl = kept.reduce((sum, t) => sum + t.pl, 0);
        const avgMetric = kept.reduce((sum, t) => sum + getMetricValue(t), 0) / kept.length;
        const keptPct = (kept.length / tradesWithData.length) * 100;

        let score: number;
        switch (strategy) {
          case "maxTotalPl":
            score = totalPl * (0.5 + 0.5 * (keptPct / 100));
            break;
          case "bestAvgCustom":
            score = keptPct >= minKeptPct ? avgMetric : -Infinity;
            break;
          default:
            score = -Infinity;
        }

        return { keptCount: kept.length, keptPct, totalPl, avgMetric, score };
      };

      // Find best range for a single axis while holding others fixed
      const optimizeAxis = (
        axisIndex: number, // -1 for X, 0+ for Y
        currentX: [number, number],
        currentYs: Array<[number, number]>,
      ): [number, number] => {
        const sampled = axisIndex === -1 ? sampledX : sampledYs[axisIndex];
        let bestRange: [number, number] = axisIndex === -1 ? currentX : currentYs[axisIndex];
        let bestScore = -Infinity;

        for (let i = 0; i < sampled.length; i++) {
          for (let j = i; j < sampled.length; j++) {
            const testRange: [number, number] = [sampled[i], sampled[j]];

            let testX = currentX;
            const testYs = [...currentYs];

            if (axisIndex === -1) {
              testX = testRange;
            } else {
              testYs[axisIndex] = testRange;
            }

            const result = evaluateRanges(testX, testYs);
            if (result.score > bestScore) {
              bestScore = result.score;
              bestRange = testRange;
            }
          }
        }

        return bestRange;
      };

      // Initialize with full ranges
      let currentX: [number, number] = [sampledX[0], sampledX[sampledX.length - 1]];
      const currentYs: Array<[number, number]> = sampledYs.map((s) => [s[0], s[s.length - 1]]);

      // Coordinate descent: optimize each axis in turn, repeat until convergence
      const maxIterations = 3; // Usually converges in 2-3 iterations
      let prevScore = -Infinity;

      for (let iter = 0; iter < maxIterations; iter++) {
        // Optimize X
        currentX = optimizeAxis(-1, currentX, currentYs);

        // Optimize each Y axis
        for (let yIdx = 0; yIdx < yAxes.length; yIdx++) {
          currentYs[yIdx] = optimizeAxis(yIdx, currentX, currentYs);
        }

        // Check for convergence
        const currentScore = evaluateRanges(currentX, currentYs).score;
        if (currentScore <= prevScore) break; // No improvement, stop
        prevScore = currentScore;
      }

      return { x: currentX, y: currentYs };
    },
    [tradesWithData, yAxes, metric, minKeptPct],
  );

  // Handle optimize button click
  const handleOptimize = useCallback(
    (strategy: OptimizeStrategy, target: OptimizeTarget) => {
      if (strategy === "reset") {
        setXRangeValues([axisRanges.x.min, axisRanges.x.max]);
        setYRangeValues(
          yAxes.map((_, i) => [axisRanges.y[i]?.min ?? 0, axisRanges.y[i]?.max ?? 1]),
        );
        return;
      }

      if (target === "all") {
        const optimalRange = findOptimalRangeAll(strategy);
        if (optimalRange) {
          setXRangeValues(optimalRange.x);
          setYRangeValues(optimalRange.y);
        }
      } else if (target === "x") {
        const optimalRange = findOptimalRange1D(-1, strategy);
        if (optimalRange) {
          setXRangeValues(optimalRange);
        }
      } else if (typeof target === "number") {
        const optimalRange = findOptimalRange1D(target, strategy);
        if (optimalRange) {
          setYRangeValues((prev) => {
            const next = [...prev];
            next[target] = optimalRange;
            return next;
          });
        }
      }
    },
    [findOptimalRange1D, findOptimalRangeAll, axisRanges, yAxes],
  );

  // Get field info for display
  const xInfo = getFieldInfo(xAxisField);
  const xLabel = xInfo?.label ?? xAxisField;

  // Format metric value
  const formatMetric = (v: number) => {
    if (metric === "pl") return `$${v.toFixed(0)}`;
    return `${v.toFixed(1)}%`;
  };

  // Format P/L value
  const formatPl = (v: number) => {
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  if (!whatIfResults) return null;

  // Render optimization dropdown
  const renderOptimizeDropdown = (target: OptimizeTarget, label: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs gap-1">
          <Sparkles className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => handleOptimize("maxTotalPl", target)}>
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
                    handleOptimize("bestAvgCustom", target);
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
              onClick={() => handleOptimize("bestAvgCustom", target)}
            >
              Apply
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Render stats cell
  const renderStatsCell = (stats: QuadrantStats, label: string, isKept: boolean) => (
    <div
      className={`p-2 rounded ${isKept ? "bg-primary/10 border border-primary/30" : "bg-muted/50"}`}
    >
      <div className="flex items-center gap-1 mb-1">
        {isKept && <Check className="h-3 w-3 text-primary" />}
        <span className="text-xs font-medium">
          {label} ({stats.count})
        </span>
      </div>
      <div
        className={`text-sm font-medium ${stats.avgMetric > 0 ? "text-green-600 dark:text-green-400" : stats.avgMetric < 0 ? "text-red-600 dark:text-red-400" : ""}`}
      >
        Avg: {formatMetric(stats.avgMetric)}
      </div>
      <div className="text-xs text-muted-foreground">Win: {stats.winRate.toFixed(0)}%</div>
      <div
        className={`text-xs ${stats.totalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
      >
        P/L: {formatPl(stats.totalPl)}
      </div>
    </div>
  );

  return (
    <div className={`mt-3 p-3 bg-muted/30 rounded-lg border text-sm ${className ?? ""}`}>
      {/* Header with global controls */}
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium">What-If Filter Explorer</div>
        <div className="flex items-center gap-2">
          {renderOptimizeDropdown("all", "Optimize All")}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => handleOptimize("reset", "all")}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        </div>
      </div>

      {/* Range Sliders */}
      <div className="space-y-4 mb-4">
        {/* X-Axis Slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">X: {xLabel}</Label>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">
                {whatIfResults.xRangeMin.toFixed(2)} - {whatIfResults.xRangeMax.toFixed(2)}
              </span>
              {renderOptimizeDropdown("x", "Optimize X")}
            </div>
          </div>
          <Slider
            value={xRangeValues}
            onValueChange={(v) => setXRangeValues(v as [number, number])}
            min={axisRanges.x.min}
            max={axisRanges.x.max}
            step={(axisRanges.x.max - axisRanges.x.min) / 100 || 0.01}
            className="w-full"
          />
        </div>

        {/* Y-Axis Sliders */}
        {yAxes.map((yAxis, index) => {
          const yRange = yRangeValues[index] ?? [0, 1];
          const dataRange = axisRanges.y[index] ?? { min: 0, max: 1 };
          const yLabel = yAxis.label;
          // Color dots matching AXIS_COLORS in scatter-chart.tsx
          const axisColors = [
            "rgb(59, 130, 246)", // Blue (y1)
            "rgb(249, 115, 22)", // Orange (y2)
            "rgb(20, 184, 166)", // Teal (y3)
          ];
          const dotColor = axisColors[index] ?? axisColors[0];

          return (
            <div key={yAxis.field} className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: dotColor }}
                  />
                  Y{yAxes.length > 1 ? index + 1 : ""}: {yLabel}
                </Label>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">
                    {yRange[0].toFixed(2)} - {yRange[1].toFixed(2)}
                  </span>
                  {renderOptimizeDropdown(index, `Optimize Y${yAxes.length > 1 ? index + 1 : ""}`)}
                </div>
              </div>
              <Slider
                value={yRange}
                onValueChange={(v) => {
                  setYRangeValues((prev) => {
                    const next = [...prev];
                    next[index] = v as [number, number];
                    return next;
                  });
                }}
                min={dataRange.min}
                max={dataRange.max}
                step={(dataRange.max - dataRange.min) / 100 || 0.01}
                className="w-full"
              />
            </div>
          );
        })}
      </div>

      {/* Results Grid */}
      <div className="pt-3 border-t">
        <div className="grid grid-cols-2 gap-2 mb-3">
          {renderStatsCell(whatIfResults.inRange, "In Range", true)}
          {renderStatsCell(whatIfResults.outOfRange, "Outside Range", false)}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t">
        <div>
          <div className="text-muted-foreground text-xs">Total P/L (All)</div>
          <div
            className={`font-medium ${whatIfResults.allTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            {formatPl(whatIfResults.allTotalPl)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Total P/L (In Range)</div>
          <div
            className={`font-medium ${whatIfResults.keptTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            {formatPl(whatIfResults.keptTotalPl)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">P/L Change if Filtered</div>
          <div
            className={`font-medium ${whatIfResults.keptTotalPl - whatIfResults.allTotalPl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            {whatIfResults.keptTotalPl - whatIfResults.allTotalPl >= 0 ? "+" : ""}
            {formatPl(whatIfResults.keptTotalPl - whatIfResults.allTotalPl)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">vs All Trades</div>
          <div
            className={`font-medium ${whatIfResults.improvement > 0 ? "text-green-600 dark:text-green-400" : whatIfResults.improvement < 0 ? "text-red-600 dark:text-red-400" : ""}`}
          >
            {whatIfResults.improvement > 0 ? "+" : ""}
            {formatMetric(whatIfResults.improvement)}
          </div>
        </div>
      </div>

      {/* Footer summary */}
      <div className="mt-3 pt-2 border-t text-xs text-muted-foreground">
        Keeping {whatIfResults.keptPct.toFixed(0)}% of trades ({whatIfResults.inRange.count} of{" "}
        {whatIfResults.totalTrades}). All trades avg: {formatMetric(whatIfResults.allAvg)}
      </div>
    </div>
  );
}

export default WhatIfExplorer2D;
