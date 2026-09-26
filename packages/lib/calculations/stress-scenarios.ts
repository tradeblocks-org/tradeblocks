import type { Trade } from "../models/trade.ts";
import { PortfolioStatsCalculator } from "./portfolio-stats.ts";
import { formatDateKey } from "./trade-matching.ts";

/**
 * Stress Test Scenarios
 *
 * Built-in market stress scenarios for stress_test tool.
 * All scenarios are post-2013 since backtests typically start there.
 */

/**
 * Built-in stress scenarios with date ranges and descriptions
 */
export const STRESS_SCENARIOS: Record<
  string,
  { startDate: string; endDate: string; description: string }
> = {
  // Crashes & Corrections
  china_deval_2015: {
    startDate: "2015-08-11",
    endDate: "2015-08-25",
    description: "China yuan devaluation, global selloff",
  },
  brexit: {
    startDate: "2016-06-23",
    endDate: "2016-06-27",
    description: "UK Brexit vote shock",
  },
  volmageddon: {
    startDate: "2018-02-02",
    endDate: "2018-02-09",
    description: "VIX spike, XIV blowup, largest VIX jump since 1987",
  },
  q4_2018: {
    startDate: "2018-10-01",
    endDate: "2018-12-24",
    description: "Fed rate hike selloff",
  },
  covid_crash: {
    startDate: "2020-02-19",
    endDate: "2020-03-23",
    description: "COVID-19 pandemic crash, peak to trough",
  },
  bear_2022: {
    startDate: "2022-01-03",
    endDate: "2022-10-12",
    description: "Fed tightening bear market",
  },
  svb_crisis: {
    startDate: "2023-03-08",
    endDate: "2023-03-15",
    description: "Silicon Valley Bank collapse, regional bank contagion",
  },
  vix_aug_2024: {
    startDate: "2024-08-01",
    endDate: "2024-08-15",
    description: "Yen carry trade unwind, VIX spike",
  },
  liberation_day: {
    startDate: "2025-04-02",
    endDate: "2025-04-08",
    description: "Trump tariffs, largest drop since COVID",
  },
  // Recoveries
  covid_recovery: {
    startDate: "2020-03-23",
    endDate: "2020-08-18",
    description: "V-shaped recovery from COVID crash",
  },
  liberation_recovery: {
    startDate: "2025-04-09",
    endDate: "2025-05-02",
    description: "Post 90-day tariff pause rally, S&P +9.5% single day",
  },
};

/** Calculate trade-realized stress outcomes for selected built-in or custom date intervals. */
export function buildRealizedStressScenarios(
  trades: Trade[],
  scenariosToRun: Array<{
    name: string;
    startDate: string;
    endDate: string;
    description: string;
    isCustom: boolean;
  }>,
  includeEmpty: boolean,
  preFilteredScenarioNames: string[],
  portfolioDateRange: { start: string | null; end: string | null },
) {
  const calculator = new PortfolioStatsCalculator();
  const { start: portfolioStartDate, end: portfolioEndDate } = portfolioDateRange;
  // Calculate stats for each scenario
  type ScenarioStats = {
    netPl: number;
    winRate: number;
    maxDrawdown: number;
    profitFactor: number | null;
    avgWin: number | null;
    avgLoss: number | null;
  };
  const scenarioResults: Array<{
    name: string;
    description: string;
    dateRange: { start: string; end: string };
    tradeCount: number;
    stats: ScenarioStats | null;
    isCustom: boolean;
    noCoverage?: boolean;
  }> = [];

  let worstScenario: { name: string; netPl: number } | null = null;
  let bestScenario: { name: string; netPl: number } | null = null;
  let scenariosWithTrades = 0;
  let scenariosSkipped = 0;
  const skippedScenarioNames: string[] = [];

  for (const scenario of scenariosToRun) {
    // Calendar-date filtering is inclusive; malformed custom bounds are ignored.
    const start = /^\d{4}-\d{2}-\d{2}$/.test(scenario.startDate) ? scenario.startDate : undefined;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(scenario.endDate) ? scenario.endDate : undefined;
    const scenarioTrades = trades.filter((trade) => {
      const date = formatDateKey(new Date(trade.dateClosed ?? trade.dateOpened));
      return (!start || date >= start) && (!end || date <= end);
    });

    if (scenarioTrades.length === 0) {
      // Genuine coverage gap (had date overlap but zero trades)
      scenariosSkipped++;
      skippedScenarioNames.push(scenario.name);
      if (includeEmpty) {
        scenarioResults.push({
          name: scenario.name,
          description: scenario.description,
          dateRange: { start: scenario.startDate, end: scenario.endDate },
          tradeCount: 0,
          stats: null,
          isCustom: scenario.isCustom,
          noCoverage: true,
        });
      }
    } else {
      // Calculate trade-based stats (no daily logs per constraining decision)
      const stats = calculator.calculatePortfolioStats(
        scenarioTrades,
        undefined, // No daily logs
        true, // Force trade-based calculations
      );

      scenarioResults.push({
        name: scenario.name,
        description: scenario.description,
        dateRange: { start: scenario.startDate, end: scenario.endDate },
        tradeCount: scenarioTrades.length,
        stats: {
          netPl: stats.netPl,
          winRate: stats.winRate,
          maxDrawdown: stats.maxDrawdown,
          profitFactor: stats.profitFactor,
          avgWin: stats.avgWin,
          avgLoss: stats.avgLoss,
        },
        isCustom: scenario.isCustom,
      });

      scenariosWithTrades++;

      // Track best/worst scenarios
      if (worstScenario === null || stats.netPl < worstScenario.netPl) {
        worstScenario = { name: scenario.name, netPl: stats.netPl };
      }
      if (bestScenario === null || stats.netPl > bestScenario.netPl) {
        bestScenario = { name: scenario.name, netPl: stats.netPl };
      }
    }
  }

  // Build summary
  const summaryData = {
    totalScenariosTested: scenariosToRun.length,
    scenariosWithTrades,
    scenariosSkipped,
    ...(skippedScenarioNames.length > 0 ? { skippedScenarios: skippedScenarioNames } : {}),
    ...(preFilteredScenarioNames.length > 0
      ? { preFilteredScenarios: preFilteredScenarioNames }
      : {}),
    worstScenario: worstScenario?.name ?? null,
    bestScenario: bestScenario?.name ?? null,
    portfolioDateRange: {
      start: portfolioStartDate,
      end: portfolioEndDate,
    },
  };
  return {
    scenarioResults,
    summaryData,
    worstScenario,
    bestScenario,
    scenariosWithTrades,
    scenariosSkipped,
  };
}
