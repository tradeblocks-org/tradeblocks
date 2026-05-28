/**
 * Unit tests for shared filter utilities.
 *
 * Validates:
 * - filterByStrategy case-insensitive matching
 * - filterByDateRange Eastern Time string comparison (timezone-safe)
 * - filterByDateRange YYYY-MM-DD input validation
 * - filterDailyLogsByDateRange parity with filterByDateRange
 * - Edge cases: empty arrays, undefined params, malformed dates
 */

// @ts-expect-error - importing from bundled output
import {
  filterByStrategy,
  filterByDateRange,
  filterDailyLogsByDateRange,
} from '../../src/test-exports.ts';

// =============================================================================
// Test Data Helpers
// =============================================================================

/** Minimal Trade-like object for filter testing */
function makeTrade(dateStr: string, strategy = 'Test Strategy', pl = 100) {
  return {
    dateOpened: new Date(dateStr + 'T14:00:00.000Z'), // midday UTC to test timezone handling
    timeOpened: '09:30:00',
    openingPrice: 100,
    legs: '1 SPY 470C',
    premium: 500,
    pl,
    numContracts: 1,
    fundsAtClose: 10000,
    marginReq: 2000,
    strategy,
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
  };
}

/** Minimal DailyLogEntry-like object */
function makeDailyLog(dateStr: string) {
  return {
    date: new Date(dateStr + 'T14:00:00.000Z'),
    netLiquidity: 10000,
    currentFunds: 10000,
    withdrawn: 0,
    tradingFunds: 10000,
    dailyPl: 0,
    dailyPlPct: 0,
    drawdownPct: 0,
  };
}

const trades = [
  makeTrade('2025-01-06', 'Alpha Strategy'),
  makeTrade('2025-01-07', 'Beta Strategy'),
  makeTrade('2025-01-08', 'Alpha Strategy'),
  makeTrade('2025-01-09', 'gamma strategy'),
  makeTrade('2025-01-10', 'Alpha Strategy'),
];

const dailyLogs = [
  makeDailyLog('2025-01-06'),
  makeDailyLog('2025-01-07'),
  makeDailyLog('2025-01-08'),
  makeDailyLog('2025-01-09'),
  makeDailyLog('2025-01-10'),
];

// =============================================================================
// filterByStrategy
// =============================================================================

describe('filterByStrategy', () => {
  test('returns all trades when strategy is undefined', () => {
    expect(filterByStrategy(trades, undefined)).toHaveLength(5);
  });

  test('filters by exact strategy name (case-insensitive)', () => {
    const result = filterByStrategy(trades, 'alpha strategy');
    expect(result).toHaveLength(3);
    expect(result.every((t: { strategy: string }) => t.strategy === 'Alpha Strategy')).toBe(true);
  });

  test('matches regardless of case', () => {
    expect(filterByStrategy(trades, 'GAMMA STRATEGY')).toHaveLength(1);
    expect(filterByStrategy(trades, 'Gamma Strategy')).toHaveLength(1);
  });

  test('returns empty array for non-existent strategy', () => {
    expect(filterByStrategy(trades, 'Nonexistent')).toHaveLength(0);
  });

  test('handles empty trades array', () => {
    expect(filterByStrategy([], 'Alpha Strategy')).toHaveLength(0);
  });
});

// =============================================================================
// filterByDateRange
// =============================================================================

