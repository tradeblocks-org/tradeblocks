"use client";

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Database,
  Calendar,
  Columns3,
  Eye,
  Trash2,
  Pencil,
  Check,
  X,
  HelpCircle,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { StaticDataset, MatchStrategy } from "@tradeblocks/lib";
import { MATCH_STRATEGY_LABELS, MATCH_STRATEGY_DESCRIPTIONS } from "@tradeblocks/lib";
import { useStaticDatasetsStore, makeMatchStatsCacheKey } from "@tradeblocks/lib/stores";
import type { Trade } from "@tradeblocks/lib";

interface DatasetCardProps {
  dataset: StaticDataset;
  onPreview: (dataset: StaticDataset) => void;
  /** Trades from the active block for computing match stats */
  trades?: Trade[];
  /** Block ID for caching match stats */
  blockId?: string;
}

export function DatasetCard({ dataset, onPreview, trades, blockId }: DatasetCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(dataset.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const updateMatchStrategy = useStaticDatasetsStore((state) => state.updateMatchStrategy);
  const renameDataset = useStaticDatasetsStore((state) => state.renameDataset);
  const deleteDataset = useStaticDatasetsStore((state) => state.deleteDataset);
  const validateName = useStaticDatasetsStore((state) => state.validateName);
  const computeMatchStats = useStaticDatasetsStore((state) => state.computeMatchStats);

  // Build the cache key for this specific dataset/block/strategy combo
  const cacheKey = blockId
    ? makeMatchStatsCacheKey(dataset.id, blockId, dataset.matchStrategy)
    : null;

  // Subscribe directly to the cached stats for this specific key
  // This ensures re-render when this specific cache entry changes
  const matchStats = useStaticDatasetsStore((state) =>
    cacheKey && trades && trades.length > 0 ? (state.cachedMatchStats.get(cacheKey) ?? null) : null,
  );

  // Subscribe directly to computing state for this specific key
  const isLoadingStats = useStaticDatasetsStore((state) =>
    cacheKey ? state.computingMatchStats.has(cacheKey) : false,
  );

  // Trigger computation if not cached and not already computing
  useEffect(() => {
    if (!trades || trades.length === 0 || !blockId || !cacheKey) {
      return;
    }

    // Check current state and trigger computation if needed
    const state = useStaticDatasetsStore.getState();
    const cached = state.cachedMatchStats.get(cacheKey);
    const computing = state.computingMatchStats.has(cacheKey);

    if (!cached && !computing) {
      computeMatchStats(dataset.id, blockId, trades, dataset.matchStrategy);
    }
  }, [trades, blockId, dataset.id, dataset.matchStrategy, cacheKey, computeMatchStats]);

  const formatDate = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(date));

  const formatDateTime = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(date));

  const handleStrategyChange = useCallback(
    async (value: string) => {
      await updateMatchStrategy(dataset.id, value as MatchStrategy);
    },
    [dataset.id, updateMatchStrategy],
  );

  const handleStartEdit = useCallback(() => {
    setEditName(dataset.name);
    setNameError(null);
    setIsEditing(true);
  }, [dataset.name]);

  const handleCancelEdit = useCallback(() => {
    setEditName(dataset.name);
    setNameError(null);
    setIsEditing(false);
  }, [dataset.name]);

  const handleSaveEdit = useCallback(async () => {
    if (!editName.trim() || editName === dataset.name) {
      setIsEditing(false);
      return;
    }

    const validation = await validateName(editName, dataset.id);
    if (!validation.valid) {
      setNameError(validation.error || "Invalid name");
      return;
    }

    const result = await renameDataset(dataset.id, editName.trim());
    if (result.success) {
      setIsEditing(false);
      setNameError(null);
    } else {
      setNameError(result.error || "Failed to rename");
    }
  }, [editName, dataset.id, dataset.name, validateName, renameDataset]);

  const handleDelete = useCallback(async () => {
    await deleteDataset(dataset.id);
    setShowDeleteConfirm(false);
  }, [dataset.id, deleteDataset]);

  return (
    <Card className="relative">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setNameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveEdit();
                    if (e.key === "Escape") handleCancelEdit();
                  }}
                  className="h-8 text-lg font-semibold"
                  autoFocus
                />
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleSaveEdit}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleCancelEdit}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg font-semibold leading-tight truncate">
                  {dataset.name}
                </CardTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:opacity-100"
                  onClick={handleStartEdit}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
            )}
            {nameError && <p className="text-xs text-destructive mt-1">{nameError}</p>}
            <p className="text-sm text-muted-foreground truncate mt-1">{dataset.fileName}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="text-xs">
            <Database className="w-3 h-3 mr-1" />
            {dataset.rowCount.toLocaleString()} rows
          </Badge>
          <Badge variant="outline" className="text-xs">
            <Calendar className="w-3 h-3 mr-1" />
            {formatDate(dataset.dateRange.start)} - {formatDate(dataset.dateRange.end)}
          </Badge>
          {/* Match Stats Badge */}
          {isLoadingStats && (
            <Badge variant="outline" className="text-xs">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Matching...
            </Badge>
          )}
          {!isLoadingStats && matchStats && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant={
                      matchStats.matchPercentage >= 90
                        ? "default"
                        : matchStats.matchPercentage >= 50
                          ? "secondary"
                          : "outline"
                    }
                    className={`text-xs ${matchStats.matchPercentage < 50 ? "text-amber-600 dark:text-amber-400 border-amber-300" : ""}`}
                  >
                    {matchStats.matchPercentage >= 90 ? (
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                    ) : matchStats.matchPercentage < 50 ? (
                      <AlertTriangle className="w-3 h-3 mr-1" />
                    ) : null}
                    {matchStats.matchPercentage}% matched
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <p>
                    {matchStats.matchedTrades} of {matchStats.totalTrades} trades matched
                  </p>
                  {matchStats.outsideDateRange > 0 && (
                    <p className="text-muted-foreground">
                      {matchStats.outsideDateRange} outside date range
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Columns */}
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Columns3 className="w-3 h-3" />
            <span>Columns:</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {dataset.columns.slice(0, 5).map((column) => (
              <Badge key={column} variant="outline" className="text-xs font-mono">
                {column}
              </Badge>
            ))}
            {dataset.columns.length > 5 && (
              <Badge variant="outline" className="text-xs">
                +{dataset.columns.length - 5} more
              </Badge>
            )}
          </div>
        </div>

        {/* Match Strategy */}
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Match Strategy:</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="w-3 h-3 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p className="text-xs">
                    Determines how trade timestamps are matched to dataset rows.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Select value={dataset.matchStrategy} onValueChange={handleStrategyChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue>{MATCH_STRATEGY_LABELS[dataset.matchStrategy]}</SelectValue>
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

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-muted-foreground">
            Uploaded {formatDateTime(dataset.uploadedAt)}
          </span>
          <Button size="sm" variant="outline" onClick={() => onPreview(dataset)}>
            <Eye className="w-4 h-4 mr-1" />
            Preview
          </Button>
        </div>
      </CardContent>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Dataset?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{dataset.name}&quot; and all its data. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
