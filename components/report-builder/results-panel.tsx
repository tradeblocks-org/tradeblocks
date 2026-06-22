"use client";

/**
 * Results Panel
 *
 * Right panel of the Report Builder showing the chart builder and comparison stats.
 * Wrapped in React.memo for performance - only re-renders when props actually change.
 */

import { memo, useState, useEffect } from "react";
import { MultiSelect } from "@/components/multi-select";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { RegimeComparisonStats } from "@tradeblocks/lib";
import { EnrichedTrade } from "@tradeblocks/lib";
import {
  CHART_TYPE_LABELS,
  ChartAxisConfig,
  ChartType,
  StaticDatasetFieldInfo,
  TABLE_COLUMN_OPTIONS,
  THRESHOLD_METRIC_LABELS,
  ThresholdMetric,
} from "@tradeblocks/lib";
import { isDiscreteTimingField } from "@tradeblocks/lib";
import { HelpCircle } from "lucide-react";
import { BucketEditor } from "./bucket-editor";
import { ChartAxisSelector } from "./chart-axis-selector";
import { ComparisonSummaryCard } from "./comparison-summary-card";
import { CustomChart } from "./custom-chart";
import { CustomTable } from "./custom-table";
import { HistogramChart } from "./histogram-chart";
import { ScatterChart } from "./scatter-chart";
import { ThresholdChart } from "./threshold-chart";

/**
 * Tooltip content for each chart type
 */
const CHART_TYPE_TOOLTIPS: Record<ChartType, { flavor: string; detailed: string }> = {
  scatter: {
    flavor: "How do two metrics relate to each other across your trades?",
    detailed:
      "Scatter plots reveal correlations and patterns between any two fields. Use Color By to highlight winners/losers, or Size By to emphasize trade magnitude. Great for finding relationships like 'do longer holds produce better returns?'",
  },
  line: {
    flavor: "How does a metric trend over time or another ordered variable?",
    detailed:
      "Line charts connect points in order, ideal for time series or sequential analysis. Add multiple Y-axes to compare different metrics on the same timeline. Perfect for spotting trends in your trading performance.",
  },
  histogram: {
    flavor: "How are your trade values distributed?",
    detailed:
      "Histograms show the frequency distribution of a single metric. Use this to understand typical ranges, identify outliers, and see if your results follow expected patterns like normal distribution.",
  },
  bar: {
    flavor: "How do averages compare across different value ranges?",
    detailed:
      "Bar charts group trades into buckets by X-axis value and show the average Y value for each bucket. Useful for questions like 'what's the average P/L for trades at different delta levels?'",
  },
  box: {
    flavor: "How does the spread of outcomes vary across quartiles?",
    detailed:
      "Box plots divide your X-axis values into quartiles (Q1-Q4) and show the distribution of Y values in each. Reveals not just averages but variability - are high-delta trades more consistent or more volatile?",
  },
  threshold: {
    flavor: "Where should you set your entry or exit filter thresholds?",
    detailed:
      "Threshold analysis helps optimize filter cutoffs. The cumulative lines show what percentage of trades and P/L fall below each threshold. The dots show average returns above vs below each point - look for thresholds where 'above' significantly outperforms 'below'.",
  },
  table: {
    flavor: "What are the aggregate statistics for each value bucket?",
    detailed:
      "The table view groups trades by X-axis ranges and calculates statistics for each bucket. Compare win rates, average P/L, trade counts, and more across different segments of your data.",
  },
};

/**
 * Tooltip component for chart type explanation
 */
