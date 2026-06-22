import { describe, it, expect } from '@jest/globals'
import { processChartData, Trade, DailyLogEntry } from '@tradeblocks/lib'

/**
 * Helper to create a date at local midnight (same as parseDatePreservingCalendarDay)
 * This simulates how CSV dates are parsed in production
 */
function localDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day)
}

describe('Monthly Returns Percentage Calculation', () => {
  it('calculates monthly returns percentage from trades with compounding', async () => {
    // Create trades across multiple months using local midnight dates
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 5000, // +5% on 100k
        numContracts: 1,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      },
      {
        dateOpened: localDate(2024, 2, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 2',
        premium: 0,
        pl: 10500, // +10% on 105k
        numContracts: 1,
        fundsAtClose: 115500,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 2, 20)
      },
      {
        dateOpened: localDate(2024, 3, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 3',
        premium: 0,
        pl: -5775, // -5% on 115.5k
        numContracts: 1,
        fundsAtClose: 109725,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 3, 20)
      }
    ]

    const result = await processChartData(trades)

    expect(result.monthlyReturnsPercent).toBeDefined()
    expect(result.monthlyReturnsPercent[2024]).toBeDefined()

    // January: +5000 / 100000 = +5%
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(5.0, 1)

    // February: +10500 / 105000 = +10%
    expect(result.monthlyReturnsPercent[2024][2]).toBeCloseTo(10.0, 1)

    // March: -5775 / 115500 = -5%
    expect(result.monthlyReturnsPercent[2024][3]).toBeCloseTo(-5.0, 1)

    // Other months should be zero
    expect(result.monthlyReturnsPercent[2024][4]).toBe(0)
    expect(result.monthlyReturnsPercent[2024][12]).toBe(0)
  })

  it('calculates monthly returns percentage from daily logs', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 5000,
        numContracts: 1,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      },
      {
        dateOpened: localDate(2024, 2, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 2',
        premium: 0,
        pl: 10000,
        numContracts: 1,
        fundsAtClose: 115000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 2, 20)
      }
    ]

    const dailyLogs: DailyLogEntry[] = [
      {
        date: localDate(2024, 1, 1),
        netLiquidity: 100000,
        currentFunds: 100000,
        tradingFunds: 100000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      },
      {
        date: localDate(2024, 1, 31),
        netLiquidity: 105000,
        currentFunds: 105000,
        tradingFunds: 105000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      },
      {
        date: localDate(2024, 2, 1),
        netLiquidity: 105000,
        currentFunds: 105000,
        tradingFunds: 105000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      },
      {
        date: localDate(2024, 2, 29),
        netLiquidity: 115000,
        currentFunds: 115000,
        tradingFunds: 115000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      }
    ]

    const result = await processChartData(trades, dailyLogs)

    expect(result.monthlyReturnsPercent).toBeDefined()
    expect(result.monthlyReturnsPercent[2024]).toBeDefined()

    // January: +5000 / 100000 (from daily log) = +5%
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(5.0, 1)

    // February: +10000 / 105000 (from daily log) = +9.52%
    expect(result.monthlyReturnsPercent[2024][2]).toBeCloseTo(9.52, 1)
  })

  it('falls back to trade-based percentages when monthly balances are missing', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 10),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 5000,
        numContracts: 1,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 15)
      },
      {
        dateOpened: localDate(2024, 2, 12),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 2',
        premium: 0,
        pl: 10000,
        numContracts: 1,
        fundsAtClose: 115000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 2, 20)
      }
    ]

    // Daily logs only cover January so February should fall back to trade-derived data
    const dailyLogs: DailyLogEntry[] = [
      {
        date: localDate(2024, 1, 1),
        netLiquidity: 100000,
        currentFunds: 100000,
        tradingFunds: 100000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      },
      {
        date: localDate(2024, 1, 31),
        netLiquidity: 105000,
        currentFunds: 105000,
        tradingFunds: 105000,
        withdrawn: 0,
        dailyPl: 0,
        dailyPlPct: 0,
        drawdownPct: 0
      }
    ]

    const result = await processChartData(trades, dailyLogs)

    expect(result.monthlyReturnsPercent[2024]).toBeDefined()
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(5.0, 1)
    expect(result.monthlyReturnsPercent[2024][2]).toBeCloseTo(9.52, 1)
  })

  it('handles empty trades gracefully', async () => {
    const result = await processChartData([])

    expect(result.monthlyReturnsPercent).toBeDefined()
    expect(Object.keys(result.monthlyReturnsPercent)).toHaveLength(0)
  })

  it('handles single month of trades', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 2000,
        numContracts: 1,
        fundsAtClose: 102000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      }
    ]

    const result = await processChartData(trades)

    expect(result.monthlyReturnsPercent).toBeDefined()
    expect(result.monthlyReturnsPercent[2024]).toBeDefined()
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(2.0, 1)

    // Other months should be zero
    for (let month = 2; month <= 12; month++) {
      expect(result.monthlyReturnsPercent[2024][month]).toBe(0)
    }
  })

  it('handles negative returns correctly', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: -3000,
        numContracts: 1,
        fundsAtClose: 97000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      }
    ]

    const result = await processChartData(trades)

    expect(result.monthlyReturnsPercent).toBeDefined()
    // -3000 / 100000 = -3%
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(-3.0, 1)
  })

  it('maintains consistency between dollar and percent returns', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 5000,
        numContracts: 1,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      }
    ]

    const result = await processChartData(trades)

    // Dollar amount should match
    expect(result.monthlyReturns[2024][1]).toBe(5000)

    // Percentage should be 5% (5000 / 100000)
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(5.0, 1)
  })

  it('handles multiple trades in same month', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 1, 5),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 2000,
        numContracts: 1,
        fundsAtClose: 102000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 10)
      },
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 2',
        premium: 0,
        pl: 3000,
        numContracts: 1,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      }
    ]

    const result = await processChartData(trades)

    // Total dollar return: 5000
    expect(result.monthlyReturns[2024][1]).toBe(5000)

    // Percentage: 5000 / 100000 = 5%
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(5.0, 1)
  })

  it('handles trades spanning multiple years', async () => {
    const trades: Trade[] = [
      {
        dateOpened: localDate(2023, 12, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 1',
        premium: 0,
        pl: 2000,
        numContracts: 1,
        fundsAtClose: 102000,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2023, 12, 20)
      },
      {
        dateOpened: localDate(2024, 1, 15),
        timeOpened: '09:30:00',
        openingPrice: 100,
        legs: 'Trade 2',
        premium: 0,
        pl: 3060,
        numContracts: 1,
        fundsAtClose: 105060,
        marginReq: 20000,
        strategy: 'Test',
        openingCommissionsFees: 10,
        closingCommissionsFees: 10,
        openingShortLongRatio: 0.5,
        dateClosed: localDate(2024, 1, 20)
      }
    ]

    const result = await processChartData(trades)

    expect(result.monthlyReturnsPercent[2023]).toBeDefined()
    expect(result.monthlyReturnsPercent[2024]).toBeDefined()

    // Dec 2023: 2000 / 100000 = 2%
    expect(result.monthlyReturnsPercent[2023][12]).toBeCloseTo(2.0, 1)

    // Jan 2024: 3060 / 102000 = 3% (compounded from previous month)
    expect(result.monthlyReturnsPercent[2024][1]).toBeCloseTo(3.0, 1)
  })
})
