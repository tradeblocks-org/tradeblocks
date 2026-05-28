/**
 * Cumulative Distribution Calculations
 *
 * Generates data for SLR-style distribution charts showing:
 * - % of trades at or above each threshold
 * - % of P&L at or above each threshold
 * - Win rate at each threshold
 * - Average ROM at each threshold
 */

import { mean, std, median } from 'mathjs'
import type { Trade } from '../models/trade.ts'
import type { RegimeSourceField } from '../models/regime.ts'
import { getTradeFieldValue, computeDerivedFields, type DerivedTradeFields } from './regime-filter.ts'

/**
 * Single point in a cumulative distribution
 */
export interface CumulativeDistributionPoint {
  threshold: number
  // "At or above" metrics
  tradesAtOrAbove: number
  tradesAtOrAbovePercent: number
  plAtOrAbove: number
  plAtOrAbovePercent: number
  avgRomAtOrAbove: number
  winRateAtOrAbove: number
  // "At or below" metrics (inverse)
  tradesAtOrBelow: number
  tradesAtOrBelowPercent: number
  plAtOrBelow: number
  plAtOrBelowPercent: number
  avgRomAtOrBelow: number
  winRateAtOrBelow: number
}

/**
 * Statistics about the distribution
 */
export interface DistributionStats {
  min: number
  max: number
  mean: number
  median: number
  stdDev: number
  count: number
  missingCount: number
}

/**
 * Complete cumulative distribution analysis
 */
export interface CumulativeDistributionAnalysis {
  field: RegimeSourceField
  fieldLabel: string
  points: CumulativeDistributionPoint[]
  stats: DistributionStats
}

/**
 * Extract field values from trades along with trade data
 */
interface TradeWithValue {
  trade: Trade
  value: number
  rom?: number
}

function extractTradeValues(
  trades: Trade[],
  field: RegimeSourceField,
  derivedFieldsMap?: Map<number, DerivedTradeFields>
): TradeWithValue[] {
  const results: TradeWithValue[] = []

  trades.forEach((trade, index) => {
    const derived = derivedFieldsMap?.get(index) ?? computeDerivedFields(trade)
    const value = getTradeFieldValue(trade, field, derived)

    if (value !== undefined && isFinite(value)) {
      const rom = trade.marginReq && trade.marginReq > 0
        ? (trade.pl / trade.marginReq) * 100
        : undefined

      results.push({ trade, value, rom })
    }
  })

  return results
}

/**
 * Calculate statistics for a subset of trades
 */
function calculateSubsetStats(entries: TradeWithValue[]): {
  totalPl: number
  avgRom: number
  winRate: number
} {
  if (entries.length === 0) {
    return { totalPl: 0, avgRom: 0, winRate: 0 }
  }

  const totalPl = entries.reduce((sum, e) => sum + e.trade.pl, 0)
  const wins = entries.filter(e => e.trade.pl > 0).length
  const winRate = (wins / entries.length) * 100

  const roms = entries.filter(e => e.rom !== undefined).map(e => e.rom!)
  const avgRom = roms.length > 0 ? (mean(roms) as number) : 0

  return { totalPl, avgRom, winRate }
}

/**
 * Calculate cumulative distribution for a trade field
 *
 * Creates data points showing what % of trades/P&L occur at each threshold level.
 * Useful for charts like "SLR Distribution" showing trades at or above each ratio.
 *
 * @param trades - Trade data
 * @param field - Which field to analyze
 * @param numBuckets - Number of threshold points (default 50)
 * @param derivedFieldsMap - Optional pre-computed derived fields
 */
export function calculateCumulativeDistribution(
  trades: Trade[],
  field: RegimeSourceField,
  numBuckets: number = 50,
  derivedFieldsMap?: Map<number, DerivedTradeFields>
): CumulativeDistributionAnalysis {
  const fieldLabels: Record<RegimeSourceField, string> = {
    openingVix: 'Opening VIX',
    closingVix: 'Closing VIX',
    openingShortLongRatio: 'Opening S/L Ratio',
    closingShortLongRatio: 'Closing S/L Ratio',
    gap: 'Gap %',
    movement: 'Movement',
    timeOpened: 'Time of Day (minutes)',
    dayOfWeek: 'Day of Week',
    durationHours: 'Duration (Hours)',
    mfePercent: 'MFE %',
    maePercent: 'MAE %',
    profitCapturePercent: 'Profit Capture %',
    excursionRatio: 'Excursion Ratio'
  }

  // Extract valid values
  const entries = extractTradeValues(trades, field, derivedFieldsMap)

  if (entries.length === 0) {
    return {
      field,
      fieldLabel: fieldLabels[field],
      points: [],
      stats: {
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        stdDev: 0,
        count: 0,
        missingCount: trades.length
      }
    }
  }

  // Sort by value for cumulative calculation
  entries.sort((a, b) => a.value - b.value)
  const values = entries.map(e => e.value)

  // Calculate statistics
  const minVal = values[0]
  const maxVal = values[values.length - 1]
  const meanVal = mean(values) as number
  const medianVal = median(values) as number
  const stdVal = values.length > 1 ? (std(values, 'uncorrected') as number) : 0

  // Total P&L for percentage calculations
  const totalPl = entries.reduce((sum, e) => sum + e.trade.pl, 0)
  const totalTrades = entries.length

  // Generate threshold points
  const step = (maxVal - minVal) / numBuckets
  const points: CumulativeDistributionPoint[] = []

  for (let i = 0; i <= numBuckets; i++) {
    const threshold = minVal + (step * i)

    // Entries at or above this threshold
    const atOrAbove = entries.filter(e => e.value >= threshold)
    const aboveStats = calculateSubsetStats(atOrAbove)

    // Entries at or below this threshold
    const atOrBelow = entries.filter(e => e.value <= threshold)
    const belowStats = calculateSubsetStats(atOrBelow)

    points.push({
      threshold,
      // At or above
      tradesAtOrAbove: atOrAbove.length,
      tradesAtOrAbovePercent: (atOrAbove.length / totalTrades) * 100,
      plAtOrAbove: aboveStats.totalPl,
      plAtOrAbovePercent: totalPl !== 0 ? (aboveStats.totalPl / totalPl) * 100 : 0,
      avgRomAtOrAbove: aboveStats.avgRom,
      winRateAtOrAbove: aboveStats.winRate,
      // At or below
      tradesAtOrBelow: atOrBelow.length,
      tradesAtOrBelowPercent: (atOrBelow.length / totalTrades) * 100,
      plAtOrBelow: belowStats.totalPl,
      plAtOrBelowPercent: totalPl !== 0 ? (belowStats.totalPl / totalPl) * 100 : 0,
      avgRomAtOrBelow: belowStats.avgRom,
      winRateAtOrBelow: belowStats.winRate
    })
  }

  return {
    field,
    fieldLabel: fieldLabels[field],
    points,
    stats: {
      min: minVal,
      max: maxVal,
      mean: meanVal,
      median: medianVal,
      stdDev: stdVal,
      count: entries.length,
      missingCount: trades.length - entries.length
    }
  }
}

