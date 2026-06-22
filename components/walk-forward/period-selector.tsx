"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { AlertCircle, ChevronDown, HelpCircle, Loader2, Square, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { MultiSelect } from "@/components/multi-select";
import type { CorrelationMethodOption, WalkForwardOptimizationTarget } from "@tradeblocks/lib";
import { validatePreRunConfiguration } from "@tradeblocks/lib";
import {
  PARAMETER_METADATA,
  suggestStepForRange,
  useWalkForwardStore,
} from "@tradeblocks/lib/stores";
import { cn } from "@tradeblocks/lib";

interface PeriodSelectorProps {
  blockId?: string | null;
  addon?: React.ReactNode;
}

const TARGET_OPTIONS: Array<{
  value: WalkForwardOptimizationTarget;
  label: string;
  group: "performance" | "risk-adjusted";
}> = [
  // Performance targets
  { value: "netPl", label: "Net Profit", group: "performance" },
  { value: "profitFactor", label: "Profit Factor", group: "performance" },
  { value: "cagr", label: "CAGR", group: "performance" },
  { value: "avgDailyPl", label: "Avg Daily P/L", group: "performance" },
  { value: "winRate", label: "Win Rate", group: "performance" },
  // Risk-adjusted targets
  { value: "sharpeRatio", label: "Sharpe Ratio", group: "risk-adjusted" },
  { value: "sortinoRatio", label: "Sortino Ratio", group: "risk-adjusted" },
  { value: "calmarRatio", label: "Calmar Ratio", group: "risk-adjusted" },
];

// Helper text for parameters (extends the store's PARAMETER_METADATA)
const PARAMETER_HELPERS: Record<string, string> = {
  kellyMultiplier: "Scale Kelly sizing to sweep risk appetite.",
  fixedFractionPct: "Percent of capital risked per trade.",
  maxDrawdownPct: "Reject combos that breach this drawdown.",
  maxDailyLossPct: "Cut risk-off when day losses exceed cap.",
  consecutiveLossLimit: "Stops trading after N losing trades.",
};

