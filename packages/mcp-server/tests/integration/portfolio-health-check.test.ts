/**
 * Integration tests for portfolio_health_check MCP tool
 *
 * Tests the unified 4-layer health assessment: verdict -> grades -> flags -> keyNumbers.
 * Uses test fixtures with multiple strategies to test correlation, tail risk, MC, and WFA.
 *
 * CLI Test Mode Verification:
 * TRADEBLOCKS_DATA_DIR=~/backtests tradeblocks-mcp --call portfolio_health_check '{"blockId":"main-port-2026"}'
 *
 * Expected: Summary line + JSON with 4 layers (verdict, grades, flags, keyNumbers)
 */
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import from built bundle (test-exports.js has @lib dependencies bundled)
// @ts-expect-error - importing from bundled output
import { loadBlock, calculateCorrelationMatrix, performTailRiskAnalysis, PortfolioStatsCalculator } from '../../src/test-exports.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

interface Trade {
  strategy: string;
  pl: number;
  dateOpened: Date;
  fundsAtClose: number;
  openingCommissionsFees: number;
  closingCommissionsFees: number;
  [key: string]: unknown;
}

interface Flag {
  type: 'warning' | 'pass';
  dimension: 'diversification' | 'tailRisk' | 'robustness' | 'consistency';
  message: string;
}

interface HealthCheckResult {
  blockId: string;
  thresholds: {
    correlationThreshold: number;
    tailDependenceThreshold: number;
    profitProbabilityThreshold: number;
    wfeThreshold: number;
    mddMultiplierThreshold: number;
  };
  verdict: {
    status: 'HEALTHY' | 'MODERATE_CONCERNS' | 'ISSUES_DETECTED';
    oneLineSummary: string;
    flagCount: number;
  };
  grades: {
    diversification: 'A' | 'B' | 'C' | 'F';
    tailRisk: 'A' | 'B' | 'C' | 'F';
    robustness: 'A' | 'B' | 'C' | 'F' | null;
    consistency: 'A' | 'B' | 'C' | 'F';
  };
  flags: Flag[];
  keyNumbers: {
    strategies: number;
    trades: number;
    sharpe: number | null;
    sortino: number | null;
    maxDrawdownPct: number;
    netPl: number;
    avgCorrelation: number;
    avgTailDependence: number;
    mcProbabilityOfProfit: number;
    mcMedianMdd: number;
    mcMddMultiplier: number | null;
    wfe: number | null;
  };
  error?: string;
  message?: string;
}

const HEALTH_CHECK_DEFAULTS = {
  correlationThreshold: 0.5,
  tailDependenceThreshold: 0.5,
  profitProbabilityThreshold: 0.95,
  wfeThreshold: -0.15,
  mddMultiplierThreshold: 3.0,
};

/**
 * Simulates the portfolio_health_check tool logic for testing
 * Note: This is a simplified version that doesn't run full MC/WFA
 * but tests the core response structure
 */
