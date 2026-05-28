/**
 * Regime Filter Logic
 *
 * Filters trades by regime criteria with AND logic across multiple criteria.
 * Supports numeric thresholds, time of day, and day of week filtering.
 */

import type { Trade } from '../models/trade.ts'
import type {
  RegimeDefinition,
  RegimeBucket,
  NumericThresholdBucket,
  TimeOfDayBucket,
  DayOfWeekBucket,
  RegimeFilterConfig,
  RegimeFilterCriterion,
  RegimeSourceField
} from '../models/regime.ts'

/**
 * Derived fields that can be computed from a trade
 */
export interface DerivedTradeFields {
  durationHours?: number
  mfePercent?: number
  maePercent?: number
  profitCapturePercent?: number
  excursionRatio?: number
  dayOfWeek: number  // 0-6, Sunday-Saturday
  timeMinutes: number  // Minutes since midnight (0-1439)
}

/**
 * Compute derived fields from a trade
 */
export function computeDerivedFields(trade: Trade): DerivedTradeFields {
  // The date in the CSV is stored as Eastern Time date, parsed as UTC midnight
  // Use getUTCDay() to get the correct day without timezone shift
  const dateOpened = new Date(trade.dateOpened)
  const dayOfWeek = dateOpened.getUTCDay()

  // Parse time from HH:mm:ss format
  let timeMinutes = 0
  if (trade.timeOpened) {
    const [hours, minutes] = trade.timeOpened.split(':').map(Number)
    timeMinutes = (hours || 0) * 60 + (minutes || 0)
  }

  // Calculate duration if closed
  let durationHours: number | undefined
  if (trade.dateClosed) {
    const openDate = new Date(trade.dateOpened)
    const closeDate = new Date(trade.dateClosed)
    durationHours = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60)
  }

  // Pull through MFE/MAE-derived fields when present (e.g., EnrichedTrade)
  const maybeNumber = (val: unknown) =>
    typeof val === 'number' && isFinite(val) ? val : undefined

  const mfePercent = maybeNumber((trade as unknown as Record<string, unknown>).mfePercent)
  const maePercent = maybeNumber((trade as unknown as Record<string, unknown>).maePercent)
  const profitCapturePercent = maybeNumber((trade as unknown as Record<string, unknown>).profitCapturePercent)
  const excursionRatio = maybeNumber((trade as unknown as Record<string, unknown>).excursionRatio)

  return {
    dayOfWeek,
    timeMinutes,
    durationHours,
    mfePercent,
    maePercent,
    profitCapturePercent,
    excursionRatio
  }
}

/**
 * Get the value of a field from a trade for filtering
 */
export function getTradeFieldValue(
  trade: Trade,
  field: RegimeSourceField,
  derived: DerivedTradeFields
): number | undefined {
  switch (field) {
    case 'openingVix':
      return trade.openingVix
    case 'closingVix':
      return trade.closingVix
    case 'openingShortLongRatio':
      return trade.openingShortLongRatio
    case 'closingShortLongRatio':
      return trade.closingShortLongRatio
    case 'gap':
      return trade.gap
    case 'movement':
      return trade.movement
    case 'timeOpened':
      return derived.timeMinutes
    case 'dayOfWeek':
      return derived.dayOfWeek
    case 'durationHours':
      return derived.durationHours
    case 'mfePercent':
      return derived.mfePercent
    case 'maePercent':
      return derived.maePercent
    case 'profitCapturePercent':
      return derived.profitCapturePercent
    case 'excursionRatio':
      return derived.excursionRatio
    default:
      return undefined
  }
}

/**
 * Check if a value matches a numeric threshold bucket
 */
function matchesNumericBucket(value: number, bucket: NumericThresholdBucket): boolean {
  const min = bucket.min ?? -Infinity
  const max = bucket.max ?? Infinity

  // For buckets with both bounds, use >= min and < max
  // For open-ended buckets, include the boundary
  if (bucket.min === null) {
    // Open at bottom: value <= max
    return value <= max
  } else if (bucket.max === null) {
    // Open at top: value >= min
    return value >= min
  } else {
    // Bounded: min <= value < max (exclusive upper bound to avoid overlaps)
    return value >= min && value < max
  }
}

/**
 * Check if a time value (minutes since midnight) matches a time of day bucket
 */
function matchesTimeOfDayBucket(timeMinutes: number, bucket: TimeOfDayBucket): boolean {
  const [startH, startM] = bucket.startTime.split(':').map(Number)
  const [endH, endM] = bucket.endTime.split(':').map(Number)

  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  return timeMinutes >= startMinutes && timeMinutes < endMinutes
}

/**
 * Check if a day of week value matches a day of week bucket
 */
function matchesDayOfWeekBucket(dayOfWeek: number, bucket: DayOfWeekBucket): boolean {
  return bucket.days.includes(dayOfWeek)
}

/**
 * Check if a trade matches a specific bucket
 */
export function tradeMatchesBucket(
  trade: Trade,
  bucket: RegimeBucket,
  derived: DerivedTradeFields,
  sourceField: RegimeSourceField
): boolean {
  const value = getTradeFieldValue(trade, sourceField, derived)

  if (value === undefined || !isFinite(value)) {
    return false
  }

  switch (bucket.type) {
    case 'numeric_threshold':
      return matchesNumericBucket(value, bucket)
    case 'time_of_day':
      return matchesTimeOfDayBucket(value, bucket)
    case 'day_of_week':
      return matchesDayOfWeekBucket(value, bucket)
    default:
      return false
  }
}

