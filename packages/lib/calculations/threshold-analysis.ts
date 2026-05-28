/**
 * Threshold Analysis Calculations
 *
 * For any given field, calculates running cumulative statistics to help
 * identify optimal filter thresholds. Shows what happens if you filter
 * trades above or below each value.
 *
 * Outputs 4 series:
 * 1. Cumulative % of trades at or below X
 * 2. Cumulative % of total P/L from trades at or below X
 * 3. Average P/L (or ROM) for trades ABOVE X threshold
 * 4. Average P/L (or ROM) for trades BELOW X threshold
 */

import { type EnrichedTrade, getEnrichedTradeValue } from '../models/enriched-trade.ts'

/**
 * A single data point in the threshold analysis
 */
export interface ThresholdDataPoint {
  xValue: number                    // The threshold value (e.g., SLR = 0.5)
  cumulativeTradesPct: number       // % of total trades at or below this X
  cumulativePlPct: number           // % of total P/L from trades at or below this X
  avgPlAbove: number | null         // Avg P/L for trades > X (null if no trades)
  avgPlBelow: number | null         // Avg P/L for trades <= X (null if no trades)
  avgPlPctAbove: number | null      // Avg P/L % (P/L/premium*100) for trades > X
  avgPlPctBelow: number | null      // Avg P/L % (P/L/premium*100) for trades <= X
  avgRomAbove: number | null        // Avg ROM for trades > X (null if no trades)
  avgRomBelow: number | null        // Avg ROM for trades <= X (null if no trades)
  tradesAbove: number               // Count of trades > X
  tradesBelow: number               // Count of trades <= X
}

/**
 * Full result of threshold analysis
 */
export interface ThresholdAnalysisResult {
  field: string                     // The field being analyzed
  dataPoints: ThresholdDataPoint[]  // Sorted by xValue ascending
  totalTrades: number
  totalPl: number
}

// Use shared getEnrichedTradeValue from enriched-trade model
const getTradeValue = getEnrichedTradeValue

/**
 * Calculate threshold analysis for a given field
 *
 * @param trades - Array of enriched trades
 * @param xField - Field to analyze (e.g., 'openingShortLongRatio', 'openingVix')
 * @param binCount - Number of unique X values to sample (default 50 for smooth curves)
 * @returns ThresholdAnalysisResult with data points for charting
 */
export function calculateThresholdAnalysis(
  trades: EnrichedTrade[],
  xField: string,
  binCount: number = 50
): ThresholdAnalysisResult {
  if (trades.length === 0) {
    return {
      field: xField,
      dataPoints: [],
      totalTrades: 0,
      totalPl: 0
    }
  }

  // Extract valid X values and sort trades by X
  const tradesWithX = trades
    .map(trade => ({
      trade,
      xValue: getTradeValue(trade, xField),
      pl: trade.pl ?? 0,
      plPct: trade.premiumEfficiency ?? (trade.premium && trade.premium !== 0 && trade.numContracts ? (trade.pl / Math.abs(trade.premium * trade.numContracts)) * 100 : 0),
      rom: trade.rom ?? 0
    }))
    .filter(t => t.xValue !== null) as Array<{
      trade: EnrichedTrade
      xValue: number
      pl: number
      plPct: number
      rom: number
    }>

  if (tradesWithX.length === 0) {
    return {
      field: xField,
      dataPoints: [],
      totalTrades: 0,
      totalPl: 0
    }
  }

  // Sort by X value
  tradesWithX.sort((a, b) => a.xValue - b.xValue)

  // Calculate totals
  const totalTrades = tradesWithX.length
  const totalPl = tradesWithX.reduce((sum, t) => sum + t.pl, 0)

  // Get unique X values to sample
  // If fewer unique values than binCount, use all unique values
  const uniqueXValues = [...new Set(tradesWithX.map(t => t.xValue))].sort((a, b) => a - b)

  let sampleXValues: number[]
  if (uniqueXValues.length <= binCount) {
    sampleXValues = uniqueXValues
  } else {
    // Sample evenly across the range
    sampleXValues = []
    for (let i = 0; i < binCount; i++) {
      const idx = Math.floor((i / (binCount - 1)) * (uniqueXValues.length - 1))
      sampleXValues.push(uniqueXValues[idx])
    }
    // Dedupe in case of rounding
    sampleXValues = [...new Set(sampleXValues)]
  }

  // Calculate statistics for each threshold
  const dataPoints: ThresholdDataPoint[] = sampleXValues.map(threshold => {
    // Split trades by threshold
    const tradesBelow = tradesWithX.filter(t => t.xValue <= threshold)
    const tradesAbove = tradesWithX.filter(t => t.xValue > threshold)

    // Cumulative percentages (trades at or below threshold)
    const cumulativeTradesPct = (tradesBelow.length / totalTrades) * 100
    const plBelow = tradesBelow.reduce((sum, t) => sum + t.pl, 0)
    // Handle case where total P/L is 0 or negative
    const cumulativePlPct = totalPl !== 0
      ? (plBelow / totalPl) * 100
      : (tradesBelow.length / totalTrades) * 100

    // Average P/L above/below threshold
    const avgPlAbove = tradesAbove.length > 0
      ? tradesAbove.reduce((sum, t) => sum + t.pl, 0) / tradesAbove.length
      : null
    const avgPlBelow = tradesBelow.length > 0
      ? tradesBelow.reduce((sum, t) => sum + t.pl, 0) / tradesBelow.length
      : null

    // Average P/L % (premium efficiency) above/below threshold
    const avgPlPctAbove = tradesAbove.length > 0
      ? tradesAbove.reduce((sum, t) => sum + t.plPct, 0) / tradesAbove.length
      : null
    const avgPlPctBelow = tradesBelow.length > 0
      ? tradesBelow.reduce((sum, t) => sum + t.plPct, 0) / tradesBelow.length
      : null

    // Average ROM above/below threshold
    const avgRomAbove = tradesAbove.length > 0
      ? tradesAbove.reduce((sum, t) => sum + t.rom, 0) / tradesAbove.length
      : null
    const avgRomBelow = tradesBelow.length > 0
      ? tradesBelow.reduce((sum, t) => sum + t.rom, 0) / tradesBelow.length
      : null

    return {
      xValue: threshold,
      cumulativeTradesPct,
      cumulativePlPct,
      avgPlAbove,
      avgPlBelow,
      avgPlPctAbove,
      avgPlPctBelow,
      avgRomAbove,
      avgRomBelow,
      tradesAbove: tradesAbove.length,
      tradesBelow: tradesBelow.length
    }
  })

  return {
    field: xField,
    dataPoints,
    totalTrades,
    totalPl
  }
}

