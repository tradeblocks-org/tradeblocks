/**
 * Unit tests for data-quality module
 *
 * Tests scoreDataQuality / formatCoverageReport (pure functions) and
 * queryCoverage's canonical quote-cache aggregation behavior.
 */

import { queryCoverage, scoreDataQuality, formatCoverageReport } from '../../src/test-exports.ts';
import type { DataQualityInput, CoverageResult } from '../../src/test-exports.ts';
import type { MarketStores } from '../../src/test-exports.ts';

interface CoverageInput {
  earliest: string | null;
  latest: string | null;
  totalDates: number;
}

/**
 * Build a minimal MarketStores stub that lets queryCoverage exercise the
 * spot+quote getCoverage path without booting DuckDB. Phase 4 / CONSUMER-02:
 * the function's only IO is `stores.spot.getCoverage` + `stores.quote.getCoverage`.
 */
function makeMockStores(spot: CoverageInput, quote: CoverageInput): MarketStores {
  const cov = (c: CoverageInput) => async () => ({
    earliest: c.earliest,
    latest: c.latest,
    missingDates: [] as string[],
    totalDates: c.totalDates,
  });
  return {
    spot: { getCoverage: cov(spot) },
    quote: { getCoverage: cov(quote) },
    enriched: {},
    chain: {},
  } as unknown as MarketStores;
}

// ---------------------------------------------------------------------------
// scoreDataQuality tests
// ---------------------------------------------------------------------------