/**
 * Find the optimal threshold for a given metric
 * Returns the threshold that maximizes the target metric
 */
export function findOptimalThreshold(
  analysis: CumulativeDistributionAnalysis,
  metric: 'winRateAtOrAbove' | 'avgRomAtOrAbove' | 'winRateAtOrBelow' | 'avgRomAtOrBelow',
  minSampleSize: number = 10
): { threshold: number; value: number; sampleSize: number } | null {
  if (analysis.points.length === 0) {
    return null
  }

  let best: { threshold: number; value: number; sampleSize: number } | null = null

  for (const point of analysis.points) {
    const sampleSize = metric.includes('Above')
      ? point.tradesAtOrAbove
      : point.tradesAtOrBelow

    if (sampleSize < minSampleSize) continue

    const value = point[metric]

    if (best === null || value > best.value) {
      best = {
        threshold: point.threshold,
        value,
        sampleSize
      }
    }
  }

  return best
}

/**
 * Calculate the tradeoff at a specific threshold
 * Shows what you gain vs what you give up by filtering at this level
 */
export interface ThresholdTradeoff {
  threshold: number
  // What you keep (at or above for high values, at or below for low values)
  keptTrades: number
  keptTradesPercent: number
  keptPl: number
  keptPlPercent: number
  keptWinRate: number
  keptAvgRom: number
  // What you exclude
  excludedTrades: number
  excludedTradesPercent: number
  excludedPl: number
  excludedPlPercent: number
  excludedWinRate: number
  excludedAvgRom: number
}

/**
 * Calculate tradeoff analysis for a threshold (keeping values at or above)
 */
export function calculateThresholdTradeoff(
  analysis: CumulativeDistributionAnalysis,
  threshold: number
): ThresholdTradeoff | null {
  // Find the closest point to the threshold
  let closestPoint = analysis.points[0]
  let minDiff = Math.abs(closestPoint.threshold - threshold)

  for (const point of analysis.points) {
    const diff = Math.abs(point.threshold - threshold)
    if (diff < minDiff) {
      minDiff = diff
      closestPoint = point
    }
  }

  if (!closestPoint) return null

  const totalTrades = analysis.stats.count
  const totalPl = analysis.points[0]?.plAtOrAbove ?? 0 // First point has all trades

  return {
    threshold: closestPoint.threshold,
    // Kept (at or above)
    keptTrades: closestPoint.tradesAtOrAbove,
    keptTradesPercent: closestPoint.tradesAtOrAbovePercent,
    keptPl: closestPoint.plAtOrAbove,
    keptPlPercent: closestPoint.plAtOrAbovePercent,
    keptWinRate: closestPoint.winRateAtOrAbove,
    keptAvgRom: closestPoint.avgRomAtOrAbove,
    // Excluded (below)
    excludedTrades: totalTrades - closestPoint.tradesAtOrAbove,
    excludedTradesPercent: 100 - closestPoint.tradesAtOrAbovePercent,
    excludedPl: totalPl - closestPoint.plAtOrAbove,
    excludedPlPercent: 100 - closestPoint.plAtOrAbovePercent,
    excludedWinRate: closestPoint.winRateAtOrBelow,
    excludedAvgRom: closestPoint.avgRomAtOrBelow
  }
}

/**
 * Generate distribution data for multiple fields at once
 */
export function calculateMultipleDistributions(
  trades: Trade[],
  fields: RegimeSourceField[],
  numBuckets: number = 50
): Map<RegimeSourceField, CumulativeDistributionAnalysis> {
  const results = new Map<RegimeSourceField, CumulativeDistributionAnalysis>()

  // Pre-compute derived fields once for efficiency
  const derivedFieldsMap = new Map<number, DerivedTradeFields>()
  trades.forEach((trade, index) => {
    derivedFieldsMap.set(index, computeDerivedFields(trade))
  })

  for (const field of fields) {
    results.set(field, calculateCumulativeDistribution(trades, field, numBuckets, derivedFieldsMap))
  }

  return results
}