/**
 * Result of finding the optimal threshold
 */
export interface OptimalThresholdResult {
  threshold: number              // The X value with the largest gap
  gap: number                    // The difference (above - below)
  avgAbove: number | null        // Avg metric for trades > threshold
  avgBelow: number | null        // Avg metric for trades <= threshold
  tradesAbove: number
  tradesBelow: number
  recommendation: 'above' | 'below' | 'neutral'  // Which side performs better
}

/**
 * Find the optimal threshold - the point where the gap between
 * above vs below average metrics is largest
 *
 * @param analysis - The threshold analysis result
 * @param metric - Which metric to use: 'pl', 'plPct', or 'rom'
 * @param minTradesPct - Minimum % of trades required on each side (default 10%)
 * @returns The optimal threshold info, or null if not enough data
 */
export function findOptimalThreshold(
  analysis: ThresholdAnalysisResult,
  metric: 'pl' | 'plPct' | 'rom' = 'plPct',
  minTradesPct: number = 10
): OptimalThresholdResult | null {
  if (analysis.dataPoints.length === 0) {
    return null
  }

  const minTrades = Math.ceil(analysis.totalTrades * (minTradesPct / 100))

  // Get the right metric values based on selection
  const getAbove = (d: ThresholdDataPoint) => {
    switch (metric) {
      case 'rom': return d.avgRomAbove
      case 'plPct': return d.avgPlPctAbove
      default: return d.avgPlAbove
    }
  }
  const getBelow = (d: ThresholdDataPoint) => {
    switch (metric) {
      case 'rom': return d.avgRomBelow
      case 'plPct': return d.avgPlPctBelow
      default: return d.avgPlBelow
    }
  }

  let bestPoint: ThresholdDataPoint | null = null
  let bestGap = 0

  for (const point of analysis.dataPoints) {
    // Ensure minimum trades on each side
    if (point.tradesAbove < minTrades || point.tradesBelow < minTrades) {
      continue
    }

    const above = getAbove(point)
    const below = getBelow(point)

    if (above === null || below === null) {
      continue
    }

    // Calculate absolute gap (we want the largest difference either direction)
    const gap = Math.abs(above - below)

    if (gap > bestGap) {
      bestGap = gap
      bestPoint = point
    }
  }

  if (!bestPoint) {
    return null
  }

  const avgAbove = getAbove(bestPoint)
  const avgBelow = getBelow(bestPoint)

  let recommendation: 'above' | 'below' | 'neutral' = 'neutral'
  if (avgAbove !== null && avgBelow !== null) {
    if (avgAbove > avgBelow) {
      recommendation = 'above'
    } else if (avgBelow > avgAbove) {
      recommendation = 'below'
    }
  }

  return {
    threshold: bestPoint.xValue,
    gap: avgAbove !== null && avgBelow !== null ? avgAbove - avgBelow : 0,
    avgAbove,
    avgBelow,
    tradesAbove: bestPoint.tradesAbove,
    tradesBelow: bestPoint.tradesBelow,
    recommendation
  }
}
