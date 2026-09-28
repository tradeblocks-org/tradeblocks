import type { Trade } from "../models/trade.ts";

function getNormalizedContractCount(trade: Trade): number {
  const contracts =
    typeof trade.numContracts === "number" && isFinite(trade.numContracts)
      ? Math.abs(trade.numContracts)
      : 0;

  return contracts > 0 ? contracts : 1;
}

export function computeTotalPremium(trade: Trade): number | undefined {
  if (typeof trade.premium !== "number" || !isFinite(trade.premium)) {
    return undefined;
  }

  const total = Math.abs(trade.premium) * getNormalizedContractCount(trade);
  return isFinite(total) && total > 0 ? total : undefined;
}

/**
 * Computes total MFE (Maximum Favorable Excursion) in dollars.
 * OptionOmega exports maxProfit as a percentage of initial premium.
 */
export function computeTotalMaxProfit(trade: Trade): number | undefined {
  if (typeof trade.maxProfit !== "number" || !isFinite(trade.maxProfit) || trade.maxProfit === 0) {
    return undefined;
  }

  const totalPremium = computeTotalPremium(trade);
  if (!totalPremium || totalPremium <= 0) {
    return undefined;
  }

  // maxProfit is a percentage (e.g., 18.67 means 18.67% of initial premium)
  const mfe = (Math.abs(trade.maxProfit) / 100) * totalPremium;
  return isFinite(mfe) && mfe > 0 ? mfe : undefined;
}

/**
 * Computes total MAE (Maximum Adverse Excursion) in dollars.
 * OptionOmega exports maxLoss as a percentage of initial premium.
 */
export function computeTotalMaxLoss(trade: Trade): number | undefined {
  if (typeof trade.maxLoss !== "number" || !isFinite(trade.maxLoss) || trade.maxLoss === 0) {
    return undefined;
  }

  const totalPremium = computeTotalPremium(trade);
  if (!totalPremium || totalPremium <= 0) {
    return undefined;
  }

  // maxLoss is a percentage (e.g., -12.65 means 12.65% loss of initial premium)
  const mae = (Math.abs(trade.maxLoss) / 100) * totalPremium;
  return isFinite(mae) && mae > 0 ? mae : undefined;
}

export type EfficiencyBasis = "premium" | "maxProfit" | "margin" | "unknown";

export interface PremiumEfficiencyResult {
  percentage?: number;
  denominator?: number;
  basis: EfficiencyBasis;
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
  const totalPremium = computeTotalPremium(trade);
  const totalMaxProfit = computeTotalMaxProfit(trade);
  const margin =
    typeof trade.marginReq === "number" && isFinite(trade.marginReq) && trade.marginReq !== 0
      ? Math.abs(trade.marginReq)
      : undefined;

  let denominator: number | undefined;
  let basis: EfficiencyBasis = "unknown";

  if (totalPremium && totalPremium > 0) {
    denominator = totalPremium;
    basis = "premium";
  } else if (totalMaxProfit && totalMaxProfit > 0) {
    denominator = totalMaxProfit;
    basis = "maxProfit";
  } else if (margin && margin > 0) {
    denominator = margin;
    basis = "margin";
  }

  if (!denominator || denominator === 0) {
    return { basis };
  }

  const percentage = (trade.pl / denominator) * 100;

  if (!isFinite(percentage)) {
    return { basis };
  }

  return {
    percentage,
    denominator,
    basis,
  };
}
