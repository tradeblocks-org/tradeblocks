"use client";

/**
 * Save Report Dialog
 *
 * Modal dialog to save the current report configuration.
 */

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettingsStore } from "@tradeblocks/lib/stores";
import {
  FilterConfig,
  ChartType,
  ChartAxisConfig,
  ThresholdMetric,
  getFieldInfo,
  getColumnLabel,
  FILTER_OPERATOR_LABELS,
  CHART_TYPE_LABELS,
  THRESHOLD_METRIC_LABELS,
} from "@tradeblocks/lib";

interface SaveReportDialogProps {
  filterConfig: FilterConfig;
  chartType: ChartType;
  xAxis: ChartAxisConfig;
  yAxis: ChartAxisConfig;
  yAxis2?: ChartAxisConfig;
  yAxis3?: ChartAxisConfig;
  colorBy?: ChartAxisConfig;
  sizeBy?: ChartAxisConfig;
  tableBuckets?: number[];
  tableColumns?: string[];
  thresholdMetric?: ThresholdMetric;
  boxBucketCount?: number;
}

export function SaveReportDialog({
  filterConfig,
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
}: SaveReportDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const saveReport = useSettingsStore((state) => state.saveReport);

  const handleSave = () => {
    if (!name.trim()) return;

    saveReport({
      name: name.trim(),
      filter: filterConfig,
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
    });

    setName("");
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Save className="h-4 w-4" />
          Save Report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Save Report</DialogTitle>
          <DialogDescription>
            Save the current filter and chart configuration as a reusable report.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="report-name">Report Name</Label>
            <Input
              id="report-name"
              placeholder="My Custom Report"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              <strong>Chart Type:</strong> {CHART_TYPE_LABELS[chartType]}
            </p>
            {/* X Axis label varies by chart type */}
            <p>
              <strong>
                {chartType === "table"
                  ? "Group By"
                  : chartType === "threshold"
                    ? "Analyze Field"
                    : "X Axis"}
                :
              </strong>{" "}
              {getFieldInfo(xAxis.field)?.label || xAxis.field}
            </p>
            {/* Y Axis - not shown for table or histogram */}
            {chartType !== "table" && chartType !== "histogram" && (
              <p>
                <strong>Y Axis:</strong> {getFieldInfo(yAxis.field)?.label || yAxis.field}
              </p>
            )}
            {/* Additional Y axes for scatter/line only */}
            {(chartType === "scatter" || chartType === "line") &&
              yAxis2 &&
              yAxis2.field !== "none" && (
                <p>
                  <strong>Y Axis 2:</strong> {getFieldInfo(yAxis2.field)?.label || yAxis2.field}
                </p>
              )}
            {(chartType === "scatter" || chartType === "line") &&
              yAxis3 &&
              yAxis3.field !== "none" && (
                <p>
                  <strong>Y Axis 3:</strong> {getFieldInfo(yAxis3.field)?.label || yAxis3.field}
                </p>
              )}
            {/* Color/Size for scatter only */}
            {chartType === "scatter" && colorBy && colorBy.field !== "none" && (
              <p>
                <strong>Color By:</strong> {getFieldInfo(colorBy.field)?.label || colorBy.field}
              </p>
            )}
            {chartType === "scatter" && sizeBy && sizeBy.field !== "none" && (
              <p>
                <strong>Size By:</strong> {getFieldInfo(sizeBy.field)?.label || sizeBy.field}
              </p>
            )}
            {/* Threshold metric */}
            {chartType === "threshold" && thresholdMetric && (
              <p>
                <strong>Metric:</strong> {THRESHOLD_METRIC_LABELS[thresholdMetric]}
              </p>
            )}
            {/* Box plot bucket count */}
            {chartType === "box" && boxBucketCount && (
              <p>
                <strong>Buckets:</strong> {boxBucketCount}
              </p>
            )}
            {/* Table buckets and columns */}
            {chartType === "table" && tableBuckets && tableBuckets.length > 0 && (
              <p>
                <strong>Buckets:</strong> {tableBuckets.join(", ")}
              </p>
            )}
            {chartType === "table" && tableColumns && tableColumns.length > 0 && (
              <p>
                <strong>Columns:</strong> {tableColumns.map((c) => getColumnLabel(c)).join(", ")}
              </p>
            )}
            {filterConfig.conditions.filter((c) => c.enabled).length > 0 && (
              <div>
                <p className="mb-1">
                  <strong>Filters:</strong>
                </p>
                <ul className="list-disc list-inside pl-2 space-y-0.5">
                  {filterConfig.conditions
                    .filter((c) => c.enabled)
                    .map((c) => {
                      const fieldInfo = getFieldInfo(c.field);
                      const fieldLabel = fieldInfo?.label || c.field;
                      const opLabel = FILTER_OPERATOR_LABELS[c.operator];
                      const valueStr =
                        c.operator === "between" ? `${c.value} - ${c.value2}` : c.value;
                      return (
                        <li key={c.id}>
                          {fieldLabel} {opLabel} {valueStr}
                        </li>
                      );
                    })}
                </ul>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SaveReportDialog;
