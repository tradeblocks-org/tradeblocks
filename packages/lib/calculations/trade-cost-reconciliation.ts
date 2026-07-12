/**
 * Pure cost decomposition for an already-matched model/live trade pair.
 *
 * This module deliberately does not match trades, bind strategies, or read files.
 * Callers must establish the pair before invoking it.
 */

import type { ReportingTrade } from "../models/reporting-trade.ts";
import type { Trade } from "../models/trade.ts";

export type TradeCostScaling = "perContract" | "toActualContracts";

export interface TradeCostReconciliationOptions {
  /** Output basis. Defaults to the live trade's total contract count. */
  scaling?: TradeCostScaling;
  /** Absolute arithmetic tolerance in dollars. Defaults to 1e-9. */
  identityTolerance?: number;
}

export type TradeCostReconciliationUnavailableReason =
  | "invalid-scaling"
  | "missing-actual-closing-cost"
  | "invalid-model-contract-count"
  | "invalid-actual-contract-count"
  | "invalid-model-gross"
  | "invalid-actual-net"
  | "invalid-model-opening-fees"
  | "invalid-model-closing-fees"
  | "invalid-actual-initial-premium"
  | "invalid-actual-closing-cost"
  | "negative-model-fees"
  | "negative-inferred-actual-fees"
  | "invalid-identity-tolerance";

export interface TradeCostReconciliationUnavailable {
  available: false;
  reason: TradeCostReconciliationUnavailableReason;
  message: string;
}

export interface TradeCostReconciliationSide {
  /** Gross P/L before commissions and fees, in the selected output basis. */
  gross: number;
  /** Positive commissions and fees deducted from gross P/L. */
  fees: number;
  /** Net P/L after commissions and fees. */
  net: number;
}

export interface ActualTradeCostReconciliationSide {
  /** Gross P/L before inferred fees, in the selected output basis. */
  gross: number;
  /** Fees inferred as gross P/L minus the reporting log's net P/L. */
  inferredFees: number;
  /** Reporting-log net P/L after applying the selected output basis. */
  net: number;
}

export interface TradeCostReconciliationAvailable {
  available: true;
  scaling: {
    basis: TradeCostScaling;
    modelContracts: number;
    actualContracts: number;
    modelScaleFactor: number;
    actualScaleFactor: number;
  };
  model: TradeCostReconciliationSide;
  actual: ActualTradeCostReconciliationSide;
  residuals: {
    /** Actual gross P/L minus model gross P/L. */
    grossExecution: number;
    /** Actual inferred fees minus model commissions and fees. */
    fees: number;
    /** Actual net P/L minus model net P/L. */
    net: number;
  };
  arithmeticIdentity: {
    /** grossExecution - fees; this must equal the observed net residual. */
    derivedNetDelta: number;
    observedNetDelta: number;
    error: number;
    tolerance: number;
    holds: boolean;
  };
}

export type TradeCostReconciliation =
  | TradeCostReconciliationAvailable
  | TradeCostReconciliationUnavailable;

