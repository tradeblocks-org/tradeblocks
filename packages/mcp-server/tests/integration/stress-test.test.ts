/**
 * Integration tests for stress_test MCP tool
 *
 * Tests historical scenario analysis with built-in and custom scenarios.
 * Uses test fixture: stress-test-block with trades spanning COVID crash, 2022 bear, and VIX Aug 2024.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import from built bundle (test-exports.js has @lib dependencies bundled)
// @ts-expect-error - importing from bundled output
import { loadBlock } from '../../src/test-exports.ts';

// @ts-expect-error - importing from bundled output
import { PortfolioStatsCalculator } from '../../src/test-exports.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Define built-in scenarios (must match tool implementation)
const STRESS_SCENARIOS: Record<
  string,
  { startDate: string; endDate: string; description: string }
> = {
  china_deval_2015: {
    startDate: '2015-08-11',
    endDate: '2015-08-25',
    description: 'China yuan devaluation, global selloff',
  },
  brexit: {
    startDate: '2016-06-23',
    endDate: '2016-06-27',
    description: 'UK Brexit vote shock',
  },
  volmageddon: {
    startDate: '2018-02-02',
    endDate: '2018-02-09',
    description: 'VIX spike, XIV blowup, largest VIX jump since 1987',
  },
  q4_2018: {
    startDate: '2018-10-01',
    endDate: '2018-12-24',
    description: 'Fed rate hike selloff',
  },
  covid_crash: {
    startDate: '2020-02-19',
    endDate: '2020-03-23',
    description: 'COVID-19 pandemic crash, peak to trough',
  },
  bear_2022: {
    startDate: '2022-01-03',
    endDate: '2022-10-12',
    description: 'Fed tightening bear market',
  },
  svb_crisis: {
    startDate: '2023-03-08',
    endDate: '2023-03-15',
    description: 'Silicon Valley Bank collapse, regional bank contagion',
  },
  vix_aug_2024: {
    startDate: '2024-08-01',
    endDate: '2024-08-15',
    description: 'Yen carry trade unwind, VIX spike',
  },
  liberation_day: {
    startDate: '2025-04-02',
    endDate: '2025-04-08',
    description: 'Trump tariffs, largest drop since COVID',
  },
  covid_recovery: {
    startDate: '2020-03-23',
    endDate: '2020-08-18',
    description: 'V-shaped recovery from COVID crash',
  },
  liberation_recovery: {
    startDate: '2025-04-09',
    endDate: '2025-05-02',
    description: 'Post 90-day tariff pause rally, S&P +9.5% single day',
  },
};

/**
 * Filter trades by date range (mirrors tool implementation)
 */
