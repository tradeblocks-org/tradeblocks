"use client";

/**
 * Report Builder Tab
 *
 * Main container for the Custom Report Builder.
 * Provides flexible filtering and chart building capabilities.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Filter, ChevronRight } from "lucide-react";
import { usePerformanceStore } from "@tradeblocks/lib/stores";
import { useSettingsStore } from "@tradeblocks/lib/stores";
import { useStaticDatasetsStore } from "@tradeblocks/lib/stores";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FilterConfig,
  ChartType,
  ChartAxisConfig,
  ReportConfig,
  ThresholdMetric,
  StaticDatasetFieldInfo,
  createEmptyFilterConfig,
  DEFAULT_TABLE_COLUMNS,
} from "@tradeblocks/lib";
import { applyFilters, FlexibleFilterResult } from "@tradeblocks/lib";
import { calculateRegimeComparison, RegimeComparisonStats } from "@tradeblocks/lib";
import { getDefaultBucketEdges } from "@tradeblocks/lib";
import { FilterPanel } from "./filter-panel";
import { MetricsGuideDialog } from "./metrics-guide-dialog";
import { ResultsPanel } from "./results-panel";
import { SavedReportsDropdown } from "./saved-reports-dropdown";
import { SaveReportDialog } from "./save-report-dialog";

export function ReportBuilderTab() {
  const data = usePerformanceStore((state) => state.data);
  const initialize = useSettingsStore((state) => state.initialize);
  const staticDatasets = useStaticDatasetsStore((state) => state.datasets);
  const loadStaticDatasets = useStaticDatasetsStore((state) => state.loadDatasets);
  const isStaticDatasetsInitialized = useStaticDatasetsStore((state) => state.isInitialized);

  // Initialize settings store and static datasets on mount
  useEffect(() => {
    initialize();
    if (!isStaticDatasetsInitialized) {
      loadStaticDatasets();
    }
  }, [initialize, loadStaticDatasets, isStaticDatasetsInitialized]);

  // Convert static datasets to field info format for Report Builder
  const staticDatasetFieldInfo: StaticDatasetFieldInfo[] = useMemo(() => {
    return staticDatasets.map((ds) => ({
      datasetName: ds.name,
      columns: ds.columns,
    }));
  }, [staticDatasets]);

  // Filter state
  const [filterConfig, setFilterConfig] = useState<FilterConfig>(createEmptyFilterConfig());
  const [showFilters, setShowFilters] = useState(false);

  // Chart configuration state
  const [chartType, setChartType] = useState<ChartType>("scatter");
  const [xAxis, setXAxis] = useState<ChartAxisConfig>({
    field: "openingVix",
    label: "Opening VIX",
  });
  const [yAxis, setYAxis] = useState<ChartAxisConfig>({ field: "pl", label: "Profit/Loss" });
  const [yAxis2, setYAxis2] = useState<ChartAxisConfig | undefined>(undefined);
  const [yAxis3, setYAxis3] = useState<ChartAxisConfig | undefined>(undefined);
  const [colorBy, setColorBy] = useState<ChartAxisConfig | undefined>(undefined);
  const [sizeBy, setSizeBy] = useState<ChartAxisConfig | undefined>(undefined);
  const [tableBuckets, setTableBuckets] = useState<number[]>(() =>
    getDefaultBucketEdges("openingVix"),
  );
  const [tableColumns, setTableColumns] = useState<string[]>(DEFAULT_TABLE_COLUMNS);
  const [thresholdMetric, setThresholdMetric] = useState<ThresholdMetric>("plPct");
  const [boxBucketCount, setBoxBucketCount] = useState<number>(4);
  const [reportName, setReportName] = useState<string | undefined>(undefined);
  const [showWhatIf, setShowWhatIf] = useState(true);
  const [keepFilters, setKeepFilters] = useState(false);

  const handleFilterChange = useCallback((config: FilterConfig) => {
    setFilterConfig(config);
    setReportName(undefined);
  }, []);

  // Load a saved report
  const handleLoadReport = useCallback(
    (report: ReportConfig) => {
      // Only replace filters if keepFilters is off
      if (!keepFilters) {
        setFilterConfig(report.filter);
      }
      setChartType(report.chartType);
      setXAxis(report.xAxis);
      setYAxis(report.yAxis);
      setYAxis2(report.yAxis2);
      setYAxis3(report.yAxis3);
      setColorBy(report.colorBy);
      setSizeBy(report.sizeBy);
      setTableBuckets(report.tableBuckets ?? getDefaultBucketEdges(report.xAxis.field));
      setTableColumns(report.tableColumns ?? DEFAULT_TABLE_COLUMNS);
      setThresholdMetric(report.thresholdMetric ?? "plPct");
      setBoxBucketCount(report.boxBucketCount ?? 4);
      setReportName(keepFilters ? undefined : report.name);
    },
    [keepFilters],
  );

  // Use pre-computed enriched trades from the performance store
  // These are cached at upload time for instant access
  const enrichedTrades = useMemo(() => data?.enrichedTrades ?? [], [data?.enrichedTrades]);

  // Calculate filtered results using enriched trades
  const filterResult = useMemo((): FlexibleFilterResult | null => {
    if (enrichedTrades.length === 0) {
      return null;
    }
    return applyFilters(enrichedTrades, filterConfig);
  }, [enrichedTrades, filterConfig]);

  // Calculate comparison stats
  const comparisonStats = useMemo((): RegimeComparisonStats | null => {
    if (!filterResult || enrichedTrades.length === 0) {
      return null;
    }
    return calculateRegimeComparison(filterResult.filteredTrades, enrichedTrades);
  }, [filterResult, enrichedTrades]);

  // Axis change handlers - memoized to prevent child re-renders
  const handleXAxisChange = useCallback((field: string) => {
    setXAxis({ field, label: field });
    // Reset table buckets to defaults for new field
    setTableBuckets(getDefaultBucketEdges(field));
    setReportName(undefined);
  }, []);

  const handleYAxisChange = useCallback((field: string) => {
    setYAxis({ field, label: field });
    setReportName(undefined);
  }, []);

  const handleYAxis2Change = useCallback((field: string) => {
    if (field === "none") {
      setYAxis2(undefined);
    } else {
      setYAxis2({ field, label: field });
    }
    setReportName(undefined);
  }, []);

  const handleYAxis3Change = useCallback((field: string) => {
    if (field === "none") {
      setYAxis3(undefined);
    } else {
      setYAxis3({ field, label: field });
    }
    setReportName(undefined);
  }, []);

  const handleColorByChange = useCallback((field: string) => {
    if (field === "none") {
      setColorBy(undefined);
    } else {
      setColorBy({ field, label: field });
    }
    setReportName(undefined);
  }, []);

  const handleSizeByChange = useCallback((field: string) => {
    if (field === "none") {
      setSizeBy(undefined);
    } else {
      setSizeBy({ field, label: field });
    }
    setReportName(undefined);
  }, []);

  const handleChartTypeChange = useCallback((type: ChartType) => {
    setChartType(type);
    setReportName(undefined);
  }, []);

  const handleTableBucketsChange = useCallback((buckets: number[]) => {
    setTableBuckets(buckets);
    setReportName(undefined);
  }, []);

  const handleTableColumnsChange = useCallback((columns: string[]) => {
    setTableColumns(columns);
    setReportName(undefined);
  }, []);

  const handleThresholdMetricChange = useCallback((metric: ThresholdMetric) => {
    setThresholdMetric(metric);
    setReportName(undefined);
  }, []);

  const handleBoxBucketCountChange = useCallback((count: number) => {
    setBoxBucketCount(count);
    setReportName(undefined);
  }, []);

  if (enrichedTrades.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No trade data available. Import a trade log to use the Report Builder.
      </div>
    );
  }

  const activeFilterCount = filterConfig.conditions.filter((c) => c.enabled).length;

  return (
    <div className="space-y-4">
      {/* Header with Save/Load and Filter Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SavedReportsDropdown onSelect={handleLoadReport} />
          <SaveReportDialog
            filterConfig={filterConfig}
            chartType={chartType}
            xAxis={xAxis}
            yAxis={yAxis}
            yAxis2={yAxis2}
            yAxis3={yAxis3}
            colorBy={colorBy}
            sizeBy={sizeBy}
            tableBuckets={tableBuckets}
            tableColumns={tableColumns}
            thresholdMetric={thresholdMetric}
            boxBucketCount={boxBucketCount}
          />
        </div>
        <div className="flex items-center gap-2">
          <MetricsGuideDialog />
          <Button
            variant={showFilters ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-2"
          >
            <Filter className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
              >
                {activeFilterCount}
              </Badge>
            )}
            <ChevronRight
              className={`h-4 w-4 transition-transform ${showFilters ? "rotate-90" : ""}`}
            />
          </Button>
        </div>
      </div>

      {/* Main Content - Chart with optional Filter Panel */}
      <div className={`grid grid-cols-1 gap-6 ${showFilters ? "lg:grid-cols-[1fr_300px]" : ""}`}>
        {/* Left Panel - Chart Builder (takes full width when filters hidden) */}
        <ResultsPanel
          trades={enrichedTrades}
          filteredTrades={filterResult?.filteredTrades ?? enrichedTrades}
          comparisonStats={comparisonStats}
          chartType={chartType}
          xAxis={xAxis}
          yAxis={yAxis}
          yAxis2={yAxis2}
          yAxis3={yAxis3}
          colorBy={colorBy}
          sizeBy={sizeBy}
          tableBuckets={tableBuckets}
          tableColumns={tableColumns}
          thresholdMetric={thresholdMetric}
          boxBucketCount={boxBucketCount}
          reportName={reportName}
          showWhatIf={showWhatIf}
          staticDatasets={staticDatasetFieldInfo}
          onShowWhatIfChange={setShowWhatIf}
          onChartTypeChange={handleChartTypeChange}
          onXAxisChange={handleXAxisChange}
          onYAxisChange={handleYAxisChange}
          onYAxis2Change={handleYAxis2Change}
          onYAxis3Change={handleYAxis3Change}
          onColorByChange={handleColorByChange}
          onSizeByChange={handleSizeByChange}
          onTableBucketsChange={handleTableBucketsChange}
          onTableColumnsChange={handleTableColumnsChange}
          onThresholdMetricChange={handleThresholdMetricChange}
          onBoxBucketCountChange={handleBoxBucketCountChange}
        />

        {/* Right Panel - Filters (only shown when toggled) */}
        {showFilters && (
          <FilterPanel
            filterConfig={filterConfig}
            onFilterChange={handleFilterChange}
            filterResult={filterResult}
            trades={enrichedTrades}
            staticDatasets={staticDatasetFieldInfo}
            keepFilters={keepFilters}
            onKeepFiltersChange={setKeepFilters}
          />
        )}
      </div>
    </div>
  );
}

export default ReportBuilderTab;
