/**
 * Shared utility for equity curve calculations.
 *
 * This module provides a single source of truth for rebuilding equity curves
 * when trades are modified (scaled, filtered, etc.). It prevents bugs where
 * fundsAtClose values become inconsistent with P&L values.
 *
 * @example
 * ```typescript
 * // Rebuild equity curve after scaling trades
 * const scaledTrades = trades.map(t => ({ ...t, pl: t.pl * 0.5 }))
 * const withEquity = rebuildEquityCurve(scaledTrades, { initialCapital: 10000 })
 *
 * // Or use the combined helper
 * const scaled = scaleTradesWithEquityCurve(trades, 0.5, { initialCapital: 10000 })
 * ```
 */

import type { Trade } from '../models/trade.ts'

/**
 * Options for rebuilding equity curves.
 */
export interface RebuildEquityCurveOptions {
  /**
   * Initial capital to start the equity curve from.
   * If not provided, will be calculated from the first trade's fundsAtClose - pl.
   */
  initialCapital?: number

  /**
   * Whether to sort trades by close date before processing.
   * Default: true
   */
  sortByDate?: boolean

  /**
   * Whether to include commissions in P&L calculation.
   * When true, uses net P&L (pl - commissions).
   * Default: false (uses gross P&L from trade.pl)
   */
  useNetPl?: boolean
}

/**
 * Options for scaling trades with equity curve rebuild.
 */
export interface ScaleTradesOptions extends RebuildEquityCurveOptions {
  /**
   * Whether to also scale commission fees.
   * Default: true
   */
  scaleCommissions?: boolean
}

/**
 * Sort trades by close date and time.
 *
 * @param trades - Array of trades to sort
 * @returns New array sorted by dateClosed and timeClosed
 */
export function sortTradesByCloseDate<T extends Pick<Trade, 'dateClosed' | 'timeClosed'>>(
  trades: T[]
): T[] {
  return [...trades].sort((a, b) => {
    if (!a.dateClosed && !b.dateClosed) return 0
    if (!a.dateClosed) return 1
    if (!b.dateClosed) return -1

    const dateA = new Date(a.dateClosed)
    const dateB = new Date(b.dateClosed)
    const cmp = dateA.getTime() - dateB.getTime()
    if (cmp !== 0) return cmp

    // Secondary sort by time
    return (a.timeClosed || '').localeCompare(b.timeClosed || '')
  })
}

/**
 * Calculate initial capital from a sorted array of trades.
 *
 * Uses the first trade's fundsAtClose - pl to derive the starting capital.
 *
 * @param sortedTrades - Trades sorted by close date
 * @returns Initial capital, or undefined if cannot be determined
 */
export function calculateInitialCapital(
  sortedTrades: Pick<Trade, 'fundsAtClose' | 'pl'>[]
): number | undefined {
  if (sortedTrades.length === 0) return undefined

  const firstTrade = sortedTrades[0]
  if (firstTrade.fundsAtClose === undefined || firstTrade.fundsAtClose === null) {
    return undefined
  }

  return firstTrade.fundsAtClose - firstTrade.pl
}

/**
 * Get the net P&L for a trade (gross P&L minus commissions).
 *
 * @param trade - Trade to calculate net P&L for
 * @returns Net P&L value
 */
export function getNetPl(trade: Pick<Trade, 'pl' | 'openingCommissionsFees' | 'closingCommissionsFees'>): number {
  const openingComm = trade.openingCommissionsFees ?? 0
  const closingComm = trade.closingCommissionsFees ?? 0
  return trade.pl - openingComm - closingComm
}

/**
 * Rebuild the equity curve for a set of trades.
 *
 * This function recalculates fundsAtClose for each trade based on cumulative P&L.
 * It's essential to call this after modifying trade P&L values (e.g., scaling).
 *
 * IMPORTANT: The returned trades maintain their original order but have
 * fundsAtClose recalculated based on chronological P&L accumulation.
 *
 * @param trades - Array of trades (will not be mutated)
 * @param options - Configuration options
 * @returns New array of trades with recalculated fundsAtClose values
 *
 * @example
 * ```typescript
 * // After scaling P&L, rebuild the equity curve
 * const scaledTrades = trades.map(t => ({ ...t, pl: t.pl * 0.5 }))
 * const withEquity = rebuildEquityCurve(scaledTrades, { initialCapital: 10000 })
 * ```
 */
