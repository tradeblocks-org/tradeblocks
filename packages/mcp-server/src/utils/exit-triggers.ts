/**
 * Exit Trigger Evaluation Engine
 *
 * Pure logic module (no I/O, no DuckDB, no fetch) that evaluates 15 exit
 * trigger types against a greeks-enriched P&L path from trade replay.
 *
 * Provides the computational heart of the `analyze_exit_triggers` tool.
 */

import type { PnlPoint, ReplayLeg } from './trade-replay.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerType =
  | 'profitTarget'
  | 'stopLoss'
  | 'trailingStop'
  | 'profitAction'
  | 'dteExit'
  | 'ditExit'
  | 'clockTimeExit'
  | 'underlyingPriceMove'
  | 'positionDelta'
  | 'perLegDelta'
  | 'vixMove'
  | 'vix9dMove'
  | 'vix9dVixRatio'
  | 'slRatioThreshold'
  | 'slRatioMove';

export interface PartialClose {
  index: number;
  pnlAtFire: number;
  allocation: number;
  trigger: string;
}

export interface ExitTriggerConfig {
  type: TriggerType;
  threshold: number;
  unit?: 'percent' | 'dollar';                  // D-07: default 'dollar', backwards compatible
  steps?: Array<{ armAt: number; stopAt: number; closeAllocationPct?: number }>;
  // Context-specific optional fields:
  expiry?: string;                              // YYYY-MM-DD for dteExit
  openDate?: string;                            // YYYY-MM-DD for ditExit
  clockTime?: string;                           // "HH:MM" for clockTimeExit (threshold ignored)
  trailAmount?: number;                         // Dollar trail for trailingStop
  // Directional delta fields (per-leg directional exits):
  legIndex?: number;                            // 0-based leg index for perLegDelta — targets specific leg
  exitAbove?: number;                           // Fire when value > exitAbove (directional, no abs)
  exitBelow?: number;                           // Fire when value < exitBelow (directional, no abs)
  // Data maps for triggers needing external prices:
  underlyingPrices?: Map<string, number>;        // timestamp -> price
  vixPrices?: Map<string, number>;               // timestamp -> VIX price
  vix9dPrices?: Map<string, number>;             // timestamp -> VIX9D price
  // S/L ratio inputs:
  spreadWidth?: number;                          // Width of spread in dollars
  contracts?: number;                            // Number of contracts
  multiplier?: number;                           // Default 100
  // profitTarget confirmation: N synchronized-quote bars at-or-above threshold required before firing (default 1 = fire on first cross)
  requiredHits?: number;
  // Internal: set by handler when unit='percent' to compute dollar threshold
  entryCost?: number;                            // D-11: cost/credit of entry (negative = credit received)
  entrySLRatio?: number;                         // Runtime-hydrated opening short/long ratio for slRatioMove
}

export interface TriggerFireEvent {
  type: TriggerType;
  firedAt: string;          // Timestamp when trigger fired
  pnlAtFire: number;       // Strategy P&L when trigger fired
  index: number;            // Index into pnlPath
  detail?: string;          // Human-readable description
}

export interface ExitTriggerResult {
  triggers: TriggerFireEvent[];         // All triggers that fired (sorted by fire time)
  firstToFire: TriggerFireEvent | null; // Earliest trigger
  actualExit?: {
    timestamp: string;
    pnl: number;
    pnlDifference: number;             // firstToFire.pnl - actualExit.pnl
  };
  partialCloses?: PartialClose[];       // Partial position closes from profitAction steps
  summary: string;
}

export interface LegGroupConfig {
  label: string;
  legIndices: number[];
  triggers: ExitTriggerConfig[];
}