export function WalkForwardPeriodSelector({ blockId, addon }: PeriodSelectorProps) {
  const config = useWalkForwardStore((state) => state.config);
  const updateConfig = useWalkForwardStore((state) => state.updateConfig);
  const autoConfigureFromBlock = useWalkForwardStore((state) => state.autoConfigureFromBlock);
  const tradeFrequency = useWalkForwardStore((state) => state.tradeFrequency);
  const autoConfigApplied = useWalkForwardStore((state) => state.autoConfigApplied);
  const constrainedByFrequency = useWalkForwardStore((state) => state.constrainedByFrequency);
  const runAnalysis = useWalkForwardStore((state) => state.runAnalysis);
  const cancelAnalysis = useWalkForwardStore((state) => state.cancelAnalysis);
  const isRunning = useWalkForwardStore((state) => state.isRunning);
  const progress = useWalkForwardStore((state) => state.progress);
  const error = useWalkForwardStore((state) => state.error);

  // Phase 1: Extended parameter ranges
  const extendedParameterRanges = useWalkForwardStore((state) => state.extendedParameterRanges);
  const setExtendedParameterRange = useWalkForwardStore((state) => state.setExtendedParameterRange);
  const toggleParameter = useWalkForwardStore((state) => state.toggleParameter);
  const combinationEstimate = useWalkForwardStore((state) => state.combinationEstimate);

  // Phase 1: Strategy filter and normalization
  const availableStrategies = useWalkForwardStore((state) => state.availableStrategies);
  const selectedStrategies = useWalkForwardStore((state) => state.selectedStrategies);
  const setSelectedStrategies = useWalkForwardStore((state) => state.setSelectedStrategies);
  const loadAvailableStrategies = useWalkForwardStore((state) => state.loadAvailableStrategies);
  const normalizeTo1Lot = useWalkForwardStore((state) => state.normalizeTo1Lot);
  const setNormalizeTo1Lot = useWalkForwardStore((state) => state.setNormalizeTo1Lot);

  // Phase 2: Diversification config
  const diversificationConfig = useWalkForwardStore((state) => state.diversificationConfig);
  const updateDiversificationConfig = useWalkForwardStore(
    (state) => state.updateDiversificationConfig,
  );

  // Phase 3: Strategy weight sweeps
  const strategyWeightSweep = useWalkForwardStore((state) => state.strategyWeightSweep);
  const setStrategyWeightMode = useWalkForwardStore((state) => state.setStrategyWeightMode);
  const toggleStrategyWeight = useWalkForwardStore((state) => state.toggleStrategyWeight);
  const setStrategyWeightConfig = useWalkForwardStore((state) => state.setStrategyWeightConfig);
  const setTopNCount = useWalkForwardStore((state) => state.setTopNCount);

  // Collapsible state
  const [parametersOpen, setParametersOpen] = useState(false);
  const [diversificationOpen, setDiversificationOpen] = useState(false);
  const [strategyWeightsOpen, setStrategyWeightsOpen] = useState(false);

  // Window configuration input states (for free text editing)
  const [inSampleInput, setInSampleInput] = useState(String(config.inSampleDays));
  const [outOfSampleInput, setOutOfSampleInput] = useState(String(config.outOfSampleDays));
  const [stepSizeInput, setStepSizeInput] = useState(String(config.stepSizeDays));

  // Min trades input states (for free text editing)
  const [minISTradesInput, setMinISTradesInput] = useState(String(config.minInSampleTrades ?? 0));
  const [minOOSTradesInput, setMinOOSTradesInput] = useState(
    String(config.minOutOfSampleTrades ?? 0),
  );

  // Parameter range input states (for free text editing)
  // Keys are like "kellyMultiplier_min", "kellyMultiplier_max", "kellyMultiplier_step"
  const [paramInputs, setParamInputs] = useState<Record<string, string>>(() => {
    const inputs: Record<string, string> = {};
    Object.entries(extendedParameterRanges).forEach(([key, range]) => {
      const [min, max, step] = range;
      const metadata = PARAMETER_METADATA[key];
      const precision = metadata?.precision ?? 2;
      inputs[`${key}_min`] = min.toFixed(precision);
      inputs[`${key}_max`] = max.toFixed(precision);
      inputs[`${key}_step`] = step.toFixed(precision);
    });
    return inputs;
  });

  // Sync input states when config changes externally (e.g., presets)
  useEffect(() => {
    setInSampleInput(String(config.inSampleDays));
    setOutOfSampleInput(String(config.outOfSampleDays));
    setStepSizeInput(String(config.stepSizeDays));
    setMinISTradesInput(String(config.minInSampleTrades ?? 0));
    setMinOOSTradesInput(String(config.minOutOfSampleTrades ?? 0));
  }, [
    config.inSampleDays,
    config.outOfSampleDays,
    config.stepSizeDays,
    config.minInSampleTrades,
    config.minOutOfSampleTrades,
  ]);

  // Sync parameter range inputs when extendedParameterRanges changes (e.g., slider drag, preset)
  useEffect(() => {
    const inputs: Record<string, string> = {};
    Object.entries(extendedParameterRanges).forEach(([key, range]) => {
      const [min, max, step] = range;
      const metadata = PARAMETER_METADATA[key];
      const precision = metadata?.precision ?? 2;
      inputs[`${key}_min`] = min.toFixed(precision);
      inputs[`${key}_max`] = max.toFixed(precision);
      inputs[`${key}_step`] = step.toFixed(precision);
    });
    setParamInputs(inputs);
  }, [extendedParameterRanges]);

  // Blur handlers for window configuration inputs
  const handleInSampleBlur = () => {
    const val = parseInt(inSampleInput, 10);
    if (!isNaN(val) && val >= 1) {
      updateConfig({ inSampleDays: val });
      setInSampleInput(String(val));
    } else {
      setInSampleInput(String(config.inSampleDays));
    }
  };

  const handleOutOfSampleBlur = () => {
    const val = parseInt(outOfSampleInput, 10);
    if (!isNaN(val) && val >= 1) {
      updateConfig({ outOfSampleDays: val });
      setOutOfSampleInput(String(val));
    } else {
      setOutOfSampleInput(String(config.outOfSampleDays));
    }
  };

  const handleStepSizeBlur = () => {
    const val = parseInt(stepSizeInput, 10);
    if (!isNaN(val) && val >= 1) {
      updateConfig({ stepSizeDays: val });
      setStepSizeInput(String(val));
    } else {
      setStepSizeInput(String(config.stepSizeDays));
    }
  };

  const handleMinISTradesBlur = () => {
    const val = parseInt(minISTradesInput, 10);
    if (!isNaN(val) && val >= 1) {
      updateConfig({ minInSampleTrades: val });
      setMinISTradesInput(String(val));
    } else {
      setMinISTradesInput(String(config.minInSampleTrades ?? 0));
    }
  };

  const handleMinOOSTradesBlur = () => {
    const val = parseInt(minOOSTradesInput, 10);
    if (!isNaN(val) && val >= 1) {
      updateConfig({ minOutOfSampleTrades: val });
      setMinOOSTradesInput(String(val));
    } else {
      setMinOOSTradesInput(String(config.minOutOfSampleTrades ?? 0));
    }
  };

  // Auto-configure when block changes
  useEffect(() => {
    if (blockId) {
      autoConfigureFromBlock(blockId);
      loadAvailableStrategies(blockId);
    }
  }, [blockId, autoConfigureFromBlock, loadAvailableStrategies]);

  // Disable run if no block, already running, or no sweep/constraint configured
  const hasEnabledParameters = Object.values(extendedParameterRanges).some(
    ([, , , enabled]) => enabled,
  );
  const hasEnabledConstraints =
    diversificationConfig.enableCorrelationConstraint ||
    diversificationConfig.enableTailRiskConstraint;
  const hasEnabledWeightSweeps = strategyWeightSweep.configs.some((c) => c.enabled);
  const hasValidConfig = hasEnabledParameters || hasEnabledConstraints || hasEnabledWeightSweeps;
  const disableRun = !blockId || isRunning || !hasValidConfig;

  const handleRun = async () => {
    if (!blockId) return;
    await runAnalysis(blockId);
  };

  // Build strategy options for multi-select
  const strategyOptions = useMemo(
    () =>
      availableStrategies.map((strategy) => ({
        label: strategy,
        value: strategy,
      })),
    [availableStrategies],
  );

  // Strategies eligible for weight sweeps = selected strategies (if any), otherwise all available
  const strategiesForWeightSweep = useMemo(
    () => (selectedStrategies.length > 0 ? selectedStrategies : availableStrategies),
    [selectedStrategies, availableStrategies],
  );

  // Filter strategy weight configs to only show strategies in the current filter
  const filteredWeightConfigs = useMemo(
    () =>
      strategyWeightSweep.configs.filter((config) =>
        strategiesForWeightSweep.includes(config.strategy),
      ),
    [strategyWeightSweep.configs, strategiesForWeightSweep],
  );

  // Pre-run configuration guidance - validates config before analysis
  const preRunObservations = useMemo(() => validatePreRunConfiguration(config), [config]);

  const renderParameterControls = () => {
    return Object.entries(extendedParameterRanges).map(([key, range]) => {
      const metadata = PARAMETER_METADATA[key];
      if (!metadata) return null;

      const [minValue, maxValue, stepValue, enabled] = range;
      const helperText = PARAMETER_HELPERS[key] || "";

      const sliderMin = Math.min(metadata.min, minValue);
      const sliderMax = Math.max(metadata.max, maxValue);
      const precision = metadata.precision;

      // Check if step size suggestion is needed
      const suggestedStep = suggestStepForRange(key, minValue, maxValue);
      const currentValueCount = Math.floor((maxValue - minValue) / stepValue) + 1;
      const showStepSuggestion =
        enabled && stepValue < suggestedStep * 0.5 && currentValueCount > 20;

      return (
        <div
          key={key}
          className={cn(
            "space-y-2 rounded-lg border p-3 transition-colors",
            enabled
              ? "border-border/40 bg-card"
              : "border-border/30 cursor-pointer hover:border-border/50 hover:bg-muted/30",
          )}
          onClick={!enabled ? () => toggleParameter(key, true) : undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* Enable/Disable Checkbox */}
              <Checkbox
                checked={enabled}
                onCheckedChange={(checked) => toggleParameter(key, Boolean(checked))}
                aria-label={`Enable ${metadata.label}`}
              />
              <div>
                <p className="text-sm font-semibold">{metadata.label}</p>
                <p className="text-xs text-muted-foreground">{helperText}</p>
              </div>
            </div>
            {enabled && (
              <Badge variant="secondary">
                {minValue.toFixed(precision)} - {maxValue.toFixed(precision)}
              </Badge>
            )}
          </div>

          {enabled && (
            <>
              <Slider
                min={sliderMin}
                max={sliderMax}
                step={stepValue}
                value={[minValue, maxValue]}
                onValueChange={(values) => {
                  if (!values || values.length < 2) return;
                  const nextMin = Number(values[0].toFixed(precision));
                  const nextMax = Number(values[1].toFixed(precision));
                  setExtendedParameterRange(key, [nextMin, nextMax, stepValue, true]);
                }}
              />
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Min</Label>
                  <Input
                    type="number"
                    value={paramInputs[`${key}_min`] ?? minValue.toFixed(precision)}
                    step={stepValue}
                    onChange={(event) => {
                      setParamInputs((prev) => ({ ...prev, [`${key}_min`]: event.target.value }));
                    }}
                    onBlur={() => {
                      const next = Number.parseFloat(paramInputs[`${key}_min`] ?? "");
                      if (Number.isFinite(next) && next >= metadata.min) {
                        setExtendedParameterRange(key, [next, maxValue, stepValue, true]);
                      } else {
                        setParamInputs((prev) => ({
                          ...prev,
                          [`${key}_min`]: minValue.toFixed(precision),
                        }));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Max</Label>
                  <Input
                    type="number"
                    value={paramInputs[`${key}_max`] ?? maxValue.toFixed(precision)}
                    step={stepValue}
                    onChange={(event) => {
                      setParamInputs((prev) => ({ ...prev, [`${key}_max`]: event.target.value }));
                    }}
                    onBlur={() => {
                      const next = Number.parseFloat(paramInputs[`${key}_max`] ?? "");
                      if (Number.isFinite(next) && next <= metadata.max) {
                        setExtendedParameterRange(key, [minValue, next, stepValue, true]);
                      } else {
                        setParamInputs((prev) => ({
                          ...prev,
                          [`${key}_max`]: maxValue.toFixed(precision),
                        }));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Step</Label>
                  <Input
                    type="number"
                    value={paramInputs[`${key}_step`] ?? stepValue.toFixed(precision)}
                    step={metadata.step}
                    onChange={(event) => {
                      setParamInputs((prev) => ({ ...prev, [`${key}_step`]: event.target.value }));
                    }}
                    onBlur={() => {
                      const parsed = Number.parseFloat(paramInputs[`${key}_step`] ?? "");
                      if (Number.isFinite(parsed) && parsed >= metadata.step) {
                        setExtendedParameterRange(key, [minValue, maxValue, parsed, true]);
                      } else {
                        setParamInputs((prev) => ({
                          ...prev,
                          [`${key}_step`]: stepValue.toFixed(precision),
                        }));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </div>
              </div>

              {/* Step suggestion alert */}
              {showStepSuggestion && (
                <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  <span>
                    Consider step size of {suggestedStep} for this range ({currentValueCount}{" "}
                    values)
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 text-xs px-2"
                    onClick={() =>
                      setExtendedParameterRange(key, [minValue, maxValue, suggestedStep, true])
                    }
                  >
                    Apply
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      );
    });
  };

  const progressPercent =
    progress && progress.totalCombinations
      ? Math.min(
          100,
          Math.round(((progress.testedCombinations ?? 0) / progress.totalCombinations) * 100),
        )
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              Define in-sample / out-of-sample cadence, optimization target, and parameter sweeps.
            </CardDescription>
          </div>
          {addon}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Analysis error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {autoConfigApplied && tradeFrequency && (
          <Alert
            className={
              constrainedByFrequency
                ? "border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/20"
                : undefined
            }
          >
            <Sparkles
              className={cn(
                "h-4 w-4",
                constrainedByFrequency && "text-amber-600 dark:text-amber-400",
              )}
            />
            <AlertTitle
              className={constrainedByFrequency ? "text-amber-800 dark:text-amber-300" : undefined}
            >
              {constrainedByFrequency
                ? "Auto-configured for low-frequency trading"
                : "Auto-configured for your trading frequency"}
            </AlertTitle>
            <AlertDescription
              className={
                constrainedByFrequency ? "text-amber-700/80 dark:text-amber-400/80" : undefined
              }
            >
              Detected ~{tradeFrequency.tradesPerMonth.toFixed(1)} trades/month (
              {tradeFrequency.totalTrades} trades over {Math.round(tradeFrequency.tradingDays / 30)}{" "}
              months).
              {constrainedByFrequency
                ? " With limited trade data, shorter windows and lower trade minimums are necessary to run analysis. Results may be noisier than high-frequency strategies."
                : " Window sizes adjusted to capture sufficient trades per period."}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label>In-Sample Days</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">In-Sample Window</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        The historical period used for optimization and parameter tuning.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        During this window, the algorithm tests different parameter combinations to
                        find the optimal settings based on your chosen metric. Larger windows
                        provide more data but may include outdated market regimes. Default: 45 days
                        (range: 30-60 days).
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <Input
              type="number"
              value={inSampleInput}
              onChange={(e) => setInSampleInput(e.target.value)}
              onBlur={handleInSampleBlur}
              onKeyDown={(e) => e.key === "Enter" && handleInSampleBlur()}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label>Out-of-Sample Days</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Out-of-Sample Window</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        The forward-testing period to validate optimized parameters on unseen data.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        This simulates real trading by applying optimized parameters to future data
                        they were never trained on. Performance here reveals whether results are
                        robust or just fit to historical noise. Default: 15 days (typically 1/3 of
                        in-sample, range: 10-20 days).
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <Input
              type="number"
              value={outOfSampleInput}
              onChange={(e) => setOutOfSampleInput(e.target.value)}
              onBlur={handleOutOfSampleBlur}
              onKeyDown={(e) => e.key === "Enter" && handleOutOfSampleBlur()}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label>Step Size (Days)</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Step Size</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        How many days to advance between each walk-forward iteration.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Smaller steps create more overlapping windows and test results, giving finer
                        granularity but increasing computation time. Larger steps move faster
                        through history with less overlap. Default: 15 days (equal to OOS window for
                        non-overlapping periods, range: 10-20 days).
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <Input
              type="number"
              value={stepSizeInput}
              onChange={(e) => setStepSizeInput(e.target.value)}
              onBlur={handleStepSizeBlur}
              onKeyDown={(e) => e.key === "Enter" && handleStepSizeBlur()}
            />
          </div>
        </div>

        {/* Pre-run configuration guidance */}
        {preRunObservations.length > 0 && (
          <div className="space-y-2">
            {preRunObservations.map((obs, idx) => (
              <Alert
                key={idx}
                className={cn(
                  "py-2",
                  obs.severity === "warning"
                    ? "border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20"
                    : "border-slate-300/50 bg-slate-50/50 dark:bg-slate-900/30",
                )}
              >
                <AlertCircle
                  className={cn(
                    "h-4 w-4",
                    obs.severity === "warning"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-slate-600 dark:text-slate-400",
                  )}
                />
                <AlertTitle
                  className={cn(
                    "text-sm",
                    obs.severity === "warning"
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-slate-700 dark:text-slate-300",
                  )}
                >
                  {obs.title}
                </AlertTitle>
                <AlertDescription
                  className={cn(
                    "text-xs",
                    obs.severity === "warning"
                      ? "text-amber-700/80 dark:text-amber-400/80"
                      : "text-slate-600/80 dark:text-slate-400/80",
                  )}
                >
                  {obs.description}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {/* Strategy Filter & Normalization Section */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
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
                        Select which strategies to include in the analysis.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Leave empty to include all strategies. Filter to focus on specific strategy
                        subsets or exclude strategies that don't fit your analysis.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <MultiSelect
              options={strategyOptions}
              defaultValue={selectedStrategies}
              onValueChange={setSelectedStrategies}
              placeholder={availableStrategies.length > 0 ? "All strategies" : "Loading..."}
              disabled={availableStrategies.length === 0}
              maxCount={2}
              searchable={availableStrategies.length > 5}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label htmlFor="normalize-1lot">Normalize to 1-Lot</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">1-Lot Normalization</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        Normalize all trades to single contracts before analysis.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Useful when your backtest uses cumulative position scaling. This removes
                        position size variations so you can evaluate the pure edge of your strategy
                        independent of sizing decisions.
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <div className="flex items-center gap-3 h-9 px-3 border rounded-md bg-background">
              <Switch
                id="normalize-1lot"
                checked={normalizeTo1Lot}
                onCheckedChange={setNormalizeTo1Lot}
              />
              <Label
                htmlFor="normalize-1lot"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                {normalizeTo1Lot ? "Enabled" : "Disabled"}
              </Label>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label>Optimization Target</Label>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </HoverCardTrigger>
                <HoverCardContent className="w-80 p-0 overflow-hidden">
                  <div className="space-y-3">
                    <div className="bg-primary/5 border-b px-4 py-3">
                      <h4 className="text-sm font-semibold text-primary">Optimization Target</h4>
                    </div>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm font-medium text-foreground leading-relaxed">
                        The performance metric to maximize when finding optimal parameters.
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Each in-sample window tests all parameter combinations and selects the one
                        with the highest value for this metric. Choose based on your priorities:
                        risk-adjusted returns (Sharpe/Sortino), total profit (Net P/L), or
                        consistency (Win Rate, Profit Factor).
                      </p>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </div>
            <Select
              value={config.optimizationTarget}
              onValueChange={(value) =>
                updateConfig({ optimizationTarget: value as WalkForwardOptimizationTarget })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Performance</SelectLabel>
                  {TARGET_OPTIONS.filter((o) => o.group === "performance").map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Risk-Adjusted</SelectLabel>
                  {TARGET_OPTIONS.filter((o) => o.group === "risk-adjusted").map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label>Min IS Trades</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Minimum In-Sample Trades
                        </h4>
                      </div>
                      <div className="px-4 pb-4">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Skip windows with fewer than this many trades in the optimization period.
                          Too few trades produce unreliable parameter estimates. Default: 15 trades
                          (minimum recommended for meaningful optimization).
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                type="number"
                value={minISTradesInput}
                onChange={(e) => setMinISTradesInput(e.target.value)}
                onBlur={handleMinISTradesBlur}
                onKeyDown={(e) => e.key === "Enter" && handleMinISTradesBlur()}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label>Min OOS Trades</Label>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-80 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">
                          Minimum Out-of-Sample Trades
                        </h4>
                      </div>
                      <div className="px-4 pb-4">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Skip windows with fewer than this many trades in the validation period. At
                          least 5-10 trades needed to meaningfully assess out-of-sample performance.
                        </p>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
              <Input
                type="number"
                value={minOOSTradesInput}
                onChange={(e) => setMinOOSTradesInput(e.target.value)}
                onBlur={handleMinOOSTradesBlur}
                onKeyDown={(e) => e.key === "Enter" && handleMinOOSTradesBlur()}
              />
            </div>
          </div>
        </div>

        {/* Nudge when no parameters enabled - above the collapsible so it's always visible */}
        {!Object.values(extendedParameterRanges).some(([, , , enabled]) => enabled) && (
          <div className="flex items-start gap-2.5 rounded-md border border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-950/20 px-3 py-2.5">
            <Sparkles className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
              Enable at least one parameter sweep to run the analysis. The optimizer tests
              combinations across your ranges to find the best settings for each window.
            </p>
          </div>
        )}

        <Collapsible open={parametersOpen} onOpenChange={setParametersOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-border/40 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">Parameter Sweeps</p>
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground/60 cursor-help" />
                  </HoverCardTrigger>
                  <HoverCardContent className="w-96 p-0 overflow-hidden">
                    <div className="space-y-3">
                      <div className="bg-primary/5 border-b px-4 py-3">
                        <h4 className="text-sm font-semibold text-primary">Parameter Sweeps</h4>
                      </div>
                      <div className="px-4 pb-4 space-y-3">
                        <p className="text-sm font-medium text-foreground leading-relaxed">
                          Define ranges for position sizing and risk control parameters to test.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          For each in-sample window, the optimizer tests all combinations within
                          these ranges to find the best settings. Wider ranges explore more
                          possibilities but increase computation time exponentially.
                        </p>
                        <div className="text-xs text-muted-foreground space-y-1 border-t border-border pt-2">
                          <p className="font-medium">Example:</p>
                          <p className="font-mono text-[10px] bg-muted/50 p-2 rounded">
                            Kelly: 0.5-1.5 (step 0.1) = 11 values
                            <br />
                            Max DD: 10-20 (step 2) = 6 values
                            <br />
                            Total: 11 × 6 = 66 combinations
                          </p>
                        </div>
                      </div>
                    </div>
                  </HoverCardContent>
                </HoverCard>
                <Badge variant="outline" className="text-xs">
                  {Object.values(extendedParameterRanges).some(([, , , enabled]) => enabled)
                    ? "Active"
                    : "Inactive"}
                </Badge>
                {/* Combination Estimate Badge - only show when parameters are enabled */}
                {combinationEstimate && combinationEstimate.enabledParameters.length > 0 && (
                  <Badge
                    variant={
                      combinationEstimate.warningLevel === "danger"
                        ? "destructive"
                        : combinationEstimate.warningLevel === "warning"
                          ? "secondary"
                          : "outline"
                    }
                    className={cn(
                      "text-xs",
                      combinationEstimate.warningLevel === "warning" &&
                        "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
                    )}
                  >
                    {combinationEstimate.count.toLocaleString()} combinations
                    {combinationEstimate.warningLevel === "danger" && " ⚠️"}
                    {combinationEstimate.warningLevel === "warning" && " ⚡"}
                  </Badge>
                )}
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  parametersOpen && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-4">
            {/* Combination breakdown */}
            {combinationEstimate && combinationEstimate.enabledParameters.length > 0 && (
              <div className="text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
                <span className="font-medium">Breakdown: </span>
                {combinationEstimate.enabledParameters.map((param, idx) => (
                  <span key={param}>
                    {PARAMETER_METADATA[param]?.label ?? param}:{" "}
                    {combinationEstimate.breakdown[param]}
                    {idx < combinationEstimate.enabledParameters.length - 1 && " × "}
                  </span>
                ))}
              </div>
            )}

            {/* Warning for high combination count */}
            {combinationEstimate?.warningLevel === "danger" && (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  High combination count may cause slow analysis. Consider disabling parameters,
                  narrowing ranges, or increasing step sizes.
                </AlertDescription>
              </Alert>
            )}

            <div className="grid gap-3 md:grid-cols-2">{renderParameterControls()}</div>
          </CollapsibleContent>
        </Collapsible>

        {/* Diversification Constraints */}
        <Collapsible open={diversificationOpen} onOpenChange={setDiversificationOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-border/40 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">Diversification Constraints</p>
                <Badge variant="outline" className="text-xs">
                  {diversificationConfig.enableCorrelationConstraint ||
                  diversificationConfig.enableTailRiskConstraint
                    ? "Active"
                    : "Inactive"}
                </Badge>
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  diversificationOpen && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-4">
            {/* Correlation Constraint */}
            <div
              className={cn(
                "space-y-3 rounded-lg border p-3",
                diversificationConfig.enableCorrelationConstraint
                  ? "border-border/40"
                  : "border-border/20 opacity-70",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="corr-constraint"
                    checked={diversificationConfig.enableCorrelationConstraint}
                    onCheckedChange={(checked) =>
                      updateDiversificationConfig({ enableCorrelationConstraint: Boolean(checked) })
                    }
                  />
                  <Label htmlFor="corr-constraint" className="text-sm font-medium cursor-pointer">
                    Correlation Constraint
                  </Label>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-0 overflow-hidden">
                      <div className="space-y-3">
                        <div className="bg-primary/5 border-b px-4 py-3">
                          <h4 className="text-sm font-semibold text-primary">
                            Correlation Constraint
                          </h4>
                        </div>
                        <div className="px-4 pb-4 space-y-3">
                          <p className="text-sm font-medium text-foreground leading-relaxed">
                            Reject parameter combinations with highly correlated strategies.
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            If any pair of strategies exceeds the max correlation threshold, that
                            parameter combination is rejected. This helps ensure portfolio
                            diversification.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
              </div>
              {diversificationConfig.enableCorrelationConstraint && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">
                      Max Correlation: {diversificationConfig.maxCorrelationThreshold}
                    </Label>
                    <Slider
                      min={0.1}
                      max={0.95}
                      step={0.05}
                      value={[diversificationConfig.maxCorrelationThreshold]}
                      onValueChange={([value]) =>
                        updateDiversificationConfig({ maxCorrelationThreshold: value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Method</Label>
                    <Select
                      value={diversificationConfig.correlationMethod}
                      onValueChange={(value: CorrelationMethodOption) =>
                        updateDiversificationConfig({ correlationMethod: value })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pearson">Pearson</SelectItem>
                        <SelectItem value="spearman">Spearman</SelectItem>
                        <SelectItem value="kendall">Kendall</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {/* Tail Risk Constraint */}
            <div
              className={cn(
                "space-y-3 rounded-lg border p-3",
                diversificationConfig.enableTailRiskConstraint
                  ? "border-border/40"
                  : "border-border/20 opacity-70",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="tail-constraint"
                    checked={diversificationConfig.enableTailRiskConstraint}
                    onCheckedChange={(checked) =>
                      updateDiversificationConfig({ enableTailRiskConstraint: Boolean(checked) })
                    }
                  />
                  <Label htmlFor="tail-constraint" className="text-sm font-medium cursor-pointer">
                    Tail Risk Constraint
                  </Label>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-0 overflow-hidden">
                      <div className="space-y-3">
                        <div className="bg-primary/5 border-b px-4 py-3">
                          <h4 className="text-sm font-semibold text-primary">
                            Tail Risk Constraint
                          </h4>
                        </div>
                        <div className="px-4 pb-4 space-y-3">
                          <p className="text-sm font-medium text-foreground leading-relaxed">
                            Reject combinations with high joint tail risk.
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Measures how likely strategies are to experience extreme losses
                            together. High tail dependence means strategies may all fail
                            simultaneously during market stress.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
              </div>
              {diversificationConfig.enableTailRiskConstraint && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">
                      Max Tail Dependence: {diversificationConfig.maxTailDependenceThreshold}
                    </Label>
                    <Slider
                      min={0.1}
                      max={0.9}
                      step={0.05}
                      value={[diversificationConfig.maxTailDependenceThreshold]}
                      onValueChange={([value]) =>
                        updateDiversificationConfig({ maxTailDependenceThreshold: value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">
                      Tail Threshold: {(diversificationConfig.tailThreshold * 100).toFixed(0)}%
                    </Label>
                    <Slider
                      min={0.05}
                      max={0.25}
                      step={0.01}
                      value={[diversificationConfig.tailThreshold]}
                      onValueChange={([value]) =>
                        updateDiversificationConfig({ tailThreshold: value })
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Shared Options */}
            {(diversificationConfig.enableCorrelationConstraint ||
              diversificationConfig.enableTailRiskConstraint) && (
              <div className="grid gap-4 md:grid-cols-2 pt-2 border-t border-border/40">
                <div className="space-y-2">
                  <Label className="text-xs">Return Normalization</Label>
                  <Select
                    value={diversificationConfig.normalization}
                    onValueChange={(value: "raw" | "margin" | "notional") =>
                      updateDiversificationConfig({ normalization: value })
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="raw">Raw P&L</SelectItem>
                      <SelectItem value="margin">Return on Margin</SelectItem>
                      <SelectItem value="notional">Return on Notional</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Date Basis</Label>
                  <Select
                    value={diversificationConfig.dateBasis}
                    onValueChange={(value: "opened" | "closed") =>
                      updateDiversificationConfig({ dateBasis: value })
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="opened">Trade Open Date</SelectItem>
                      <SelectItem value="closed">Trade Close Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        {/* Strategy Weight Sweeps - only show when multiple strategies are in the analysis */}
        {strategiesForWeightSweep.length > 1 && (
          <Collapsible open={strategyWeightsOpen} onOpenChange={setStrategyWeightsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-border/40 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">Strategy Weight Sweeps</p>
                  <Badge variant="outline" className="text-xs">
                    {filteredWeightConfigs.some((c) => c.enabled)
                      ? `${filteredWeightConfigs.filter((c) => c.enabled).length} active`
                      : "Inactive"}
                  </Badge>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    strategyWeightsOpen && "rotate-180",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-4">
              {/* Mode Selection (only shown for >3 strategies in the filter) */}
              {strategiesForWeightSweep.length > 3 && (
                <div className="space-y-2 p-3 rounded-lg bg-muted/30">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">Sweep Mode</Label>
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-0 overflow-hidden">
                        <div className="space-y-3">
                          <div className="bg-primary/5 border-b px-4 py-3">
                            <h4 className="text-sm font-semibold text-primary">Sweep Mode</h4>
                          </div>
                          <div className="px-4 pb-4 space-y-3">
                            <p className="text-sm font-medium text-foreground leading-relaxed">
                              With {strategiesForWeightSweep.length} strategies, full range sweeps
                              would create too many combinations.
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              <strong>Binary:</strong> Include (1.0) or exclude (0.0) each strategy.
                              <br />
                              <strong>Top N:</strong> Only sweep weight ranges for top N strategies,
                              others fixed at 1.0.
                            </p>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="sweep-mode"
                        checked={strategyWeightSweep.mode === "binary"}
                        onChange={() => setStrategyWeightMode("binary")}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">Binary (Include/Exclude)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="sweep-mode"
                        checked={strategyWeightSweep.mode === "topN"}
                        onChange={() => setStrategyWeightMode("topN")}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">Top N Auto-Select</span>
                    </label>
                  </div>
                  {strategyWeightSweep.mode === "topN" && (
                    <div className="flex items-center gap-2 pt-1">
                      <Label className="text-xs">Top strategies to sweep:</Label>
                      <Input
                        type="number"
                        min={1}
                        max={Math.min(5, strategiesForWeightSweep.length)}
                        value={strategyWeightSweep.topNCount}
                        onChange={(e) => setTopNCount(Number(e.target.value))}
                        className="h-7 w-16"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Strategy Selection via MultiSelect */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Strategies to Sweep</Label>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-0 overflow-hidden">
                      <div className="space-y-3">
                        <div className="bg-primary/5 border-b px-4 py-3">
                          <h4 className="text-sm font-semibold text-primary">
                            Strategy Weight Sweeps
                          </h4>
                        </div>
                        <div className="px-4 pb-4 space-y-3">
                          <p className="text-sm font-medium text-foreground leading-relaxed">
                            Optimize allocation weights for selected strategies.
                          </p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Select which strategies should have their weights swept during
                            optimization. Weights range from 0 (exclude) to 2 (double weight).
                            Strategies not selected will use weight 1.0.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
                <MultiSelect
                  options={strategiesForWeightSweep.map((s) => ({ label: s, value: s }))}
                  defaultValue={filteredWeightConfigs
                    .filter((c) => c.enabled)
                    .map((c) => c.strategy)}
                  onValueChange={(selected) => {
                    // Update enabled state for all strategies
                    filteredWeightConfigs.forEach((config) => {
                      const shouldEnable = selected.includes(config.strategy);
                      if (config.enabled !== shouldEnable) {
                        toggleStrategyWeight(config.strategy, shouldEnable);
                      }
                    });
                  }}
                  placeholder="Select strategies to sweep weights..."
                  maxCount={3}
                  searchable={strategiesForWeightSweep.length > 5}
                />
              </div>

              {/* Weight Range Controls - only show when strategies are enabled */}
              {filteredWeightConfigs.some((c) => c.enabled) && (
                <div className="space-y-3">
                  <Label className="text-xs text-muted-foreground">Weight Ranges</Label>
                  <div className="grid gap-3 md:grid-cols-2">
                    {filteredWeightConfigs
                      .filter((config) => config.enabled)
                      .map((config) => (
                        <div
                          key={config.strategy}
                          className="rounded-lg border border-border/40 p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{config.strategy}</span>
                            <Badge variant="secondary" className="text-xs">
                              {config.range[0]} – {config.range[1]}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Min</Label>
                              <Input
                                type="number"
                                step={0.25}
                                min={0}
                                max={2}
                                value={config.range[0]}
                                onChange={(e) =>
                                  setStrategyWeightConfig(config.strategy, {
                                    range: [
                                      Number(e.target.value),
                                      config.range[1],
                                      config.range[2],
                                    ],
                                  })
                                }
                                className="h-7"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Max</Label>
                              <Input
                                type="number"
                                step={0.25}
                                min={0}
                                max={2}
                                value={config.range[1]}
                                onChange={(e) =>
                                  setStrategyWeightConfig(config.strategy, {
                                    range: [
                                      config.range[0],
                                      Number(e.target.value),
                                      config.range[2],
                                    ],
                                  })
                                }
                                className="h-7"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Step</Label>
                              <Input
                                type="number"
                                step={0.01}
                                min={0.01}
                                max={0.5}
                                value={config.range[2]}
                                onChange={(e) =>
                                  setStrategyWeightConfig(config.strategy, {
                                    range: [
                                      config.range[0],
                                      config.range[1],
                                      Number(e.target.value),
                                    ],
                                  })
                                }
                                className="h-7"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {strategiesForWeightSweep.length <= 3 && (
                <p className="text-xs text-muted-foreground">
                  With ≤3 strategies, full range sweeps are available for all selected strategies.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="space-y-3 rounded-lg border border-dashed border-primary/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-primary">Analysis Controls</p>
              <p className="text-xs text-muted-foreground">
                {progress ? progress.phase : "Awaiting run"}
              </p>
            </div>
            <div className="flex gap-2">
              {isRunning ? (
                <Button variant="outline" onClick={cancelAnalysis} size="sm">
                  <Square className="mr-2 h-3.5 w-3.5" />
                  Cancel
                </Button>
              ) : null}
              <Button onClick={handleRun} disabled={disableRun} size="sm">
                {isRunning ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <IconPlayerPlay className="mr-2 h-3.5 w-3.5" />
                    Run Analysis
                  </>
                )}
              </Button>
            </div>
          </div>
          {progress && progress.totalCombinations ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Window {progress.currentPeriod}/{progress.totalPeriods}
                </span>
                <span>
                  {progress.testedCombinations}/{progress.totalCombinations} combos tested
                </span>
              </div>
              <Progress value={progressPercent} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Progress updates will appear here once the engine starts crunching windows.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