function unavailable(
  reason: TradeCostReconciliationUnavailableReason,
  message: string,
): TradeCostReconciliationUnavailable {
  return { available: false, reason, message };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decompose model-vs-live P/L for a pair that the caller has already matched.
 *
 * Trade.pl is the model's gross P/L (the same invariant used by enrichTrades),
 * so model net is gross minus recorded commissions/fees. Actual gross is
 * reconstructed from the reporting log's opening premium and average closing cost:
 * `(initialPremium + avgClosingCost) * contracts * 100`.
 */
export function reconcileTradeCosts(
  model: Trade,
  actual: ReportingTrade,
  options: TradeCostReconciliationOptions = {},
): TradeCostReconciliation {
  const basis = options.scaling ?? "toActualContracts";
  const tolerance = options.identityTolerance ?? 1e-9;

  if (basis !== "perContract" && basis !== "toActualContracts") {
    return unavailable(
      "invalid-scaling",
      'scaling must be either "perContract" or "toActualContracts"',
    );
  }
  if (!isFiniteNumber(tolerance) || tolerance < 0) {
    return unavailable(
      "invalid-identity-tolerance",
      "identityTolerance must be a finite, non-negative number",
    );
  }
  if (!isFiniteNumber(model.numContracts) || model.numContracts <= 0) {
    return unavailable(
      "invalid-model-contract-count",
      "Model contract count must be finite and greater than zero",
    );
  }
  if (!isFiniteNumber(actual.numContracts) || actual.numContracts <= 0) {
    return unavailable(
      "invalid-actual-contract-count",
      "Actual contract count must be finite and greater than zero",
    );
  }
  if (!isFiniteNumber(model.pl)) {
    return unavailable("invalid-model-gross", "Model gross P/L must be finite");
  }
  if (!isFiniteNumber(actual.pl)) {
    return unavailable("invalid-actual-net", "Actual P/L must be finite");
  }
  if (!isFiniteNumber(model.openingCommissionsFees)) {
    return unavailable(
      "invalid-model-opening-fees",
      "Model opening commissions and fees must be finite",
    );
  }
  if (!isFiniteNumber(model.closingCommissionsFees)) {
    return unavailable(
      "invalid-model-closing-fees",
      "Model closing commissions and fees must be finite",
    );
  }
  if (!isFiniteNumber(actual.initialPremium)) {
    return unavailable("invalid-actual-initial-premium", "Actual initial premium must be finite");
  }
  if (actual.avgClosingCost === undefined || actual.avgClosingCost === null) {
    return unavailable(
      "missing-actual-closing-cost",
      "Actual average closing cost is required for cost reconciliation",
    );
  }
  if (!isFiniteNumber(actual.avgClosingCost)) {
    return unavailable("invalid-actual-closing-cost", "Actual average closing cost must be finite");
  }

  const modelFeesTotal = model.openingCommissionsFees + model.closingCommissionsFees;
  if (!isFiniteNumber(modelFeesTotal) || modelFeesTotal < 0) {
    return unavailable(
      "negative-model-fees",
      "Model commissions and fees must sum to a finite, non-negative value",
    );
  }

  const actualGrossTotal =
    (actual.initialPremium + actual.avgClosingCost) * actual.numContracts * 100;
  const actualFeesTotal = actualGrossTotal - actual.pl;
  if (!isFiniteNumber(actualGrossTotal) || !isFiniteNumber(actualFeesTotal)) {
    return unavailable(
      "invalid-actual-closing-cost",
      "Actual gross P/L and inferred fees must be finite",
    );
  }
  if (actualFeesTotal < 0) {
    return unavailable(
      "negative-inferred-actual-fees",
      "Actual gross P/L is less than reported net P/L, producing negative inferred fees",
    );
  }

  const modelScaleFactor =
    basis === "perContract" ? 1 / model.numContracts : actual.numContracts / model.numContracts;
  const actualScaleFactor = basis === "perContract" ? 1 / actual.numContracts : 1;

  const modelGross = model.pl * modelScaleFactor;
  const modelFees = modelFeesTotal * modelScaleFactor;
  const modelNet = modelGross - modelFees;
  const actualGross = actualGrossTotal * actualScaleFactor;
  const actualFees = actualFeesTotal * actualScaleFactor;
  const actualNet = actual.pl * actualScaleFactor;

  const grossExecutionResidual = actualGross - modelGross;
  const feeResidual = actualFees - modelFees;
  const netDelta = actualNet - modelNet;
  const derivedNetDelta = grossExecutionResidual - feeResidual;
  const identityError = netDelta - derivedNetDelta;

  return {
    available: true,
    scaling: {
      basis,
      modelContracts: model.numContracts,
      actualContracts: actual.numContracts,
      modelScaleFactor,
      actualScaleFactor,
    },
    model: {
      gross: modelGross,
      fees: modelFees,
      net: modelNet,
    },
    actual: {
      gross: actualGross,
      inferredFees: actualFees,
      net: actualNet,
    },
    residuals: {
      grossExecution: grossExecutionResidual,
      fees: feeResidual,
      net: netDelta,
    },
    arithmeticIdentity: {
      derivedNetDelta,
      observedNetDelta: netDelta,
      error: identityError,
      tolerance,
      holds: Math.abs(identityError) <= tolerance,
    },
  };
}
