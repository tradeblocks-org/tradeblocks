"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { calculationOrchestrator } from "@tradeblocks/lib";
import { PortfolioStatsCalculator } from "@tradeblocks/lib";
import {
  addDailyLogEntries,
  addReportingTrades,
  addTrades,
  createBlock,
  getBlock,
  deleteReportingTradesByBlock,
  updateDailyLogsForBlock,
  updateBlock as updateProcessedBlock,
  updateReportingTradesForBlock,
  updateTradesForBlock,
} from "@tradeblocks/lib";
import { storeCombinedTradesCache, deleteCombinedTradesCache } from "@tradeblocks/lib";
import { storePerformanceSnapshotCache, deletePerformanceSnapshotCache } from "@tradeblocks/lib";
import { storeEnrichedTradesCache, deleteEnrichedTradesCache } from "@tradeblocks/lib";
import { buildPerformanceSnapshot } from "@tradeblocks/lib";
import { enrichTrades } from "@tradeblocks/lib";
import { combineAllLegGroupsAsync } from "@tradeblocks/lib";
import { REQUIRED_DAILY_LOG_COLUMNS } from "@tradeblocks/lib";
import {
  REPORTING_TRADE_COLUMN_ALIASES,
  REQUIRED_REPORTING_TRADE_COLUMNS,
  isTatFormat,
} from "@tradeblocks/lib";
import type { StrategyAlignment } from "@tradeblocks/lib";
import { REQUIRED_TRADE_COLUMNS, TRADE_COLUMN_ALIASES, type Trade } from "@tradeblocks/lib";
import {
  DailyLogProcessingProgress,
  DailyLogProcessingResult,
  DailyLogProcessor,
} from "@tradeblocks/lib";
import {
  ReportingTradeProcessingProgress,
  ReportingTradeProcessingResult,
  ReportingTradeProcessor,
} from "@tradeblocks/lib";
import { TradeProcessingProgress, TradeProcessingResult, TradeProcessor } from "@tradeblocks/lib";
import { useBlockStore } from "@tradeblocks/lib/stores";
import { cn } from "@tradeblocks/lib";
import { findMissingHeaders, normalizeHeaders, parseCsvLine } from "@tradeblocks/lib";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Calendar,
  CheckCircle,
  Info,
  List,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ProgressDialog } from "@/components/progress-dialog";
import type { SnapshotProgress } from "@tradeblocks/lib";
import { waitForRender } from "@tradeblocks/lib";
import { useProgressDialog } from "@/hooks/use-progress-dialog";

interface Block {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  created: Date;
  lastModified: Date;
  tradeLog: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  dailyLog?: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  reportingLog?: {
    fileName: string;
    rowCount: number;
    fileSize: number;
  };
  stats: {
    totalPnL: number;
    winRate: number;
    totalTrades: number;
    avgWin: number;
    avgLoss: number;
  };
  strategyAlignment?: {
    mappings: StrategyAlignment[];
    updatedAt: Date;
  };
  tags?: string[];
  color?: string;
}

interface FileUploadState {
  file: File | null;
  status: "empty" | "dragover" | "uploaded" | "error" | "existing" | "processing";
  error?: string;
  existingFileName?: string;
  existingRowCount?: number;
  progress?: number;
  processedData?: {
    rowCount: number;
    dateRange?: { start: Date | null; end: Date | null };
    strategies?: string[];
    stats?: {
      processingTimeMs: number;
      strategies: string[];
      dateRange: { start: Date | null; end: Date | null };
      totalPL: number;
    };
  };
  requiresStrategyName?: boolean;
}

type UploadType = "trade" | "daily" | "reporting";

interface BlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "new" | "edit";
  block?: Block | null;
}

