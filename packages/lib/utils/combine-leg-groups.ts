/**
 * Leg Group Combining Utility
 *
 * For MEIC (Multiple Entry Iron Condor) and similar strategies where the backtester
 * creates separate trade records for each leg group (e.g., calls and puts) that were
 * opened simultaneously but may have different exit conditions/times.
 *
 * This utility groups trades by entry timestamp and combines them into single trade records.
 */

import type { Trade } from '../models/trade.ts'
import type { ReportingTrade } from '../models/reporting-trade.ts'
import { yieldToMain, checkCancelled } from './async-helpers.ts'

/**
 * Key used to group trades that were opened at the same time
 */
export interface TradeGroupKey {
  dateOpened: string // ISO date string
  timeOpened: string
  strategy: string
}

/**
 * Result of combining multiple leg groups into a single trade
 */
export interface CombinedTrade extends Trade {
  originalTradeCount: number // Number of trades that were combined
  combinedLegs: string[] // Array of leg strings from each trade
}

/**
 * Result of combining multiple ReportingTrade leg groups into a single trade
 */
export interface CombinedReportingTrade extends ReportingTrade {
  originalTradeCount: number // Number of trades that were combined
  combinedLegs: string[] // Array of leg strings from each trade
}

/**
 * Type guard to check if a Trade is a CombinedTrade
 */
export function isCombinedTrade(trade: Trade): trade is CombinedTrade {
  return 'originalTradeCount' in trade && 'combinedLegs' in trade
}

/**
 * Type guard to check if a ReportingTrade is a CombinedReportingTrade
 */
export function isCombinedReportingTrade(trade: ReportingTrade): trade is CombinedReportingTrade {
  return 'originalTradeCount' in trade && 'combinedLegs' in trade
}

/**
 * Generate a unique key for grouping trades by entry timestamp
 */
function generateGroupKey(trade: Trade): string {
  const dateStr = trade.dateOpened.toISOString().split('T')[0]
  return `${dateStr}|${trade.timeOpened}|${trade.strategy}`
}

/**
 * Parse a group key back into its components
 * (Not currently used but kept for future API compatibility)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseGroupKey(key: string): TradeGroupKey {
  const [dateOpened, timeOpened, strategy] = key.split('|')
  return { dateOpened, timeOpened, strategy }
}

/**
 * Group trades by their entry timestamp (date + time + strategy)
 * Returns a map where the key is the group identifier and value is array of trades
 */
export function groupTradesByEntry(trades: Trade[]): Map<string, Trade[]> {
  const groups = new Map<string, Trade[]>()

  for (const trade of trades) {
    const key = generateGroupKey(trade)
    const group = groups.get(key) || []
    group.push(trade)
    groups.set(key, group)
  }

  return groups
}

/**
 * Combine a group of trades that were opened at the same time into a single trade record
 *
 * Rules for combining:
 * - Opening fields: Use first trade's values (they should be identical)
 * - Closing fields: Use the last closing time among all trades
 * - Premium: Sum of all premiums
 * - P/L: Sum of all P/Ls
 * - Commissions: Sum of all commissions
 * - Margin: Use the maximum margin requirement
 * - Contracts: Sum of all contracts
 * - Legs: Concatenate all leg descriptions
 * - Closing price: Use weighted average based on premiums
 * - Funds at close: Use final funds from last closed trade
 */
