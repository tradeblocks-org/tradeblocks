/**
 * Batch Exit Analysis Engine
 *
 * Pure logic module (no I/O, no DuckDB, no fetch) that takes pre-analyzed
 * trade inputs and a candidate exit policy, evaluates the policy against each
 * trade's P&L path, and computes aggregate statistics with per-trigger attribution.
 *
 * This is the computational heart of the `batch_exit_analysis` MCP tool.
 */

import {
  analyzeExitTriggers,
  type ExitTriggerConfig,
  type TriggerType,
  type LegGroupConfig,
  type PartialClose,
} from './exit-triggers.ts';
import type { PnlPoint, ReplayLeg } from './trade-replay.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BaselineMode = 'actual' | 'holdToEnd';

export interface BatchExitConfig {
  /** Triggers to evaluate as candidate exit policy. */
  candidatePolicy: ExitTriggerConfig[];
  /** Optional per-group triggers (passed through to analyzeExitTriggers). */
  legGroups?: LegGroupConfig[];
  /** Baseline mode: 'actual' uses tradelog P&L, 'holdToEnd' uses last path point. */
  baselineMode: BaselineMode;
  /** Output density: 'summary' omits per-trade breakdown; 'full' includes it. */
  format: 'summary' | 'full';
}

export interface TradeInput {
  tradeIndex: number;
  /** Trade open date YYYY-MM-DD */
  dateOpened: string;
  /** Actual P&L from tradelog pl field (used when baselineMode='actual'). */
  actualPnl: number;
  /** Full replay P&L path from trade-replay module. */
  pnlPath: PnlPoint[];
  /** Replay legs parallel to pnlPath.legPrices. */
  legs: ReplayLeg[];
  /** Entry cost for percentage-based triggers (D-11). */
  entryCost?: number;
}

export interface TradeExitResult {
  tradeIndex: number;
  dateOpened: string;
  /** Actual P&L from tradelog. */
  actualPnl: number;
  /** P&L if candidate policy was applied. */
  candidatePnl: number;
  /** Baseline P&L (actual or holdToEnd). */
  baselinePnl: number;
  /** candidatePnl - baselinePnl */
  pnlDelta: number;
  /** Which trigger fired first, or 'noTrigger'. */
  triggerFired: TriggerType | 'noTrigger';
  /** Timestamp when trigger fired, or null. */
  fireTimestamp: string | null;
  /** Partial position closes from profitAction steps (if any). */
  partialCloses?: PartialClose[];
}

export interface TriggerAttribution {
  trigger: TriggerType | 'noTrigger';
  /** How many trades this trigger fired first on. */
  count: number;
  /** Average candidate P&L when this trigger fired. */
  avgPnl: number;
  /** Sum candidate P&L for this trigger group. */
  totalPnl: number;
  /** Average pnlDelta vs baseline for this trigger group. */
  avgDelta: number;
}

export interface AggregateStats {
  totalTrades: number;
  /** candidatePnl > 0 */
  winningTrades: number;
  /** candidatePnl < 0 */
  losingTrades: number;
  /** winningTrades / totalTrades */
  winRate: number;
  /** Sum of candidatePnl */
  totalPnl: number;
  /** Mean candidatePnl */
  avgPnl: number;
  /** Mean of winning candidatePnls */
  avgWin: number;
  /** Mean of losing candidatePnls */
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  /** sum(wins) / abs(sum(losses)); Infinity if no losses */
  profitFactor: number;
  /** Max sequential drawdown from equity curve (cumsum of candidatePnls) */
  maxDrawdown: number;
  /** mean/stddev of candidatePnls; null if < 2 trades */
  sharpeRatio: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  // Deltas vs baseline
  baselineTotalPnl: number;
  /** totalPnl - baselineTotalPnl */
  totalPnlDelta: number;
  baselineWinRate: number;
}

export interface BatchExitResult {
  aggregate: AggregateStats;
  triggerAttribution: TriggerAttribution[];
  /** Empty if format='summary'. */
  perTrade: TradeExitResult[];
  baselineMode: BaselineMode;
  summary: string;
  profileContext?: {
    structureType: string;
    exitRules: string[];
  };
  /** Trades skipped due to replay errors (D-15). */
  skippedTrades?: Array<{ tradeIndex: number; dateOpened: string; error: string }>;
}

