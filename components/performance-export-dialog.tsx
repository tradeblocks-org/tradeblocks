"use client";

import { FileJson, FileSpreadsheet } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PerformanceData } from "@tradeblocks/lib/stores";
import { downloadCsv, downloadJson, generateExportFilename } from "@tradeblocks/lib";
import {
  CHART_EXPORTS,
  exportMultipleCharts,
  getChartExportsByTab,
  getMultipleChartsJson,
} from "@tradeblocks/lib";

interface PerformanceExportDialogProps {
  data: PerformanceData;
  blockName: string;
}

const TAB_ORDER = [
  "Overview",
  "Returns Analysis",
  "Risk & Margin",
  "Trade Efficiency",
  "Excursion Analysis",
] as const;

export function PerformanceExportDialog({ data, blockName }: PerformanceExportDialogProps) {
  const [selectedCharts, setSelectedCharts] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  const chartsByTab = getChartExportsByTab();

  const toggleChart = (chartId: string) => {
    setSelectedCharts((prev) => {
      const next = new Set(prev);
      if (next.has(chartId)) {
        next.delete(chartId);
      } else {
        next.add(chartId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedCharts(new Set(CHART_EXPORTS.map((c) => c.id)));
  };

  const clearAll = () => {
    setSelectedCharts(new Set());
  };

  const handleExportSelectedCsv = () => {
    if (selectedCharts.size === 0) return;

    const lines = exportMultipleCharts(data, Array.from(selectedCharts));
    downloadCsv(lines, generateExportFilename(blockName, "charts", "csv"));
    setOpen(false);
  };

  const handleExportSelectedJson = () => {
    if (selectedCharts.size === 0) return;

    const jsonData = getMultipleChartsJson(data, Array.from(selectedCharts));
    downloadJson(jsonData, generateExportFilename(blockName, "charts", "json"));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          Export Charts
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export Chart Data</DialogTitle>
          <DialogDescription>
            Select charts to export raw data for analysis in external tools or GPT.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mb-2">
          <Button variant="outline" size="sm" onClick={selectAll}>
            Select All
          </Button>
          <Button variant="outline" size="sm" onClick={clearAll}>
            Clear
          </Button>
        </div>

        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-6">
            {TAB_ORDER.map((tab) => {
              const charts = chartsByTab[tab];
              if (!charts || charts.length === 0) return null;

              return (
                <div key={tab}>
                  <h4 className="text-sm font-medium text-muted-foreground mb-3 border-b pb-1">
                    {tab}
                  </h4>
                  <div className="space-y-1">
                    {charts.map((chart) => (
                      <div key={chart.id} className="flex items-start gap-2 py-2">
                        <Checkbox
                          id={chart.id}
                          checked={selectedCharts.has(chart.id)}
                          onCheckedChange={() => toggleChart(chart.id)}
                          className="mt-0.5"
                        />
                        <label
                          htmlFor={chart.id}
                          className="text-sm cursor-pointer flex-1 min-w-0 leading-tight"
                        >
                          <span className="font-medium">{chart.name}</span>
                          <span className="text-muted-foreground text-xs block">
                            {chart.description}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-4 border-t">
          <div className="text-xs text-muted-foreground mr-auto self-center hidden sm:block">
            {selectedCharts.size} chart{selectedCharts.size !== 1 ? "s" : ""} selected
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportSelectedCsv}
            disabled={selectedCharts.size === 0}
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button size="sm" onClick={handleExportSelectedJson} disabled={selectedCharts.size === 0}>
            <FileJson className="mr-2 h-4 w-4" />
            Export JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