/**
 * Assign a trade to the appropriate bucket within a regime
 * Returns the bucket ID or null if no match
 */
export function assignTradeToBucket(
  trade: Trade,
  regime: RegimeDefinition,
  derived?: DerivedTradeFields
): string | null {
  const derivedFields = derived ?? computeDerivedFields(trade)

  for (const bucket of regime.buckets) {
    if (tradeMatchesBucket(trade, bucket, derivedFields, regime.sourceField)) {
      return bucket.id
    }
  }

  return null
}

/**
 * Check if a trade matches a filter criterion
 *
 * A trade matches if:
 * - The criterion is disabled (always matches)
 * - No specific buckets are selected (matches any bucket in the regime)
 * - The trade matches one of the selected buckets
 */
export function tradeMatchesCriterion(
  trade: Trade,
  criterion: RegimeFilterCriterion,
  regime: RegimeDefinition,
  derived?: DerivedTradeFields
): boolean {
  // Disabled criteria always match
  if (!criterion.enabled) {
    return true
  }

  // No specific buckets selected = any bucket matches
  if (criterion.selectedBucketIds.length === 0) {
    return true
  }

  const derivedFields = derived ?? computeDerivedFields(trade)
  const matchedBucketId = assignTradeToBucket(trade, regime, derivedFields)

  // Trade matches if it falls into one of the selected buckets
  return matchedBucketId !== null && criterion.selectedBucketIds.includes(matchedBucketId)
}

/**
 * Filter trades by regime criteria
 *
 * All enabled criteria are combined with AND logic:
 * - A trade must match ALL enabled criteria to be included
 * - If no criteria are enabled, all trades are returned
 *
 * @param trades - All trades to filter
 * @param config - Filter configuration with criteria
 * @param regimes - Map of regime ID to regime definition
 * @returns Trades that match ALL enabled criteria
 */
export function filterTradesByRegime(
  trades: Trade[],
  config: RegimeFilterConfig,
  regimes: Map<string, RegimeDefinition>
): Trade[] {
  const enabledCriteria = config.criteria.filter(c => c.enabled)

  // No enabled filters = return all trades
  if (enabledCriteria.length === 0) {
    return trades
  }

  return trades.filter(trade => {
    const derived = computeDerivedFields(trade)

    // ALL enabled criteria must match (AND logic)
    return enabledCriteria.every(criterion => {
      const regime = regimes.get(criterion.regimeId)
      if (!regime) return true // Unknown regime = no filter

      return tradeMatchesCriterion(trade, criterion, regime, derived)
    })
  })
}

/**
 * Result of filtering with additional metadata
 */
export interface FilterResult {
  filteredTrades: Trade[]
  excludedTrades: Trade[]
  matchCount: number
  totalCount: number
  matchPercent: number
}

/**
 * Filter trades and return both matching and non-matching sets
 */
export function filterTradesWithResult(
  trades: Trade[],
  config: RegimeFilterConfig,
  regimes: Map<string, RegimeDefinition>
): FilterResult {
  const enabledCriteria = config.criteria.filter(c => c.enabled)

  // No enabled filters = all trades match
  if (enabledCriteria.length === 0) {
    return {
      filteredTrades: trades,
      excludedTrades: [],
      matchCount: trades.length,
      totalCount: trades.length,
      matchPercent: 100
    }
  }

  const filteredTrades: Trade[] = []
  const excludedTrades: Trade[] = []

  trades.forEach(trade => {
    const derived = computeDerivedFields(trade)

    const matches = enabledCriteria.every(criterion => {
      const regime = regimes.get(criterion.regimeId)
      if (!regime) return true

      return tradeMatchesCriterion(trade, criterion, regime, derived)
    })

    if (matches) {
      filteredTrades.push(trade)
    } else {
      excludedTrades.push(trade)
    }
  })

  return {
    filteredTrades,
    excludedTrades,
    matchCount: filteredTrades.length,
    totalCount: trades.length,
    matchPercent: trades.length > 0
      ? (filteredTrades.length / trades.length) * 100
      : 0
  }
}

/**
 * Group trades by bucket within a regime
 * Returns a map of bucket ID to trades in that bucket
 */
export function groupTradesByBucket(
  trades: Trade[],
  regime: RegimeDefinition
): Map<string, Trade[]> {
  const groups = new Map<string, Trade[]>()

  // Initialize all buckets with empty arrays
  regime.buckets.forEach(bucket => {
    groups.set(bucket.id, [])
  })

  // Also track unmatched trades
  groups.set('_unmatched', [])

  trades.forEach(trade => {
    const derived = computeDerivedFields(trade)
    const bucketId = assignTradeToBucket(trade, regime, derived)

    if (bucketId && groups.has(bucketId)) {
      groups.get(bucketId)!.push(trade)
    } else {
      groups.get('_unmatched')!.push(trade)
    }
  })

  return groups
}

/**
 * Count trades per bucket within a regime
 * Useful for showing bucket counts in the filter UI
 */
export function countTradesPerBucket(
  trades: Trade[],
  regime: RegimeDefinition
): Map<string, number> {
  const counts = new Map<string, number>()

  // Initialize all buckets with zero
  regime.buckets.forEach(bucket => {
    counts.set(bucket.id, 0)
  })

  trades.forEach(trade => {
    const derived = computeDerivedFields(trade)
    const bucketId = assignTradeToBucket(trade, regime, derived)

    if (bucketId && counts.has(bucketId)) {
      counts.set(bucketId, counts.get(bucketId)! + 1)
    }
  })

  return counts
}