// ---------------------------------------------------------------------------
// computeAggregateStats
// ---------------------------------------------------------------------------

/**
 * Compute aggregate statistics from a set of per-trade exit results.
 */
export function computeAggregateStats(tradeResults: TradeExitResult[]): AggregateStats {
  if (tradeResults.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      maxWin: 0,
      maxLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      sharpeRatio: null,
      maxWinStreak: 0,
      maxLossStreak: 0,
      baselineTotalPnl: 0,
      totalPnlDelta: 0,
      baselineWinRate: 0,
    };
  }

  const candidatePnls = tradeResults.map(r => r.candidatePnl);
  const baselinePnls = tradeResults.map(r => r.baselinePnl);

  const winningTrades = candidatePnls.filter(p => p > 0).length;
  const losingTrades = candidatePnls.filter(p => p < 0).length;
  const totalTrades = tradeResults.length;
  const winRate = winningTrades / totalTrades;

  const totalPnl = candidatePnls.reduce((sum, p) => sum + p, 0);
  const avgPnl = totalPnl / totalTrades;

  const wins = candidatePnls.filter(p => p > 0);
  const losses = candidatePnls.filter(p => p < 0);

  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const maxWin = wins.length > 0 ? Math.max(...wins) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses) : 0;

  // Profit factor: sum(wins) / abs(sum(losses)), Infinity if no losses
  const sumWins = wins.reduce((s, p) => s + p, 0);
  const sumLosses = losses.reduce((s, p) => s + p, 0);
  const profitFactor = losses.length === 0
    ? Infinity
    : sumWins / Math.abs(sumLosses);

  // Max drawdown from equity curve (cumsum of candidatePnls)
  let runningPeak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const pnl of candidatePnls) {
    equity += pnl;
    if (equity > runningPeak) runningPeak = equity;
    const dd = runningPeak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio: mean / sample stddev (N-1), null if < 2 trades
  let sharpeRatio: number | null = null;
  if (totalTrades >= 2) {
    const mean = avgPnl;
    const variance =
      candidatePnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (totalTrades - 1);
    const stddev = Math.sqrt(variance);
    sharpeRatio = stddev === 0 ? null : mean / stddev;
  }

  // Win/loss streaks
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  for (const pnl of candidatePnls) {
    if (pnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
    } else if (pnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    } else {
      // Breakeven — reset both streaks
      currentWinStreak = 0;
      currentLossStreak = 0;
    }
  }

  // Baseline aggregates
  const baselineTotalPnl = baselinePnls.reduce((sum, p) => sum + p, 0);
  const baselineWins = baselinePnls.filter(p => p > 0).length;
  const baselineWinRate = baselineWins / totalTrades;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalPnl,
    avgPnl,
    avgWin,
    avgLoss,
    maxWin,
    maxLoss,
    profitFactor,
    maxDrawdown,
    sharpeRatio,
    maxWinStreak,
    maxLossStreak,
    baselineTotalPnl,
    totalPnlDelta: totalPnl - baselineTotalPnl,
    baselineWinRate,
  };
}

// ---------------------------------------------------------------------------
// computeTriggerAttribution
// ---------------------------------------------------------------------------

/**
 * Group trade results by which trigger fired first.
 * Returns attribution sorted by count descending.
 */