export function rebuildEquityCurve<T extends Trade>(
  trades: T[],
  options: RebuildEquityCurveOptions = {}
): T[] {
  const { sortByDate = true, useNetPl = false } = options

  if (trades.length === 0) return []

  // Filter to trades with close dates for equity calculation
  const closedTrades = trades.filter(t => t.dateClosed)
  if (closedTrades.length === 0) return [...trades]

  // Sort trades chronologically
  const sortedTrades = sortByDate ? sortTradesByCloseDate(closedTrades) : closedTrades

  // Determine initial capital
  let initialCapital = options.initialCapital
  if (initialCapital === undefined) {
    // Try to calculate from original first trade's fundsAtClose
    const originalSorted = sortTradesByCloseDate(
      trades.filter(t => t.dateClosed && t.fundsAtClose !== undefined && t.fundsAtClose !== null)
    )
    initialCapital = calculateInitialCapital(originalSorted)

    // Fallback to a reasonable default
    if (initialCapital === undefined) {
      initialCapital = 1000000
    }
  }

  // Build mapping of trade -> new fundsAtClose
  // We use a Map keyed by trade reference since trades may have same values
  const fundsAtCloseMap = new Map<T, number>()
  let runningEquity = initialCapital

  for (const trade of sortedTrades) {
    const pl = useNetPl ? getNetPl(trade) : trade.pl
    runningEquity += pl
    fundsAtCloseMap.set(trade, runningEquity)
  }

  // Return trades in original order with updated fundsAtClose
  return trades.map(trade => {
    const newFundsAtClose = fundsAtCloseMap.get(trade)
    if (newFundsAtClose !== undefined) {
      return { ...trade, fundsAtClose: newFundsAtClose }
    }
    return { ...trade }
  })
}

/**
 * Scale trades by a factor and rebuild the equity curve.
 *
 * This is the recommended way to scale trades as it ensures the equity curve
 * remains consistent with the scaled P&L values.
 *
 * @param trades - Array of trades (will not be mutated)
 * @param scaleFactor - Factor to multiply P&L by (e.g., 0.5 for half, 2 for double)
 * @param options - Configuration options
 * @returns New array of trades with scaled P&L and recalculated fundsAtClose
 *
 * @example
 * ```typescript
 * // Scale trades to 50% and rebuild equity curve
 * const scaled = scaleTradesWithEquityCurve(trades, 0.5, { initialCapital: 10000 })
 *
 * // Scale up by 2x
 * const doubled = scaleTradesWithEquityCurve(trades, 2.0)
 * ```
 */
export function scaleTradesWithEquityCurve<T extends Trade>(
  trades: T[],
  scaleFactor: number,
  options: ScaleTradesOptions = {}
): T[] {
  const { scaleCommissions = true, ...rebuildOptions } = options

  if (trades.length === 0) return []

  // Scale P&L and optionally commissions
  const scaledTrades = trades.map(trade => {
    const scaled: T = {
      ...trade,
      pl: trade.pl * scaleFactor,
    }

    if (scaleCommissions) {
      if (trade.openingCommissionsFees !== undefined) {
        scaled.openingCommissionsFees = trade.openingCommissionsFees * scaleFactor
      }
      if (trade.closingCommissionsFees !== undefined) {
        scaled.closingCommissionsFees = trade.closingCommissionsFees * scaleFactor
      }
    }

    return scaled
  })

  // Rebuild equity curve with scaled P&L
  return rebuildEquityCurve(scaledTrades, rebuildOptions)
}

/**
 * Normalize trades to one lot (single contract) and rebuild equity curve.
 *
 * Divides P&L by contract count to get per-contract performance.
 *
 * @param trades - Array of trades (will not be mutated)
 * @param options - Configuration options
 * @returns New array of trades normalized to one lot with rebuilt equity curve
 *
 * @example
 * ```typescript
 * const normalized = normalizeToOneLot(trades, { initialCapital: 10000 })
 * ```
 */
export function normalizeToOneLot<T extends Trade>(
  trades: T[],
  options: RebuildEquityCurveOptions = {}
): T[] {
  if (trades.length === 0) return []

  // Normalize each trade to single contract
  const normalizedTrades = trades.map(trade => {
    const contracts = trade.numContracts || 1
    const scaleFactor = 1 / contracts

    return {
      ...trade,
      pl: trade.pl * scaleFactor,
      numContracts: 1,
      openingCommissionsFees: trade.openingCommissionsFees
        ? trade.openingCommissionsFees * scaleFactor
        : trade.openingCommissionsFees,
      closingCommissionsFees: trade.closingCommissionsFees
        ? trade.closingCommissionsFees * scaleFactor
        : trade.closingCommissionsFees,
    }
  })

  // Rebuild equity curve with normalized P&L
  return rebuildEquityCurve(normalizedTrades, options)
}