describe('scoreDataQuality', () => {
  test('avgBarsPerDay >= 200 with low missing returns high confidence', () => {
    const input: DataQualityInput = {
      totalBars: 80000,
      tradingDays: 252,
      daysWithQuotes: 240,
      daysWithSparseData: 12,
      daysWithNoData: 0,
      missingDates: [],
    };
    const result = scoreDataQuality(input);
    expect(result.confidenceLevel).toBe('high');
    expect(result.avgBarsPerDay).toBeGreaterThanOrEqual(200);
  });

  test('avgBarsPerDay 50-199 returns medium confidence', () => {
    const input: DataQualityInput = {
      totalBars: 12000,
      tradingDays: 100,
      daysWithQuotes: 0,
      daysWithSparseData: 100,
      daysWithNoData: 0,
      missingDates: [],
    };
    const result = scoreDataQuality(input);
    expect(result.avgBarsPerDay).toBe(120);
    expect(result.confidenceLevel).toBe('medium');
  });

  test('avgBarsPerDay < 50 returns low confidence', () => {
    const input: DataQualityInput = {
      totalBars: 4600,
      tradingDays: 100,
      daysWithQuotes: 0,
      daysWithSparseData: 100,
      daysWithNoData: 0,
      missingDates: [],
    };
    const result = scoreDataQuality(input);
    expect(result.avgBarsPerDay).toBe(46);
    expect(result.confidenceLevel).toBe('low');
  });

  test('0 tradingDays returns low confidence', () => {
    const input: DataQualityInput = {
      totalBars: 0,
      tradingDays: 0,
      daysWithQuotes: 0,
      daysWithSparseData: 0,
      daysWithNoData: 0,
      missingDates: [],
    };
    const result = scoreDataQuality(input);
    expect(result.avgBarsPerDay).toBe(0);
    expect(result.confidenceLevel).toBe('low');
  });

  test('missingDataDates > 10% of range caps confidence at medium or below', () => {
    // 252 trading days, 30 missing = ~12% → should not be high
    const missingDates = Array.from({ length: 30 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`);
    const input: DataQualityInput = {
      totalBars: 252 * 320,  // would be 'high' barsPerDay if not for missing
      tradingDays: 252,
      daysWithQuotes: 222,
      daysWithSparseData: 0,
      daysWithNoData: 30,
      missingDates,
    };
    const result = scoreDataQuality(input);
    // 30/252 ≈ 11.9% missing → should cap at medium or go to low
    expect(result.confidenceLevel).not.toBe('high');
  });

  test('returns correct tradesWithQuoteData and tradesWithSparseData', () => {
    const input: DataQualityInput = {
      totalBars: 50000,
      tradingDays: 200,
      daysWithQuotes: 150,
      daysWithSparseData: 50,
      daysWithNoData: 0,
      missingDates: [],
    };
    const result = scoreDataQuality(input);
    expect(result.tradesWithQuoteData).toBe(150);
    expect(result.tradesWithSparseData).toBe(50);
    expect(result.missingDataDates).toEqual([]);
  });

  test('missing dates are preserved in result', () => {
    const missingDates = ['2024-03-15', '2024-03-18'];
    const input: DataQualityInput = {
      totalBars: 200,
      tradingDays: 10,
      daysWithQuotes: 8,
      daysWithSparseData: 0,
      daysWithNoData: 2,
      missingDates,
    };
    const result = scoreDataQuality(input);
    expect(result.missingDataDates).toEqual(missingDates);
  });
});

// ---------------------------------------------------------------------------
// formatCoverageReport tests
// ---------------------------------------------------------------------------

describe('formatCoverageReport', () => {
  test('produces human-readable text with date ranges and density labels', () => {
    const coverage: CoverageResult = {
      totalBars: 32000,
      dateBreakdown: [
        { date: '2024-01-02', barCount: 320, hasQuotes: true },
        { date: '2024-01-03', barCount: 315, hasQuotes: true },
        { date: '2024-01-04', barCount: 330, hasQuotes: true },
        { date: '2024-02-01', barCount: 42, hasQuotes: false },
        { date: '2024-02-02', barCount: 46, hasQuotes: false },
      ],
      summary: 'SPX options: 2024-01-02 through 2024-02-02',
    };
    const report = formatCoverageReport('SPX%', coverage);
    // Should include some mention of dense/sparse
    expect(report).toMatch(/dense|sparse/i);
    // Should include date references
    expect(report).toMatch(/2024/);
    // Should include bars/day metric
    expect(report).toMatch(/bars\/day|bars per day/i);
  });

  test('groups consecutive days with similar density into ranges', () => {
    const coverage: CoverageResult = {
      totalBars: 6000,
      dateBreakdown: [
        { date: '2024-01-02', barCount: 310, hasQuotes: true },
        { date: '2024-01-03', barCount: 315, hasQuotes: true },
        { date: '2024-01-04', barCount: 320, hasQuotes: true },
        { date: '2024-02-01', barCount: 40, hasQuotes: false },
        { date: '2024-02-02', barCount: 45, hasQuotes: false },
      ],
      summary: '',
    };
    const report = formatCoverageReport('SPX%', coverage);
    // Dense group should be collapsed, not list every date
    const lines = report.split('\n').filter(l => l.trim().length > 0);
    // Fewer lines than total dates — means grouping happened
    expect(lines.length).toBeLessThan(coverage.dateBreakdown.length + 2);
  });

  test('handles empty date breakdown', () => {
    const coverage: CoverageResult = {
      totalBars: 0,
      dateBreakdown: [],
      summary: 'No data found',
    };
    const report = formatCoverageReport('SPX%', coverage);
    expect(report).toMatch(/no data/i);
  });
});

// ---------------------------------------------------------------------------
// queryCoverage tests
// ---------------------------------------------------------------------------

describe('queryCoverage', () => {
  test('union of spot + quote coverage marks dates that quote covers as hasQuotes=true', async () => {
    const stores = makeMockStores(
      { earliest: '2024-01-02', latest: '2024-01-03', totalDates: 2 },
      { earliest: '2024-01-02', latest: '2024-01-02', totalDates: 1 },
    );

    const coverage = await queryCoverage(stores, 'SPX', '2024-01-02', '2024-01-03');

    expect(coverage.totalBars).toBe(2);
    expect(coverage.dateBreakdown).toEqual([
      { date: '2024-01-02', barCount: 1, hasQuotes: true },
      { date: '2024-01-03', barCount: 1, hasQuotes: false },
    ]);
    expect(coverage.summary).toContain('SPX');
  });

  test('returns empty coverage cleanly when both stores have no data', async () => {
    const stores = makeMockStores(
      { earliest: null, latest: null, totalDates: 0 },
      { earliest: null, latest: null, totalDates: 0 },
    );

    const coverage = await queryCoverage(stores, 'SPX', '2024-01-02', '2024-01-03');

    expect(coverage.totalBars).toBe(0);
    expect(coverage.dateBreakdown).toEqual([]);
    expect(coverage.summary).toMatch(/No intraday data found/i);
  });
});