export function computeTriggerAttribution(
  tradeResults: TradeExitResult[],
): TriggerAttribution[] {
  const groups = new Map<
    TriggerType | 'noTrigger',
    { count: number; totalPnl: number; totalDelta: number }
  >();

  for (const result of tradeResults) {
    const key = result.triggerFired;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.totalPnl += result.candidatePnl;
      existing.totalDelta += result.pnlDelta;
    } else {
      groups.set(key, {
        count: 1,
        totalPnl: result.candidatePnl,
        totalDelta: result.pnlDelta,
      });
    }
  }

  return Array.from(groups.entries())
    .map(([trigger, { count, totalPnl, totalDelta }]) => ({
      trigger,
      count,
      totalPnl,
      avgPnl: totalPnl / count,
      avgDelta: totalDelta / count,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// analyzeBatch
// ---------------------------------------------------------------------------

/**
 * Evaluate a candidate exit policy against a set of trade replay results.
 *
 * For each trade:
 *   1. Run analyzeExitTriggers with the candidate policy against the trade's P&L path.
 *   2. candidatePnl = firstToFire.pnlAtFire if trigger fired, else last path point P&L.
 *   3. baselinePnl = trade.actualPnl if baselineMode='actual', else last path point P&L.
 *   4. Build TradeExitResult.
 *
 * Then compute aggregate stats and trigger attribution.
 */
export function analyzeBatch(
  trades: TradeInput[],
  config: BatchExitConfig,
): BatchExitResult {
  if (trades.length === 0) {
    const emptyAggregate = computeAggregateStats([]);
    return {
      aggregate: emptyAggregate,
      triggerAttribution: [],
      perTrade: [],
      baselineMode: config.baselineMode,
      summary: 'Analyzed 0 trades: no data.',
    };
  }

  const { candidatePolicy, legGroups, baselineMode, format } = config;

  const perTradeResults: TradeExitResult[] = trades.map(trade => {
    const { pnlPath, legs, actualPnl, tradeIndex, dateOpened, entryCost } = trade;

    // Last path point P&L — used as holdToEnd value
    const lastPnl = pnlPath.length > 0
      ? pnlPath[pnlPath.length - 1].strategyPnl
      : 0;

    // Copy entryCost onto each trigger config for percentage-based triggers (D-11)
    const triggersWithCost = candidatePolicy.map(t => ({
      ...t,
      entryCost,
    }));

    const legGroupsWithCost = legGroups?.map(group => ({
      ...group,
      triggers: group.triggers.map(trigger => ({
        ...trigger,
        entryCost,
      })),
    }));

    // Run exit trigger analysis with candidate policy
    const analysisResult = analyzeExitTriggers({
      pnlPath,
      legs,
      triggers: triggersWithCost,
      legGroups: legGroupsWithCost,
    });

    const { firstToFire, partialCloses } = analysisResult.overall;

    // Candidate P&L: account for partial closes from profitAction steps
    let candidatePnl: number;
    if (partialCloses && partialCloses.length > 0) {
      // Sum of partial close P&Ls
      const partialPnl = partialCloses.reduce((sum, pc) => sum + pc.pnlAtFire, 0);
      const closedAllocation = partialCloses.reduce((sum, pc) => sum + pc.allocation, 0);
      const remainingAllocation = 1 - closedAllocation;
      // Remaining position: firstToFire.pnlAtFire already reflects remaining allocation,
      // or if no trigger fired, scale last P&L by remaining allocation
      const remainingPnl = firstToFire !== null
        ? firstToFire.pnlAtFire
        : lastPnl * remainingAllocation;
      candidatePnl = partialPnl + remainingPnl;
    } else {
      // No partial closes: original behavior
      candidatePnl = firstToFire !== null ? firstToFire.pnlAtFire : lastPnl;
    }

    // Baseline P&L depends on mode
    const baselinePnl = baselineMode === 'actual' ? actualPnl : lastPnl;

    const pnlDelta = candidatePnl - baselinePnl;

    const triggerFired: TriggerType | 'noTrigger' =
      firstToFire !== null ? firstToFire.type : 'noTrigger';
    const fireTimestamp = firstToFire !== null ? firstToFire.firedAt : null;

    return {
      tradeIndex,
      dateOpened,
      actualPnl,
      candidatePnl,
      baselinePnl,
      pnlDelta,
      triggerFired,
      fireTimestamp,
      partialCloses: partialCloses && partialCloses.length > 0 ? partialCloses : undefined,
    };
  });

  const aggregate = computeAggregateStats(perTradeResults);
  const triggerAttribution = computeTriggerAttribution(perTradeResults);

  // Build summary string
  const topTrigger = triggerAttribution.length > 0 ? triggerAttribution[0] : null;
  const topTriggerStr = topTrigger
    ? `Top trigger: ${topTrigger.trigger} fired on ${topTrigger.count} trades.`
    : 'No triggers fired.';

  const summary =
    `Analyzed ${trades.length} trades: candidate win rate ${(aggregate.winRate * 100).toFixed(1)}%, ` +
    `total P&L $${aggregate.totalPnl.toFixed(2)} (delta $${aggregate.totalPnlDelta.toFixed(2)} vs baseline). ` +
    topTriggerStr;

  return {
    aggregate,
    triggerAttribution,
    perTrade: format === 'summary' ? [] : perTradeResults,
    baselineMode,
    summary,
  };
}
