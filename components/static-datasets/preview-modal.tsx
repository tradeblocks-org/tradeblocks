"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertTriangle, Filter } from "lucide-react";
import type {
  StaticDataset,
  StaticDatasetRow,
  DatasetMatchResult,
  MatchStrategy,
} from "@tradeblocks/lib";
import { MATCH_STRATEGY_LABELS, MATCH_STRATEGY_DESCRIPTIONS } from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";
import {
  matchTradesToDataset,
  calculateMatchStats,
  formatTimeDifference,
  combineDateAndTime,
} from "@tradeblocks/lib";
import { useStaticDatasetsStore } from "@tradeblocks/lib/stores";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { getTradesByBlock } from "@tradeblocks/lib";

interface PreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataset: StaticDataset | null;
}

interface PreviewData {
  trades: Trade[];
  rows: StaticDatasetRow[];
  matchResults: DatasetMatchResult[];
  stats: {
    totalTrades: number;
    matchedTrades: number;
    outsideDateRange: number;
    matchPercentage: number;
  };
}

type FilterMode = "all" | "matched" | "unmatched";

export function PreviewModal({ open, onOpenChange, dataset }: PreviewModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<string>("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [matchStrategy, setMatchStrategy] = useState<MatchStrategy>("nearest-before");

  const getDatasetRows = useStaticDatasetsStore((state) => state.getDatasetRows);
  const updateMatchStrategy = useStaticDatasetsStore((state) => state.updateMatchStrategy);
  const activeBlockId = useBlockStore((state) => state.activeBlockId);
  const blocks = useBlockStore((state) => state.blocks);

  const activeBlock = useMemo(
    () => blocks.find((b) => b.id === activeBlockId),
    [blocks, activeBlockId],
  );

  // Reset selected column and match strategy when dataset changes
  useEffect(() => {
    if (dataset) {
      if (dataset.columns.length) {
        setSelectedColumn(dataset.columns[0]);
      }
      setMatchStrategy(dataset.matchStrategy);
    }
  }, [dataset]);

  // Load preview data when modal opens or match strategy changes
  useEffect(() => {
    if (!open || !dataset) {
      setPreviewData(null);
      setError(null);
      return;
    }

    if (!activeBlockId) {
      setError("No active block selected. Please activate a block to preview matching.");
      return;
    }

    const loadPreviewData = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Load dataset rows and block trades in parallel
        const [rows, trades] = await Promise.all([
          getDatasetRows(dataset.id),
          getTradesByBlock(activeBlockId),
        ]);

        if (trades.length === 0) {
          setError("No trades found in the active block.");
          setIsLoading(false);
          return;
        }

        // Create a dataset object with the current match strategy for calculations
        const datasetWithStrategy = { ...dataset, matchStrategy };

        // Calculate matches using the current match strategy
        const matchResults = matchTradesToDataset(trades, datasetWithStrategy, rows);
        const stats = calculateMatchStats(trades, datasetWithStrategy, rows);

        setPreviewData({
          trades,
          rows,
          matchResults,
          stats,
        });
      } catch (err) {
        console.error("Failed to load preview data:", err);
        setError(err instanceof Error ? err.message : "Failed to load preview data");
      } finally {
        setIsLoading(false);
      }
    };

    loadPreviewData();
  }, [open, dataset, activeBlockId, getDatasetRows, matchStrategy]);

  const formatTradeTime = (trade: Trade) => {
    const timestamp = combineDateAndTime(trade.dateOpened, trade.timeOpened);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(timestamp);
  };

  const formatMatchedTime = (date: Date | null) => {
    if (!date) return "No match";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(date));
  };

  const formatDateRange = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(date));
  };

  // Use selected column or fall back to first column
  const previewColumn = selectedColumn || dataset?.columns[0] || "value";

  // Handle match strategy change - update local state and persist to store
  const handleMatchStrategyChange = async (newStrategy: MatchStrategy) => {
    setMatchStrategy(newStrategy);
    if (dataset) {
      await updateMatchStrategy(dataset.id, newStrategy);
    }
  };

  // Filter results based on filter mode
  const filteredResults = useMemo(() => {
    if (!previewData) return [];

    return previewData.matchResults
      .map((result, index) => ({ result, trade: previewData.trades[index] }))
      .filter(({ result }) => {
        if (filterMode === "matched") return result.matchedRow !== null;
        if (filterMode === "unmatched") return result.matchedRow === null;
        return true;
      });
  }, [previewData, filterMode]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] sm:max-w-[720px] md:max-w-[900px] lg:max-w-[1100px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Preview: {dataset?.name} → &quot;{activeBlock?.name || "No Block"}&quot;
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-center gap-2">
              <span>Match Strategy:</span>
              <Select
                value={matchStrategy}
                onValueChange={(v) => handleMatchStrategyChange(v as MatchStrategy)}
              >
                <SelectTrigger className="h-7 w-[160px] text-xs">
                  <SelectValue>{MATCH_STRATEGY_LABELS[matchStrategy]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MATCH_STRATEGY_LABELS) as MatchStrategy[]).map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>
                      <div className="flex flex-col">
                        <span>{MATCH_STRATEGY_LABELS[strategy]}</span>
                        <span className="text-xs text-muted-foreground">
                          {MATCH_STRATEGY_DESCRIPTIONS[strategy]}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Error State */}
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Preview Data */}
          {previewData && !isLoading && (
            <>
              {/* Stats Summary */}
              <div className="flex flex-wrap gap-3">
                <Badge
                  variant={previewData.stats.matchPercentage >= 90 ? "default" : "secondary"}
                  className="text-sm py-1 px-3"
                >
                  <CheckCircle2 className="w-4 h-4 mr-1" />
                  {previewData.stats.matchedTrades}/{previewData.stats.totalTrades} trades matched (
                  {previewData.stats.matchPercentage}%)
                </Badge>
                {dataset && (
                  <Badge variant="outline" className="text-sm py-1 px-3">
                    Dataset: {formatDateRange(dataset.dateRange.start)} -{" "}
                    {formatDateRange(dataset.dateRange.end)}
                  </Badge>
                )}
                {previewData.stats.outsideDateRange > 0 && (
                  <Badge
                    variant="outline"
                    className="text-sm py-1 px-3 text-amber-600 dark:text-amber-400 border-amber-300"
                  >
                    <AlertTriangle className="w-4 h-4 mr-1" />
                    {previewData.stats.outsideDateRange} trades outside dataset date range
                  </Badge>
                )}
              </div>

              {/* Controls Row: Column Selector + Filter Toggle */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Column:</span>
                  <Select value={selectedColumn} onValueChange={setSelectedColumn}>
                    <SelectTrigger className="w-[180px] h-8 text-sm">
                      <SelectValue>{selectedColumn}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {dataset?.columns.map((col) => (
                        <SelectItem key={col} value={col}>
                          {col}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1">
                  <Filter className="w-4 h-4 text-muted-foreground" />
                  <div className="flex rounded-md border">
                    <Button
                      variant={filterMode === "all" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs rounded-r-none"
                      onClick={() => setFilterMode("all")}
                    >
                      All ({previewData.stats.totalTrades})
                    </Button>
                    <Button
                      variant={filterMode === "matched" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs rounded-none border-x"
                      onClick={() => setFilterMode("matched")}
                    >
                      Matched ({previewData.stats.matchedTrades})
                    </Button>
                    <Button
                      variant={filterMode === "unmatched" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs rounded-l-none"
                      onClick={() => setFilterMode("unmatched")}
                    >
                      Unmatched ({previewData.stats.totalTrades - previewData.stats.matchedTrades})
                    </Button>
                  </div>
                </div>
              </div>

              {/* Match Table */}
              <div className="flex-1 overflow-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-medium">Trade Open Time</th>
                      <th className="text-left p-3 font-medium">Strategy</th>
                      <th className="text-left p-3 font-medium">Matched Timestamp</th>
                      <th className="text-left p-3 font-medium">Offset</th>
                      <th className="text-right p-3 font-medium">
                        {dataset?.name}.{previewColumn}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.slice(0, 100).map(({ result, trade }, index) => {
                      const value = result.matchedRow?.values[previewColumn];

                      return (
                        <tr
                          key={index}
                          className={`border-t ${!result.matchedRow ? "bg-destructive/5" : ""}`}
                        >
                          <td className="p-3 font-mono text-xs">{formatTradeTime(trade)}</td>
                          <td className="p-3 text-xs truncate max-w-[120px]" title={trade.strategy}>
                            {trade.strategy}
                          </td>
                          <td className="p-3 font-mono text-xs">
                            {formatMatchedTime(result.matchedTimestamp)}
                          </td>
                          <td className="p-3">
                            <Badge
                              variant={result.matchedRow ? "outline" : "destructive"}
                              className="text-xs"
                            >
                              {formatTimeDifference(result.timeDifferenceMs)}
                            </Badge>
                          </td>
                          <td className="p-3 text-right font-mono text-xs">
                            {value !== undefined
                              ? typeof value === "number"
                                ? value.toFixed(2)
                                : value
                              : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredResults.length > 100 && (
                  <div className="p-3 text-center text-sm text-muted-foreground bg-muted border-t">
                    Showing first 100 of {filteredResults.length} trades
                  </div>
                )}
                {filteredResults.length === 0 && (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    No{" "}
                    {filterMode === "matched"
                      ? "matched"
                      : filterMode === "unmatched"
                        ? "unmatched"
                        : ""}{" "}
                    trades to display
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