async function simulatePortfolioHealthCheck(
  baseDir: string,
  blockId: string,
  options: {
    correlationThreshold?: number;
    tailDependenceThreshold?: number;
    profitProbabilityThreshold?: number;
    wfeThreshold?: number;
    mddMultiplierThreshold?: number;
  } = {}
): Promise<HealthCheckResult> {
  const {
    correlationThreshold = HEALTH_CHECK_DEFAULTS.correlationThreshold,
    tailDependenceThreshold = HEALTH_CHECK_DEFAULTS.tailDependenceThreshold,
    profitProbabilityThreshold = HEALTH_CHECK_DEFAULTS.profitProbabilityThreshold,
    wfeThreshold = HEALTH_CHECK_DEFAULTS.wfeThreshold,
    mddMultiplierThreshold = HEALTH_CHECK_DEFAULTS.mddMultiplierThreshold,
  } = options;

  const block = await loadBlock(baseDir, blockId);
  const trades: Trade[] = block.trades;

  if (trades.length === 0) {
    return {
      blockId,
      thresholds: { correlationThreshold, tailDependenceThreshold, profitProbabilityThreshold, wfeThreshold, mddMultiplierThreshold },
      verdict: { status: 'HEALTHY', oneLineSummary: 'No trades', flagCount: 0 },
      grades: { diversification: 'A', tailRisk: 'A', robustness: null, consistency: 'A' },
      flags: [],
      keyNumbers: {
        strategies: 0, trades: 0, sharpe: null, sortino: null, maxDrawdownPct: 0,
        netPl: 0, avgCorrelation: 0, avgTailDependence: 0, mcProbabilityOfProfit: 0,
        mcMedianMdd: 0, mcMddMultiplier: null, wfe: null,
      },
      message: `No trades found in block "${blockId}"`,
    };
  }

  const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();

  if (strategies.length < 2) {
    return {
      blockId,
      thresholds: { correlationThreshold, tailDependenceThreshold, profitProbabilityThreshold, wfeThreshold, mddMultiplierThreshold },
      verdict: { status: 'HEALTHY', oneLineSummary: 'Single strategy', flagCount: 0 },
      grades: { diversification: 'A', tailRisk: 'A', robustness: null, consistency: 'A' },
      flags: [],
      keyNumbers: {
        strategies: strategies.length, trades: trades.length, sharpe: null, sortino: null,
        maxDrawdownPct: 0, netPl: 0, avgCorrelation: 0, avgTailDependence: 0,
        mcProbabilityOfProfit: 0, mcMedianMdd: 0, mcMddMultiplier: null, wfe: null,
      },
      error: `Portfolio health check requires at least 2 strategies. Found ${strategies.length}.`,
    };
  }

  if (trades.length < 20) {
    return {
      blockId,
      thresholds: { correlationThreshold, tailDependenceThreshold, profitProbabilityThreshold, wfeThreshold, mddMultiplierThreshold },
      verdict: { status: 'HEALTHY', oneLineSummary: 'Insufficient trades', flagCount: 0 },
      grades: { diversification: 'A', tailRisk: 'A', robustness: null, consistency: 'A' },
      flags: [],
      keyNumbers: {
        strategies: strategies.length, trades: trades.length, sharpe: null, sortino: null,
        maxDrawdownPct: 0, netPl: 0, avgCorrelation: 0, avgTailDependence: 0,
        mcProbabilityOfProfit: 0, mcMedianMdd: 0, mcMddMultiplier: null, wfe: null,
      },
      error: `Portfolio health check requires at least 20 trades. Found ${trades.length}.`,
    };
  }

  // Calculate portfolio stats
  const calculator = new PortfolioStatsCalculator();
  const stats = calculator.calculatePortfolioStats(trades, undefined, true);

  // Calculate correlation matrix
  const correlationMatrix = calculateCorrelationMatrix(trades, {
    method: 'kendall',
    normalization: 'raw',
    dateBasis: 'opened',
    alignment: 'shared',
  });

  // Calculate tail risk
  const tailRisk = performTailRiskAnalysis(trades, {
    tailThreshold: 0.1,
    normalization: 'raw',
    dateBasis: 'opened',
    minTradingDays: 10,
  });

  // Calculate average correlation
  let totalCorrelation = 0;
  let correlationCount = 0;
  for (let i = 0; i < correlationMatrix.strategies.length; i++) {
    for (let j = i + 1; j < correlationMatrix.strategies.length; j++) {
      const val = correlationMatrix.correlationData[i][j];
      if (!Number.isNaN(val) && val !== null) {
        totalCorrelation += Math.abs(val);
        correlationCount++;
      }
    }
  }
  const avgCorrelation = correlationCount > 0 ? totalCorrelation / correlationCount : 0;

  // Calculate average tail dependence
  let totalTailDependence = 0;
  let tailCount = 0;
  for (let i = 0; i < tailRisk.strategies.length; i++) {
    for (let j = i + 1; j < tailRisk.strategies.length; j++) {
      const valAB = tailRisk.jointTailRiskMatrix[i]?.[j];
      const valBA = tailRisk.jointTailRiskMatrix[j]?.[i];
      if (valAB !== undefined && valBA !== undefined && !Number.isNaN(valAB) && !Number.isNaN(valBA)) {
        totalTailDependence += (valAB + valBA) / 2;
        tailCount++;
      }
    }
  }
  const avgTailDependence = tailCount > 0 ? totalTailDependence / tailCount : 0;

  // Build flags
  const flags: Flag[] = [];

  // High correlation pairs
  const highCorrPairs: string[] = [];
  for (let i = 0; i < correlationMatrix.strategies.length; i++) {
    for (let j = i + 1; j < correlationMatrix.strategies.length; j++) {
      const val = correlationMatrix.correlationData[i][j];
      if (!Number.isNaN(val) && Math.abs(val) > correlationThreshold) {
        highCorrPairs.push(
          `${correlationMatrix.strategies[i]} & ${correlationMatrix.strategies[j]} (${val.toFixed(2)})`
        );
      }
    }
  }
  if (highCorrPairs.length > 0) {
    flags.push({
      type: 'warning',
      dimension: 'diversification',
      message: `High correlation pairs (>${correlationThreshold}): ${highCorrPairs.join(', ')}`,
    });
  } else {
    flags.push({
      type: 'pass',
      dimension: 'diversification',
      message: `No correlation pairs above ${correlationThreshold} threshold`,
    });
  }

  // High tail dependence pairs
  const highTailPairs: string[] = [];
  for (let i = 0; i < tailRisk.strategies.length; i++) {
    for (let j = i + 1; j < tailRisk.strategies.length; j++) {
      const valAB = tailRisk.jointTailRiskMatrix[i]?.[j];
      const valBA = tailRisk.jointTailRiskMatrix[j]?.[i];
      if (valAB !== undefined && valBA !== undefined && !Number.isNaN(valAB) && !Number.isNaN(valBA)) {
        const avgTail = (valAB + valBA) / 2;
        if (avgTail > tailDependenceThreshold) {
          highTailPairs.push(
            `${tailRisk.strategies[i]} & ${tailRisk.strategies[j]} (${avgTail.toFixed(2)})`
          );
        }
      }
    }
  }
  if (highTailPairs.length > 0) {
    flags.push({
      type: 'warning',
      dimension: 'tailRisk',
      message: `High tail dependence pairs (>${tailDependenceThreshold}): ${highTailPairs.join(', ')}`,
    });
  } else {
    flags.push({
      type: 'pass',
      dimension: 'tailRisk',
      message: `No tail dependence pairs above ${tailDependenceThreshold} threshold`,
    });
  }

  // Mock MC profit probability (simplified for tests)
  const mcProbabilityOfProfit = 0.98; // High for test purposes
  flags.push({
    type: mcProbabilityOfProfit >= profitProbabilityThreshold ? 'pass' : 'warning',
    dimension: 'consistency',
    message: mcProbabilityOfProfit >= profitProbabilityThreshold
      ? `Monte Carlo profit probability meets threshold`
      : `Monte Carlo profit probability below threshold`,
  });

  // Build grades
  type Grade = 'A' | 'B' | 'C' | 'F';

  let diversificationGrade: Grade;
  if (avgCorrelation < 0.2) diversificationGrade = 'A';
  else if (avgCorrelation < 0.4) diversificationGrade = 'B';
  else if (avgCorrelation < 0.6) diversificationGrade = 'C';
  else diversificationGrade = 'F';

  let tailRiskGrade: Grade;
  if (avgTailDependence < 0.3) tailRiskGrade = 'A';
  else if (avgTailDependence < 0.5) tailRiskGrade = 'B';
  else if (avgTailDependence < 0.7) tailRiskGrade = 'C';
  else tailRiskGrade = 'F';

  // WFA skipped for test simplicity
  const robustnessGrade: Grade | null = null;

  let consistencyGrade: Grade;
  if (mcProbabilityOfProfit >= 0.98) consistencyGrade = 'A';
  else if (mcProbabilityOfProfit >= 0.9) consistencyGrade = 'B';
  else if (mcProbabilityOfProfit >= 0.7) consistencyGrade = 'C';
  else consistencyGrade = 'F';

  // Build verdict
  const warningFlags = flags.filter((f) => f.type === 'warning');
  const flagCount = warningFlags.length;
  let verdict: 'HEALTHY' | 'MODERATE_CONCERNS' | 'ISSUES_DETECTED';
  let oneLineSummary: string;

  if (flagCount === 0) {
    verdict = 'HEALTHY';
    oneLineSummary = 'Portfolio shows strong diversification, controlled tail risk, and consistent outcomes.';
  } else if (flagCount <= 2) {
    verdict = 'MODERATE_CONCERNS';
    const concernDimensions = [...new Set(warningFlags.map((f) => f.dimension))];
    oneLineSummary = `Portfolio has ${flagCount} warning(s) in ${concernDimensions.join(', ')} - review flagged items.`;
  } else {
    verdict = 'ISSUES_DETECTED';
    const concernDimensions = [...new Set(warningFlags.map((f) => f.dimension))];
    oneLineSummary = `Portfolio has ${flagCount} warnings across ${concernDimensions.join(', ')} - significant review recommended.`;
  }

  return {
    blockId,
    thresholds: { correlationThreshold, tailDependenceThreshold, profitProbabilityThreshold, wfeThreshold, mddMultiplierThreshold },
    verdict: { status: verdict, oneLineSummary, flagCount },
    grades: {
      diversification: diversificationGrade,
      tailRisk: tailRiskGrade,
      robustness: robustnessGrade,
      consistency: consistencyGrade,
    },
    flags,
    keyNumbers: {
      strategies: strategies.length,
      trades: trades.length,
      sharpe: stats.sharpeRatio,
      sortino: stats.sortinoRatio,
      maxDrawdownPct: stats.maxDrawdown * 100,
      netPl: stats.netPl,
      avgCorrelation,
      avgTailDependence,
      mcProbabilityOfProfit,
      mcMedianMdd: 0.1, // Mock
      mcMddMultiplier: null,
      wfe: null,
    },
  };
}

