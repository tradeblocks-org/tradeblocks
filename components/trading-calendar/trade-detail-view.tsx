"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useTradingCalendarStore } from "@tradeblocks/lib/stores";
import { Trade } from "@tradeblocks/lib";
import { ReportingTrade } from "@tradeblocks/lib";
import { formatCurrency, createScalingContext, getScaleFactor } from "@tradeblocks/lib";
import {
  groupTradesByEntry,
  combineLegGroup,
  groupReportingTradesByEntry,
  combineReportingLegGroup,
  CombinedTrade,
  CombinedReportingTrade,
} from "@tradeblocks/lib";
import { cn } from "@tradeblocks/lib";

/**
 * Normalize backtest premium to dollars
 * Backtest trades may store premium in cents (whole numbers without decimals)
 * while reporting trades store premium in dollars
 */
function normalizeBacktestPremium(trade: Trade | CombinedTrade): number {
  if (trade.premiumPrecision === "cents") {
    return trade.premium / 100;
  }
  return trade.premium;
}

interface DetailRowProps {
  label: string;
  value: string | number | null | undefined;
  format?: "currency" | "number" | "text" | "percent" | "premium";
  scaleFactor?: number | null;
}

function DetailRow({ label, value, format = "text", scaleFactor = null }: DetailRowProps) {
  const formatValue = (val: string | number | null | undefined): string => {
    if (val === null || val === undefined) return "-";
    if (typeof val === "string") return val;
    if (format === "currency") return formatCurrency(val);
    if (format === "number") return val.toLocaleString();
    if (format === "percent") return `${val.toFixed(2)}%`;
    if (format === "premium") {
      // Format as debit (db) or credit (cr)
      const absVal = Math.abs(val);
      const formatted = absVal.toFixed(2);
      return val < 0 ? `${formatted} db` : `${formatted} cr`;
    }
    return String(val);
  };

  // Apply scaling if provided
  const hasScaling = scaleFactor !== null && scaleFactor !== 1 && typeof value === "number";
  const scaledValue = hasScaling ? (value as number) * scaleFactor! : null;

  const primaryValue = scaledValue ?? value;
  const primaryFormatted = formatValue(primaryValue);
  const rawFormatted = hasScaling ? formatValue(value) : null;

  return (
    <div className="grid grid-cols-2 gap-4 py-2 border-b border-border/50">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-right">
        {primaryFormatted}
        {rawFormatted && (
          <span className="text-xs text-muted-foreground ml-1">(raw: {rawFormatted})</span>
        )}
      </div>
    </div>
  );
}

/**
 * Display legs with each leg on its own line
 * Leg format: "<contracts> <date> <strike> <type> <action> <price>"
 * Multiple legs separated by " | "
 * Strips the leading contract count since it's shown separately in the Contracts row
 */