describe('filterByDateRange', () => {
  test('returns all trades when no dates provided', () => {
    expect(filterByDateRange(trades)).toHaveLength(5);
  });

  test('returns all trades when both dates are undefined', () => {
    expect(filterByDateRange(trades, undefined, undefined)).toHaveLength(5);
  });

  test('filters by startDate only', () => {
    const result = filterByDateRange(trades, '2025-01-08');
    expect(result).toHaveLength(3);
  });

  test('filters by endDate only', () => {
    const result = filterByDateRange(trades, undefined, '2025-01-08');
    expect(result).toHaveLength(3);
  });

  test('filters by both startDate and endDate', () => {
    const result = filterByDateRange(trades, '2025-01-07', '2025-01-09');
    expect(result).toHaveLength(3);
  });

  test('includes trades on exact start date', () => {
    const result = filterByDateRange(trades, '2025-01-06', '2025-01-06');
    expect(result).toHaveLength(1);
  });

  test('includes trades on exact end date', () => {
    const result = filterByDateRange(trades, '2025-01-10', '2025-01-10');
    expect(result).toHaveLength(1);
  });

  test('returns empty when range matches no trades', () => {
    expect(filterByDateRange(trades, '2025-02-01', '2025-02-28')).toHaveLength(0);
  });

  test('handles empty trades array', () => {
    expect(filterByDateRange([], '2025-01-01', '2025-12-31')).toHaveLength(0);
  });

  // --- Input validation ---

  test('ignores malformed startDate (not YYYY-MM-DD)', () => {
    // Should return all trades (malformed date is silently skipped)
    expect(filterByDateRange(trades, '2025-1-8')).toHaveLength(5);
    expect(filterByDateRange(trades, 'foo')).toHaveLength(5);
    expect(filterByDateRange(trades, '')).toHaveLength(5);
    expect(filterByDateRange(trades, '01/08/2025')).toHaveLength(5);
  });

  test('ignores malformed endDate (not YYYY-MM-DD)', () => {
    expect(filterByDateRange(trades, undefined, '2025-1-8')).toHaveLength(5);
    expect(filterByDateRange(trades, undefined, 'bar')).toHaveLength(5);
  });

  test('valid startDate with malformed endDate applies only startDate', () => {
    const result = filterByDateRange(trades, '2025-01-09', 'bad-date');
    expect(result).toHaveLength(2); // Jan 9, Jan 10
  });

  test('malformed startDate with valid endDate applies only endDate', () => {
    const result = filterByDateRange(trades, 'nope', '2025-01-07');
    expect(result).toHaveLength(2); // Jan 6, Jan 7
  });

  // --- Timezone safety ---

  test('local-midnight dates preserve calendar date (parseDatePreservingCalendarDay pattern)', () => {
    // This is how dates are actually created: new Date(year, month, day) at local midnight
    const trade = makeTrade('2025-01-07');
    trade.dateOpened = new Date(2025, 0, 7); // local midnight Jan 7

    const result = filterByDateRange([trade], '2025-01-07', '2025-01-07');
    expect(result).toHaveLength(1); // Must be Jan 7 regardless of server timezone
  });

  test('string dateOpened extracts calendar date without timezone conversion', () => {
    // After JSON serialization, dateOpened may be an ISO string
    const trade = makeTrade('2025-01-07');
    (trade as Record<string, unknown>).dateOpened = '2025-01-07T05:00:00.000Z';

    const result = filterByDateRange([trade], '2025-01-07', '2025-01-07');
    expect(result).toHaveLength(1); // Regex extracts 2025-01-07 from string
  });

  test('string dateOpened as plain YYYY-MM-DD works', () => {
    const trade = makeTrade('2025-01-07');
    (trade as Record<string, unknown>).dateOpened = '2025-01-07';

    const result = filterByDateRange([trade], '2025-01-07', '2025-01-07');
    expect(result).toHaveLength(1);
  });
});

// =============================================================================
// filterDailyLogsByDateRange
// =============================================================================

describe('filterDailyLogsByDateRange', () => {
  test('returns all logs when no dates provided', () => {
    expect(filterDailyLogsByDateRange(dailyLogs)).toHaveLength(5);
  });

  test('filters by startDate', () => {
    expect(filterDailyLogsByDateRange(dailyLogs, '2025-01-08')).toHaveLength(3);
  });

  test('filters by endDate', () => {
    expect(filterDailyLogsByDateRange(dailyLogs, undefined, '2025-01-08')).toHaveLength(3);
  });

  test('filters by both dates', () => {
    expect(filterDailyLogsByDateRange(dailyLogs, '2025-01-07', '2025-01-09')).toHaveLength(3);
  });

  test('ignores malformed dates', () => {
    expect(filterDailyLogsByDateRange(dailyLogs, 'bad', 'also-bad')).toHaveLength(5);
  });

  test('handles empty array', () => {
    expect(filterDailyLogsByDateRange([], '2025-01-01', '2025-12-31')).toHaveLength(0);
  });
});
