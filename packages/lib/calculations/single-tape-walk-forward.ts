import type { Trade } from "../models/trade.ts";
import type { WalkForwardConfig } from "../models/walk-forward.ts";
import { WalkForwardAnalyzer } from "./walk-forward-analyzer.ts";
import { assessResults, getRecommendedParameters } from "./walk-forward-verdict.ts";
import { formatDateKey } from "./trade-matching.ts";

// Analyzer windows are UTC-midnight calendar sentinels; reconstruct local calendar
// values before formatting rather than treating the sentinel as a market instant.
function windowDateKey(date: Date): string {
  return formatDateKey(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Sizing and strategy-weight sweep on one realized trade tape, not a marked portfolio replay. */
export async function singleTapeWalkForwardByTrades(
  trades: Trade[],
  options: Omit<WalkForwardConfig, "inSampleDays" | "outOfSampleDays" | "stepSizeDays"> & {
    isWindowCount: number;
    oosWindowCount: number;
    inSampleDays?: number;
    outOfSampleDays?: number;
    stepSizeDays?: number;
  },
) {
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
  );
  // Calendar-day distance is independent of the host's daylight-saving shifts.
  const first = sortedTrades[0] && new Date(sortedTrades[0].dateOpened);
  const last =
    sortedTrades.length > 1 && new Date(sortedTrades[sortedTrades.length - 1].dateOpened);
  const totalDays =
    first && last
      ? (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) -
          Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) /
        86400000
      : 0;
  let inSampleDays: number;
  let outOfSampleDays: number;
  let stepSizeDays: number;
  if (options.inSampleDays !== undefined && options.outOfSampleDays !== undefined) {
    inSampleDays = options.inSampleDays;
    outOfSampleDays = options.outOfSampleDays;
    stepSizeDays = options.stepSizeDays ?? outOfSampleDays;
  } else {
    const daysPerWindow = Math.floor(totalDays / (options.isWindowCount + options.oosWindowCount));
    inSampleDays = daysPerWindow * options.isWindowCount;
    outOfSampleDays = daysPerWindow * options.oosWindowCount;
    stepSizeDays = options.stepSizeDays ?? daysPerWindow;
  }
  const { isWindowCount: _isWindowCount, oosWindowCount: _oosWindowCount, ...settings } = options;
  const config: WalkForwardConfig = { ...settings, inSampleDays, outOfSampleDays, stepSizeDays };
  const computation = await new WalkForwardAnalyzer().analyze({ trades, config });
  return {
    computation,
    config,
    verdict: assessResults(computation.results),
    recommended: getRecommendedParameters(computation.results.periods),
    periods: computation.results.periods.map((period) => ({
      inSampleStart: windowDateKey(period.inSampleStart),
      inSampleEnd: windowDateKey(period.inSampleEnd),
      outOfSampleStart: windowDateKey(period.outOfSampleStart),
      outOfSampleEnd: windowDateKey(period.outOfSampleEnd),
      targetMetricInSample: period.targetMetricInSample,
      targetMetricOutOfSample: period.targetMetricOutOfSample,
      diversificationMetrics: period.diversificationMetrics ?? null,
    })),
  };
}