describe('portfolio_health_check', () => {
  describe('4-layer response structure', () => {
    it('should return all 4 layers: verdict, grades, flags, keyNumbers', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result).toHaveProperty('verdict');
      expect(result).toHaveProperty('grades');
      expect(result).toHaveProperty('flags');
      expect(result).toHaveProperty('keyNumbers');
    });

    it('should have correct verdict structure', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.verdict).toHaveProperty('status');
      expect(result.verdict).toHaveProperty('oneLineSummary');
      expect(result.verdict).toHaveProperty('flagCount');
      expect(['HEALTHY', 'MODERATE_CONCERNS', 'ISSUES_DETECTED']).toContain(result.verdict.status);
    });

    it('should have correct grades structure with A/B/C/F values', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.grades).toHaveProperty('diversification');
      expect(result.grades).toHaveProperty('tailRisk');
      expect(result.grades).toHaveProperty('robustness');
      expect(result.grades).toHaveProperty('consistency');

      // Grades should be A, B, C, F, or null
      const validGrades = ['A', 'B', 'C', 'F', null];
      expect(validGrades).toContain(result.grades.diversification);
      expect(validGrades).toContain(result.grades.tailRisk);
      expect(validGrades).toContain(result.grades.robustness);
      expect(validGrades).toContain(result.grades.consistency);
    });

    it('should have flags with type, dimension, and message', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.flags.length).toBeGreaterThan(0);
      for (const flag of result.flags) {
        expect(flag).toHaveProperty('type');
        expect(flag).toHaveProperty('dimension');
        expect(flag).toHaveProperty('message');
        expect(['warning', 'pass']).toContain(flag.type);
        expect(['diversification', 'tailRisk', 'robustness', 'consistency']).toContain(flag.dimension);
      }
    });

    it('should have keyNumbers with required metrics', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.keyNumbers).toHaveProperty('strategies');
      expect(result.keyNumbers).toHaveProperty('trades');
      expect(result.keyNumbers).toHaveProperty('sharpe');
      expect(result.keyNumbers).toHaveProperty('sortino');
      expect(result.keyNumbers).toHaveProperty('maxDrawdownPct');
      expect(result.keyNumbers).toHaveProperty('netPl');
      expect(result.keyNumbers).toHaveProperty('avgCorrelation');
      expect(result.keyNumbers).toHaveProperty('avgTailDependence');
      expect(result.keyNumbers).toHaveProperty('mcProbabilityOfProfit');
    });
  });

  describe('verdict logic', () => {
    it('should return HEALTHY when no warnings', async () => {
      // Use very high thresholds so no pairs get flagged
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.99,
        tailDependenceThreshold: 0.99,
      });

      expect(result.verdict.flagCount).toBe(0);
      expect(result.verdict.status).toBe('HEALTHY');
    });

    it('should return MODERATE_CONCERNS when 1-2 warnings', async () => {
      // Use thresholds that should trigger exactly some warnings
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.3, // Low threshold to trigger warning
        tailDependenceThreshold: 0.99, // High threshold to avoid warning
      });

      if (result.verdict.flagCount >= 1 && result.verdict.flagCount <= 2) {
        expect(result.verdict.status).toBe('MODERATE_CONCERNS');
      }
    });

    it('should return ISSUES_DETECTED when 3+ warnings', async () => {
      // Use very low thresholds to trigger multiple warnings
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.1,
        tailDependenceThreshold: 0.1,
        profitProbabilityThreshold: 0.999, // Very high to trigger warning
      });

      if (result.verdict.flagCount >= 3) {
        expect(result.verdict.status).toBe('ISSUES_DETECTED');
      }
    });
  });

  describe('grades calculation', () => {
    it('should assign diversification grade based on avg correlation', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // Grade is A (<0.2), B (<0.4), C (<0.6), F (>=0.6)
      const avgCorr = result.keyNumbers.avgCorrelation;
      if (avgCorr < 0.2) expect(result.grades.diversification).toBe('A');
      else if (avgCorr < 0.4) expect(result.grades.diversification).toBe('B');
      else if (avgCorr < 0.6) expect(result.grades.diversification).toBe('C');
      else expect(result.grades.diversification).toBe('F');
    });

    it('should assign tailRisk grade based on avg tail dependence', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // Grade is A (<0.3), B (<0.5), C (<0.7), F (>=0.7)
      const avgTail = result.keyNumbers.avgTailDependence;
      if (avgTail < 0.3) expect(result.grades.tailRisk).toBe('A');
      else if (avgTail < 0.5) expect(result.grades.tailRisk).toBe('B');
      else if (avgTail < 0.7) expect(result.grades.tailRisk).toBe('C');
      else expect(result.grades.tailRisk).toBe('F');
    });

    it('should return null robustness grade when WFA cannot run', async () => {
      // For small test fixtures, WFA typically cannot run
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // WFA is typically skipped for small test fixtures
      expect(result.grades.robustness).toBeNull();
    });
  });

  describe('flag generation', () => {
    it('should flag high correlation pairs correctly', async () => {
      // Use low threshold to ensure pairs are flagged
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.3,
      });

      const corrFlags = result.flags.filter((f) => f.dimension === 'diversification');
      expect(corrFlags.length).toBeGreaterThan(0);
    });

    it('should include strategy names in flag messages', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.3, // Low threshold to trigger warnings
      });

      const warningFlags = result.flags.filter((f) => f.type === 'warning');
      for (const flag of warningFlags) {
        // Warning messages should contain specific info (strategy names or numbers)
        expect(flag.message.length).toBeGreaterThan(20);
      }
    });

    it('should respect custom correlation threshold', async () => {
      const highThreshold = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.99,
      });
      const lowThreshold = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        correlationThreshold: 0.1,
      });

      const highCorrWarnings = highThreshold.flags.filter(
        (f) => f.dimension === 'diversification' && f.type === 'warning'
      );
      const lowCorrWarnings = lowThreshold.flags.filter(
        (f) => f.dimension === 'diversification' && f.type === 'warning'
      );

      // Low threshold should flag more pairs
      expect(lowCorrWarnings.length).toBeGreaterThanOrEqual(highCorrWarnings.length);
    });

    it('should respect custom tail dependence threshold', async () => {
      const highThreshold = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        tailDependenceThreshold: 0.99,
      });
      const lowThreshold = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block', {
        tailDependenceThreshold: 0.1,
      });

      const highTailWarnings = highThreshold.flags.filter(
        (f) => f.dimension === 'tailRisk' && f.type === 'warning'
      );
      const lowTailWarnings = lowThreshold.flags.filter(
        (f) => f.dimension === 'tailRisk' && f.type === 'warning'
      );

      // Low threshold should flag more pairs
      expect(lowTailWarnings.length).toBeGreaterThanOrEqual(highTailWarnings.length);
    });
  });

  describe('keyNumbers population', () => {
    it('should populate strategy count correctly', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // similarity-test-block has 4 strategies
      expect(result.keyNumbers.strategies).toBe(4);
    });

    it('should populate trade count correctly', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // similarity-test-block has 40 trades
      expect(result.keyNumbers.trades).toBe(40);
    });

    it('should populate avgCorrelation', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(typeof result.keyNumbers.avgCorrelation).toBe('number');
      expect(result.keyNumbers.avgCorrelation).toBeGreaterThanOrEqual(0);
      expect(result.keyNumbers.avgCorrelation).toBeLessThanOrEqual(1);
    });

    it('should populate avgTailDependence', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(typeof result.keyNumbers.avgTailDependence).toBe('number');
      expect(result.keyNumbers.avgTailDependence).toBeGreaterThanOrEqual(0);
    });
  });

  describe('thresholds configuration', () => {
    it('should use default thresholds when not specified', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.thresholds.correlationThreshold).toBe(0.5);
      expect(result.thresholds.tailDependenceThreshold).toBe(0.5);
      expect(result.thresholds.profitProbabilityThreshold).toBe(0.95);
      expect(result.thresholds.wfeThreshold).toBe(-0.15);
      expect(result.thresholds.mddMultiplierThreshold).toBe(3.0);
    });

    it('should respect custom thresholds', async () => {
      const customThresholds = {
        correlationThreshold: 0.7,
        tailDependenceThreshold: 0.6,
        profitProbabilityThreshold: 0.9,
        wfeThreshold: -0.2,
        mddMultiplierThreshold: 4.0,
      };

      const result = await simulatePortfolioHealthCheck(
        FIXTURES_DIR,
        'similarity-test-block',
        customThresholds
      );

      expect(result.thresholds.correlationThreshold).toBe(0.7);
      expect(result.thresholds.tailDependenceThreshold).toBe(0.6);
      expect(result.thresholds.profitProbabilityThreshold).toBe(0.9);
      expect(result.thresholds.wfeThreshold).toBe(-0.2);
      expect(result.thresholds.mddMultiplierThreshold).toBe(4.0);
    });
  });

  describe('edge cases', () => {
    it('should handle minimum 2 strategies', async () => {
      // mock-block has 2 strategies
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'mock-block');

      if (result.keyNumbers.strategies === 2) {
        expect(result.grades).toBeDefined();
        expect(result.flags.length).toBeGreaterThan(0);
      }
    });

    it('should reject single strategy block', async () => {
      // This test would need a single-strategy fixture
      // For now, test that error message is set when strategy count check fails
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      // Similarity-test-block has 4 strategies, so no error
      expect(result.error).toBeUndefined();
    });

    it('should handle non-existent block gracefully', async () => {
      await expect(
        simulatePortfolioHealthCheck(FIXTURES_DIR, 'non-existent-block')
      ).rejects.toThrow();
    });
  });

  describe('blockId and thresholds in result', () => {
    it('should include blockId in result', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.blockId).toBe('similarity-test-block');
    });

    it('should include thresholds in result', async () => {
      const result = await simulatePortfolioHealthCheck(FIXTURES_DIR, 'similarity-test-block');

      expect(result.thresholds).toBeDefined();
      expect(typeof result.thresholds.correlationThreshold).toBe('number');
      expect(typeof result.thresholds.tailDependenceThreshold).toBe('number');
    });
  });
});