function LegsRow({ legs }: { legs: string }) {
  // Split by " | " to get individual legs
  const legParts = legs.split(" | ");

  // Strip leading contract count from each leg (it's shown in Contracts row)
  const legDetails = legParts.map((leg) => {
    const match = leg.match(/^\d+\s+(.+)$/);
    return match ? match[1] : leg;
  });

  return (
    <div className="grid grid-cols-2 gap-4 py-2 border-b border-border/50">
      <div className="text-sm text-muted-foreground">Legs</div>
      <div className="text-sm font-medium text-right">
        {legDetails.map((detail, idx) => (
          <div key={idx}>{detail}</div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Individual Leg Card (compact version for inside combined groups)
// =============================================================================

interface IndividualLegCardProps {
  trade: Trade | ReportingTrade;
  index: number;
  type: "backtest" | "actual";
}

function IndividualLegCard({ trade, index, type }: IndividualLegCardProps) {
  const isBacktest = type === "backtest";
  // Normalize backtest premium from cents to dollars if needed
  const premium = isBacktest
    ? normalizeBacktestPremium(trade as Trade)
    : (trade as ReportingTrade).initialPremium;

  return (
    <div className="p-3 bg-muted/30 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">Leg {index + 1}</span>
        <span
          className={cn(
            "text-sm font-semibold",
            trade.pl > 0 && "text-green-500",
            trade.pl < 0 && "text-red-500",
          )}
        >
          {formatCurrency(trade.pl)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="truncate">Legs: {trade.legs}</div>
        <div>
          Premium: {Math.abs(premium).toFixed(2)} {premium < 0 ? "db" : "cr"}
        </div>
        <div>
          Close: {"timeClosed" in trade ? (trade.timeClosed ?? "-") : "-"}
          {" - "}
          {trade.reasonForClose ?? "-"}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Combined Trade Group (expandable/collapsible)
// =============================================================================

interface CombinedActualTradeGroupProps {
  combined: CombinedReportingTrade;
  originalTrades: ReportingTrade[];
  scalingMode: "raw" | "perContract" | "toReported";
  sideBySide?: boolean;
}

function CombinedActualTradeGroup({
  combined,
  originalTrades,
  scalingMode,
  sideBySide = false,
}: CombinedActualTradeGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const scaleFactor = useMemo(() => {
    if (scalingMode === "raw") return null;
    if (scalingMode === "perContract") {
      return combined.numContracts > 0 ? 1 / combined.numContracts : null;
    }
    return null;
  }, [scalingMode, combined.numContracts]);

  // Calculate scaled P&L for header display
  const displayPl = scaleFactor !== null ? combined.pl * scaleFactor : combined.pl;

  const legCount = combined.originalTradeCount;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card className="pt-2 pb-4">
        <CardHeader className="pt-2 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              {legCount > 1 ? `Combined Trade (${legCount} legs)` : "Trade Details"}
              <Badge
                variant="outline"
                className="bg-purple-500/10 text-purple-500 border-purple-500/50 text-xs"
              >
                Actual
              </Badge>
            </CardTitle>
            <div
              className={cn(
                "text-lg font-bold",
                displayPl > 0 && "text-green-500",
                displayPl < 0 && "text-red-500",
              )}
            >
              {formatCurrency(displayPl)}
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <DetailRow label="Time Opened" value={combined.timeOpened ?? "-"} />
          <DetailRow label="Time Closed" value={combined.timeClosed ?? "-"} />
          <DetailRow label="Opening Price" value={combined.openingPrice} format="number" />
          <LegsRow legs={combined.legs} />
          <DetailRow label="Premium" value={combined.initialPremium} format="premium" />
          <DetailRow label="Contracts" value={combined.numContracts} format="number" />
          <DetailRow label="Closing Price" value={combined.closingPrice} format="number" />
          <DetailRow
            label="Avg Closing Cost"
            value={combined.avgClosingCost}
            format="currency"
            scaleFactor={scaleFactor}
          />
          <DetailRow label="Reason for Close" value={combined.reasonForClose} />
          <DetailRow label="P&L" value={combined.pl} format="currency" scaleFactor={scaleFactor} />

          {/* Spacer to match "Show Backtest Details" button height when side-by-side */}
          {sideBySide && (
            <div
              className="w-full mt-4 py-2 border-t border-border/50 h-[36px]"
              aria-hidden="true"
            />
          )}

          {legCount > 1 && (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full mt-4 py-2 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2 border-t border-border/50"
              >
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")}
                />
                {isExpanded ? "Hide Leg Details" : "Show Leg Details"}
              </button>
            </CollapsibleTrigger>
          )}
        </CardContent>

        {legCount > 1 && (
          <CollapsibleContent>
            <div className="px-4 pb-2 space-y-3">
              {originalTrades.map((trade, idx) => (
                <IndividualLegCard key={idx} trade={trade} index={idx} type="actual" />
              ))}
            </div>
          </CollapsibleContent>
        )}
      </Card>
    </Collapsible>
  );
}

interface CombinedBacktestTradeGroupProps {
  combined: CombinedTrade;
  originalTrades: Trade[];
  scalingMode: "raw" | "perContract" | "toReported";
  toReportedScaleFactor?: number | null;
}

function CombinedBacktestTradeGroup({
  combined,
  originalTrades,
  scalingMode,
  toReportedScaleFactor,
}: CombinedBacktestTradeGroupProps) {
  const [isLegsExpanded, setIsLegsExpanded] = useState(false);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  const scaleFactor = useMemo(() => {
    if (scalingMode === "raw") return null;
    if (scalingMode === "perContract") {
      return combined.numContracts > 0 ? 1 / combined.numContracts : null;
    }
    if (scalingMode === "toReported") {
      return toReportedScaleFactor ?? null;
    }
    return null;
  }, [scalingMode, combined.numContracts, toReportedScaleFactor]);

  const legCount = combined.originalTradeCount;

  return (
    <Card className="pt-2 pb-4">
      <CardHeader className="pt-2 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {legCount > 1 ? `Combined Trade (${legCount} legs)` : "Trade Details"}
            <Badge
              variant="outline"
              className="bg-blue-500/10 text-blue-500 border-blue-500/50 text-xs"
            >
              Backtest
            </Badge>
          </CardTitle>
          <div
            className={cn(
              "text-lg font-bold",
              combined.pl > 0 && "text-green-500",
              combined.pl < 0 && "text-red-500",
            )}
          >
            {formatCurrency(scaleFactor ? combined.pl * scaleFactor : combined.pl)}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <DetailRow label="Time Opened" value={combined.timeOpened ?? "-"} />
        <DetailRow label="Time Closed" value={combined.timeClosed ?? "-"} />
        <DetailRow label="Opening Price" value={combined.openingPrice} format="number" />
        <LegsRow legs={combined.legs} />
        <DetailRow label="Premium" value={normalizeBacktestPremium(combined)} format="premium" />
        <DetailRow label="Contracts" value={combined.numContracts} format="number" />
        <DetailRow label="Closing Price" value={combined.closingPrice} format="number" />
        <DetailRow
          label="Avg Closing Cost"
          value={combined.avgClosingCost}
          format="currency"
          scaleFactor={scaleFactor}
        />
        <DetailRow label="Reason for Close" value={combined.reasonForClose} />
        <DetailRow label="P&L" value={combined.pl} format="currency" scaleFactor={scaleFactor} />

        {/* Additional Backtest Details - Collapsible */}
        <Collapsible open={isDetailsExpanded} onOpenChange={setIsDetailsExpanded}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full mt-4 py-2 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2 border-t border-border/50"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", isDetailsExpanded && "rotate-180")}
              />
              {isDetailsExpanded ? "Hide Backtest Details" : "Show Backtest Details"}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-2">
              <DetailRow
                label="Opening Commissions"
                value={combined.openingCommissionsFees}
                format="currency"
                scaleFactor={scaleFactor}
              />
              <DetailRow
                label="Closing Commissions"
                value={combined.closingCommissionsFees}
                format="currency"
                scaleFactor={scaleFactor}
              />
              <DetailRow
                label="Margin Requirement"
                value={combined.marginReq}
                format="currency"
                scaleFactor={scaleFactor}
              />
              {combined.openingVix && (
                <DetailRow label="Opening VIX" value={combined.openingVix} format="number" />
              )}
              {combined.closingVix && (
                <DetailRow label="Closing VIX" value={combined.closingVix} format="number" />
              )}
              {combined.gap !== undefined && (
                <DetailRow label="Gap" value={combined.gap} format="number" />
              )}
              {combined.movement !== undefined && (
                <DetailRow label="Movement" value={combined.movement} format="number" />
              )}
              {/* For combined trades (multiple legs), maxProfit/maxLoss are dollar amounts derived from margin */}
              {/* For single trades, they are percentages of premium */}
              {combined.maxProfit !== undefined && (
                <DetailRow
                  label="Max Profit"
                  value={combined.maxProfit}
                  format={combined.originalTradeCount > 1 ? "currency" : "percent"}
                  scaleFactor={combined.originalTradeCount > 1 ? scaleFactor : undefined}
                />
              )}
              {combined.maxLoss !== undefined && (
                <DetailRow
                  label="Max Loss"
                  value={combined.maxLoss}
                  format={combined.originalTradeCount > 1 ? "currency" : "percent"}
                  scaleFactor={combined.originalTradeCount > 1 ? scaleFactor : undefined}
                />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Leg Details - Collapsible */}
        {legCount > 1 && (
          <Collapsible open={isLegsExpanded} onOpenChange={setIsLegsExpanded}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full mt-2 py-2 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2 border-t border-border/50"
              >
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", isLegsExpanded && "rotate-180")}
                />
                {isLegsExpanded ? "Hide Leg Details" : "Show Leg Details"}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2 space-y-3">
                {originalTrades.map((trade, idx) => (
                  <IndividualLegCard key={idx} trade={trade} index={idx} type="backtest" />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Individual Trade Cards (for when combining is disabled)
// =============================================================================

interface SingleTradeCardProps {
  trade: ReportingTrade;
  tradeIndex: number;
  totalTrades: number;
  scalingMode: "raw" | "perContract" | "toReported";
  sideBySide?: boolean;
}

function ActualTradeCard({
  trade,
  tradeIndex,
  totalTrades,
  scalingMode,
  sideBySide = false,
}: SingleTradeCardProps) {
  const scaleFactor = useMemo(() => {
    if (scalingMode === "raw") return null;
    if (scalingMode === "perContract") {
      return trade.numContracts > 0 ? 1 / trade.numContracts : null;
    }
    return null;
  }, [scalingMode, trade.numContracts]);

  // Calculate scaled P&L for header display
  const displayPl = scaleFactor !== null ? trade.pl * scaleFactor : trade.pl;

  const tradeLabel = totalTrades > 1 ? ` (Trade ${tradeIndex + 1} of ${totalTrades})` : "";

  return (
    <Card className="pt-2 pb-4">
      <CardHeader className="pt-2 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            Trade Details{tradeLabel}
            <Badge
              variant="outline"
              className="bg-purple-500/10 text-purple-500 border-purple-500/50 text-xs"
            >
              Actual
            </Badge>
          </CardTitle>
          <div
            className={cn(
              "text-lg font-bold",
              displayPl > 0 && "text-green-500",
              displayPl < 0 && "text-red-500",
            )}
          >
            {formatCurrency(displayPl)}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DetailRow label="Time Opened" value={trade.timeOpened ?? "-"} />
        <DetailRow label="Time Closed" value={trade.timeClosed ?? "-"} />
        <DetailRow label="Opening Price" value={trade.openingPrice} format="number" />
        <LegsRow legs={trade.legs} />
        <DetailRow label="Premium" value={trade.initialPremium} format="premium" />
        <DetailRow label="Contracts" value={trade.numContracts} format="number" />
        <DetailRow label="Closing Price" value={trade.closingPrice} format="number" />
        <DetailRow
          label="Avg Closing Cost"
          value={trade.avgClosingCost}
          format="currency"
          scaleFactor={scaleFactor}
        />
        <DetailRow label="Reason for Close" value={trade.reasonForClose} />
        <DetailRow label="P&L" value={trade.pl} format="currency" scaleFactor={scaleFactor} />

        {/* Spacer to match "Show Backtest Details" button height when side-by-side */}
        {sideBySide && (
          <div className="w-full mt-4 py-2 border-t border-border/50 h-[36px]" aria-hidden="true" />
        )}
      </CardContent>
    </Card>
  );
}

interface BacktestTradeCardProps {
  trade: Trade;
  tradeIndex: number;
  totalTrades: number;
  scalingMode: "raw" | "perContract" | "toReported";
  toReportedScaleFactor?: number | null;
}

function BacktestTradeCard({
  trade,
  tradeIndex,
  totalTrades,
  scalingMode,
  toReportedScaleFactor,
}: BacktestTradeCardProps) {
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  const scaleFactor = useMemo(() => {
    if (scalingMode === "raw") return null;
    if (scalingMode === "perContract") {
      return trade.numContracts > 0 ? 1 / trade.numContracts : null;
    }
    if (scalingMode === "toReported") {
      return toReportedScaleFactor ?? null;
    }
    return null;
  }, [scalingMode, trade.numContracts, toReportedScaleFactor]);

  const tradeLabel = totalTrades > 1 ? ` (Trade ${tradeIndex + 1} of ${totalTrades})` : "";

  return (
    <Card className="pt-2 pb-4">
      <CardHeader className="pt-2 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            Trade Details{tradeLabel}
            <Badge
              variant="outline"
              className="bg-blue-500/10 text-blue-500 border-blue-500/50 text-xs"
            >
              Backtest
            </Badge>
          </CardTitle>
          <div
            className={cn(
              "text-lg font-bold",
              trade.pl > 0 && "text-green-500",
              trade.pl < 0 && "text-red-500",
            )}
          >
            {formatCurrency(scaleFactor ? trade.pl * scaleFactor : trade.pl)}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DetailRow label="Time Opened" value={trade.timeOpened ?? "-"} />
        <DetailRow label="Time Closed" value={trade.timeClosed ?? "-"} />
        <DetailRow label="Opening Price" value={trade.openingPrice} format="number" />
        <LegsRow legs={trade.legs} />
        <DetailRow label="Premium" value={normalizeBacktestPremium(trade)} format="premium" />
        <DetailRow label="Contracts" value={trade.numContracts} format="number" />
        <DetailRow label="Closing Price" value={trade.closingPrice} format="number" />
        <DetailRow
          label="Avg Closing Cost"
          value={trade.avgClosingCost}
          format="currency"
          scaleFactor={scaleFactor}
        />
        <DetailRow label="Reason for Close" value={trade.reasonForClose} />
        <DetailRow label="P&L" value={trade.pl} format="currency" scaleFactor={scaleFactor} />

        {/* Additional Backtest Details - Collapsible */}
        <Collapsible open={isDetailsExpanded} onOpenChange={setIsDetailsExpanded}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full mt-4 py-2 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2 border-t border-border/50"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", isDetailsExpanded && "rotate-180")}
              />
              {isDetailsExpanded ? "Hide Backtest Details" : "Show Backtest Details"}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-2">
              <DetailRow
                label="Opening Commissions"
                value={trade.openingCommissionsFees}
                format="currency"
                scaleFactor={scaleFactor}
              />
              <DetailRow
                label="Closing Commissions"
                value={trade.closingCommissionsFees}
                format="currency"
                scaleFactor={scaleFactor}
              />
              <DetailRow
                label="Margin Requirement"
                value={trade.marginReq}
                format="currency"
                scaleFactor={scaleFactor}
              />
              {trade.openingVix && (
                <DetailRow label="Opening VIX" value={trade.openingVix} format="number" />
              )}
              {trade.closingVix && (
                <DetailRow label="Closing VIX" value={trade.closingVix} format="number" />
              )}
              {trade.gap !== undefined && (
                <DetailRow label="Gap" value={trade.gap} format="number" />
              )}
              {trade.movement !== undefined && (
                <DetailRow label="Movement" value={trade.movement} format="number" />
              )}
              {trade.maxProfit !== undefined && (
                <DetailRow label="Max Profit" value={trade.maxProfit} format="percent" />
              )}
              {trade.maxLoss !== undefined && (
                <DetailRow label="Max Loss" value={trade.maxLoss} format="percent" />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Trade Matching Utilities
// =============================================================================

interface MatchedTradePair {
  actual: ReportingTrade | null;
  backtest: Trade | null;
  pairIndex: number;
}

/**
 * Match actual and backtest trades by premium sign (credit vs debit)
 * This helps align corresponding positions in side-by-side view
 */
function matchTradesByPremiumSign(
  actualTrades: ReportingTrade[],
  backtestTrades: Trade[],
): MatchedTradePair[] {
  const pairs: MatchedTradePair[] = [];

  // Separate trades by premium sign
  const actualCredits = actualTrades.filter((t) => t.initialPremium >= 0);
  const actualDebits = actualTrades.filter((t) => t.initialPremium < 0);
  const btCredits = backtestTrades.filter((t) => t.premium >= 0);
  const btDebits = backtestTrades.filter((t) => t.premium < 0);

  let pairIndex = 0;

  // Match credits first
  const maxCredits = Math.max(actualCredits.length, btCredits.length);
  for (let i = 0; i < maxCredits; i++) {
    pairs.push({
      actual: actualCredits[i] ?? null,
      backtest: btCredits[i] ?? null,
      pairIndex: pairIndex++,
    });
  }

  // Then match debits
  const maxDebits = Math.max(actualDebits.length, btDebits.length);
  for (let i = 0; i < maxDebits; i++) {
    pairs.push({
      actual: actualDebits[i] ?? null,
      backtest: btDebits[i] ?? null,
      pairIndex: pairIndex++,
    });
  }

  return pairs;
}

// =============================================================================
// Main Component
// =============================================================================

export function TradeDetailView() {
  const { selectedDate, selectedStrategy, calendarDays, scalingMode, combineLegGroups } =
    useTradingCalendarStore();

  const dayData = selectedDate ? calendarDays.get(selectedDate) : undefined;

  // Find trades for this strategy on this day
  const backtestTrades = useMemo(() => {
    if (!dayData || !selectedStrategy) return [];
    return dayData.backtestTrades.filter((t) => t.strategy === selectedStrategy);
  }, [dayData, selectedStrategy]);

  const actualTrades = useMemo(() => {
    if (!dayData || !selectedStrategy) return [];
    return dayData.actualTrades.filter((t) => t.strategy === selectedStrategy);
  }, [dayData, selectedStrategy]);

  // Group and combine trades if toggle is enabled
  const combinedBacktestGroups = useMemo(() => {
    if (!combineLegGroups || backtestTrades.length === 0) return [];
    const groups = groupTradesByEntry(backtestTrades);
    return Array.from(groups.values()).map((group) => ({
      combined: combineLegGroup(group),
      original: group,
    }));
  }, [backtestTrades, combineLegGroups]);

  const combinedActualGroups = useMemo(() => {
    if (!combineLegGroups || actualTrades.length === 0) return [];
    const groups = groupReportingTradesByEntry(actualTrades);
    return Array.from(groups.values()).map((group) => ({
      combined: combineReportingLegGroup(group),
      original: group,
    }));
  }, [actualTrades, combineLegGroups]);

  // Create centralized scaling context - uses first trade's contract count as "unit size"
  const scalingContext = useMemo(
    () => createScalingContext(backtestTrades, actualTrades),
    [backtestTrades, actualTrades],
  );

  // Get scale factors from centralized functions
  const btScaleFactor = useMemo(
    () => getScaleFactor(scalingContext, scalingMode, "backtest"),
    [scalingContext, scalingMode],
  );
  const actualScaleFactor = useMemo(
    () => getScaleFactor(scalingContext, scalingMode, "actual"),
    [scalingContext, scalingMode],
  );

  // Scale totals based on scaling mode using centralized scaling
  const scaledTotals = useMemo(() => {
    const totalBtPl = backtestTrades.reduce((sum, t) => sum + t.pl, 0);
    const totalActualPl = actualTrades.reduce((sum, t) => sum + t.pl, 0);

    // Apply scaling using centralized scale factors
    const scaledBtPl = btScaleFactor !== null ? totalBtPl * btScaleFactor : totalBtPl;
    const scaledActualPl =
      actualScaleFactor !== null ? totalActualPl * actualScaleFactor : totalActualPl;

    // Determine display contracts based on scaling mode
    const displayContracts =
      scalingMode === "perContract"
        ? 1
        : scalingMode === "toReported" && scalingContext.hasActual
          ? scalingContext.actualContracts
          : scalingContext.btContracts;

    // Calculate slippage only when we can meaningfully compare
    let slippage: number | null = null;
    if (backtestTrades.length > 0 && actualTrades.length > 0) {
      if (scalingMode === "raw") {
        // Raw mode: slippage isn't meaningful with different contract counts
        slippage = null;
      } else {
        // perContract or toReported: values are on same scale, slippage is meaningful
        slippage = scaledActualPl - scaledBtPl;
      }
    }

    return {
      backtest: backtestTrades.length > 0 ? { pl: scaledBtPl, contracts: displayContracts } : null,
      actual:
        actualTrades.length > 0
          ? {
              pl: scaledActualPl,
              contracts: scalingMode === "perContract" ? 1 : scalingContext.actualContracts,
            }
          : null,
      slippage,
    };
  }, [backtestTrades, actualTrades, scalingMode, btScaleFactor, actualScaleFactor, scalingContext]);

  // Match trades by premium sign for side-by-side alignment
  const matchedPairs = useMemo(() => {
    if (!combineLegGroups && backtestTrades.length > 0 && actualTrades.length > 0) {
      return matchTradesByPremiumSign(actualTrades, backtestTrades);
    }
    return [];
  }, [actualTrades, backtestTrades, combineLegGroups]);

  // Early return after all hooks
  if (!selectedDate || !selectedStrategy) return null;
  if (!dayData) return null;

  const hasBacktest = backtestTrades.length > 0;
  const hasActual = actualTrades.length > 0;

  return (
    <div className="space-y-4">
      {/* Strategy summary header */}
      <Card className="py-3">
        <CardContent className="pt-0">
          <div className="flex items-center justify-between gap-6">
            {/* Left: Strategy name and badges */}
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold">{selectedStrategy}</h2>
              <div className="flex gap-1.5">
                {hasBacktest && (
                  <Badge
                    variant="outline"
                    className="bg-blue-500/10 text-blue-500 border-blue-500/50 text-xs"
                  >
                    Backtest
                  </Badge>
                )}
                {hasActual && (
                  <Badge
                    variant="outline"
                    className="bg-purple-500/10 text-purple-500 border-purple-500/50 text-xs"
                  >
                    Actual
                  </Badge>
                )}
              </div>
              {scalingMode !== "raw" && (
                <span className="text-xs text-muted-foreground">
                  {scalingMode === "perContract" ? "(per contract)" : "(scaled to actual)"}
                </span>
              )}
            </div>

            {/* Right: P&L totals */}
            <div className="flex items-center gap-6">
              {scaledTotals.backtest && (
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Backtest</div>
                  <div
                    className={cn(
                      "text-lg font-bold",
                      scaledTotals.backtest.pl > 0 && "text-green-500",
                      scaledTotals.backtest.pl < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(scaledTotals.backtest.pl)}
                  </div>
                </div>
              )}

              {scaledTotals.actual && (
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Actual</div>
                  <div
                    className={cn(
                      "text-lg font-bold",
                      scaledTotals.actual.pl > 0 && "text-green-500",
                      scaledTotals.actual.pl < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(scaledTotals.actual.pl)}
                  </div>
                </div>
              )}

              {scaledTotals.slippage !== null && (
                <div className="text-right border-l border-border pl-6">
                  <div className="text-xs text-muted-foreground">Slippage</div>
                  <div
                    className={cn(
                      "text-lg font-bold",
                      scaledTotals.slippage > 0 && "text-green-500",
                      scaledTotals.slippage < 0 && "text-red-500",
                    )}
                  >
                    {formatCurrency(scaledTotals.slippage)}
                  </div>
                  {scaledTotals.backtest && scaledTotals.backtest.pl !== 0 && (
                    <div className="text-xs text-muted-foreground">
                      {((scaledTotals.slippage / Math.abs(scaledTotals.backtest.pl)) * 100).toFixed(
                        1,
                      )}
                      %
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Trade cards - side by side when both exist, full width when only one */}
      {combineLegGroups ? (
        hasActual && hasBacktest ? (
          /* Side-by-side layout for matched strategies */
          <div className="grid grid-cols-2 gap-4">
            {/* Actual column */}
            <div className="space-y-4">
              {combinedActualGroups.map((group, index) => (
                <CombinedActualTradeGroup
                  key={`actual-group-${index}`}
                  combined={group.combined}
                  originalTrades={group.original}
                  scalingMode={scalingMode}
                  sideBySide
                />
              ))}
            </div>
            {/* Backtest column */}
            <div className="space-y-4">
              {combinedBacktestGroups.map((group, index) => (
                <CombinedBacktestTradeGroup
                  key={`backtest-group-${index}`}
                  combined={group.combined}
                  originalTrades={group.original}
                  scalingMode={scalingMode}
                  toReportedScaleFactor={btScaleFactor}
                />
              ))}
            </div>
          </div>
        ) : (
          /* Full width for unmatched (only actual or only backtest) */
          <>
            {combinedActualGroups.map((group, index) => (
              <CombinedActualTradeGroup
                key={`actual-group-${index}`}
                combined={group.combined}
                originalTrades={group.original}
                scalingMode={scalingMode}
              />
            ))}
            {combinedBacktestGroups.map((group, index) => (
              <CombinedBacktestTradeGroup
                key={`backtest-group-${index}`}
                combined={group.combined}
                originalTrades={group.original}
                scalingMode={scalingMode}
                toReportedScaleFactor={btScaleFactor}
              />
            ))}
          </>
        )
      ) : hasActual && hasBacktest && matchedPairs.length > 0 ? (
        /* Side-by-side layout with matched pairs (by premium sign) */
        <div className="space-y-4">
          {matchedPairs.map((pair) => (
            <div key={`pair-${pair.pairIndex}`} className="grid grid-cols-2 gap-4">
              {/* Actual (left) */}
              <div>
                {pair.actual ? (
                  <ActualTradeCard
                    trade={pair.actual}
                    tradeIndex={pair.pairIndex}
                    totalTrades={matchedPairs.length}
                    scalingMode={scalingMode}
                    sideBySide
                  />
                ) : (
                  <div className="h-full" /> /* Empty placeholder */
                )}
              </div>
              {/* Backtest (right) */}
              <div>
                {pair.backtest ? (
                  <BacktestTradeCard
                    trade={pair.backtest}
                    tradeIndex={pair.pairIndex}
                    totalTrades={matchedPairs.length}
                    scalingMode={scalingMode}
                    toReportedScaleFactor={btScaleFactor}
                  />
                ) : (
                  <div className="h-full" /> /* Empty placeholder */
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Full width for unmatched (only actual or only backtest) */
        <>
          {actualTrades.map((trade, index) => (
            <ActualTradeCard
              key={`actual-${index}`}
              trade={trade}
              tradeIndex={index}
              totalTrades={actualTrades.length}
              scalingMode={scalingMode}
            />
          ))}
          {backtestTrades.map((trade, index) => (
            <BacktestTradeCard
              key={`backtest-${index}`}
              trade={trade}
              tradeIndex={index}
              totalTrades={backtestTrades.length}
              scalingMode={scalingMode}
              toReportedScaleFactor={btScaleFactor}
            />
          ))}
        </>
      )}
    </div>
  );
}