function ChartTypeTooltip({ chartType }: { chartType: ChartType }) {
  const tooltip = CHART_TYPE_TOOLTIPS[chartType];
  const title = CHART_TYPE_LABELS[chartType];

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60 cursor-help" />
      </HoverCardTrigger>
      <HoverCardContent className="w-80 p-0 overflow-hidden">
        <div className="space-y-3">
          <div className="bg-primary/5 border-b px-4 py-3">
            <h4 className="text-sm font-semibold text-primary">{title}</h4>
          </div>
          <div className="px-4 pb-4 space-y-3">
            <p className="text-sm font-medium text-foreground leading-relaxed">{tooltip.flavor}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{tooltip.detailed}</p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

interface ResultsPanelProps {
  trades: EnrichedTrade[];
  filteredTrades: EnrichedTrade[];
  comparisonStats: RegimeComparisonStats | null;
  chartType: ChartType;
  xAxis: ChartAxisConfig;
  yAxis: ChartAxisConfig;
  yAxis2?: ChartAxisConfig;
  yAxis3?: ChartAxisConfig;
  colorBy?: ChartAxisConfig;
  sizeBy?: ChartAxisConfig;
  tableBuckets: number[];
  tableColumns: string[];
  thresholdMetric: ThresholdMetric;
  boxBucketCount: number;
  reportName?: string; // Name of loaded/saved report
  showWhatIf: boolean;
  staticDatasets?: StaticDatasetFieldInfo[];
  onShowWhatIfChange: (show: boolean) => void;
  onChartTypeChange: (type: ChartType) => void;
  onXAxisChange: (field: string) => void;
  onYAxisChange: (field: string) => void;
  onYAxis2Change: (field: string) => void;
  onYAxis3Change: (field: string) => void;
  onColorByChange: (field: string) => void;
  onSizeByChange: (field: string) => void;
  onTableBucketsChange: (buckets: number[]) => void;
  onTableColumnsChange: (columns: string[]) => void;
  onThresholdMetricChange: (metric: ThresholdMetric) => void;
  onBoxBucketCountChange: (count: number) => void;
}

export const ResultsPanel = memo(function ResultsPanel({
  trades,
  filteredTrades,
  comparisonStats,
  chartType,
  xAxis,
  yAxis,
  yAxis2,
  yAxis3,
  colorBy,
  sizeBy,
  tableBuckets,
  tableColumns,
  thresholdMetric,
  boxBucketCount,
  reportName,
  showWhatIf,
  staticDatasets,
  onShowWhatIfChange,
  onChartTypeChange,
  onXAxisChange,
  onYAxisChange,
  onYAxis2Change,
  onYAxis3Change,
  onColorByChange,
  onSizeByChange,
  onTableBucketsChange,
  onTableColumnsChange,
  onThresholdMetricChange,
  onBoxBucketCountChange,
}: ResultsPanelProps) {
  // Check if we're showing a filtered subset
  const isFiltered = filteredTrades.length !== trades.length;

  // Determine number of columns for non-scatter/line layouts
  const getGridCols = () => {
    if (chartType === "histogram") return "grid-cols-2 lg:grid-cols-3"; // type + x + metric
    if (chartType === "threshold") return "grid-cols-2 lg:grid-cols-3"; // type + x + metric
    if (chartType === "table") return "grid-cols-2"; // type + x (buckets on second row)
    if (chartType === "box") return "grid-cols-2 lg:grid-cols-4"; // type + x + y + buckets
    return "grid-cols-2 lg:grid-cols-3"; // type + x + y (bar)
  };

  // State for box bucket count input (two-state pattern for free editing)
  const [boxBucketInputValue, setBoxBucketInputValue] = useState<string>(String(boxBucketCount));

  // Sync input value when prop changes (e.g., loading a saved report)
  useEffect(() => {
    setBoxBucketInputValue(String(boxBucketCount));
  }, [boxBucketCount]);

  const handleBoxBucketBlur = () => {
    const val = parseInt(boxBucketInputValue, 10);
    if (!isNaN(val) && val >= 2) {
      onBoxBucketCountChange(val);
      setBoxBucketInputValue(String(val));
    } else {
      // Revert to last valid value
      setBoxBucketInputValue(String(boxBucketCount));
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      {/* Chart Configuration */}
      <Card className="min-w-0">
        <CardHeader className="pb-2 space-y-2">
          {/* Report title (only shown when a report is loaded) */}
          {reportName && <h3 className="text-base font-semibold">{reportName}</h3>}

          {/* Compact controls row */}
          {chartType === "scatter" || chartType === "line" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2 items-end">
              {/* Chart type selector */}
              <div className="min-w-0">
                <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  Chart Type
                  <ChartTypeTooltip chartType={chartType} />
                </Label>
                <Select value={chartType} onValueChange={(v) => onChartTypeChange(v as ChartType)}>
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CHART_TYPE_LABELS).map(([type, label]) => (
                      <SelectItem key={type} value={type}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* X Axis */}
              <ChartAxisSelector
                label="X Axis"
                value={xAxis.field}
                onChange={onXAxisChange}
                trades={trades}
                staticDatasets={staticDatasets}
              />

              {/* Y axes on the same row for better balance */}
              <ChartAxisSelector
                label="Y Axis (Primary)"
                value={yAxis.field}
                onChange={onYAxisChange}
                trades={trades}
                staticDatasets={staticDatasets}
              />
              <ChartAxisSelector
                label="Y Axis 2 (Right)"
                value={yAxis2?.field ?? "none"}
                onChange={onYAxis2Change}
                allowNone
                trades={trades}
                staticDatasets={staticDatasets}
              />
              <ChartAxisSelector
                label="Y Axis 3 (Far Right)"
                value={yAxis3?.field ?? "none"}
                onChange={onYAxis3Change}
                allowNone
                trades={trades}
                staticDatasets={staticDatasets}
              />
            </div>
          ) : (
            <div className={`grid ${getGridCols()} gap-2 items-end`}>
              {/* Chart type selector */}
              <div className="min-w-0">
                <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  Chart Type
                  <ChartTypeTooltip chartType={chartType} />
                </Label>
                <Select value={chartType} onValueChange={(v) => onChartTypeChange(v as ChartType)}>
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CHART_TYPE_LABELS).map(([type, label]) => (
                      <SelectItem key={type} value={type}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* X Axis / Group By / Analyze Field */}
              <ChartAxisSelector
                label={
                  chartType === "table"
                    ? "Group By"
                    : chartType === "threshold"
                      ? "Analyze Field"
                      : "X Axis"
                }
                value={xAxis.field}
                onChange={onXAxisChange}
                trades={trades}
                staticDatasets={staticDatasets}
              />

              {/* Y Axis (for bar, box) */}
              {(chartType === "bar" || chartType === "box") && (
                <ChartAxisSelector
                  label="Y Axis"
                  value={yAxis.field}
                  onChange={onYAxisChange}
                  trades={trades}
                />
              )}

              {/* Bucket count for box plot (hidden for discrete timing fields which use natural categories) */}
              {chartType === "box" && !isDiscreteTimingField(xAxis.field) && (
                <div className="min-w-0">
                  <Label className="text-xs text-muted-foreground mb-1 block">Buckets</Label>
                  <Input
                    type="number"
                    min={2}
                    className="h-8 w-full"
                    value={boxBucketInputValue}
                    onChange={(e) => setBoxBucketInputValue(e.target.value)}
                    onBlur={handleBoxBucketBlur}
                    onKeyDown={(e) => e.key === "Enter" && handleBoxBucketBlur()}
                  />
                </div>
              )}

              {/* Metric selector for threshold and histogram */}
              {(chartType === "threshold" || chartType === "histogram") && (
                <div className="min-w-0">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    {chartType === "histogram" ? "Metric (What-If)" : "Metric"}
                  </Label>
                  <Select
                    value={thresholdMetric}
                    onValueChange={(v) => onThresholdMetricChange(v as ThresholdMetric)}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(THRESHOLD_METRIC_LABELS).map(([metric, label]) => (
                        <SelectItem key={metric} value={metric}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {/* Scatter-specific secondary controls - Color/Size/What-If */}
          {chartType === "scatter" && (
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
              <div className="sm:col-span-2">
                <ChartAxisSelector
                  label="Color By"
                  value={colorBy?.field ?? "none"}
                  onChange={onColorByChange}
                  allowNone
                  trades={trades}
                />
              </div>
              <div className="sm:col-span-2">
                <ChartAxisSelector
                  label="Size By"
                  value={sizeBy?.field ?? "none"}
                  onChange={onSizeByChange}
                  allowNone
                  trades={trades}
                />
              </div>
              <div className={showWhatIf ? "" : "sm:col-span-2"}>
                <Label className="text-xs text-muted-foreground mb-1 block">What-If Analysis</Label>
                <div className="flex items-center gap-2 h-8">
                  <Switch
                    id="what-if-toggle"
                    checked={showWhatIf}
                    onCheckedChange={onShowWhatIfChange}
                  />
                  <Label htmlFor="what-if-toggle" className="text-xs cursor-pointer">
                    {showWhatIf ? "On" : "Off"}
                  </Label>
                </div>
              </div>
              {showWhatIf && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Metric</Label>
                  <Select
                    value={thresholdMetric}
                    onValueChange={(v) => onThresholdMetricChange(v as ThresholdMetric)}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(THRESHOLD_METRIC_LABELS).map(([metric, label]) => (
                        <SelectItem key={metric} value={metric}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {/* Table-specific controls (buckets and columns) */}
          {chartType === "table" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              <BucketEditor
                field={xAxis.field}
                value={tableBuckets}
                onChange={onTableBucketsChange}
              />
              <div className="min-w-0">
                <Label className="text-xs text-muted-foreground mb-1 block">Columns</Label>
                <MultiSelect
                  options={TABLE_COLUMN_OPTIONS}
                  defaultValue={tableColumns}
                  onValueChange={onTableColumnsChange}
                  placeholder="Select columns..."
                  maxCount={4}
                  hideSelectAll
                />
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className={chartType === "table" ? "overflow-hidden" : ""}>
          {chartType === "table" ? (
            <CustomTable
              trades={filteredTrades}
              xAxis={xAxis}
              bucketEdges={tableBuckets}
              selectedColumns={tableColumns}
            />
          ) : chartType === "threshold" ? (
            <ThresholdChart trades={filteredTrades} xAxis={xAxis} metric={thresholdMetric} />
          ) : chartType === "histogram" ? (
            <HistogramChart trades={filteredTrades} xAxis={xAxis} metric={thresholdMetric} />
          ) : chartType === "scatter" ? (
            <ScatterChart
              trades={filteredTrades}
              xAxis={xAxis}
              yAxis={yAxis}
              yAxis2={yAxis2}
              yAxis3={yAxis3}
              colorBy={colorBy}
              sizeBy={sizeBy}
              metric={thresholdMetric}
              showWhatIf={showWhatIf}
            />
          ) : (
            <CustomChart
              trades={filteredTrades}
              chartType={chartType}
              xAxis={xAxis}
              yAxis={yAxis}
              yAxis2={yAxis2}
              yAxis3={yAxis3}
              colorBy={colorBy}
              sizeBy={sizeBy}
              boxBucketCount={boxBucketCount}
            />
          )}

          {/* Trade count */}
          <div className="text-sm text-muted-foreground text-center mt-2">
            Showing {filteredTrades.length} of {trades.length} trades
            {isFiltered && (
              <span className="ml-1">
                ({((filteredTrades.length / trades.length) * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Comparison Stats - Only show when filtered */}
      {isFiltered && comparisonStats && <ComparisonSummaryCard stats={comparisonStats} />}
    </div>
  );
});

export default ResultsPanel;
