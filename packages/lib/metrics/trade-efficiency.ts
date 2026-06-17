import type { Trade } from '../models/trade.ts'

/**
 * Standard options multiplier used to convert per-contract values into notional dollars.
 * Equity and index option contracts typically control 100 shares, so premium/max profit
 * values need to be scaled by 100 to reflect the total economic exposure.
 */
const OPTION_CONTRACT_MULTIPLIER = 100

/**
 * Margin-to-notional ratio threshold that indicates a trade is lightly margined.
 * When gross notional is less than 50% of the posted margin requirement we treat
 * the trade as an option-style structure and apply the contract multiplier.
 */
const MARGIN_RATIO_THRESHOLD = 0.5

/**
 * Notional dollar threshold under which trades are considered "small". These trades
 * likely represent single-lot option structures, so we apply the option multiplier
 * even if there is no explicit margin requirement to compare against.
 */
const SMALL_NOTIONAL_THRESHOLD = 5_000

function getNormalizedContractCount(trade: Trade): number {
  const contracts = typeof trade.numContracts === 'number' && isFinite(trade.numContracts)
    ? Math.abs(trade.numContracts)
    : 0

  return contracts > 0 ? contracts : 1
}

function applyOptionMultiplierIfNeeded(total: number, trade: Trade): number {
  if (!isFinite(total) || total <= 0) {
    return total
  }

  const margin = typeof trade.marginReq === 'number' && isFinite(trade.marginReq)
    ? Math.abs(trade.marginReq)
    : undefined

  if (margin && margin > 0) {
    const ratio = total / margin
    if (ratio > 0 && ratio < MARGIN_RATIO_THRESHOLD) {
      return total * OPTION_CONTRACT_MULTIPLIER
    }
    return total
  }

  if (total < SMALL_NOTIONAL_THRESHOLD) {
    return total * OPTION_CONTRACT_MULTIPLIER
  }

  return total
}

function normalisePerContractValue(value: number, trade: Trade, isPremium: boolean): number {
  const contracts = getNormalizedContractCount(trade)
  let base = Math.abs(value)

  if (isPremium && trade.premiumPrecision === 'cents') {
    base = base / 100
  }

  const total = base * contracts
  return applyOptionMultiplierIfNeeded(total, trade)
}

export function computeTotalPremium(trade: Trade): number | undefined {
  if (typeof trade.premium !== 'number' || !isFinite(trade.premium)) {
    return undefined
  }

  const total = normalisePerContractValue(Math.abs(trade.premium), trade, true)
  return isFinite(total) && total > 0 ? total : undefined
}

/**
 * Computes total MFE (Maximum Favorable Excursion) in dollars.
 * OptionOmega exports maxProfit as a percentage of initial premium.
 */
export function computeTotalMaxProfit(trade: Trade): number | undefined {
  if (typeof trade.maxProfit !== 'number' || !isFinite(trade.maxProfit) || trade.maxProfit === 0) {
    return undefined
  }

  const totalPremium = computeTotalPremium(trade)
  if (!totalPremium || totalPremium <= 0) {
    return undefined
  }

  // maxProfit is a percentage (e.g., 18.67 means 18.67% of initial premium)
  const mfe = (Math.abs(trade.maxProfit) / 100) * totalPremium
  return isFinite(mfe) && mfe > 0 ? mfe : undefined
}

/**
 * Computes total MAE (Maximum Adverse Excursion) in dollars.
 * OptionOmega exports maxLoss as a percentage of initial premium.
 */
export function computeTotalMaxLoss(trade: Trade): number | undefined {
  if (typeof trade.maxLoss !== 'number' || !isFinite(trade.maxLoss) || trade.maxLoss === 0) {
    return undefined
  }

  const totalPremium = computeTotalPremium(trade)
  if (!totalPremium || totalPremium <= 0) {
    return undefined
  }

  // maxLoss is a percentage (e.g., -12.65 means 12.65% loss of initial premium)
  const mae = (Math.abs(trade.maxLoss) / 100) * totalPremium
  return isFinite(mae) && mae > 0 ? mae : undefined
}

export type EfficiencyBasis = 'premium' | 'maxProfit' | 'margin' | 'unknown'

export interface PremiumEfficiencyResult {
  percentage?: number
  denominator?: number
  basis: EfficiencyBasis
}

/**
 * Calculates a trade's premium efficiency percentage.
 *
 * The function searches for the most appropriate denominator to express trade performance:
 * 1. Total premium collected (preferred when available)
 * 2. Total maximum profit
 * 3. Margin requirement
 *
 * Once a denominator is selected, it normalizes the trade's P/L against that value to
 * compute an efficiency percentage. If no denominator can be derived or the resulting
 * ratio is not finite, only the basis is reported.
 *
 * @param trade Trade record including premium, max profit, margin requirement, and P/L.
 * @returns Object describing the efficiency percentage, denominator, and basis used.
 */
export function calculatePremiumEfficiencyPercent(trade: Trade): PremiumEfficiencyResult {
  const totalPremium = computeTotalPremium(trade)
  const totalMaxProfit = computeTotalMaxProfit(trade)
  const margin = typeof trade.marginReq === 'number' && isFinite(trade.marginReq) && trade.marginReq !== 0
    ? Math.abs(trade.marginReq)
    : undefined

  let denominator: number | undefined
  let basis: EfficiencyBasis = 'unknown'

  if (totalPremium && totalPremium > 0) {
    denominator = totalPremium
    basis = 'premium'
  } else if (totalMaxProfit && totalMaxProfit > 0) {
    denominator = totalMaxProfit
    basis = 'maxProfit'
  } else if (margin && margin > 0) {
    denominator = margin
    basis = 'margin'
  }

  if (!denominator || denominator === 0) {
    return { basis }
  }

  const percentage = (trade.pl / denominator) * 100

  if (!isFinite(percentage)) {
    return { basis }
  }

  return {
    percentage,
    denominator,
    basis
  }
}