export function combineLegGroup(trades: Trade[]): CombinedTrade {
  if (trades.length === 0) {
    throw new Error('Cannot combine empty trade group')
  }

  // Sort trades by closing time (or use original order if not closed)
  const sortedTrades = [...trades].sort((a, b) => {
    if (!a.dateClosed && !b.dateClosed) return 0
    if (!a.dateClosed) return 1
    if (!b.dateClosed) return -1

    const dateCompare = a.dateClosed.getTime() - b.dateClosed.getTime()
    if (dateCompare !== 0) return dateCompare

    // Secondary sort by time if dates are equal
    const timeA = a.timeClosed || '00:00:00'
    const timeB = b.timeClosed || '00:00:00'
    return timeA.localeCompare(timeB)
  })

  // Use first trade as template (opening info should be identical)
  const firstTrade = sortedTrades[0]
  const lastTrade = sortedTrades[sortedTrades.length - 1]

  // Aggregate numeric values
  const totalPremium = trades.reduce((sum, t) => sum + t.premium, 0)
  const totalPL = trades.reduce((sum, t) => sum + t.pl, 0)
  // Use the contract size of the first leg to represent the "Strategy Unit Size"
  // e.g. A 10-lot Iron Condor has 4 legs of 10 contracts.
  // We want the combined trade to say "10 contracts" (10 ICs), not 40.
  const totalContracts = firstTrade.numContracts
  const totalOpeningCommissions = trades.reduce((sum, t) => sum + t.openingCommissionsFees, 0)
  const totalClosingCommissions = trades.reduce((sum, t) => sum + t.closingCommissionsFees, 0)
  
  // For margin:
  // - Debit trades (totalPremium < 0): Sum margin (e.g. Straddle = Call + Put cost)
  // - Credit trades (totalPremium >= 0): Max margin (e.g. Iron Condor = Max(Call side, Put side))
  const maxMargin = totalPremium < 0
    ? trades.reduce((sum, t) => sum + t.marginReq, 0)
    : Math.max(...trades.map(t => t.marginReq))

  // Calculate weighted average closing price
  let weightedClosingPrice: number | undefined
  if (trades.every(t => t.closingPrice !== undefined)) {
    const totalPremiumForClosedTrades = trades
      .filter(t => t.closingPrice !== undefined)
      .reduce((sum, t) => sum + Math.abs(t.premium), 0)

    if (totalPremiumForClosedTrades > 0) {
      weightedClosingPrice = trades
        .filter(t => t.closingPrice !== undefined)
        .reduce((sum, t) => sum + (t.closingPrice! * Math.abs(t.premium)), 0) / totalPremiumForClosedTrades
    }
  }

  // Calculate total closing cost if all trades have it recorded
  let avgClosingCost: number | undefined
  const tradesWithClosingCost = trades.filter(t => t.avgClosingCost !== undefined)
  if (tradesWithClosingCost.length === trades.length) {
    avgClosingCost = tradesWithClosingCost.reduce((sum, t) => sum + t.avgClosingCost!, 0)
  }

  // Combine leg descriptions
  const combinedLegs = trades.map(t => t.legs)
  const combinedLegsString = combinedLegs.join(' | ')

  // Use last trade's closing information (latest exit)
  const dateClosed = lastTrade.dateClosed
  const timeClosed = lastTrade.timeClosed
  const reasonForClose = lastTrade.reasonForClose
  const fundsAtClose = lastTrade.fundsAtClose
  const closingShortLongRatio = lastTrade.closingShortLongRatio
  const closingVix = lastTrade.closingVix

  // Calculate combined opening short/long ratio (weighted by premium)
  const totalAbsPremium = trades.reduce((sum, t) => sum + Math.abs(t.premium), 0)
  const weightedOpeningShortLongRatio = totalAbsPremium > 0
    ? trades.reduce((sum, t) => sum + (t.openingShortLongRatio * Math.abs(t.premium)), 0) / totalAbsPremium
    : trades[0].openingShortLongRatio

  // For optional fields, use first trade's value or undefined
  const gap = firstTrade.gap
  const movement = firstTrade.movement

  // Max profit/loss handling:
  // - For single trades (originalTradeCount === 1): preserve original percentage values from CSV
  // - For combined trades (originalTradeCount > 1): derive dollar amounts from margin
  let maxProfit: number | undefined
  let maxLoss: number | undefined

  if (trades.length === 1) {
    // Single trade: preserve original values (percentages from CSV)
    maxProfit = firstTrade.maxProfit
    maxLoss = firstTrade.maxLoss
    // For debit trades without explicit maxLoss, use premium paid as max loss
    if (maxLoss === undefined && firstTrade.premium < 0) {
      maxLoss = firstTrade.premium
    }
  } else {
    // Combined trades: sum maxProfit, use margin for maxLoss
    if (trades.every(t => t.maxProfit !== undefined)) {
      maxProfit = trades.reduce((sum, t) => sum + t.maxProfit!, 0)
    }

    // Use margin requirement as ground truth for worst-case loss
    if (maxMargin && Number.isFinite(maxMargin) && maxMargin > 0) {
      maxLoss = -maxMargin
    } else if (trades.every(t => t.maxLoss !== undefined)) {
      maxLoss = trades.reduce((sum, t) => sum + t.maxLoss!, 0)
    } else if (totalPremium < 0) {
      // Fallback: For debit trades, the max loss is at least the premium paid
      maxLoss = totalPremium
    }
  }

  const combined: CombinedTrade = {
    // Opening information (from first trade)
    dateOpened: firstTrade.dateOpened,
    timeOpened: firstTrade.timeOpened,
    openingPrice: firstTrade.openingPrice,
    legs: combinedLegsString,
    premium: totalPremium,
    premiumPrecision: firstTrade.premiumPrecision,
    openingVix: firstTrade.openingVix,

    // Closing information (from last closed trade)
    closingPrice: weightedClosingPrice,
    dateClosed,
    timeClosed,
    avgClosingCost,
    reasonForClose,
    closingVix,

    // Aggregated values
    pl: totalPL,
    numContracts: totalContracts,
    fundsAtClose,
    marginReq: maxMargin,
    openingCommissionsFees: totalOpeningCommissions,
    closingCommissionsFees: totalClosingCommissions,

    // Strategy and ratios
    strategy: firstTrade.strategy,
    openingShortLongRatio: weightedOpeningShortLongRatio,
    closingShortLongRatio,

    // Optional market data
    gap,
    movement,
    maxProfit,
    maxLoss,

    // Combined trade metadata
    originalTradeCount: trades.length,
    combinedLegs,
  }

  return combined
}

