/**
 * Mapping between reporting strategies (backtests) and live strategies (trade log)
 * used for comparison workflows.
 */
export interface StrategyAlignment {
  id: string;
  reportingStrategies: string[];
  liveStrategies: string[];
  note?: string;
  createdAt: Date;
  updatedAt: Date;
  matchOverrides?: MatchOverrides;
}

export interface MatchOverrides {
  selectedBacktestedIds: string[];
  selectedReportedIds: string[];
  tradePairs?: TradePair[];
}

export interface TradePair {
  backtestedId: string;
  reportedId: string;
  manual: boolean; // true if user created, false if auto-matched
}