function filterByDateRange(
  trades: Array<{ dateOpened: Date }>,
  startDate?: string,
  endDate?: string
) {
  let filtered = trades;
  if (startDate) {
    const start = new Date(startDate);
    filtered = filtered.filter((t) => new Date(t.dateOpened) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filtered = filtered.filter((t) => new Date(t.dateOpened) <= end);
  }
  return filtered;
}

/**
 * Simulates the stress_test tool logic for testing
 * This mirrors the tool implementation to verify expected outputs
 */
async function simulateStressTest(
  baseDir: string,
  blockId: string,
  options: {
    scenarios?: string[];
    customScenarios?: Array<{ name: string; startDate: string; endDate: string }>;
  } = {}
) {
  const calculator = new PortfolioStatsCalculator();
  const block = await loadBlock(baseDir, blockId);
  const trades = block.trades;

  // Build list of scenarios to run
  const scenariosToRun: Array<{
    name: string;
    startDate: string;
    endDate: string;
    description: string;
    isCustom: boolean;
  }> = [];

  // Add built-in scenarios
  if (options.scenarios && options.scenarios.length > 0) {
    for (const scenarioName of options.scenarios) {
      const scenario = STRESS_SCENARIOS[scenarioName];
      if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioName}`);
      }
      scenariosToRun.push({
        name: scenarioName,
        ...scenario,
        isCustom: false,
      });
    }
  } else if (!options.customScenarios || options.customScenarios.length === 0) {
    // Run all built-in scenarios only if no custom scenarios specified
    for (const [name, scenario] of Object.entries(STRESS_SCENARIOS)) {
      scenariosToRun.push({
        name,
        ...scenario,
        isCustom: false,
      });
    }
  }

  // Add custom scenarios
  if (options.customScenarios && options.customScenarios.length > 0) {
    for (const custom of options.customScenarios) {
      scenariosToRun.push({
        name: custom.name,
        startDate: custom.startDate,
        endDate: custom.endDate,
        description: `Custom scenario: ${custom.startDate} to ${custom.endDate}`,
        isCustom: true,
      });
    }
  }

  // Calculate stats for each scenario
  interface ScenarioResult {
    name: string;
    description: string;
    dateRange: { start: string; end: string };
    tradeCount: number;
    stats: {
      netPl: number;
      winRate: number;
      maxDrawdown: number;
    } | null;
    isCustom: boolean;
  }

  const scenarioResults: ScenarioResult[] = [];

  let worstScenario: { name: string; netPl: number } | null = null;
  let bestScenario: { name: string; netPl: number } | null = null;
  let scenariosWithTrades = 0;

  for (const scenario of scenariosToRun) {
    const scenarioTrades = filterByDateRange(
      trades,
      scenario.startDate,
      scenario.endDate
    );

    if (scenarioTrades.length === 0) {
      scenarioResults.push({
        name: scenario.name,
        description: scenario.description,
        dateRange: { start: scenario.startDate, end: scenario.endDate },
        tradeCount: 0,
        stats: null,
        isCustom: scenario.isCustom,
      });
    } else {
      const stats = calculator.calculatePortfolioStats(
        scenarioTrades,
        undefined,
        true
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
        },
        isCustom: scenario.isCustom,
      });

      scenariosWithTrades++;

      if (worstScenario === null || stats.netPl < worstScenario.netPl) {
        worstScenario = { name: scenario.name, netPl: stats.netPl };
      }
      if (bestScenario === null || stats.netPl > bestScenario.netPl) {
        bestScenario = { name: scenario.name, netPl: stats.netPl };
      }
    }
  }

  return {
    blockId,
    scenarios: scenarioResults,
    summary: {
      totalScenarios: scenarioResults.length,
      scenariosWithTrades,
      worstScenario: worstScenario?.name ?? null,
      bestScenario: bestScenario?.name ?? null,
    },
    availableBuiltInScenarios: Object.keys(STRESS_SCENARIOS),
  };
}

describe('stress_test', () => {
  describe('built-in scenarios', () => {
    it('should return all 11 built-in scenarios by default', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block');

      expect(result.scenarios.length).toBe(11);
      expect(result.availableBuiltInScenarios).toHaveLength(11);
      expect(result.availableBuiltInScenarios).toContain('covid_crash');
      expect(result.availableBuiltInScenarios).toContain('bear_2022');
      expect(result.availableBuiltInScenarios).toContain('vix_aug_2024');
    });

    it('should return specific scenarios when requested', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['covid_crash', 'bear_2022'],
      });

      expect(result.scenarios.length).toBe(2);
      expect(result.scenarios[0].name).toBe('covid_crash');
      expect(result.scenarios[1].name).toBe('bear_2022');
    });

    it('should throw error for non-existent scenario', async () => {
      await expect(
        simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
          scenarios: ['fake_scenario'],
        })
      ).rejects.toThrow('Unknown scenario: fake_scenario');
    });
  });

  describe('custom scenarios', () => {
    it('should handle custom scenarios with user-defined dates', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        customScenarios: [
          { name: 'q1_2024', startDate: '2024-01-01', endDate: '2024-03-31' },
        ],
      });

      // Should only have the custom scenario
      expect(result.scenarios.length).toBe(1);
      expect(result.scenarios[0].name).toBe('q1_2024');
      expect(result.scenarios[0].isCustom).toBe(true);
      expect(result.scenarios[0].dateRange.start).toBe('2024-01-01');
      expect(result.scenarios[0].dateRange.end).toBe('2024-03-31');
    });

    it('should mix built-in and custom scenarios correctly', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['covid_crash'],
        customScenarios: [
          { name: 'custom_period', startDate: '2024-01-01', endDate: '2024-06-30' },
        ],
      });

      expect(result.scenarios.length).toBe(2);

      const covidScenario = result.scenarios.find((s) => s.name === 'covid_crash');
      const customScenario = result.scenarios.find((s) => s.name === 'custom_period');

      expect(covidScenario).toBeDefined();
      expect(covidScenario?.isCustom).toBe(false);

      expect(customScenario).toBeDefined();
      expect(customScenario?.isCustom).toBe(true);
    });
  });

  describe('scenario statistics', () => {
    it('should return null stats for scenarios with no trades', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['brexit'], // No trades in Jun 2016
      });

      expect(result.scenarios[0].tradeCount).toBe(0);
      expect(result.scenarios[0].stats).toBeNull();
    });

    it('should correctly calculate stats for COVID crash scenario', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['covid_crash'],
      });

      const scenario = result.scenarios[0];

      // stress-test-block has 3 trades in COVID period (Feb 24, Mar 6, Mar 18)
      expect(scenario.tradeCount).toBe(3);
      expect(scenario.stats).not.toBeNull();

      // Verify stats are calculated (exact values depend on trade data)
      expect(typeof scenario.stats?.netPl).toBe('number');
      expect(typeof scenario.stats?.winRate).toBe('number');
      expect(typeof scenario.stats?.maxDrawdown).toBe('number');
    });

    it('should correctly calculate stats for 2022 bear market scenario', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['bear_2022'],
      });

      const scenario = result.scenarios[0];

      // stress-test-block has 3 trades in 2022 bear period (Jan 24, Jun 13, Sep 26)
      expect(scenario.tradeCount).toBe(3);
      expect(scenario.stats).not.toBeNull();
    });

    it('should correctly calculate stats for VIX Aug 2024 scenario', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['vix_aug_2024'],
      });

      const scenario = result.scenarios[0];

      // stress-test-block has 2 trades in VIX Aug 2024 period (Aug 5, Aug 8)
      expect(scenario.tradeCount).toBe(2);
      expect(scenario.stats).not.toBeNull();
    });
  });

  describe('summary statistics', () => {
    it('should identify worst and best scenarios correctly', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['covid_crash', 'bear_2022', 'vix_aug_2024'],
      });

      // Should have best/worst identified (only scenarios with trades)
      expect(result.summary.worstScenario).not.toBeNull();
      expect(result.summary.bestScenario).not.toBeNull();

      // Find the actual P/L values to verify
      const scenariosByPl = result.scenarios
        .filter((s) => s.stats !== null)
        .sort((a, b) => (a.stats?.netPl ?? 0) - (b.stats?.netPl ?? 0));

      expect(result.summary.worstScenario).toBe(scenariosByPl[0].name);
      expect(result.summary.bestScenario).toBe(scenariosByPl[scenariosByPl.length - 1].name);
    });

    it('should count scenarios with trades correctly', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['covid_crash', 'brexit', 'bear_2022'],
      });

      // COVID crash and bear_2022 have trades, brexit does not
      expect(result.summary.totalScenarios).toBe(3);
      expect(result.summary.scenariosWithTrades).toBe(2);
    });

    it('should handle all scenarios with no trades', async () => {
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        scenarios: ['brexit', 'volmageddon'], // Neither have trades in fixture
      });

      expect(result.summary.scenariosWithTrades).toBe(0);
      expect(result.summary.worstScenario).toBeNull();
      expect(result.summary.bestScenario).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle non-existent block gracefully', async () => {
      await expect(
        simulateStressTest(FIXTURES_DIR, 'non-existent-block')
      ).rejects.toThrow();
    });

    it('should handle block with no trades in any scenario', async () => {
      // mock-block has trades in 2024-01 which doesn't overlap with most scenarios
      const result = await simulateStressTest(FIXTURES_DIR, 'mock-block', {
        scenarios: ['covid_crash', 'bear_2022'],
      });

      // mock-block has no trades in these scenarios
      expect(result.summary.scenariosWithTrades).toBe(0);
      result.scenarios.forEach((s) => {
        expect(s.tradeCount).toBe(0);
        expect(s.stats).toBeNull();
      });
    });

    it('should correctly filter trades to date range', async () => {
      // Create a custom scenario that includes trades in mid-January 2024
      // (Using wider range to avoid timezone boundary issues)
      const result = await simulateStressTest(FIXTURES_DIR, 'stress-test-block', {
        customScenarios: [
          { name: 'mid_jan_2024', startDate: '2024-01-14', endDate: '2024-01-16' },
        ],
      });

      // Should include exactly the trade on 2024-01-15
      expect(result.scenarios[0].tradeCount).toBe(1);
      expect(result.scenarios[0].stats).not.toBeNull();
    });
  });
});