export interface CombineLegGroupsProgress {
  step: string
  percent: number
}

export interface CombineLegGroupsOptions {
  onProgress?: (progress: CombineLegGroupsProgress) => void
  signal?: AbortSignal
}

/**
 * Process all trades and combine leg groups that share the same entry timestamp
 *
 * @param trades - Array of trades to process
 * @returns Array of trades with leg groups combined (single trades are preserved as-is)
 */
export function combineAllLegGroups(trades: Trade[]): CombinedTrade[] {
  const groups = groupTradesByEntry(trades)
  const combinedTrades: CombinedTrade[] = []

  for (const [, groupTrades] of groups) {
    combinedTrades.push(combineLegGroup(groupTrades))
  }

  // Sort by date/time to maintain chronological order
  combinedTrades.sort((a, b) => {
    const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime()
    if (dateCompare !== 0) return dateCompare
    return a.timeOpened.localeCompare(b.timeOpened)
  })

  return combinedTrades
}

/**
 * Async version of combineAllLegGroups with progress reporting and cancellation support
 * Use this for large datasets to keep UI responsive
 *
 * @param trades - Array of trades to process
 * @param options - Progress callback and abort signal
 * @returns Array of trades with leg groups combined
 */
export async function combineAllLegGroupsAsync(
  trades: Trade[],
  options?: CombineLegGroupsOptions
): Promise<CombinedTrade[]> {
  const { onProgress, signal } = options ?? {}

  checkCancelled(signal)
  onProgress?.({ step: 'Grouping trades by entry', percent: 0 })
  await yieldToMain()

  const groups = groupTradesByEntry(trades)
  const combinedTrades: CombinedTrade[] = []
  const totalGroups = groups.size
  let processedGroups = 0

  checkCancelled(signal)
  onProgress?.({ step: 'Combining leg groups', percent: 10 })

  for (const [, groupTrades] of groups) {
    combinedTrades.push(combineLegGroup(groupTrades))
    processedGroups++

    // Yield every 100 groups to keep UI responsive
    if (processedGroups % 100 === 0) {
      checkCancelled(signal)
      const percent = 10 + Math.floor((processedGroups / totalGroups) * 70)
      onProgress?.({ step: `Combining leg groups (${processedGroups}/${totalGroups})`, percent })
      await yieldToMain()
    }
  }

  checkCancelled(signal)
  onProgress?.({ step: 'Sorting combined trades', percent: 85 })
  await yieldToMain()

  // Sort by date/time to maintain chronological order
  combinedTrades.sort((a, b) => {
    const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime()
    if (dateCompare !== 0) return dateCompare
    return a.timeOpened.localeCompare(b.timeOpened)
  })

  onProgress?.({ step: 'Complete', percent: 100 })

  return combinedTrades
}

/**
 * Identify which trades would be affected by combining leg groups
 * Useful for showing users what will change before they enable the feature
 *
 * @returns Object with statistics about grouping
 */
export function analyzeLegGroups(trades: Trade[]): {
  totalTrades: number
  uniqueEntries: number
  groupedEntries: number
  maxGroupSize: number
  avgGroupSize: number
  groupSizeDistribution: Record<number, number> // size -> count
} {
  const groups = groupTradesByEntry(trades)

  const groupSizes = Array.from(groups.values()).map(g => g.length)
  const groupedEntries = groupSizes.filter(size => size > 1).length

  const distribution: Record<number, number> = {}
  for (const size of groupSizes) {
    distribution[size] = (distribution[size] || 0) + 1
  }

  return {
    totalTrades: trades.length,
    uniqueEntries: groups.size,
    groupedEntries,
    maxGroupSize: groupSizes.length > 0 ? Math.max(...groupSizes) : 0,
    avgGroupSize: groupSizes.length > 0 ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : 0,
    groupSizeDistribution: distribution,
  }
}

// =============================================================================
// ReportingTrade Combining Functions
// =============================================================================

/**
 * Generate a unique key for grouping ReportingTrades by entry timestamp
 */