export interface LegGroupResult {
  label: string;
  result: ExitTriggerResult;
  groupPnl: number[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse "YYYY-MM-DD" to a Date at local midnight. */
function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Extract date portion "YYYY-MM-DD" from timestamp "YYYY-MM-DD HH:MM". */
function extractDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Extract time portion "HH:MM" from timestamp "YYYY-MM-DD HH:MM". */
function extractTime(timestamp: string): string {
  return timestamp.slice(11, 16);
}

/** Calendar days between two dates (absolute). */
function calendarDaysBetween(a: Date, b: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.abs(Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY));
}

/** Compute S/L ratio for spread positions. */
function computeSLRatio(
  point: PnlPoint,
  legs: ReplayLeg[],
  spreadWidth: number,
  contracts: number,
  multiplier: number,
): number {
  // Spread value = sum of abs(markPrice * quantity * multiplier) for short legs
  let spreadValue = 0;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].quantity < 0) {
      const markPrice = point.legPrices[i] ?? 0;
      spreadValue += Math.abs(markPrice * legs[i].quantity * legs[i].multiplier);
    }
  }
  const maxLoss = spreadWidth * contracts * multiplier;
  if (maxLoss === 0) return 0;
  return spreadValue / maxLoss;
}

function computeSLRatioMove(initial: number, current: number): number {
  if (initial === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (current - initial) / initial;
}

function crossesDirectionalMove(pctMove: number, threshold: number): boolean {
  if (threshold < 0) return pctMove <= threshold;
  if (threshold > 0) return pctMove >= threshold;
  return pctMove !== 0;
}

function adjustLegDeltaForPosition(rawDelta: number, leg?: ReplayLeg): number {
  return leg != null && leg.quantity < 0 ? -rawDelta : rawDelta;
}

// ---------------------------------------------------------------------------
// evaluateProfitAction — partial close aware evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a profitAction trigger with partial close support.
 * Steps with closeAllocationPct will close a fraction of the REMAINING position
 * when their armAt is first reached. The remaining position's P&L is scaled down.
 *
 * Returns both the fire event (stop hit on remaining) and any partial closes.
 */
export function evaluateProfitAction(
  trigger: ExitTriggerConfig,
  pnlPath: PnlPoint[],
  _legs: ReplayLeg[],
): { fireEvent: TriggerFireEvent | null; partialCloses: PartialClose[] } {
  const partialCloses: PartialClose[] = [];

  if (pnlPath.length === 0 || !trigger.steps?.length) {
    return { fireEvent: null, partialCloses };
  }
  if (trigger.unit === 'percent' && trigger.entryCost == null) {
    return { fireEvent: null, partialCloses };
  }

  const scale = trigger.unit === 'percent'
    ? Math.abs(trigger.entryCost!)
    : 1;

  const normalizedSteps = [...trigger.steps]
    .sort((a, b) => a.armAt - b.armAt)
    .map((step) => ({
      armAt: step.armAt * scale,
      stopAt: step.stopAt * scale,
      closeAllocationPct: step.closeAllocationPct,
    }));

  let remainingAllocation = 1.0;
  let runningMaxPnl = -Infinity;
  // Track which steps have already triggered their partial close
  const stepPartialFired = new Array(normalizedSteps.length).fill(false);

  for (let i = 0; i < pnlPath.length; i++) {
    const point = pnlPath[i];
    const pnl = point.strategyPnl;

    if (pnl > runningMaxPnl) runningMaxPnl = pnl;

    // Check each step for partial close (only when armAt first reached)
    for (let s = 0; s < normalizedSteps.length; s++) {
      const step = normalizedSteps[s];
      if (!stepPartialFired[s] && step.closeAllocationPct && runningMaxPnl >= step.armAt) {
        stepPartialFired[s] = true;
        const closeAmt = remainingAllocation * step.closeAllocationPct;
        partialCloses.push({
          index: i,
          pnlAtFire: pnl * remainingAllocation * step.closeAllocationPct,
          allocation: closeAmt,
          trigger: 'profitAction',
        });
        remainingAllocation -= closeAmt;
      }
    }

    // Compute active stop floor (same logic as original)
    let activeFloor = -Infinity;
    for (const step of normalizedSteps) {
      if (runningMaxPnl >= step.armAt) {
        activeFloor = Math.max(activeFloor, step.stopAt);
      }
    }

    // Check if stop hit on remaining allocation
    // Scaled comparison: pnl * remainingAllocation <= activeFloor * remainingAllocation
    // Simplifies to: pnl <= activeFloor (when remainingAllocation > 0)
    if (activeFloor > -Infinity && remainingAllocation > 0 && pnl <= activeFloor) {
      const effectivePnl = pnl * remainingAllocation;
      const detail = trigger.unit === 'percent'
        ? `Profit action: stop adjusted to ${(activeFloor / scale * 100).toFixed(0)}% ($${activeFloor.toFixed(2)}) at max P&L $${runningMaxPnl.toFixed(2)}, hit at $${pnl.toFixed(2)} (remaining ${(remainingAllocation * 100).toFixed(0)}%)`
        : `Profit action: stop adjusted to $${activeFloor.toFixed(2)} at max P&L $${runningMaxPnl.toFixed(2)}, hit at $${pnl.toFixed(2)} (remaining ${(remainingAllocation * 100).toFixed(0)}%)`;

      return {
        fireEvent: {
          type: 'profitAction',
          firedAt: point.timestamp,
          pnlAtFire: effectivePnl,
          index: i,
          detail,
        },
        partialCloses,
      };
    }
  }

  return { fireEvent: null, partialCloses };
}

// ---------------------------------------------------------------------------
// evaluateTrigger
// ---------------------------------------------------------------------------

/**
 * Evaluate a single trigger against the full P&L path.
 * Returns the first point where it fires, or null.
 */
export function evaluateTrigger(
  trigger: ExitTriggerConfig,
  pnlPath: PnlPoint[],
  legs: ReplayLeg[],
): TriggerFireEvent | null {
  if (pnlPath.length === 0) return null;

  const { type, threshold } = trigger;

  // State for triggers that track running values
  let runningMaxPnl = -Infinity;
  let profitTargetHits = 0;
  let initialSLRatio: number | null = null;
  let firstUnderlyingPrice: number | null = null;
  let firstVixPrice: number | null = null;
  let firstVix9dPrice: number | null = null;

  for (let i = 0; i < pnlPath.length; i++) {
    const point = pnlPath[i];
    const pnl = point.strategyPnl;

    // Update running max for trailingStop
    if (pnl > runningMaxPnl) runningMaxPnl = pnl;

    let fired = false;
    let detail: string | undefined;

    switch (type) {
      case 'profitTarget': {
        // unit='percent' requires entryCost; if missing, cannot compute — no fire
        if (trigger.unit === 'percent' && trigger.entryCost == null) break;
        const requiredHits = trigger.requiredHits ?? 1;
        const dollarThresholdPT = trigger.unit === 'percent'
          ? threshold * Math.abs(trigger.entryCost!)
          : threshold;
        if (pnl >= dollarThresholdPT) {
          if (point.allLegsSync !== false) profitTargetHits++;
          if (profitTargetHits < requiredHits) break;
          fired = true;
          detail = trigger.unit === 'percent'
            ? `P&L $${pnl.toFixed(2)} >= ${(threshold * 100).toFixed(0)}% of $${Math.abs(trigger.entryCost!).toFixed(2)} ($${dollarThresholdPT.toFixed(2)})`
            : `P&L $${pnl.toFixed(2)} >= target $${dollarThresholdPT.toFixed(2)}`;
        } else if (point.allLegsSync !== false) {
          profitTargetHits = 0;
        }
        break;
      }

      case 'stopLoss': {
        // Normalize negative threshold — users may pass -2 meaning "stop at $2 loss"
        const absThreshold = Math.abs(threshold);
        // unit='percent' requires entryCost; if missing, cannot compute — no fire
        if (trigger.unit === 'percent' && trigger.entryCost == null) break;
        const dollarThresholdSL = trigger.unit === 'percent'
          ? absThreshold * Math.abs(trigger.entryCost!)
          : absThreshold;
        if (pnl <= -dollarThresholdSL) {
          fired = true;
          detail = trigger.unit === 'percent'
            ? `P&L $${pnl.toFixed(2)} <= -${(absThreshold * 100).toFixed(0)}% of $${Math.abs(trigger.entryCost!).toFixed(2)} (-$${dollarThresholdSL.toFixed(2)})`
            : `P&L $${pnl.toFixed(2)} <= stop -$${dollarThresholdSL.toFixed(2)}`;
        }
        break;
      }

      case 'trailingStop': {
        const trailAmt = trigger.trailAmount ?? threshold;
        const dropdown = runningMaxPnl - pnl;
        if (dropdown >= trailAmt && runningMaxPnl > -Infinity) {
          fired = true;
          detail = `Dropdown $${dropdown.toFixed(2)} from max $${runningMaxPnl.toFixed(2)} >= trail $${trailAmt.toFixed(2)}`;
        }
        break;
      }

      case 'profitAction': {
        // Delegate to evaluateProfitAction for the full path evaluation
        // (evaluateTrigger is called point-by-point in the loop, but profitAction
        //  needs full-path context for partial close tracking, so we handle it
        //  by breaking out of the loop and evaluating the full path at once.)
        const paResult = evaluateProfitAction(trigger, pnlPath, legs);
        return paResult.fireEvent;
      }

      case 'dteExit': {
        if (!trigger.expiry) break;
        const pointDate = parseDate(extractDate(point.timestamp));
        const expiryDate = parseDate(trigger.expiry);
        const dte = calendarDaysBetween(pointDate, expiryDate);
        // Only fire if point is before/on expiry
        if (pointDate <= expiryDate && dte <= threshold) {
          fired = true;
          detail = `DTE ${dte} <= threshold ${threshold}`;
        }
        break;
      }

      case 'ditExit': {
        if (!trigger.openDate) break;
        const pointDate = parseDate(extractDate(point.timestamp));
        const openDate = parseDate(trigger.openDate);
        const dit = calendarDaysBetween(openDate, pointDate);
        if (dit >= threshold) {
          fired = true;
          detail = `DIT ${dit} >= threshold ${threshold}`;
        }
        break;
      }

      case 'clockTimeExit': {
        const clockTime = trigger.clockTime ?? '15:00';
        const pointTime = extractTime(point.timestamp);
        if (pointTime >= clockTime) {
          fired = true;
          detail = `Time ${pointTime} >= ${clockTime}`;
        }
        break;
      }

      case 'underlyingPriceMove': {
        if (!trigger.underlyingPrices) break;
        const price = trigger.underlyingPrices.get(point.timestamp);
        if (price == null) break;
        if (firstUnderlyingPrice === null) {
          firstUnderlyingPrice = price;
          break; // Can't compute move on first price
        }
        const pctMove = ((price - firstUnderlyingPrice) / firstUnderlyingPrice) * 100;
        if (Math.abs(pctMove) >= threshold) {
          fired = true;
          detail = `Underlying moved ${pctMove.toFixed(2)}% (threshold ${threshold}%)`;
        }
        break;
      }

      case 'positionDelta': {
        const netDelta = point.netDelta ?? 0;
        if (trigger.exitAbove != null) {
          if (netDelta > trigger.exitAbove) {
            fired = true;
            detail = `Net delta ${netDelta.toFixed(4)} > exitAbove ${trigger.exitAbove}`;
          }
        } else if (trigger.exitBelow != null) {
          if (netDelta < trigger.exitBelow) {
            fired = true;
            detail = `Net delta ${netDelta.toFixed(4)} < exitBelow ${trigger.exitBelow}`;
          }
        } else if (Math.abs(netDelta) >= threshold) {
          fired = true;
          detail = `Net delta ${netDelta.toFixed(4)} >= threshold ${threshold}`;
        }
        break;
      }

      case 'perLegDelta': {
        if (!point.legGreeks) break;
        if (trigger.legIndex != null) {
          // Target a specific leg
          if (trigger.legIndex >= point.legGreeks.length) break;
          const rawDelta = point.legGreeks[trigger.legIndex].delta ?? 0;
          const legDelta = adjustLegDeltaForPosition(rawDelta, legs[trigger.legIndex]);
          if (trigger.exitAbove != null) {
            if (legDelta > trigger.exitAbove) {
              fired = true;
              detail = `Leg ${trigger.legIndex} delta ${legDelta.toFixed(4)} > exitAbove ${trigger.exitAbove}`;
            }
          } else if (trigger.exitBelow != null) {
            if (legDelta < trigger.exitBelow) {
              fired = true;
              detail = `Leg ${trigger.legIndex} delta ${legDelta.toFixed(4)} < exitBelow ${trigger.exitBelow}`;
            }
          } else {
            // legIndex set but no directional fields — use abs() on that single leg
            if (Math.abs(legDelta) >= threshold) {
              fired = true;
              detail = `Leg ${trigger.legIndex} delta ${legDelta.toFixed(4)} >= threshold ${threshold}`;
            }
          }
        } else {
          // No legIndex — iterate all legs with abs() (backward compat)
          for (let li = 0; li < point.legGreeks.length; li++) {
            const rawDelta = point.legGreeks[li].delta ?? 0;
            const legDelta = adjustLegDeltaForPosition(rawDelta, legs[li]);
            if (Math.abs(legDelta) >= threshold) {
              fired = true;
              detail = `Leg ${li} delta ${legDelta.toFixed(4)} >= threshold ${threshold}`;
              break;
            }
          }
        }
        break;
      }

      case 'vixMove': {
        if (!trigger.vixPrices) break;
        const vix = trigger.vixPrices.get(point.timestamp);
        if (vix == null) break;
        if (firstVixPrice === null) {
          firstVixPrice = vix;
          break;
        }
        const pctMove = ((vix - firstVixPrice) / firstVixPrice) * 100;
        if (Math.abs(pctMove) >= threshold) {
          fired = true;
          detail = `VIX moved ${pctMove.toFixed(2)}% (threshold ${threshold}%)`;
        }
        break;
      }

      case 'vix9dMove': {
        if (!trigger.vix9dPrices) break;
        const vix9d = trigger.vix9dPrices.get(point.timestamp);
        if (vix9d == null) break;
        if (firstVix9dPrice === null) {
          firstVix9dPrice = vix9d;
          break;
        }
        const pctMove = ((vix9d - firstVix9dPrice) / firstVix9dPrice) * 100;
        if (Math.abs(pctMove) >= threshold) {
          fired = true;
          detail = `VIX9D moved ${pctMove.toFixed(2)}% (threshold ${threshold}%)`;
        }
        break;
      }

      case 'vix9dVixRatio': {
        if (!trigger.vixPrices || !trigger.vix9dPrices) break;
        const vix = trigger.vixPrices.get(point.timestamp);
        const vix9d = trigger.vix9dPrices.get(point.timestamp);
        if (vix == null || vix9d == null || vix === 0) break;
        const ratio = vix9d / vix;
        // If threshold >= 1, fire when ratio >= threshold (contango deepening)
        // If threshold < 1, fire when ratio <= threshold (backwardation)
        const crosses = threshold >= 1 ? ratio >= threshold : ratio <= threshold;
        if (crosses) {
          fired = true;
          detail = `VIX9D/VIX ratio ${ratio.toFixed(4)} crossed threshold ${threshold}`;
        }
        break;
      }

      case 'slRatioThreshold': {
        const sw = trigger.spreadWidth ?? 0;
        const ct = trigger.contracts ?? 1;
        const mp = trigger.multiplier ?? 100;
        if (sw === 0) break;
        const slRatio = computeSLRatio(point, legs, sw, ct, mp);
        if (slRatio >= threshold) {
          fired = true;
          detail = `S/L ratio ${slRatio.toFixed(4)} >= threshold ${threshold}`;
        }
        break;
      }

      case 'slRatioMove': {
        const sw = trigger.spreadWidth ?? 0;
        const ct = trigger.contracts ?? 1;
        const mp = trigger.multiplier ?? 100;
        if (sw === 0) break;
        const slRatio = computeSLRatio(point, legs, sw, ct, mp);
        if (initialSLRatio === null && typeof trigger.entrySLRatio === 'number') {
          initialSLRatio = trigger.entrySLRatio;
        }
        if (initialSLRatio === null) {
          initialSLRatio = slRatio;
          break; // Can't compute change on first point
        }
        const pctMove = computeSLRatioMove(initialSLRatio, slRatio);
        if (crossesDirectionalMove(pctMove, threshold)) {
          fired = true;
          detail = `S/L ratio moved ${(pctMove * 100).toFixed(2)}% from initial ${initialSLRatio.toFixed(4)} to ${slRatio.toFixed(4)} (threshold ${(threshold * 100).toFixed(2)}%)`;
        }
        break;
      }
    }

    if (fired) {
      return {
        type,
        firedAt: point.timestamp,
        pnlAtFire: pnl,
        index: i,
        detail,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// computeGroupPnl
// ---------------------------------------------------------------------------

/**
 * Compute per-group P&L at each timestamp from leg prices.
 * groupPnl[t] = sum over legIndices of (legPrices[i] - entryPrice[i]) * quantity[i] * multiplier[i]
 */
function computeGroupPnl(
  pnlPath: PnlPoint[],
  legs: ReplayLeg[],
  legIndices: number[],
): number[] {
  return pnlPath.map((point) => {
    let groupPnl = 0;
    for (const idx of legIndices) {
      if (idx < legs.length && idx < point.legPrices.length) {
        const leg = legs[idx];
        const markPrice = point.legPrices[idx];
        groupPnl += (markPrice - leg.entryPrice) * leg.quantity * leg.multiplier;
      }
    }
    return groupPnl;
  });
}

// ---------------------------------------------------------------------------
// analyzeExitTriggers
// ---------------------------------------------------------------------------

/**
 * Run all triggers against the P&L path, find first-to-fire,
 * compute actual exit comparison, and evaluate leg group triggers.
 */
export function analyzeExitTriggers(config: {
  pnlPath: PnlPoint[];
  legs: ReplayLeg[];
  triggers: ExitTriggerConfig[];
  actualExitTimestamp?: string;
  legGroups?: LegGroupConfig[];
}): {
  overall: ExitTriggerResult;
  legGroups?: LegGroupResult[];
} {
  const { pnlPath, legs, triggers, actualExitTimestamp, legGroups } = config;

  // Evaluate all triggers
  const fireEvents: TriggerFireEvent[] = [];
  let allPartialCloses: PartialClose[] = [];
  for (const trigger of triggers) {
    if (trigger.type === 'profitAction') {
      // Use the partial-close-aware helper for profitAction
      const paResult = evaluateProfitAction(trigger, pnlPath, legs);
      if (paResult.fireEvent) {
        fireEvents.push(paResult.fireEvent);
      }
      if (paResult.partialCloses.length > 0) {
        allPartialCloses = allPartialCloses.concat(paResult.partialCloses);
      }
    } else {
      const event = evaluateTrigger(trigger, pnlPath, legs);
      if (event) {
        fireEvents.push(event);
      }
    }
  }

  // Sort by fire index (earliest first)
  fireEvents.sort((a, b) => a.index - b.index);

  const firstToFire = fireEvents.length > 0 ? fireEvents[0] : null;

  // Actual exit comparison
  let actualExit: ExitTriggerResult['actualExit'];
  if (actualExitTimestamp && firstToFire) {
    // Find closest point to actualExitTimestamp
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < pnlPath.length; i++) {
      // Simple string comparison — timestamps are lexicographically ordered
      const dist = Math.abs(pnlPath[i].timestamp.localeCompare(actualExitTimestamp));
      if (pnlPath[i].timestamp === actualExitTimestamp) {
        closestIdx = i;
        break;
      }
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
    // Fallback: use last point if actualExitTimestamp is after all points
    if (actualExitTimestamp > pnlPath[pnlPath.length - 1].timestamp) {
      closestIdx = pnlPath.length - 1;
    }
    const actualPnl = pnlPath[closestIdx].strategyPnl;
    actualExit = {
      timestamp: pnlPath[closestIdx].timestamp,
      pnl: actualPnl,
      pnlDifference: firstToFire.pnlAtFire - actualPnl,
    };
  }

  // Build summary
  let summary: string;
  if (!firstToFire) {
    summary = `No triggers fired across ${pnlPath.length} data points.`;
  } else if (actualExit) {
    const betterWorse = actualExit.pnlDifference > 0 ? 'better' : 'worse';
    summary = `${firstToFire.type} fired at ${firstToFire.firedAt} (P&L $${firstToFire.pnlAtFire.toFixed(2)}). ` +
      `Actual exit at ${actualExit.timestamp} (P&L $${actualExit.pnl.toFixed(2)}). ` +
      `Trigger was $${Math.abs(actualExit.pnlDifference).toFixed(2)} ${betterWorse}.`;
  } else {
    summary = `${firstToFire.type} fired first at ${firstToFire.firedAt} (P&L $${firstToFire.pnlAtFire.toFixed(2)}). ` +
      `${fireEvents.length} trigger(s) fired total.`;
  }

  const overall: ExitTriggerResult = {
    triggers: fireEvents,
    firstToFire,
    actualExit,
    partialCloses: allPartialCloses.length > 0 ? allPartialCloses : undefined,
    summary,
  };

  // Leg group evaluation
  let legGroupResults: LegGroupResult[] | undefined;
  if (legGroups && legGroups.length > 0) {
    legGroupResults = legGroups.map((group) => {
      const groupPnlArr = computeGroupPnl(pnlPath, legs, group.legIndices);

      // Build a synthetic PnlPoint[] for this group with groupPnl as strategyPnl
      const groupPath: PnlPoint[] = pnlPath.map((point, idx) => ({
        ...point,
        strategyPnl: groupPnlArr[idx],
        // Filter legPrices/legGreeks to only this group's legs
        legPrices: group.legIndices.map((li) => point.legPrices[li] ?? 0),
        legGreeks: point.legGreeks
          ? group.legIndices.map((li) => point.legGreeks![li])
          : undefined,
      }));

      // Build group legs subset
      const groupLegs = group.legIndices.map((li) => legs[li]);

      // Evaluate per-group triggers
      const groupFireEvents: TriggerFireEvent[] = [];
      for (const trigger of group.triggers) {
        const event = evaluateTrigger(trigger, groupPath, groupLegs);
        if (event) groupFireEvents.push(event);
      }
      groupFireEvents.sort((a, b) => a.index - b.index);

      const groupFirstToFire = groupFireEvents.length > 0 ? groupFireEvents[0] : null;

      // Actual exit for group
      let groupActualExit: ExitTriggerResult['actualExit'];
      if (actualExitTimestamp && groupFirstToFire) {
        let closestIdx = pnlPath.length - 1;
        for (let i = 0; i < pnlPath.length; i++) {
          if (pnlPath[i].timestamp === actualExitTimestamp) {
            closestIdx = i;
            break;
          }
        }
        if (actualExitTimestamp > pnlPath[pnlPath.length - 1].timestamp) {
          closestIdx = pnlPath.length - 1;
        }
        const actualGroupPnl = groupPnlArr[closestIdx];
        groupActualExit = {
          timestamp: pnlPath[closestIdx].timestamp,
          pnl: actualGroupPnl,
          pnlDifference: groupFirstToFire.pnlAtFire - actualGroupPnl,
        };
      }

      const groupSummary = groupFirstToFire
        ? `${group.label}: ${groupFirstToFire.type} fired at ${groupFirstToFire.firedAt} (group P&L $${groupFirstToFire.pnlAtFire.toFixed(2)})`
        : `${group.label}: No triggers fired.`;

      return {
        label: group.label,
        result: {
          triggers: groupFireEvents,
          firstToFire: groupFirstToFire,
          actualExit: groupActualExit,
          summary: groupSummary,
        },
        groupPnl: groupPnlArr,
      };
    });
  }

  return {
    overall,
    legGroups: legGroupResults,
  };
}