export function BlockDialog({ open, onOpenChange, mode, block }: BlockDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [setAsActive, setSetAsActive] = useState(true);
  const [combineLegGroups, setCombineLegGroups] = useState(false);
  const [tradeLog, setTradeLog] = useState<FileUploadState>({
    file: null,
    status: "empty",
  });
  const [dailyLog, setDailyLog] = useState<FileUploadState>({
    file: null,
    status: "empty",
  });
  const [reportingLog, setReportingLog] = useState<FileUploadState>({
    file: null,
    status: "empty",
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<string>("");
  type PreviewData = {
    trades?: TradeProcessingResult;
    dailyLogs?: DailyLogProcessingResult;
    reporting?: ReportingTradeProcessingResult;
    initialCapital?: number;
  };

  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [processedFileName, setProcessedFileName] = useState<string | null>(null);
  const [processingErrors, setProcessingErrors] = useState<string[]>([]);
  const [missingStrategyCount, setMissingStrategyCount] = useState(0);
  const [strategyOverride, setStrategyOverride] = useState("");
  const [pendingTradeResult, setPendingTradeResult] = useState<TradeProcessingResult | null>(null);

  // Shared progress dialog controller (handles abort + clamped percent)
  const progress = useProgressDialog();
  const handleCancelCalculation = useCallback(() => {
    progress.cancel();
  }, [progress]);

  interface ProcessFilesResult {
    preview: PreviewData;
    missingStrategies: number;
  }

  const { addBlock: addBlockToStore, updateBlock, refreshBlock, deleteBlock } = useBlockStore();

  // Reset form when dialog opens/closes or mode changes
  useEffect(() => {
    if (!open) {
      // Reset when closing
      setName("");
      setDescription("");
      setSetAsActive(true);
      setCombineLegGroups(false);
      setTradeLog({ file: null, status: "empty" });
      setDailyLog({ file: null, status: "empty" });
      setReportingLog({ file: null, status: "empty" });
      setIsProcessing(false);
      setProcessingStep("");
      setPreviewData(null);
      setProcessedFileName(null);
      setProcessingErrors([]);
      setMissingStrategyCount(0);
      setStrategyOverride("");
      setPendingTradeResult(null);
      return;
    }

    if (mode === "edit" && block) {
      // Pre-populate for edit mode
      setName(block.name);
      setDescription(block.description || "");
      setSetAsActive(block.isActive);

      // Load combineLegGroups setting from ProcessedBlock
      (async () => {
        const { getBlock } = await import("@tradeblocks/lib");
        const processedBlock = await getBlock(block.id);
        if (processedBlock?.analysisConfig) {
          setCombineLegGroups(processedBlock.analysisConfig.combineLegGroups ?? false);
        }
      })();

      setTradeLog({
        file: null,
        status: "existing",
        existingFileName: block.tradeLog.fileName,
        existingRowCount: block.tradeLog.rowCount,
      });

      if (block.dailyLog) {
        setDailyLog({
          file: null,
          status: "existing",
          existingFileName: block.dailyLog.fileName,
          existingRowCount: block.dailyLog.rowCount,
        });
      } else {
        setDailyLog({
          file: null,
          status: "empty",
        });
      }

      if (block.reportingLog) {
        setReportingLog({
          file: null,
          status: "existing",
          existingFileName: block.reportingLog.fileName,
          existingRowCount: block.reportingLog.rowCount,
        });
      } else {
        setReportingLog({ file: null, status: "empty" });
      }
    } else {
      // Reset for new mode
      setName("");
      setDescription("");
      setSetAsActive(true);
      setTradeLog({ file: null, status: "empty" });
      setDailyLog({ file: null, status: "empty" });
      setReportingLog({ file: null, status: "empty" });
    }
    setMissingStrategyCount(0);
    setStrategyOverride("");
    setPendingTradeResult(null);
  }, [open, mode, block]);

  const getUploadStateSetter = useCallback((type: UploadType) => {
    switch (type) {
      case "trade":
        return setTradeLog;
      case "daily":
        return setDailyLog;
      default:
        return setReportingLog;
    }
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, type: UploadType) => {
      e.preventDefault();
      e.stopPropagation();

      const setState = getUploadStateSetter(type);
      setState((prev) => ({ ...prev, status: "dragover" }));
    },
    [getUploadStateSetter],
  );

  const resetStrategyOverrideState = useCallback(() => {
    setMissingStrategyCount(0);
    setStrategyOverride("");
    setPendingTradeResult(null);
  }, []);

  const applyStrategyOverrideToResult = useCallback(
    (result: TradeProcessingResult, override: string): TradeProcessingResult => {
      const trimmed = override.trim();
      if (!trimmed) return result;

      const updatedTrades = result.trades.map((trade) =>
        trade.strategy === "Unknown" || trade.strategy.trim() === ""
          ? { ...trade, strategy: trimmed }
          : trade,
      );

      const strategies = Array.from(new Set(updatedTrades.map((trade) => trade.strategy))).sort();

      return {
        ...result,
        trades: updatedTrades,
        stats: {
          ...result.stats,
          strategies,
        },
      };
    },
    [],
  );

  const updateTradeProcessingState = useCallback(
    (result: TradeProcessingResult, requiresOverride: boolean) => {
      setTradeLog((prev) => ({
        ...prev,
        processedData: {
          rowCount: result.validTrades,
          dateRange: result.stats.dateRange,
          strategies: result.stats.strategies,
          stats: result.stats,
        },
        requiresStrategyName: requiresOverride,
      }));

      setPreviewData((prev) => (prev ? { ...prev, trades: result } : prev));
    },
    [],
  );

  const handleStrategyOverrideInputChange = useCallback(
    (value: string) => {
      setStrategyOverride(value);

      if (!pendingTradeResult) {
        return;
      }

      const trimmed = value.trim();
      const adjusted = trimmed
        ? applyStrategyOverrideToResult(pendingTradeResult, trimmed)
        : pendingTradeResult;

      const requiresOverride = missingStrategyCount > 0 && trimmed === "";
      updateTradeProcessingState(adjusted, requiresOverride);
    },
    [
      pendingTradeResult,
      missingStrategyCount,
      applyStrategyOverrideToResult,
      updateTradeProcessingState,
    ],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent, type: UploadType) => {
      e.preventDefault();
      e.stopPropagation();

      const setState = getUploadStateSetter(type);
      setState((prev) => ({
        ...prev,
        status: prev.file ? "uploaded" : prev.existingFileName ? "existing" : "empty",
      }));
    },
    [getUploadStateSetter],
  );

  const validateCsvHeaders = useCallback(async (file: File, type: UploadType) => {
    try {
      const previewChunk = await file.slice(0, 256 * 1024).text();
      const headerLine = previewChunk.split(/\r?\n/).find((line) => line.trim().length > 0);

      if (!headerLine) {
        return "The selected file appears to be empty.";
      }

      const parsedHeaders = parseCsvLine(headerLine);
      if (parsedHeaders.length === 0) {
        return "No headers were detected in the uploaded file.";
      }

      let normalizedHeaders: string[];
      let requiredHeaders: readonly string[];

      switch (type) {
        case "trade":
          normalizedHeaders = normalizeHeaders(parsedHeaders, TRADE_COLUMN_ALIASES);
          requiredHeaders = REQUIRED_TRADE_COLUMNS;
          break;
        case "daily":
          normalizedHeaders = normalizeHeaders(parsedHeaders);
          requiredHeaders = REQUIRED_DAILY_LOG_COLUMNS;
          break;
        case "reporting":
          if (isTatFormat(parsedHeaders)) {
            return null; // TAT format detected, skip OO column validation
          }
          normalizedHeaders = normalizeHeaders(parsedHeaders, REPORTING_TRADE_COLUMN_ALIASES);
          requiredHeaders = REQUIRED_REPORTING_TRADE_COLUMNS;
          break;
      }

      const missingHeaders = findMissingHeaders(normalizedHeaders, requiredHeaders);

      if (missingHeaders.length > 0) {
        const label =
          type === "trade" ? "trade log" : type === "daily" ? "daily log" : "reporting log";
        return `Missing required ${label} columns: ${missingHeaders.join(", ")}`;
      }

      return null;
    } catch (error) {
      console.error("Failed to read CSV headers", error);
      const label =
        type === "trade" ? "trade log" : type === "daily" ? "daily log" : "reporting log";
      return `Unable to read ${label} file. Please try again.`;
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, type: UploadType) => {
      e.preventDefault();
      e.stopPropagation();

      const files = Array.from(e.dataTransfer.files);
      const file = files[0];

      const setState = getUploadStateSetter(type);

      if (type === "trade") {
        resetStrategyOverrideState();
        // Clear preview data when a new trade file is selected
        setPreviewData(null);
        setProcessedFileName(null);
      }

      if (!file) {
        setState((prev) => ({
          ...prev,
          status: prev.existingFileName ? "existing" : "empty",
          requiresStrategyName: false,
        }));
        return;
      }

      // Validate file type
      if (!file.name.toLowerCase().endsWith(".csv")) {
        toast.error("Please upload a CSV file");
        setState((prev) => ({
          ...prev,
          file: null,
          status: "error",
          error: "Please upload a CSV file",
          requiresStrategyName: false,
        }));
        return;
      }

      const headerError = await validateCsvHeaders(file, type);
      if (headerError) {
        toast.error(headerError);
        setState((prev) => ({
          ...prev,
          file: null,
          status: "error",
          error: headerError,
          existingFileName: undefined,
          existingRowCount: undefined,
          requiresStrategyName: false,
        }));
        return;
      }

      setState({
        file,
        status: "uploaded",
        error: undefined,
        existingFileName: undefined,
        existingRowCount: undefined,
        requiresStrategyName: false,
      });

      const label =
        type === "trade" ? "Trade log" : type === "daily" ? "Daily log" : "Reporting log";
      toast.success(`${label} headers look good.`);
    },
    [getUploadStateSetter, validateCsvHeaders, resetStrategyOverrideState],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>, type: UploadType) => {
      const file = e.target.files?.[0];
      const setState = getUploadStateSetter(type);

      if (type === "trade") {
        resetStrategyOverrideState();
        // Clear preview data when a new trade file is selected
        setPreviewData(null);
        setProcessedFileName(null);
      }

      if (!file) {
        setState((prev) => ({
          ...prev,
          status: prev.existingFileName ? "existing" : "empty",
          requiresStrategyName: false,
        }));
        // Reset the input value to allow re-selecting the same file
        e.target.value = "";
        return;
      }

      if (!file.name.toLowerCase().endsWith(".csv")) {
        toast.error("Please upload a CSV file");
        setState((prev) => ({
          ...prev,
          file: null,
          status: "error",
          error: "Please upload a CSV file",
          requiresStrategyName: false,
        }));
        e.target.value = "";
        return;
      }

      const headerError = await validateCsvHeaders(file, type);
      if (headerError) {
        toast.error(headerError);
        setState((prev) => ({
          ...prev,
          file: null,
          status: "error",
          error: headerError,
          existingFileName: undefined,
          existingRowCount: undefined,
          requiresStrategyName: false,
        }));
        e.target.value = "";
        return;
      }

      setState({
        file,
        status: "uploaded",
        error: undefined,
        existingFileName: undefined,
        existingRowCount: undefined,
        requiresStrategyName: false,
      });

      const label =
        type === "trade" ? "Trade log" : type === "daily" ? "Daily log" : "Reporting log";
      toast.success(`${label} headers look good.`);

      // Reset the input value to allow re-selecting the same file
      e.target.value = "";
    },
    [getUploadStateSetter, validateCsvHeaders, resetStrategyOverrideState],
  );

  const removeFile = useCallback(
    (type: UploadType) => {
      const setState = getUploadStateSetter(type);
      setState({
        file: null,
        status: "empty",
        error: undefined,
        existingFileName: undefined,
        existingRowCount: undefined,
        requiresStrategyName: false,
      });
      if (type === "trade") {
        resetStrategyOverrideState();
      }
    },
    [getUploadStateSetter, resetStrategyOverrideState],
  );

  const formatFileSize = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const processFiles = async (): Promise<ProcessFilesResult | null> => {
    if (!tradeLog.file) return null;

    setIsProcessing(true);
    setProcessingErrors([]);
    setPreviewData(null);

    try {
      // Process trade log
      setProcessingStep("Processing trade log...");
      setTradeLog((prev) => ({
        ...prev,
        status: "processing",
        progress: 0,
        requiresStrategyName: false,
      }));

      const tradeProcessor = new TradeProcessor({
        progressCallback: (progress: TradeProcessingProgress) => {
          setTradeLog((prev) => ({
            ...prev,
            progress: progress.progress,
            processedData: {
              rowCount: progress.validTrades + progress.invalidTrades,
            },
          }));
        },
      });

      const rawTradeResult = await tradeProcessor.processFile(tradeLog.file);

      if (rawTradeResult.errors.length > 0) {
        const errorMessages = rawTradeResult.errors.map((e) => e.message);
        setProcessingErrors((prev) => [...prev, ...errorMessages]);
      }

      const missingCount = rawTradeResult.trades.filter(
        (trade) => trade.strategy === "Unknown",
      ).length;
      setMissingStrategyCount(missingCount);
      setPendingTradeResult(missingCount > 0 ? rawTradeResult : null);

      const trimmedOverride = strategyOverride.trim();
      const adjustedTradeResult =
        missingCount > 0 && trimmedOverride
          ? applyStrategyOverrideToResult(rawTradeResult, trimmedOverride)
          : rawTradeResult;
      const requiresOverride = missingCount > 0 && !trimmedOverride;

      setTradeLog((prev) => ({
        ...prev,
        status: "uploaded",
        progress: 100,
        processedData: {
          rowCount: adjustedTradeResult.validTrades,
          dateRange: adjustedTradeResult.stats.dateRange,
          strategies: adjustedTradeResult.stats.strategies,
          stats: adjustedTradeResult.stats,
        },
        requiresStrategyName: requiresOverride,
      }));

      // Process daily log if provided
      let dailyResult: DailyLogProcessingResult | undefined;
      let reportingResult: ReportingTradeProcessingResult | undefined;
      let initialCapital: number;

      if (dailyLog.file) {
        setProcessingStep("Processing daily log...");
        setDailyLog((prev) => ({ ...prev, status: "processing", progress: 0 }));

        const dailyProcessor = new DailyLogProcessor({
          progressCallback: (progress: DailyLogProcessingProgress) => {
            setDailyLog((prev) => ({
              ...prev,
              progress: progress.progress,
              processedData: {
                rowCount: progress.validEntries + progress.invalidEntries,
              },
            }));
          },
        });

        dailyResult = await dailyProcessor.processFile(dailyLog.file);

        if (dailyResult && dailyResult.errors.length > 0) {
          const errorMessages = dailyResult.errors.map((e) => e.message);
          setProcessingErrors((prev) => [...prev, ...errorMessages]);
        }

        if (dailyResult) {
          setDailyLog((prev) => ({
            ...prev,
            status: "uploaded",
            progress: 100,
            processedData: {
              rowCount: dailyResult!.validEntries,
              dateRange: dailyResult!.stats.dateRange,
              stats: {
                ...dailyResult!.stats,
                strategies: [], // Daily logs don't have strategies
              },
            },
          }));
        }

        // Calculate initial capital
        initialCapital = PortfolioStatsCalculator.calculateInitialCapital(
          adjustedTradeResult.trades,
          dailyResult?.entries,
        );
      } else {
        // Calculate initial capital from trades only
        initialCapital = PortfolioStatsCalculator.calculateInitialCapital(
          adjustedTradeResult.trades,
        );
      }

      if (reportingLog.file) {
        setProcessingStep("Processing reporting log...");
        setReportingLog((prev) => ({
          ...prev,
          status: "processing",
          progress: 0,
        }));

        const reportingProcessor = new ReportingTradeProcessor({
          progressCallback: (progress: ReportingTradeProcessingProgress) => {
            setReportingLog((prev) => ({
              ...prev,
              progress: progress.progress,
              processedData: {
                rowCount: progress.validTrades + progress.invalidTrades,
              },
            }));
          },
        });

        reportingResult = await reportingProcessor.processFile(reportingLog.file);

        if (reportingResult.errors.length > 0) {
          const reportingErrors = reportingResult.errors.map((e) => e.message);
          setProcessingErrors((prev) => [...prev, ...reportingErrors]);
        }

        setReportingLog((prev) => ({
          ...prev,
          status: "uploaded",
          progress: 100,
          processedData: {
            rowCount: reportingResult!.validTrades,
            dateRange: reportingResult!.stats.dateRange,
            strategies: reportingResult!.stats.strategies,
            stats: reportingResult!.stats,
          },
        }));
      }

      if (reportingLog.file) {
        setProcessingStep("Processing reporting log...");
        setReportingLog((prev) => ({
          ...prev,
          status: "processing",
          progress: 0,
        }));

        const reportingProcessor = new ReportingTradeProcessor({
          progressCallback: (progress: ReportingTradeProcessingProgress) => {
            setReportingLog((prev) => ({
              ...prev,
              progress: progress.progress,
              processedData: {
                rowCount: progress.validTrades + progress.invalidTrades,
              },
            }));
          },
        });

        reportingResult = await reportingProcessor.processFile(reportingLog.file);

        if (reportingResult.errors.length > 0) {
          const reportingErrors = reportingResult.errors.map((e) => e.message);
          setProcessingErrors((prev) => [...prev, ...reportingErrors]);
        }

        setReportingLog((prev) => ({
          ...prev,
          status: "uploaded",
          progress: 100,
          processedData: {
            rowCount: reportingResult!.validTrades,
            dateRange: reportingResult!.stats.dateRange,
            strategies: reportingResult!.stats.strategies,
            stats: reportingResult!.stats,
          },
        }));
      }

      setProcessingStep("Calculating statistics...");

      const preview = {
        trades: adjustedTradeResult,
        dailyLogs: dailyResult,
        reporting: reportingResult,
        initialCapital,
      };

      setPreviewData(preview);
      setProcessedFileName(tradeLog.file.name);
      setProcessingStep("");

      return { preview, missingStrategies: missingCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setProcessingErrors([errorMessage]);
      setTradeLog((prev) => ({
        ...prev,
        status: "error",
        error: errorMessage,
      }));
      setProcessingStep("");
      return null;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async () => {
    if (mode === "edit" && !block) return;
    if (!tradeLog.file && !tradeLog.existingFileName) return;

    try {
      setIsProcessing(true);

      // Process files if new files were uploaded
      let processedPreview = previewData;
      let missingStrategies = missingStrategyCount;
      // Check if we need to process: either no preview exists OR the file changed
      const needsProcessing =
        tradeLog.file && (!processedPreview?.trades || processedFileName !== tradeLog.file.name);

      if (mode === "new" && tradeLog.file) {
        const result = await processFiles();
        if (!result) return; // Processing failed
        processedPreview = result.preview;
        missingStrategies = result.missingStrategies;
        if (missingStrategies > 0 && strategyOverride.trim() === "") {
          toast.error(
            "Please provide a strategy name for unlabeled trades before creating the block.",
          );
          setIsProcessing(false);
          setProcessingStep("");
          return;
        }
      } else if (mode === "edit" && needsProcessing) {
        // In edit mode, process files if they were uploaded but not yet processed
        const result = await processFiles();
        if (!result) return; // Processing failed
        processedPreview = result.preview;
        missingStrategies = result.missingStrategies;
        if (missingStrategies > 0 && strategyOverride.trim() === "") {
          toast.error("Please provide a strategy name for unlabeled trades before saving changes.");
          setIsProcessing(false);
          setProcessingStep("");
          return;
        }
      }

      if (mode === "new" && processedPreview) {
        // Create new block with processed data
        setProcessingStep("Saving to database...");

        // Create block metadata
        const now = new Date();
        const timestamp = Date.now();
        const blockMetadata = {
          name: name.trim(),
          description: description.trim() || undefined,
          isActive: false,
          tradeLog: {
            fileName: tradeLog.file!.name,
            fileSize: tradeLog.file!.size,
            originalRowCount: processedPreview.trades?.totalRows || 0,
            processedRowCount: processedPreview.trades?.trades.length || 0,
            uploadedAt: now,
          },
          dailyLog: dailyLog.file
            ? {
                fileName: dailyLog.file.name,
                fileSize: dailyLog.file.size,
                originalRowCount: processedPreview.dailyLogs?.totalRows || 0,
                processedRowCount: processedPreview.dailyLogs?.entries.length || 0,
                uploadedAt: now,
              }
            : undefined,
          reportingLog: reportingLog.file
            ? {
                fileName: reportingLog.file.name,
                fileSize: reportingLog.file.size,
                originalRowCount: processedPreview.reporting?.totalRows || 0,
                processedRowCount: processedPreview.reporting?.trades.length || 0,
                uploadedAt: now,
              }
            : undefined,
          dateRange:
            processedPreview.trades?.stats.dateRange.start &&
            processedPreview.trades?.stats.dateRange.end
              ? {
                  start: processedPreview.trades.stats.dateRange.start,
                  end: processedPreview.trades.stats.dateRange.end,
                }
              : undefined,
          processingStatus: "completed" as const,
          dataReferences: {
            tradesStorageKey: `block_${timestamp}_trades`,
            dailyLogStorageKey: dailyLog.file ? `block_${timestamp}_daily_logs` : undefined,
            reportingLogStorageKey: reportingLog.file
              ? `block_${timestamp}_reporting_logs`
              : undefined,
          },
          analysisConfig: {
            useBusinessDaysOnly: false,
            annualizationFactor: 252,
            confidenceLevel: 0.95,
            drawdownThreshold: 0.05,
            combineLegGroups,
          },
        };

        // Save to IndexedDB
        const newBlock = await createBlock(blockMetadata);

        // Add trades
        if (processedPreview.trades?.trades.length) {
          await addTrades(newBlock.id, processedPreview.trades.trades);
        }

        // Add daily log entries if present
        if (processedPreview.dailyLogs && processedPreview.dailyLogs.entries.length > 0) {
          const entriesWithBlockId = processedPreview.dailyLogs.entries.map((entry) => ({
            ...entry,
            blockId: newBlock.id,
          }));
          await addDailyLogEntries(newBlock.id, entriesWithBlockId);
        }

        if (processedPreview.reporting?.trades.length) {
          await addReportingTrades(newBlock.id, processedPreview.reporting.trades);
        }

        // Pre-calculate and cache performance snapshot for instant page loads
        if (processedPreview.trades?.trades.length) {
          // Show progress dialog BEFORE any heavy computation
          setIsProcessing(false); // Hide old processing UI
          const signal = progress.start("Starting...", 0);

          // Allow React to render the dialog before starting computation
          await waitForRender();

          try {
            let tradesToUse: Trade[] = processedPreview.trades.trades;

            // If combining leg groups, do it with progress tracking
            if (combineLegGroups) {
              const combinedTrades = await combineAllLegGroupsAsync(
                processedPreview.trades.trades,
                {
                  onProgress: (p) => {
                    // Scale combine progress to 0-30%
                    progress.update(`Combining: ${p.step}`, Math.floor(p.percent * 0.3));
                  },
                  signal,
                },
              );
              await storeCombinedTradesCache(newBlock.id, combinedTrades);
              tradesToUse = combinedTrades;
            }

            // Build performance snapshot (30-95% if combining, 0-95% if not)
            const snapshot = await buildPerformanceSnapshot({
              trades: tradesToUse,
              dailyLogs: processedPreview.dailyLogs?.entries,
              normalizeTo1Lot: false,
              onProgress: (p: SnapshotProgress) => {
                const basePercent = combineLegGroups ? 30 : 0;
                const scale = combineLegGroups ? 0.65 : 0.95;
                progress.update(p.step, basePercent + Math.floor(p.percent * scale));
              },
              signal,
            });

            // Store to cache (95-100%)
            progress.update("Saving to cache...", 96);
            await waitForRender();
            await storePerformanceSnapshotCache(newBlock.id, snapshot);

            // Pre-compute enriched trades for Report Builder
            progress.update("Pre-computing enriched trades...", 98);
            await waitForRender();
            const enrichedTrades = enrichTrades(tradesToUse, {
              dailyLogs: processedPreview.dailyLogs?.entries,
            });
            await storeEnrichedTradesCache(newBlock.id, enrichedTrades);
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              // User cancelled - skip caching, save still succeeds
              console.log("Pre-calculation cancelled by user");
              toast.info(
                "Block created, but pre-calculation was cancelled. You can recalculate later for faster page loads.",
              );
            } else {
              throw err;
            }
          } finally {
            progress.finish();
            setIsProcessing(true); // Restore for remaining operations
          }
        }

        // Calculate block stats for store
        const trades = processedPreview.trades?.trades || [];
        const blockStats = {
          totalPnL: processedPreview.trades?.stats.totalPL || 0,
          winRate:
            trades.length > 0 ? (trades.filter((t) => t.pl > 0).length / trades.length) * 100 : 0,
          totalTrades: processedPreview.trades?.validTrades || 0,
          avgWin:
            trades.length > 0
              ? trades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0) /
                  trades.filter((t) => t.pl > 0).length || 0
              : 0,
          avgLoss:
            trades.length > 0
              ? trades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0) /
                  trades.filter((t) => t.pl < 0).length || 0
              : 0,
        };

        // Add to Zustand store
        const blockForStore = {
          id: newBlock.id, // Use the actual ID from IndexedDB
          name: blockMetadata.name,
          description: blockMetadata.description,
          isActive: setAsActive,
          lastModified: new Date(),
          tradeLog: {
            fileName: tradeLog.file!.name,
            rowCount: processedPreview.trades?.validTrades || 0,
            fileSize: tradeLog.file!.size,
          },
          dailyLog: dailyLog.file
            ? {
                fileName: dailyLog.file.name,
                rowCount: processedPreview.dailyLogs?.validEntries || 0,
                fileSize: dailyLog.file.size,
              }
            : undefined,
          reportingLog: reportingLog.file
            ? {
                fileName: reportingLog.file.name,
                rowCount: processedPreview.reporting?.validTrades || 0,
                fileSize: reportingLog.file.size,
              }
            : undefined,
          stats: blockStats,
        };

        await addBlockToStore(blockForStore);
      } else if (mode === "edit" && block) {
        // Update existing block
        setProcessingStep("Updating block...");

        let processedData = processedPreview;

        // Ensure we process the daily log if it was uploaded without running the full pipeline
        if (dailyLog.file && (!processedData || !processedData.dailyLogs)) {
          setProcessingStep("Processing daily log...");
          setDailyLog((prev) => ({
            ...prev,
            status: "processing",
            progress: 0,
          }));

          const dailyProcessor = new DailyLogProcessor({
            progressCallback: (progress: DailyLogProcessingProgress) => {
              setDailyLog((prev) => ({
                ...prev,
                progress: progress.progress,
                processedData: {
                  rowCount: progress.validEntries + progress.invalidEntries,
                },
              }));
            },
          });

          const dailyResult = await dailyProcessor.processFile(dailyLog.file);

          if (dailyResult.errors.length > 0) {
            const dailyErrors = dailyResult.errors.map((e) => e.message);
            setProcessingErrors((prev) => [...prev, ...dailyErrors]);
          }

          setDailyLog((prev) => ({
            ...prev,
            status: "uploaded",
            progress: 100,
            processedData: {
              rowCount: dailyResult.validEntries,
              dateRange: dailyResult.stats.dateRange,
              stats: {
                ...dailyResult.stats,
                strategies: [],
              },
            },
          }));

          processedData = {
            ...processedData,
            dailyLogs: dailyResult,
          } as PreviewData;
        }

        // Ensure we process the reporting log if it was uploaded without running the full pipeline
        if (reportingLog.file && (!processedData || !processedData.reporting)) {
          setProcessingStep("Processing reporting log...");
          setReportingLog((prev) => ({
            ...prev,
            status: "processing",
            progress: 0,
          }));

          const reportingProcessor = new ReportingTradeProcessor({
            progressCallback: (progress: ReportingTradeProcessingProgress) => {
              setReportingLog((prev) => ({
                ...prev,
                progress: progress.progress,
                processedData: {
                  rowCount: progress.validTrades + progress.invalidTrades,
                },
              }));
            },
          });

          const reportingResult = await reportingProcessor.processFile(reportingLog.file);

          if (reportingResult.errors.length > 0) {
            const reportingErrors = reportingResult.errors.map((e) => e.message);
            setProcessingErrors((prev) => [...prev, ...reportingErrors]);
          }

          setReportingLog((prev) => ({
            ...prev,
            status: "uploaded",
            progress: 100,
            processedData: {
              rowCount: reportingResult.validTrades,
              dateRange: reportingResult.stats.dateRange,
              strategies: reportingResult.stats.strategies,
              stats: reportingResult.stats,
            },
          }));

          processedData = {
            ...processedData,
            reporting: reportingResult,
          } as PreviewData;
        }

        const updates: Partial<Block> = {
          name: name.trim(),
          description: description.trim() || undefined,
          lastModified: new Date(),
        };

        const metadataUpdates: Record<string, unknown> = {
          lastModified: new Date(),
        };

        // Get current block to check if combineLegGroups changed
        const processedBlock = await getBlock(block.id);
        const currentCombineLegGroups = processedBlock?.analysisConfig?.combineLegGroups ?? false;

        // Update analysisConfig if combineLegGroups changed
        if (combineLegGroups !== currentCombineLegGroups) {
          metadataUpdates.analysisConfig = {
            ...processedBlock?.analysisConfig,
            combineLegGroups,
          };
          // Clear cache since combining affects calculations
          calculationOrchestrator.clearCache(block.id);

          // Handle combined trades cache based on new setting
          const { getTradesByBlock, getDailyLogsByBlock } = await import("@tradeblocks/lib");
          const existingTrades = await getTradesByBlock(block.id);

          if (combineLegGroups) {
            // Enabling: pre-calculate and cache combined trades
            if (existingTrades.length > 0) {
              const existingDailyLogs = await getDailyLogsByBlock(block.id);

              // Show progress dialog BEFORE any heavy computation
              setIsProcessing(false); // Hide old processing UI
              const signal = progress.start("Starting...", 0);

              // Allow React to render the dialog before starting computation
              await waitForRender();

              try {
                // Combine leg groups with progress (this was freezing UI before)
                const combinedTrades = await combineAllLegGroupsAsync(existingTrades, {
                  onProgress: (p) => {
                    // Scale combine progress to 0-30%
                    progress.update(`Combining: ${p.step}`, Math.floor(p.percent * 0.3));
                  },
                  signal,
                });
                await storeCombinedTradesCache(block.id, combinedTrades);

                // Build performance snapshot (30-95%)
                const snapshot = await buildPerformanceSnapshot({
                  trades: combinedTrades,
                  dailyLogs: existingDailyLogs,
                  normalizeTo1Lot: false,
                  onProgress: (p: SnapshotProgress) => {
                    // Scale snapshot progress to 30-95%
                    progress.update(p.step, 30 + Math.floor(p.percent * 0.65));
                  },
                  signal,
                });

                // Store to cache (95-100%)
                progress.update("Saving to cache...", 96);
                await waitForRender();
                await storePerformanceSnapshotCache(block.id, snapshot);

                // Pre-compute enriched trades for Report Builder
                progress.update("Pre-computing enriched trades...", 98);
                await waitForRender();
                const enrichedTrades = enrichTrades(combinedTrades, {
                  dailyLogs: existingDailyLogs,
                });
                await storeEnrichedTradesCache(block.id, enrichedTrades);
              } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                  console.log("Pre-calculation cancelled by user");
                } else {
                  throw err;
                }
              } finally {
                progress.finish();
                setIsProcessing(true); // Restore for remaining operations
              }
            }
          } else {
            // Disabling: delete the cached combined trades
            await deleteCombinedTradesCache(block.id);

            // Rebuild performance snapshot with raw trades
            if (existingTrades.length > 0) {
              const existingDailyLogs = await getDailyLogsByBlock(block.id);

              // Use progress dialog for pre-calculation
              setIsProcessing(false); // Hide old processing UI
              const signal = progress.start("Starting...", 0);

              // Allow React to render the dialog before starting computation
              await waitForRender();

              try {
                const snapshot = await buildPerformanceSnapshot({
                  trades: existingTrades,
                  dailyLogs: existingDailyLogs,
                  normalizeTo1Lot: false,
                  onProgress: (p: SnapshotProgress) => {
                    // Scale to 0-95%
                    progress.update(p.step, Math.floor(p.percent * 0.95));
                  },
                  signal,
                });

                // Store to cache (95-100%)
                progress.update("Saving to cache...", 96);
                await waitForRender();
                await storePerformanceSnapshotCache(block.id, snapshot);

                // Pre-compute enriched trades for Report Builder
                progress.update("Pre-computing enriched trades...", 98);
                await waitForRender();
                const enrichedTrades = enrichTrades(existingTrades, {
                  dailyLogs: existingDailyLogs,
                });
                await storeEnrichedTradesCache(block.id, enrichedTrades);
              } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                  console.log("Pre-calculation cancelled by user");
                } else {
                  throw err;
                }
              } finally {
                progress.finish();
                setIsProcessing(true); // Restore for remaining operations
              }
            }
          }
        }

        // Track if we need to clear caches/comparison data
        let filesChanged = false;

        if (tradeLog.file && processedData?.trades) {
          filesChanged = true;
          updates.tradeLog = {
            fileName: tradeLog.file.name,
            rowCount: processedData.trades.validTrades,
            fileSize: tradeLog.file.size,
          };

          const editTrades = processedData.trades.trades;
          updates.stats = {
            totalPnL: processedData.trades.stats.totalPL || 0,
            winRate:
              editTrades.length > 0
                ? (editTrades.filter((t) => t.pl > 0).length / editTrades.length) * 100
                : 0,
            totalTrades: processedData.trades.validTrades || 0,
            avgWin:
              editTrades.length > 0
                ? editTrades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0) /
                    editTrades.filter((t) => t.pl > 0).length || 0
                : 0,
            avgLoss:
              editTrades.length > 0
                ? editTrades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0) /
                    editTrades.filter((t) => t.pl < 0).length || 0
                : 0,
          };

          metadataUpdates.tradeLog = {
            fileName: tradeLog.file.name,
            fileSize: tradeLog.file.size,
            originalRowCount: processedData.trades.totalRows,
            processedRowCount: processedData.trades.trades.length,
            uploadedAt: new Date(),
          };

          // Update dateRange when trades are replaced
          if (
            processedData.trades.stats.dateRange.start &&
            processedData.trades.stats.dateRange.end
          ) {
            metadataUpdates.dateRange = {
              start: processedData.trades.stats.dateRange.start,
              end: processedData.trades.stats.dateRange.end,
            };
          }

          // Save trades to IndexedDB (replace all existing trades)
          await updateTradesForBlock(block.id, processedData.trades.trades);

          // Update combined trades cache if setting is enabled
          if (combineLegGroups) {
            // Show progress dialog for combining (this can freeze UI with large files)
            setIsProcessing(false); // Hide old processing UI
            const signal = progress.start("Starting...", 0);
            await waitForRender();

            try {
              const combinedTrades = await combineAllLegGroupsAsync(processedData.trades.trades, {
                onProgress: (p) => {
                  progress.update(`Combining: ${p.step}`, p.percent);
                },
                signal,
              });
              await storeCombinedTradesCache(block.id, combinedTrades);
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") {
                console.log("Combine leg groups cancelled by user");
              } else {
                throw err;
              }
            } finally {
              progress.finish();
              setIsProcessing(true); // Restore for remaining operations
            }
          } else {
            // Ensure cache is cleared if trades were updated
            await deleteCombinedTradesCache(block.id);
          }
        }

        if (dailyLog.file && processedData?.dailyLogs) {
          filesChanged = true;
          updates.dailyLog = {
            fileName: dailyLog.file.name,
            rowCount: processedData.dailyLogs.validEntries,
            fileSize: dailyLog.file.size,
          };

          metadataUpdates.dailyLog = {
            fileName: dailyLog.file.name,
            fileSize: dailyLog.file.size,
            originalRowCount: processedData.dailyLogs.totalRows,
            processedRowCount: processedData.dailyLogs.entries.length,
            uploadedAt: new Date(),
          };

          // Save daily log entries to IndexedDB (replace all existing entries)
          const entriesWithBlockId = processedData.dailyLogs.entries.map((entry) => ({
            ...entry,
            blockId: block.id,
          }));
          await updateDailyLogsForBlock(block.id, entriesWithBlockId);
        } else if (!dailyLog.file && dailyLog.status === "empty" && block.dailyLog) {
          // User cleared the daily log
          filesChanged = true;
          updates.dailyLog = undefined;
          metadataUpdates.dailyLog = undefined;
        }

        if (reportingLog.file && processedData?.reporting) {
          filesChanged = true;
          updates.reportingLog = {
            fileName: reportingLog.file.name,
            rowCount: processedData.reporting.validTrades,
            fileSize: reportingLog.file.size,
          };

          metadataUpdates.reportingLog = {
            fileName: reportingLog.file.name,
            fileSize: reportingLog.file.size,
            originalRowCount: processedData.reporting.totalRows,
            processedRowCount: processedData.reporting.trades.length,
            uploadedAt: new Date(),
          };

          await updateReportingTradesForBlock(block.id, processedData.reporting.trades);
        } else if (!reportingLog.file && reportingLog.status === "empty" && block.reportingLog) {
          filesChanged = true;
          updates.reportingLog = undefined;
          updates.strategyAlignment = undefined;
          metadataUpdates.reportingLog = undefined;
          metadataUpdates.strategyAlignment = undefined;
          await deleteReportingTradesByBlock(block.id);
        }

        if (Object.keys(metadataUpdates).length > 1) {
          await updateProcessedBlock(block.id, metadataUpdates);
        }

        await updateBlock(block.id, updates);

        // Clear calculation cache when any files are replaced or removed
        if (filesChanged) {
          calculationOrchestrator.clearCache(block.id);

          // Rebuild performance snapshot cache with updated data
          // Skip if we already rebuilt due to combineLegGroups change
          if (combineLegGroups === currentCombineLegGroups) {
            const { getTradesByBlockWithOptions, getDailyLogsByBlock } =
              await import("@tradeblocks/lib");

            const trades = await getTradesByBlockWithOptions(block.id, { combineLegGroups });
            const dailyLogs = await getDailyLogsByBlock(block.id);

            if (trades.length > 0) {
              // Use progress dialog for pre-calculation
              setIsProcessing(false); // Hide old processing UI
              const signal = progress.start("Starting...", 0);

              // Allow React to render the dialog before starting computation
              await waitForRender();

              try {
                const snapshot = await buildPerformanceSnapshot({
                  trades,
                  dailyLogs,
                  normalizeTo1Lot: false,
                  onProgress: (p: SnapshotProgress) => {
                    // Scale to 0-95%
                    progress.update(p.step, Math.floor(p.percent * 0.95));
                  },
                  signal,
                });

                // Store to cache (95-100%)
                progress.update("Saving to cache...", 96);
                await waitForRender();
                await storePerformanceSnapshotCache(block.id, snapshot);

                // Pre-compute enriched trades for Report Builder
                progress.update("Pre-computing enriched trades...", 98);
                await waitForRender();
                const enrichedTrades = enrichTrades(trades, { dailyLogs });
                await storeEnrichedTradesCache(block.id, enrichedTrades);
              } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                  console.log("Pre-calculation cancelled by user");
                } else {
                  throw err;
                }
              } finally {
                progress.finish();
                setIsProcessing(true); // Restore for remaining operations
              }
            } else {
              // No trades, delete the cache
              await deletePerformanceSnapshotCache(block.id);
              await deleteEnrichedTradesCache(block.id);
            }
          }
        }

        // Refresh the block to get updated stats from IndexedDB
        await refreshBlock(block.id);
      }

      setProcessingStep("");
      onOpenChange(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setProcessingErrors([errorMessage]);
      setProcessingStep("");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDelete = async () => {
    if (!block) return;

    try {
      setIsProcessing(true);
      setProcessingStep("Deleting block...");

      // Delete from IndexedDB and update store
      await deleteBlock(block.id);

      // Close dialogs
      setShowDeleteConfirm(false);
      onOpenChange(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to delete block";
      setProcessingErrors([errorMessage]);
    } finally {
      setIsProcessing(false);
      setProcessingStep("");
    }
  };

  const strategyInputRequired = missingStrategyCount > 0 && strategyOverride.trim() === "";
  const canSubmit =
    name.trim() && (tradeLog.file || tradeLog.existingFileName) && !strategyInputRequired;

  const getDialogTitle = () =>
    mode === "edit" ? "Edit Trading Block" : "Create New Trading Block";
  const getDialogDescription = () =>
    mode === "edit"
      ? "Update block details and replace files as needed."
      : "Upload your trade log and daily log files to create a new trading block for analysis.";

  const getSubmitButtonText = () => (mode === "edit" ? "Save Changes" : "Create Block");
  const getSubmitButtonIcon = () => (mode === "edit" ? Save : Plus);

  const SubmitIcon = getSubmitButtonIcon();

  const renderFileUpload = (type: UploadType, fileState: FileUploadState, isRequired: boolean) => {
    const isTradeLog = type === "trade";
    const isDailyLog = type === "daily";
    const Icon = isTradeLog ? Activity : isDailyLog ? Calendar : List;
    const label = isTradeLog ? "Trade Log" : isDailyLog ? "Daily Log" : "Reporting Log";
    const inputId = `${mode}-${type}-file-input`;
    const isMissingColumnsError = fileState.error?.startsWith("Missing required");
    const errorHeading = isMissingColumnsError
      ? isTradeLog
        ? "Missing trade log columns"
        : isDailyLog
          ? "Missing daily log columns"
          : "Missing reporting log columns"
      : "Upload error";
    const errorMessage = fileState.error
      ? fileState.error.replace(/^Missing required (?:trade|daily|reporting) log columns:\s*/i, "")
      : "";

    const tooltipContent = isTradeLog ? (
      <div className="max-w-xs space-y-2">
        <p className="text-sm leading-snug">
          Works with OptionOmega portfolio or individual backtest CSV exports.
        </p>
        <p className="text-sm leading-snug">
          <a
            href="https://docs.optionomega.com/backtesting/backtest-results#export-to-csv"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            View OptionOmega export guide ↗
          </a>
        </p>
      </div>
    ) : isDailyLog ? (
      <div className="max-w-xs text-sm leading-snug">
        Supports OptionOmega portfolio backtest daily logs. Individual backtests don’t include the
        daily performance CSV.
      </div>
    ) : (
      <div className="max-w-xs text-sm leading-snug">
        Upload strategy reporting exports to compare backtest results with live trades. Supports
        OptionOmega and TAT CSV formats.
      </div>
    );

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={inputId}>{label}</Label>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-muted-foreground/40 text-muted-foreground hover:border-muted-foreground hover:text-foreground"
                  aria-label={`${label} requirements`}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-left">
                {tooltipContent}
              </TooltipContent>
            </Tooltip>
          </div>
          <Badge variant={isRequired ? "destructive" : "secondary"} className="text-xs">
            {isRequired ? "Required" : "Optional"}
          </Badge>
        </div>

        <div
          className={`
            relative border-2 border-dashed rounded-lg ${
              mode === "new" ? "p-3 sm:p-4" : "p-4 sm:p-5"
            } transition-all cursor-pointer
            ${fileState.status === "dragover" ? "border-primary bg-primary/5" : ""}
            ${
              fileState.status === "uploaded"
                ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                : ""
            }
            ${
              fileState.status === "existing"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
                : ""
            }
            ${fileState.status === "error" ? "border-red-500 bg-red-50 dark:bg-red-950/20" : ""}
            ${
              fileState.status === "empty"
                ? "border-muted-foreground/25 hover:border-muted-foreground/50"
                : ""
            }
          `}
          onDragOver={(e) => handleDragOver(e, type)}
          onDragLeave={(e) => handleDragLeave(e, type)}
          onDrop={(e) => handleDrop(e, type)}
          onClick={() => document.getElementById(inputId)?.click()}
        >
          <input
            id={inputId}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => handleFileSelect(e, type)}
            aria-label={`Upload ${label} CSV file`}
            title={`Upload ${label} CSV file`}
          />

          {fileState.status === "processing" && fileState.file ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">{fileState.file.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Processing {type === "trade" ? "trades" : "daily log entries"}...
                  </p>
                </div>
              </div>
              {fileState.progress !== undefined && (
                <div className="space-y-1">
                  <Progress value={fileState.progress} className="h-2" />
                  <p className="text-xs text-muted-foreground text-center">
                    {fileState.progress}% complete
                  </p>
                </div>
              )}
            </div>
          ) : fileState.status === "uploaded" && fileState.file ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">{fileState.file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatFileSize(fileState.file.size)} •{" "}
                      {mode === "edit" ? "New file" : "CSV file"}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(type);
                  }}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              {fileState.processedData && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Processed Data</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-muted-foreground">Rows:</span>
                      <span className="ml-1 font-medium">{fileState.processedData.rowCount}</span>
                    </div>
                    {fileState.processedData.strategies && (
                      <div>
                        <span className="text-muted-foreground">Strategies:</span>
                        <span className="ml-1 font-medium">
                          {fileState.processedData.strategies.length}
                        </span>
                      </div>
                    )}
                  </div>
                  {fileState.processedData.dateRange && (
                    <div className="mt-2 text-xs">
                      <span className="text-muted-foreground">Date Range:</span>
                      <span className="ml-1 font-medium">
                        {fileState.processedData.dateRange.start?.toLocaleDateString()} -{" "}
                        {fileState.processedData.dateRange.end?.toLocaleDateString()}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : fileState.status === "existing" && fileState.existingFileName ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded">
                  <Icon className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="font-medium">{fileState.existingFileName}</p>
                  <p className="text-sm text-muted-foreground">
                    {fileState.existingRowCount} rows • Current file
                  </p>
                  <p className="text-xs text-muted-foreground/75">Click to replace with new file</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  Current
                </Badge>
                {!isRequired && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(type);
                    }}
                    title="Remove this file"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
                <Upload className="w-4 h-4 text-muted-foreground" />
              </div>
            </div>
          ) : fileState.status === "error" ? (
            <div className="flex items-start gap-3 text-left">
              <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                <AlertCircle className="w-5 h-5 text-red-600" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-red-700 dark:text-red-400">{errorHeading}</p>
                <p className="text-sm text-red-600 dark:text-red-300 leading-snug">
                  {errorMessage || fileState.error}
                </p>
                <p className="text-xs text-muted-foreground">Click to try again</p>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div
                className={`${mode === "new" ? "p-2" : "p-3"} bg-muted rounded-full w-fit mx-auto ${
                  mode === "new" ? "mb-2" : "mb-4"
                }`}
              >
                <Icon
                  className={`${mode === "new" ? "w-5 h-5" : "w-6 h-6"} text-muted-foreground`}
                />
              </div>
              <p className={`font-medium ${mode === "new" ? "text-sm" : ""}`}>
                {mode === "edit" && fileState.existingFileName
                  ? `Replace ${label}`
                  : mode === "edit" && !fileState.existingFileName
                    ? `Add ${label}`
                    : `Upload ${label}`}
              </p>
              <p className={`text-sm text-muted-foreground ${mode === "new" ? "mt-0.5" : "mt-1"}`}>
                Drag & drop your CSV file here or click to browse
              </p>
            </div>
          )}
        </div>

        {isTradeLog && missingStrategyCount > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200 space-y-2">
            <div className="font-medium flex items-center justify-between gap-2">
              <span>Strategy name required</span>
              <Badge
                variant="outline"
                className="text-xs text-amber-900 dark:text-amber-200 border-amber-400/70"
              >
                {missingStrategyCount} trade
                {missingStrategyCount === 1 ? "" : "s"}
              </Badge>
            </div>
            <p className="leading-snug">
              We detected trades without a strategy label. Enter a name and we’ll apply it to every
              blank entry before saving.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={strategyOverride}
                onChange={(e) => handleStrategyOverrideInputChange(e.target.value)}
                placeholder="e.g., Custom Strategy"
                aria-label="Strategy name for unlabeled trades"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleStrategyOverrideInputChange("")}
                disabled={!strategyOverride}
                className="sm:w-auto"
              >
                Clear
              </Button>
            </div>
            {!strategyOverride.trim() && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Entry required before you can create the block.
              </p>
            )}
            {strategyOverride.trim() && (
              <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
                Applying &quot;{strategyOverride.trim()}&quot; to {missingStrategyCount} trade
                {missingStrategyCount === 1 ? "" : "s"}.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(newOpen) => {
          if (!isProcessing) {
            onOpenChange(newOpen);
          }
        }}
      >
        <DialogContent
          className={cn(
            "max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto",
            mode === "new" && "p-5 gap-3",
          )}
        >
          <DialogHeader className={mode === "new" ? "gap-1.5" : undefined}>
            <DialogTitle className={mode === "new" ? "text-base" : undefined}>
              {getDialogTitle()}
            </DialogTitle>
            <DialogDescription className={mode === "new" ? "text-xs" : undefined}>
              {getDialogDescription()}
            </DialogDescription>
          </DialogHeader>

          <div className={mode === "new" ? "space-y-3" : "space-y-6"}>
            {/* Block Details */}
            <div className={mode === "new" ? "space-y-3" : "space-y-4"}>
              <div className="space-y-2">
                <Label htmlFor="block-name">Block Name</Label>
                <Input
                  id="block-name"
                  placeholder="e.g., 2025 Q1 Strategy"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="block-description">Description (Optional)</Label>
                <Textarea
                  id="block-description"
                  placeholder="Brief description of this trading block..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={mode === "new" ? 1 : 2}
                />
              </div>
            </div>

            {mode === "edit" && <Separator />}

            {/* File Uploads */}
            <div className={mode === "new" ? "space-y-3" : "space-y-4"}>
              {mode === "edit" && (
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">File Management</h3>
                  <p className="text-xs text-muted-foreground">
                    Upload new files to replace existing ones
                  </p>
                </div>
              )}

              {renderFileUpload("trade", tradeLog, true)}
              {renderFileUpload("daily", dailyLog, false)}
              {renderFileUpload("reporting", reportingLog, false)}
            </div>

            {/* Processing Status */}
            {isProcessing && (
              <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                  <div>
                    <p className="font-medium text-blue-900 dark:text-blue-100">Processing Files</p>
                    {processingStep && (
                      <p className="text-sm text-blue-700 dark:text-blue-300">{processingStep}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Errors */}
            {processingErrors.length > 0 && (
              <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p className="font-medium text-red-900 dark:text-red-100">Processing Errors</p>
                    <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                      {processingErrors.map((error, index) => (
                        <li key={index} className="flex items-start gap-2">
                          <span className="text-red-500">•</span>
                          <span>{error}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Options */}
            <div className="space-y-3">
              {mode === "new" && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="set-active"
                    checked={setAsActive}
                    onCheckedChange={(checked) => setSetAsActive(checked === true)}
                  />
                  <Label htmlFor="set-active">Set as active block after creation</Label>
                </div>
              )}

              {/* Combine Leg Groups toggle */}
              <div className="flex items-start space-x-2">
                <Checkbox
                  id="combine-leg-groups"
                  checked={combineLegGroups}
                  onCheckedChange={(checked) => setCombineLegGroups(checked === true)}
                />
                <div className="flex flex-col space-y-1">
                  <Label htmlFor="combine-leg-groups" className="cursor-pointer">
                    Combine leg groups
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Merge trades/strategies with the same entry timestamp into single records.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {mode === "edit" && <Separator />}

          <DialogFooter className={mode === "new" ? "pt-1" : undefined}>
            <div className="flex w-full justify-between items-center">
              {mode === "edit" ? (
                <Button
                  variant="destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={isProcessing}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Block
                </Button>
              ) : (
                <div />
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isProcessing}
                >
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={!canSubmit || isProcessing}>
                  {isProcessing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <SubmitIcon className="w-4 h-4 mr-2" />
                  )}
                  {isProcessing ? "Processing..." : getSubmitButtonText()}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mode === "edit" && (
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Trading Block</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{block?.name}&quot;? This action cannot be
                undone and will permanently remove all data associated with this block.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isProcessing}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  "Delete Block"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Progress dialog for pre-calculation */}
      <ProgressDialog
        open={progress.state?.open ?? false}
        title="Pre-calculating Statistics"
        step={progress.state?.step ?? ""}
        percent={progress.state?.percent ?? 0}
        onCancel={handleCancelCalculation}
      />
    </>
  );
}