function generateReportingGroupKey(trade: ReportingTrade): string {
  const dateStr = trade.dateOpened.toISOString().split('T')[0]
  const timeStr = trade.timeOpened ?? '00:00:00'
  return `${dateStr}|${timeStr}|${trade.strategy}`
}

/**
 * Group ReportingTrades by their entry timestamp (date + time + strategy)
 * Returns a map where the key is the group identifier and value is array of trades
 */
export function groupReportingTradesByEntry(trades: ReportingTrade[]): Map<string, ReportingTrade[]> {
  const groups = new Map<string, ReportingTrade[]>()

  for (const trade of trades) {
    const key = generateReportingGroupKey(trade)
    const group = groups.get(key) || []
    group.push(trade)
    groups.set(key, group)
  }

  return groups
}

/**
 * Combine a group of ReportingTrades that were opened at the same time into a single trade record
 *
 * Rules for combining (simpler than Trade - fewer fields):
 * - Opening fields: Use first trade's values (should be identical)
 * - Closing fields: Use the last closing time among all trades
 * - Premium: Sum of all initial premiums
 * - P/L: Sum of all P/Ls
 * - Contracts: Use first trade's contract count (strategy unit size)
 * - Legs: Concatenate all leg descriptions
 */
export function combineReportingLegGroup(trades: ReportingTrade[]): CombinedReportingTrade {
  if (trades.length === 0) {
    throw new Error('Cannot combine empty reporting trade group')
  }

  // Sort trades by closing time
  const sortedTrades = [...trades].sort((a, b) => {
    if (!a.dateClosed && !b.dateClosed) return 0
    if (!a.dateClosed) return 1
    if (!b.dateClosed) return -1

    const dateCompare = a.dateClosed.getTime() - b.dateClosed.getTime()
    if (dateCompare !== 0) return dateCompare

    const timeA = a.timeClosed || '00:00:00'
    const timeB = b.timeClosed || '00:00:00'
    return timeA.localeCompare(timeB)
  })

  const firstTrade = sortedTrades[0]
  const lastTrade = sortedTrades[sortedTrades.length - 1]

  // Aggregate numeric values
  const totalPremium = trades.reduce((sum, t) => sum + t.initialPremium, 0)
  const totalPL = trades.reduce((sum, t) => sum + t.pl, 0)
  const totalContracts = firstTrade.numContracts // Strategy unit size

  // Combine leg descriptions
  const combinedLegs = trades.map(t => t.legs)
  const combinedLegsString = combinedLegs.join(' | ')

  // Calculate total closing cost if all trades have it
  let avgClosingCost: number | undefined
  const tradesWithClosingCost = trades.filter(t => t.avgClosingCost !== undefined)
  if (tradesWithClosingCost.length === trades.length) {
    avgClosingCost = tradesWithClosingCost.reduce((sum, t) => sum + t.avgClosingCost!, 0)
  }

  // Weighted average closing price
  let closingPrice: number | undefined
  if (trades.every(t => t.closingPrice !== undefined)) {
    const totalPremiumAbs = trades.reduce((sum, t) => sum + Math.abs(t.initialPremium), 0)
    if (totalPremiumAbs > 0) {
      closingPrice = trades.reduce(
        (sum, t) => sum + (t.closingPrice! * Math.abs(t.initialPremium)),
        0
      ) / totalPremiumAbs
    }
  }

  return {
    strategy: firstTrade.strategy,
    dateOpened: firstTrade.dateOpened,
    timeOpened: firstTrade.timeOpened,
    openingPrice: firstTrade.openingPrice,
    legs: combinedLegsString,
    initialPremium: totalPremium,
    numContracts: totalContracts,
    pl: totalPL,
    closingPrice,
    dateClosed: lastTrade.dateClosed,
    timeClosed: lastTrade.timeClosed,
    avgClosingCost,
    reasonForClose: lastTrade.reasonForClose,
    originalTradeCount: trades.length,
    combinedLegs,
  }
}

/**
 * Process all ReportingTrades and combine leg groups that share the same entry timestamp
 *
 * @param trades - Array of ReportingTrades to process
 * @returns Array of trades with leg groups combined
 */
export function combineAllReportingLegGroups(trades: ReportingTrade[]): CombinedReportingTrade[] {
  const groups = groupReportingTradesByEntry(trades)
  const combinedTrades: CombinedReportingTrade[] = []

  for (const [, groupTrades] of groups) {
    combinedTrades.push(combineReportingLegGroup(groupTrades))
  }

  // Sort chronologically
  combinedTrades.sort((a, b) => {
    const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime()
    if (dateCompare !== 0) return dateCompare
    const timeA = a.timeOpened || '00:00:00'
    const timeB = b.timeOpened || '00:00:00'
    return timeA.localeCompare(timeB)
  })

  return combinedTrades
}
