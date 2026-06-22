"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link2, Unlink, Lock } from "lucide-react";
import { useTradingCalendarStore, StrategyMatch } from "@tradeblocks/lib/stores";
import { cn } from "@tradeblocks/lib";

interface MatchStrategiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MatchStrategiesDialog({ open, onOpenChange }: MatchStrategiesDialogProps) {
  const {
    strategyMatches,
    unmatchedBacktestStrategies,
    unmatchedActualStrategies,
    linkStrategies,
    unlinkStrategies,
  } = useTradingCalendarStore();

  const [selectedBacktest, setSelectedBacktest] = useState<string | null>(null);
  const [selectedActual, setSelectedActual] = useState<string | null>(null);

  const handleLink = () => {
    if (selectedBacktest && selectedActual) {
      linkStrategies(selectedBacktest, selectedActual);
      setSelectedBacktest(null);
      setSelectedActual(null);
    }
  };

  const handleUnlink = (match: StrategyMatch) => {
    if (!match.isAutoMatched) {
      unlinkStrategies(match.backtestStrategy, match.actualStrategy);
    }
  };

  const hasUnmatched =
    unmatchedBacktestStrategies.length > 0 || unmatchedActualStrategies.length > 0;
  const userMatches = strategyMatches.filter((m) => !m.isAutoMatched);
  const autoMatches = strategyMatches.filter((m) => m.isAutoMatched);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85vh] w-full flex flex-col sm:max-w-[calc(100vw-2rem)] md:max-w-4xl xl:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Match Strategies</DialogTitle>
          <DialogDescription>
            Link backtest strategies to their corresponding actual strategies. Auto-matched
            strategies (exact name match) cannot be unlinked.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 flex-1 overflow-y-auto">
          {/* Existing matches */}
          {strategyMatches.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Linked Strategies</h4>
              <div className="border rounded-md p-2">
                <div className="space-y-2">
                  {/* Auto matches first */}
                  {autoMatches.map((match) => (
                    <div
                      key={`${match.backtestStrategy}-${match.actualStrategy}`}
                      className="flex items-center justify-between p-2 bg-muted/30 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="bg-blue-500/10 text-blue-500 border-blue-500/50"
                        >
                          {match.backtestStrategy}
                        </Badge>
                        <Link2 className="h-4 w-4 text-muted-foreground" />
                        <Badge
                          variant="outline"
                          className="bg-purple-500/10 text-purple-500 border-purple-500/50"
                        >
                          {match.actualStrategy}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Lock className="h-3 w-3" />
                        <span>Auto-matched</span>
                      </div>
                    </div>
                  ))}

                  {/* User matches */}
                  {userMatches.map((match) => (
                    <div
                      key={`${match.backtestStrategy}-${match.actualStrategy}`}
                      className="flex items-center justify-between p-2 bg-muted/30 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="bg-blue-500/10 text-blue-500 border-blue-500/50"
                        >
                          {match.backtestStrategy}
                        </Badge>
                        <Link2 className="h-4 w-4 text-muted-foreground" />
                        <Badge
                          variant="outline"
                          className="bg-purple-500/10 text-purple-500 border-purple-500/50"
                        >
                          {match.actualStrategy}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnlink(match)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Unlink className="h-4 w-4 mr-1" />
                        Unlink
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Unmatched strategies */}
          {hasUnmatched && (
            <div className="grid grid-cols-2 gap-4">
              {/* Backtest strategies */}
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  Unmatched Backtest ({unmatchedBacktestStrategies.length})
                </h4>
                <div className="border rounded-md p-2">
                  <div className="space-y-1">
                    {unmatchedBacktestStrategies.map((strategy) => (
                      <button
                        type="button"
                        key={strategy}
                        onClick={() =>
                          setSelectedBacktest(selectedBacktest === strategy ? null : strategy)
                        }
                        className={cn(
                          "w-full text-left px-3 py-2 rounded text-sm transition-colors",
                          selectedBacktest === strategy
                            ? "bg-blue-500/20 text-blue-500"
                            : "hover:bg-muted",
                        )}
                      >
                        {strategy}
                      </button>
                    ))}
                    {unmatchedBacktestStrategies.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        All backtest strategies matched
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Actual strategies */}
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  Unmatched Actual ({unmatchedActualStrategies.length})
                </h4>
                <div className="border rounded-md p-2">
                  <div className="space-y-1">
                    {unmatchedActualStrategies.map((strategy) => (
                      <button
                        type="button"
                        key={strategy}
                        onClick={() =>
                          setSelectedActual(selectedActual === strategy ? null : strategy)
                        }
                        className={cn(
                          "w-full text-left px-3 py-2 rounded text-sm transition-colors",
                          selectedActual === strategy
                            ? "bg-purple-500/20 text-purple-500"
                            : "hover:bg-muted",
                        )}
                      >
                        {strategy}
                      </button>
                    ))}
                    {unmatchedActualStrategies.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        All actual strategies matched
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Link action */}
          {hasUnmatched && (
            <div className="flex items-center justify-center gap-4 p-4 border rounded-md bg-muted/30">
              {selectedBacktest && selectedActual ? (
                <>
                  <Badge
                    variant="outline"
                    className="bg-blue-500/10 text-blue-500 border-blue-500/50"
                  >
                    {selectedBacktest}
                  </Badge>
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                  <Badge
                    variant="outline"
                    className="bg-purple-500/10 text-purple-500 border-purple-500/50"
                  >
                    {selectedActual}
                  </Badge>
                  <Button onClick={handleLink} size="sm">
                    Link Strategies
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select one strategy from each column to link them
                </p>
              )}
            </div>
          )}

          {/* All matched state */}
          {!hasUnmatched && strategyMatches.length > 0 && (
            <div className="text-center py-4 text-muted-foreground">All strategies are matched</div>
          )}

          {/* No strategies state */}
          {strategyMatches.length === 0 && !hasUnmatched && (
            <div className="text-center py-4 text-muted-foreground">
              No strategies to match. Upload both backtest and actual trade data.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
