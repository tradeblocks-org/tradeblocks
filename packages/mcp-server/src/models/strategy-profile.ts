/**
 * Strategy Profile Types
 *
 * TypeScript interfaces for strategy profiles stored in DuckDB.
 * Profiles capture the full definition of a trading strategy including
 * structure, greeks bias, legs, entry/exit rules, and performance benchmarks.
 */

export interface PositionSizing {
  method: string; // "pct_of_portfolio" | "fixed_contracts" | "fixed_dollar" | "discretionary"
  allocationPct?: number; // e.g., 2, 10
  maxContracts?: number; // hard cap per trade
  maxAllocationDollar?: number; // hard dollar cap per trade
  maxOpenPositions?: number; // concurrency limit
  description?: string; // free text for anything unusual
  backtestAllocationPct?: number; // allocation % used in backtest
  liveAllocationPct?: number; // allocation % used in live portfolio
  maxContractsPerTrade?: number; // per-entry cap (distinct from maxContracts hard cap)
}

export interface StrategyProfile {
  blockId: string;
  strategyName: string;
  structureType: string; // e.g., "iron_condor", "calendar_spread", "reverse_iron_condor"
  greeksBias: string; // e.g., "theta_positive", "vega_negative", "delta_neutral"
  thesis: string; // Free-text description of the strategy thesis
  legs: LegDetail[]; // Structured leg descriptions
  entryFilters: EntryFilter[]; // Conditions for entry
  exitRules: ExitRule[]; // Exit criteria
  expectedRegimes: string[]; // Market regimes this strategy targets
  keyMetrics: KeyMetrics; // Performance benchmarks
  positionSizing?: PositionSizing; // Per-block position sizing rules
  underlying?: string; // e.g., "SPX", "QQQ"
  reEntry?: boolean;
  capProfits?: boolean;
  capLosses?: boolean;
  requireTwoPricesPT?: boolean;
  closeOnCompletion?: boolean;
  ignoreMarginReq?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegDetail {
  type: string; // "long_put", "short_call", etc.
  strike: string; // Relative description: "ATM", "5-delta", "30-delta"
  expiry: string; // Relative: "same-day", "weekly", "45-DTE"
  quantity: number; // Positive = long, negative = short
  strikeMethod?: "delta" | "dollar_price" | "offset" | "percentage";
  strikeValue?: number; // numeric value (e.g., 25 for 25-delta, 3.50 for dollar_price)
}

export interface EntryFilter {
  field: string; // e.g., "VIX_Close", "RSI_14", "Vol_Regime"
  operator: string; // ">", "<", ">=", "<=", "==", "between", "in"
  value: string | number | (string | number)[];
  description?: string;
  source?: "market" | "execution"; // "market" = testable against market data, "execution" = OO/platform-level
}

export interface ExitRuleMonitoring {
  granularity?: "intra_minute" | "candle_close" | "end_of_bar";
  priceSource?: "nbbo" | "mid" | "last";
}

export interface ExitRule {
  type: string; // "stop_loss", "profit_target", "time_exit", "conditional"
  trigger: string; // e.g., "200% of credit", "50% of max profit", "15:00 ET"
  description?: string;
  stopLossType?: "percentage" | "dollar" | "sl_ratio" | "debit_percentage";
  stopLossValue?: number;
  monitoring?: ExitRuleMonitoring;
  slippage?: number; // per-rule slippage override
}

export interface KeyMetrics {
  expectedWinRate?: number; // 0-1
  targetPremium?: number; // Dollar amount
  maxLoss?: number; // Dollar amount per contract
  profitTarget?: number; // Dollar amount or percentage
  [key: string]: unknown; // Extensible for strategy-specific metrics
}

/**
 * Row type matching DuckDB column layout (for internal DB operations).
 * JSON columns are stored as strings, timestamps as Date objects.
 */
export interface StrategyProfileRow {
  block_id: string;
  strategy_name: string;
  structure_type: string;
  greeks_bias: string;
  thesis: string;
  legs: string; // JSON string
  entry_filters: string; // JSON string
  exit_rules: string; // JSON string
  expected_regimes: string; // JSON string
  key_metrics: string; // JSON string
  position_sizing: string; // JSON string
  underlying: string | null;
  re_entry: boolean | null;
  cap_profits: boolean | null;
  cap_losses: boolean | null;
  require_two_prices_pt: boolean | null;
  close_on_completion: boolean | null;
  ignore_margin_req: boolean | null;
  created_at: Date;
  updated_at: Date;
}
