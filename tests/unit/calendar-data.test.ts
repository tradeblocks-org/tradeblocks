/**
 * Unit tests for Trading Calendar data service
 */

import {
  scaleBacktestPl,
  getActualPlPerContract,
  getBacktestPlPerContract,
  scaleTradeValues,
  aggregateTradesByStrategy,
  scaleStrategyComparison,
  formatCurrency,
  formatPercent,
  getPlColorClass,
  getDayBackgroundStyle,
  calculateMaxAbsPl,
  getMonthGridDates,
  getWeekGridDates,
  groupDatesByWeek,
  StrategyDayComparison,
  // Centralized scaling functions
  createScalingContext,
  createScalingContextFromDay,
  getScaleFactor,
  scalePl,
  getScaledDayBacktestPl,
  getScaledDayActualPl,
  getScaledDayMargin,
  ScalingContext,
  Trade,
  ReportingTrade,
} from '@tradeblocks/lib'
import type { CalendarDayData, StrategyMatch } from '@tradeblocks/lib/stores'

// Helper to create a backtest trade (Trade from tradelog.csv)
function createBacktestTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date('2025-01-15'),
    timeOpened: '09:30:00',
    openingPrice: 100,
    legs: 'SPY 0DTE',
    premium: 500,
    pl: 200,
    numContracts: 1,
    fundsAtClose: 100000,
    marginReq: 5000,
    strategy: 'Test Strategy',
    openingCommissionsFees: 5,
    closingCommissionsFees: 5,
    openingShortLongRatio: 0,
    ...overrides,
  }
}

// Helper to create an actual trade (ReportingTrade from strategylog.csv)
function createActualTrade(overrides: Partial<ReportingTrade> = {}): ReportingTrade {
  return {
    strategy: 'Test Strategy',
    dateOpened: new Date('2025-01-15T09:30:00'),
    openingPrice: 100,
    legs: 'SPY 0DTE',
    initialPremium: 500,
    numContracts: 1,
    pl: 180,
    ...overrides,
  }
}

// Helper to create calendar day data
function createDayData(overrides: Partial<CalendarDayData> = {}): CalendarDayData {
  return {
    date: '2025-01-15',
    backtestTrades: [],
    actualTrades: [],
    backtestPl: 0,
    actualPl: 0,
    backtestTradeCount: 0,
    actualTradeCount: 0,
    hasBacktest: false,
    hasActual: false,
    matchedStrategies: [],
    unmatchedBacktestStrategies: [],
    unmatchedActualStrategies: [],
    totalMargin: 0,
    ...overrides,
  }
}

describe('Calendar Data Service', () => {
  describe('scaleBacktestPl', () => {
    it('should scale P&L to target contract count', () => {
      const trade = createBacktestTrade({ pl: 300, numContracts: 3 })
      expect(scaleBacktestPl(trade, 1)).toBe(100) // 300/3 * 1 = 100
      expect(scaleBacktestPl(trade, 6)).toBe(600) // 300/3 * 6 = 600
      expect(scaleBacktestPl(trade, 10)).toBe(1000) // 300/3 * 10 = 1000
    })

    it('should handle zero contracts', () => {
      const trade = createBacktestTrade({ pl: 300, numContracts: 0 })
      expect(scaleBacktestPl(trade, 5)).toBe(0)
    })

    it('should handle negative P&L', () => {
      const trade = createBacktestTrade({ pl: -300, numContracts: 3 })
      expect(scaleBacktestPl(trade, 1)).toBe(-100)
      expect(scaleBacktestPl(trade, 6)).toBe(-600)
    })
  })

  describe('getActualPlPerContract', () => {
    it('should calculate P&L per contract (no commissions in ReportingTrade)', () => {
      const trade = createActualTrade({
        pl: 200,
        numContracts: 2,
      })
      // Simple P/L division - ReportingTrade doesn't have commissions
      expect(getActualPlPerContract(trade)).toBe(100)
    })

    it('should handle zero contracts', () => {
      const trade = createActualTrade({ numContracts: 0 })
      expect(getActualPlPerContract(trade)).toBe(0)
    })
  })

  describe('getBacktestPlPerContract', () => {
    it('should calculate P&L per contract accounting for commissions', () => {
      const trade = createBacktestTrade({
        pl: 310,
        numContracts: 3,
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
      })
      // Net P/L = 310 - 10 = 300, per contract = 100
      expect(getBacktestPlPerContract(trade)).toBe(100)
    })

    it('should handle zero contracts', () => {
      const trade = createBacktestTrade({ numContracts: 0 })
      expect(getBacktestPlPerContract(trade)).toBe(0)
    })

    it('should handle undefined commissions', () => {
      const trade = createBacktestTrade({
        pl: 300,
        numContracts: 3,
        openingCommissionsFees: undefined,
        closingCommissionsFees: undefined,
      })
      expect(getBacktestPlPerContract(trade)).toBe(100)
    })
  })

  describe('scaleTradeValues', () => {
    describe('raw mode', () => {
      it('should return raw values without scaling', () => {
        const btTrade = createBacktestTrade({ pl: 300, numContracts: 3 })
        const actualTrade = createActualTrade({ pl: 800, numContracts: 8 })

        const result = scaleTradeValues(btTrade, actualTrade, 'raw')

        expect(result.backtest?.pl).toBe(300)
        expect(result.backtest?.contracts).toBe(3)
        expect(result.actual?.pl).toBe(800)
        expect(result.actual?.contracts).toBe(8)
        expect(result.slippage).toBeNull() // Not meaningful in raw mode
      })

      it('should handle null backtest trade', () => {
        const actualTrade = createActualTrade({ pl: 800, numContracts: 8 })
        const result = scaleTradeValues(null, actualTrade, 'raw')

        expect(result.backtest).toBeNull()
        expect(result.actual?.pl).toBe(800)
      })

      it('should handle null actual trade', () => {
        const btTrade = createBacktestTrade({ pl: 300, numContracts: 3 })
        const result = scaleTradeValues(btTrade, null, 'raw')

        expect(result.backtest?.pl).toBe(300)
        expect(result.actual).toBeNull()
      })
    })

    describe('perContract mode', () => {
      it('should normalize values to 1 contract', () => {
        // Trade (backtest) uses 'premium', ReportingTrade (actual) uses 'initialPremium'
        const btTrade = createBacktestTrade({
          pl: 310, // 300 net after 10 commission
          numContracts: 3,
          premium: 600,
          openingCommissionsFees: 5,
          closingCommissionsFees: 5,
        })
        const actualTrade = createActualTrade({
          pl: 800,
          numContracts: 8,
          initialPremium: 800,
        })

        const result = scaleTradeValues(btTrade, actualTrade, 'perContract')

        // Backtest: (310-10)/3 = 100 per contract (net of commissions)
        expect(result.backtest?.pl).toBe(100)
        expect(result.backtest?.contracts).toBe(1)
        expect(result.backtest?.premium).toBe(200) // 600/3

        // Actual: 800/8 = 100 per contract (no commissions in ReportingTrade)
        expect(result.actual?.pl).toBe(100)
        expect(result.actual?.contracts).toBe(1)
        expect(result.actual?.premium).toBe(100) // 800/8

        // Slippage: actual - backtest = 100 - 100 = 0
        expect(result.slippage).toBe(0)
      })

      it('should calculate slippage per contract', () => {
        const btTrade = createBacktestTrade({
          pl: 300,
          numContracts: 3,
          openingCommissionsFees: 0,
          closingCommissionsFees: 0,
        })
        const actualTrade = createActualTrade({
          pl: 240,
          numContracts: 3,
        })

        const result = scaleTradeValues(btTrade, actualTrade, 'perContract')

        // BT per contract: 100, Actual per contract: 80
        expect(result.backtest?.pl).toBe(100)
        expect(result.actual?.pl).toBe(80)
        expect(result.slippage).toBe(-20) // 80 - 100 = -20 (worse)
      })
    })

    describe('toReported mode', () => {
      it('should scale backtest DOWN to match actual (reported) contract count', () => {
        // Real-world: backtest (Trade) has large contracts, actual (ReportingTrade) has small contracts
        const btTrade = createBacktestTrade({
          pl: 1000,
          numContracts: 10,
          premium: 5000,
          openingCommissionsFees: 0,
          closingCommissionsFees: 0,
        })
        const actualTrade = createActualTrade({
          pl: 75,
          numContracts: 1,
          initialPremium: 500,
        })

        const result = scaleTradeValues(btTrade, actualTrade, 'toReported')

        // Scale BT DOWN to 1 contract: 1000 * (1/10) = 100
        expect(result.backtest?.pl).toBe(100)
        expect(result.backtest?.contracts).toBe(1)
        expect(result.backtest?.premium).toBe(500) // 5000 * (1/10)

        // Actual unchanged
        expect(result.actual?.pl).toBe(75)
        expect(result.actual?.contracts).toBe(1)

        // Slippage: actual - scaled backtest = 75 - 100 = -25 (worse)
        expect(result.slippage).toBe(-25)
      })

      it('should handle missing actual trade', () => {
        const btTrade = createBacktestTrade({ pl: 100, numContracts: 1 })
        const result = scaleTradeValues(btTrade, null, 'toReported')

        expect(result.backtest?.pl).toBe(100)
        expect(result.actual).toBeNull()
        expect(result.slippage).toBeNull()
      })

      it('should handle missing backtest trade', () => {
        const actualTrade = createActualTrade({ pl: 750, numContracts: 10 })
        const result = scaleTradeValues(null, actualTrade, 'toReported')

        expect(result.backtest).toBeNull()
        expect(result.actual?.pl).toBe(750)
        expect(result.slippage).toBeNull()
      })
    })
  })

  describe('aggregateTradesByStrategy', () => {
    it('should aggregate backtest trades by strategy', () => {
      const dayData = createDayData({
        date: '2025-01-15',
        backtestTrades: [
          createBacktestTrade({ strategy: 'Strategy A', pl: 100 }),
          createBacktestTrade({ strategy: 'Strategy A', pl: 150 }),
          createBacktestTrade({ strategy: 'Strategy B', pl: 200 }),
        ],
        hasBacktest: true,
        backtestTradeCount: 3,
      })

      const result = aggregateTradesByStrategy(dayData, [])

      expect(result).toHaveLength(2)

      const stratA = result.find(r => r.strategy === 'Strategy A')
      expect(stratA?.backtest?.totalPl).toBe(250) // 100 + 150
      expect(stratA?.backtest?.tradeCount).toBe(2)

      const stratB = result.find(r => r.strategy === 'Strategy B')
      expect(stratB?.backtest?.totalPl).toBe(200)
      expect(stratB?.backtest?.tradeCount).toBe(1)
    })

    it('should match backtest and actual by strategy mapping', () => {
      const dayData = createDayData({
        date: '2025-01-15',
        backtestTrades: [
          createBacktestTrade({ strategy: 'BT Strategy', pl: 100 }),
        ],
        actualTrades: [
          createActualTrade({ strategy: 'Live Strategy', pl: 90 }),
        ],
        hasBacktest: true,
        hasActual: true,
      })

      const matches: StrategyMatch[] = [{
        backtestStrategy: 'BT Strategy',
        actualStrategy: 'Live Strategy',
        isAutoMatched: false,
      }]

      const result = aggregateTradesByStrategy(dayData, matches)

      expect(result).toHaveLength(1)
      expect(result[0].strategy).toBe('BT Strategy')
      expect(result[0].isMatched).toBe(true)
      expect(result[0].backtest?.totalPl).toBe(100)
      expect(result[0].actual?.totalPl).toBe(90)
      expect(result[0].scaled.slippage).toBe(-10)
    })

    it('should include unmatched actual strategies separately', () => {
      const dayData = createDayData({
        date: '2025-01-15',
        backtestTrades: [
          createBacktestTrade({ strategy: 'Strategy A', pl: 100 }),
        ],
        actualTrades: [
          createActualTrade({ strategy: 'Strategy B', pl: 200 }),
        ],
        hasBacktest: true,
        hasActual: true,
      })

      const result = aggregateTradesByStrategy(dayData, [])

      expect(result).toHaveLength(2)

      const stratA = result.find(r => r.strategy === 'Strategy A')
      expect(stratA?.backtest?.totalPl).toBe(100)
      expect(stratA?.actual).toBeNull()
      expect(stratA?.isMatched).toBe(false)

      const stratB = result.find(r => r.strategy === 'Strategy B')
      expect(stratB?.backtest).toBeNull()
      expect(stratB?.actual?.totalPl).toBe(200)
      expect(stratB?.isMatched).toBe(false)
    })

    it('should sort results by strategy name', () => {
      const dayData = createDayData({
        backtestTrades: [
          createBacktestTrade({ strategy: 'Zebra' }),
          createBacktestTrade({ strategy: 'Alpha' }),
          createBacktestTrade({ strategy: 'Middle' }),
        ],
        hasBacktest: true,
      })

      const result = aggregateTradesByStrategy(dayData, [])

      expect(result.map(r => r.strategy)).toEqual(['Alpha', 'Middle', 'Zebra'])
    })
  })

  describe('scaleStrategyComparison', () => {
    // Real-world scenario: backtest runs 10 contracts, actual runs 1
    // unitContracts = first trade's count (the strategy unit size)
    const createComparison = (): StrategyDayComparison => ({
      strategy: 'Test',
      date: '2025-01-15',
      backtest: {
        trades: [],
        totalPl: 1000,      // $1000 with 10 contracts
        totalPremium: 5000,
        totalContracts: 10, // Sum (could be multiple trades)
        unitContracts: 10,  // First trade's count (strategy unit size)
        tradeCount: 1,
        totalCommissions: 0,
      },
      actual: {
        trades: [],
        totalPl: 75,        // $75 with 1 contract
        totalPremium: 500,
        totalContracts: 1,  // Sum
        unitContracts: 1,   // First trade's count (strategy unit size)
        tradeCount: 1,
      },
      isMatched: true,
      scaled: {
        backtestPl: 1000,
        actualPl: 75,
        slippage: -925,
        slippagePercent: -92.5,
      },
    })

    it('should return unchanged for raw mode', () => {
      const comparison = createComparison()
      const result = scaleStrategyComparison(comparison, 'raw')

      expect(result.scaled.backtestPl).toBe(1000)
      expect(result.scaled.actualPl).toBe(75)
    })

    it('should normalize to per-contract in perContract mode', () => {
      const comparison = createComparison()
      const result = scaleStrategyComparison(comparison, 'perContract')

      // BT: 1000/10 = 100 per contract
      expect(result.scaled.backtestPl).toBe(100)
      // Actual: 75/1 = 75 per contract
      expect(result.scaled.actualPl).toBe(75)
      // Slippage: 75 - 100 = -25
      expect(result.scaled.slippage).toBe(-25)
      // Slippage %: -25 / 100 * 100 = -25%
      expect(result.scaled.slippagePercent).toBe(-25)
    })

    it('should scale backtest DOWN to match actual in toReported mode', () => {
      const comparison = createComparison()
      const result = scaleStrategyComparison(comparison, 'toReported')

      // BT scaled DOWN: 1000 * (1/10) = 100
      expect(result.scaled.backtestPl).toBe(100)
      // Actual unchanged
      expect(result.scaled.actualPl).toBe(75)
      // Slippage: 75 - 100 = -25 (actual underperformed)
      expect(result.scaled.slippage).toBe(-25)
    })

    it('should use unitContracts not totalContracts for scaling', () => {
      // Scenario: multiple trades in same strategy
      // totalContracts = sum (30), unitContracts = first trade's count (10)
      const comparison: StrategyDayComparison = {
        strategy: 'Test',
        date: '2025-01-15',
        backtest: {
          trades: [],
          totalPl: 300,
          totalPremium: 1500,
          totalContracts: 30, // 3 trades × 10 contracts each
          unitContracts: 10,  // First trade's count
          tradeCount: 3,
          totalCommissions: 0,
        },
        actual: {
          trades: [],
          totalPl: 25,
          totalPremium: 150,
          totalContracts: 3,  // 3 trades × 1 contract each
          unitContracts: 1,   // First trade's count
          tradeCount: 3,
        },
        isMatched: true,
        scaled: { backtestPl: 300, actualPl: 25, slippage: null, slippagePercent: null },
      }

      const result = scaleStrategyComparison(comparison, 'toReported')

      // Should use unitContracts (1/10 = 0.1), NOT totalContracts (3/30 = 0.1)
      // (Same in this case, but the point is it uses unitContracts)
      // BT scaled: 300 * (1/10) = 30
      expect(result.scaled.backtestPl).toBe(30)
      expect(result.scaled.actualPl).toBe(25)
      expect(result.scaled.slippage).toBe(-5)
    })

    it('should handle missing backtest in toReported mode', () => {
      const comparison: StrategyDayComparison = {
        strategy: 'Test',
        date: '2025-01-15',
        backtest: null,
        actual: {
          trades: [],
          totalPl: 75,
          totalPremium: 500,
          totalContracts: 1,
          unitContracts: 1,
          tradeCount: 1,
        },
        isMatched: false,
        scaled: {
          backtestPl: null,
          actualPl: 75,
          slippage: null,
          slippagePercent: null,
        },
      }
      const result = scaleStrategyComparison(comparison, 'toReported')

      // Returns unchanged when backtest is missing
      expect(result.scaled.backtestPl).toBeNull()
      expect(result.scaled.actualPl).toBe(75)
    })
  })

  describe('formatCurrency', () => {
    it('should format positive values', () => {
      expect(formatCurrency(1234)).toBe('$1,234')
      expect(formatCurrency(0)).toBe('$0')
    })

    it('should format negative values', () => {
      expect(formatCurrency(-1234)).toBe('-$1,234')
    })

    it('should format compact values', () => {
      expect(formatCurrency(1500, true)).toBe('$1.5K')
      expect(formatCurrency(1500000, true)).toBe('$1.50M')
      expect(formatCurrency(-2500, true)).toBe('-$2.5K')
    })

    it('should not compact small values', () => {
      expect(formatCurrency(500, true)).toBe('$500')
    })
  })

  describe('formatPercent', () => {
    it('should format positive percentages with plus sign', () => {
      expect(formatPercent(10.5)).toBe('+10.5%')
      expect(formatPercent(0)).toBe('+0.0%')
    })

    it('should format negative percentages', () => {
      expect(formatPercent(-10.5)).toBe('-10.5%')
    })
  })

  describe('getPlColorClass', () => {
    it('should return green for positive', () => {
      expect(getPlColorClass(100)).toBe('text-green-500')
    })

    it('should return red for negative', () => {
      expect(getPlColorClass(-100)).toBe('text-red-500')
    })

    it('should return muted for zero', () => {
      expect(getPlColorClass(0)).toBe('text-muted-foreground')
    })
  })

  describe('getDayBackgroundStyle', () => {
    it('should return empty for null values', () => {
      expect(getDayBackgroundStyle(null, null)).toEqual({})
    })

    it('should return empty for zero P/L', () => {
      expect(getDayBackgroundStyle(0, 0)).toEqual({})
      expect(getDayBackgroundStyle(null, 0)).toEqual({})
    })

    it('should return green for positive P/L', () => {
      expect(getDayBackgroundStyle(null, 100)).toEqual({ className: 'bg-green-900/25' })
      expect(getDayBackgroundStyle(100, null)).toEqual({ className: 'bg-green-900/25' })
    })

    it('should return red for negative P/L', () => {
      expect(getDayBackgroundStyle(null, -100)).toEqual({ className: 'bg-red-900/25' })
      expect(getDayBackgroundStyle(-100, null)).toEqual({ className: 'bg-red-900/25' })
    })

    it('should return violet for mismatched P/L signs', () => {
      // backtest positive, actual negative
      expect(getDayBackgroundStyle(100, -50)).toEqual({ className: 'bg-violet-900/25' })
      // backtest negative, actual positive
      expect(getDayBackgroundStyle(-100, 50)).toEqual({ className: 'bg-violet-900/25' })
    })

    it('should prefer actual P/L when both exist with same sign', () => {
      // Both positive - uses actual
      expect(getDayBackgroundStyle(100, 50)).toEqual({ className: 'bg-green-900/25' })
      // Both negative - uses actual
      expect(getDayBackgroundStyle(-100, -50)).toEqual({ className: 'bg-red-900/25' })
    })
  })

  describe('calculateMaxAbsPl', () => {
    it('should find max absolute P/L across days', () => {
      const days = new Map<string, CalendarDayData>([
        ['2025-01-01', createDayData({ backtestPl: 100, hasBacktest: true })],
        ['2025-01-02', createDayData({ actualPl: -500, hasActual: true })],
        ['2025-01-03', createDayData({ backtestPl: 300, hasBacktest: true })],
      ])

      expect(calculateMaxAbsPl(days)).toBe(500)
    })

    it('should prefer actual P/L when both exist', () => {
      const days = new Map<string, CalendarDayData>([
        ['2025-01-01', createDayData({
          backtestPl: 1000,
          actualPl: 200,
          hasBacktest: true,
          hasActual: true,
        })],
      ])

      expect(calculateMaxAbsPl(days)).toBe(200)
    })

    it('should return 0 for empty map', () => {
      const days = new Map<string, CalendarDayData>()
      expect(calculateMaxAbsPl(days)).toBe(0)
    })
  })

  describe('getMonthGridDates', () => {
    it('should return full weeks for the month', () => {
      // January 2025 starts on Wednesday, ends on Friday
      const dates = getMonthGridDates(2025, 0)

      // Should start on Sunday Dec 29, 2024
      expect(dates[0].getDate()).toBe(29)
      expect(dates[0].getMonth()).toBe(11) // December

      // Should end on Saturday Feb 1, 2025
      const lastDate = dates[dates.length - 1]
      expect(lastDate.getDate()).toBe(1)
      expect(lastDate.getMonth()).toBe(1) // February

      // Should be 5 weeks = 35 days
      expect(dates.length).toBe(35)
    })

    it('should handle months starting on Sunday', () => {
      // June 2025 starts on Sunday
      const dates = getMonthGridDates(2025, 5)

      expect(dates[0].getDate()).toBe(1)
      expect(dates[0].getMonth()).toBe(5) // June
    })
  })

  describe('getWeekGridDates', () => {
    it('should return 7 days starting from Sunday', () => {
      const date = new Date('2025-01-15') // Wednesday
      const dates = getWeekGridDates(date)

      expect(dates.length).toBe(7)
      // Should start on Sunday Jan 12
      expect(dates[0].getDate()).toBe(12)
      expect(dates[0].getDay()).toBe(0) // Sunday
      // Should end on Saturday Jan 18
      expect(dates[6].getDate()).toBe(18)
      expect(dates[6].getDay()).toBe(6) // Saturday
    })

    it('should handle date on Sunday', () => {
      // Use explicit local date to avoid timezone issues
      const date = new Date(2025, 0, 12) // Sunday Jan 12
      const dates = getWeekGridDates(date)

      expect(dates[0].getDay()).toBe(0) // First day is Sunday
      expect(dates[6].getDay()).toBe(6) // Last day is Saturday
      expect(dates.length).toBe(7)
    })

    it('should handle date on Saturday', () => {
      // Use explicit local date to avoid timezone issues
      const date = new Date(2025, 0, 18) // Saturday Jan 18
      const dates = getWeekGridDates(date)

      expect(dates[0].getDay()).toBe(0) // First day is Sunday
      expect(dates[6].getDay()).toBe(6) // Last day is Saturday
      expect(dates.length).toBe(7)
    })
  })

  describe('groupDatesByWeek', () => {
    it('should group dates by ISO week number', () => {
      // Use explicit local dates to avoid timezone issues
      const dates = [
        new Date(2025, 0, 6), // Monday, Week 2
        new Date(2025, 0, 7), // Tuesday, Week 2
        new Date(2025, 0, 13), // Monday, Week 3
        new Date(2025, 0, 14), // Tuesday, Week 3
        new Date(2025, 0, 15), // Wednesday, Week 3
      ]

      const grouped = groupDatesByWeek(dates)

      // Should have 2 distinct weeks
      expect(grouped.size).toBe(2)

      // Each group should have correct count
      const weekCounts = Array.from(grouped.values()).map(v => v.length).sort()
      expect(weekCounts).toEqual([2, 3])
    })
  })

  // ==========================================================================
  // Centralized Scaling Functions Tests
  // ==========================================================================

  describe('Centralized Scaling Functions', () => {
    describe('createScalingContext', () => {
      it('should extract contract counts from first trade of each array', () => {
        const backtestTrades = [
          createBacktestTrade({ numContracts: 10 }),
          createBacktestTrade({ numContracts: 5 }),
        ]
        const actualTrades = [
          createActualTrade({ numContracts: 1 }),
          createActualTrade({ numContracts: 2 }),
        ]

        const context = createScalingContext(backtestTrades, actualTrades)

        expect(context.btContracts).toBe(15) // Sum of all backtest contracts
        expect(context.actualContracts).toBe(3) // Sum of all actual contracts
        expect(context.hasBacktest).toBe(true)
        expect(context.hasActual).toBe(true)
      })

      it('should handle empty arrays', () => {
        const context = createScalingContext([], [])

        expect(context.btContracts).toBe(0)
        expect(context.actualContracts).toBe(0)
        expect(context.hasBacktest).toBe(false)
        expect(context.hasActual).toBe(false)
      })

      it('should handle only backtest trades', () => {
        const backtestTrades = [createBacktestTrade({ numContracts: 5 })]

        const context = createScalingContext(backtestTrades, [])

        expect(context.btContracts).toBe(5)
        expect(context.actualContracts).toBe(0)
        expect(context.hasBacktest).toBe(true)
        expect(context.hasActual).toBe(false)
      })

      it('should handle only actual trades', () => {
        const actualTrades = [createActualTrade({ numContracts: 2 })]

        const context = createScalingContext([], actualTrades)

        expect(context.btContracts).toBe(0)
        expect(context.actualContracts).toBe(2)
        expect(context.hasBacktest).toBe(false)
        expect(context.hasActual).toBe(true)
      })
    })

    describe('createScalingContextFromDay', () => {
      it('should create context from CalendarDayData', () => {
        const dayData = createDayData({
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasBacktest: true,
          hasActual: true,
        })

        const context = createScalingContextFromDay(dayData)

        expect(context.btContracts).toBe(10)
        expect(context.actualContracts).toBe(1)
        expect(context.hasBacktest).toBe(true)
        expect(context.hasActual).toBe(true)
      })
    })

    describe('getScaleFactor', () => {
      const contextWithBoth: ScalingContext = {
        btContracts: 10,
        actualContracts: 1,
        hasBacktest: true,
        hasActual: true,
      }

      describe('raw mode', () => {
        it('should return null for both backtest and actual', () => {
          expect(getScaleFactor(contextWithBoth, 'raw', 'backtest')).toBeNull()
          expect(getScaleFactor(contextWithBoth, 'raw', 'actual')).toBeNull()
        })
      })

      describe('perContract mode', () => {
        it('should return 1/contracts for backtest', () => {
          // 1/10 = 0.1
          expect(getScaleFactor(contextWithBoth, 'perContract', 'backtest')).toBe(0.1)
        })

        it('should return 1/contracts for actual', () => {
          // 1/1 = 1
          expect(getScaleFactor(contextWithBoth, 'perContract', 'actual')).toBe(1)
        })

        it('should return null for zero contracts', () => {
          const contextZeroBt: ScalingContext = {
            btContracts: 0,
            actualContracts: 5,
            hasBacktest: false,
            hasActual: true,
          }
          expect(getScaleFactor(contextZeroBt, 'perContract', 'backtest')).toBeNull()
        })
      })

      describe('toReported mode', () => {
        it('should scale backtest DOWN to match actual contract count', () => {
          // actualContracts / btContracts = 1 / 10 = 0.1
          expect(getScaleFactor(contextWithBoth, 'toReported', 'backtest')).toBe(0.1)
        })

        it('should return null for actual (no scaling needed)', () => {
          expect(getScaleFactor(contextWithBoth, 'toReported', 'actual')).toBeNull()
        })

        it('should return null when backtest contracts is zero', () => {
          const context: ScalingContext = {
            btContracts: 0,
            actualContracts: 5,
            hasBacktest: false,
            hasActual: true,
          }
          expect(getScaleFactor(context, 'toReported', 'backtest')).toBeNull()
        })

        it('should return null when actual contracts is zero', () => {
          const context: ScalingContext = {
            btContracts: 10,
            actualContracts: 0,
            hasBacktest: true,
            hasActual: false,
          }
          expect(getScaleFactor(context, 'toReported', 'backtest')).toBeNull()
        })
      })
    })

    describe('scalePl', () => {
      it('should multiply P&L by scale factor', () => {
        expect(scalePl(1000, 0.1)).toBe(100)
        expect(scalePl(1000, 2)).toBe(2000)
        expect(scalePl(-500, 0.5)).toBe(-250)
      })

      it('should return unchanged P&L when scale factor is null', () => {
        expect(scalePl(1000, null)).toBe(1000)
        expect(scalePl(-500, null)).toBe(-500)
      })

      it('should handle zero P&L', () => {
        expect(scalePl(0, 0.5)).toBe(0)
        expect(scalePl(0, null)).toBe(0)
      })
    })

    describe('getScaledDayBacktestPl', () => {
      it('should return 0 when no backtest data', () => {
        const dayData = createDayData({ hasBacktest: false, backtestPl: 1000 })
        expect(getScaledDayBacktestPl(dayData, 'raw')).toBe(0)
      })

      it('should return raw value in raw mode', () => {
        const dayData = createDayData({
          backtestPl: 1000,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasBacktest: true,
          hasActual: true,
        })
        expect(getScaledDayBacktestPl(dayData, 'raw')).toBe(1000)
      })

      it('should return per-contract value in perContract mode', () => {
        const dayData = createDayData({
          backtestPl: 1000,
          // Trade P&L must match backtestPl since implementation recalculates from trades
          backtestTrades: [createBacktestTrade({ numContracts: 10, pl: 1000 })],
          hasBacktest: true,
        })
        // 1000 * (1/10) = 100
        expect(getScaledDayBacktestPl(dayData, 'perContract')).toBe(100)
      })

      it('should scale DOWN to actual in toReported mode', () => {
        const dayData = createDayData({
          backtestPl: 1000,
          // Trade P&L must match backtestPl since implementation recalculates from trades
          backtestTrades: [createBacktestTrade({ numContracts: 10, pl: 1000 })],
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasBacktest: true,
          hasActual: true,
        })
        // 1000 * (1/10) = 100 (scaled to match actual's 1 contract)
        const strategyMatches: StrategyMatch[] = [{ backtestStrategy: 'Test Strategy', actualStrategy: 'Test Strategy', isAutoMatched: false }]
        expect(getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)).toBe(100)
      })
    })

    describe('getScaledDayActualPl', () => {
      it('should return 0 when no actual data', () => {
        const dayData = createDayData({ hasActual: false, actualPl: 500 })
        expect(getScaledDayActualPl(dayData, 'raw')).toBe(0)
      })

      it('should return raw value in raw mode', () => {
        const dayData = createDayData({
          actualPl: 75,
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasActual: true,
        })
        expect(getScaledDayActualPl(dayData, 'raw')).toBe(75)
      })

      it('should return per-contract value in perContract mode', () => {
        const dayData = createDayData({
          actualPl: 200,
          // Trade P&L must match actualPl since implementation recalculates from trades
          actualTrades: [createActualTrade({ numContracts: 2, pl: 200 })],
          hasActual: true,
        })
        // 200 * (1/2) = 100
        expect(getScaledDayActualPl(dayData, 'perContract')).toBe(100)
      })

      it('should return unchanged value in toReported mode', () => {
        const dayData = createDayData({
          actualPl: 75,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasBacktest: true,
          hasActual: true,
        })
        // Actual is unchanged in toReported mode
        expect(getScaledDayActualPl(dayData, 'toReported')).toBe(75)
      })
    })

    describe('getScaledDayMargin', () => {
      it('should return 0 when no backtest data', () => {
        const dayData = createDayData({ hasBacktest: false, totalMargin: 5000 })
        expect(getScaledDayMargin(dayData, 'raw')).toBe(0)
      })

      it('should return 0 when margin is zero', () => {
        const dayData = createDayData({
          hasBacktest: true,
          totalMargin: 0,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
        })
        expect(getScaledDayMargin(dayData, 'raw')).toBe(0)
      })

      it('should return raw margin in raw mode', () => {
        const dayData = createDayData({
          totalMargin: 5000,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          hasBacktest: true,
        })
        expect(getScaledDayMargin(dayData, 'raw')).toBe(5000)
      })

      it('should return per-contract margin in perContract mode', () => {
        const dayData = createDayData({
          totalMargin: 5000,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          hasBacktest: true,
        })
        // 5000 * (1/10) = 500
        expect(getScaledDayMargin(dayData, 'perContract')).toBe(500)
      })

      it('should scale margin DOWN in toReported mode', () => {
        const dayData = createDayData({
          totalMargin: 5000,
          backtestTrades: [createBacktestTrade({ numContracts: 10 })],
          actualTrades: [createActualTrade({ numContracts: 1 })],
          hasBacktest: true,
          hasActual: true,
        })
        // 5000 * (1/10) = 500 (scaled to match actual's 1 contract)
        expect(getScaledDayMargin(dayData, 'toReported')).toBe(500)
      })
    })

    describe('Scaling consistency - verifying centralized logic', () => {
      it('should scale backtest DOWN when actual has fewer contracts (common case)', () => {
        // Real-world scenario: backtest runs 10 contracts, actual runs 1
        const dayData = createDayData({
          backtestPl: 1000,     // $1000 profit with 10 contracts
          actualPl: 75,         // $75 profit with 1 contract
          totalMargin: 50000,   // $50,000 margin for 10 contracts
          // Trade P&L and marginReq must match day totals since implementation recalculates from trades
          backtestTrades: [createBacktestTrade({ numContracts: 10, pl: 1000, marginReq: 50000 })],
          actualTrades: [createActualTrade({ numContracts: 1, pl: 75 })],
          hasBacktest: true,
          hasActual: true,
        })

        // Strategy matches required for toReported mode scaling
        const strategyMatches: StrategyMatch[] = [{ backtestStrategy: 'Test Strategy', actualStrategy: 'Test Strategy', isAutoMatched: false }]

        // In toReported mode:
        // - Backtest should scale DOWN by factor of 1/10
        // - Actual stays unchanged
        expect(getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)).toBe(100) // 1000 * 0.1
        expect(getScaledDayActualPl(dayData, 'toReported')).toBe(75)    // unchanged
        expect(getScaledDayMargin(dayData, 'toReported')).toBe(5000)    // 50000 * 0.1

        // Slippage calculation would be: 75 - 100 = -25 (actual underperformed)
        const scaledBtPl = getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)
        const scaledActualPl = getScaledDayActualPl(dayData, 'toReported')
        const slippage = scaledActualPl - scaledBtPl
        expect(slippage).toBe(-25)
      })

      it('should use sum of all contract counts for accurate scaling', () => {
        // Multiple trades on same day - should use SUM of all contracts
        const dayData = createDayData({
          backtestPl: 300,
          backtestTrades: [
            createBacktestTrade({ numContracts: 10, pl: 100 }), // First trade: 10 contracts
            createBacktestTrade({ numContracts: 10, pl: 100 }), // Second trade: 10 contracts
            createBacktestTrade({ numContracts: 10, pl: 100 }), // Third trade: 10 contracts
          ],
          actualTrades: [
            createActualTrade({ numContracts: 1, pl: 25 }), // First trade: 1 contract
            createActualTrade({ numContracts: 1, pl: 25 }), // Second trade: 1 contract
          ],
          hasBacktest: true,
          hasActual: true,
        })

        // Scale factor should be 2/30 (sum of contracts)
        const context = createScalingContextFromDay(dayData)
        expect(context.btContracts).toBe(30)      // Sum of 10+10+10
        expect(context.actualContracts).toBe(2)   // Sum of 1+1

        // toReported scaling: 300 * (2/30) = 20
        const strategyMatches: StrategyMatch[] = [{ backtestStrategy: 'Test Strategy', actualStrategy: 'Test Strategy', isAutoMatched: false }]
        expect(getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)).toBe(20)
      })

      it('should scale each strategy separately when day has multiple strategies', () => {
        // Real scenario: day has 2 different strategies with different contract counts
        // Strategy A: backtest 10 contracts @ $500, actual 1 contract
        // Strategy B: backtest 5 contracts @ $200, actual 2 contracts
        const dayData = createDayData({
          backtestPl: 700,  // 500 + 200
          actualPl: 120,    // 60 + 60 (example values)
          backtestTrades: [
            createBacktestTrade({ strategy: 'Strategy A', numContracts: 10, pl: 500, marginReq: 10000 }),
            createBacktestTrade({ strategy: 'Strategy B', numContracts: 5, pl: 200, marginReq: 5000 }),
          ],
          actualTrades: [
            createActualTrade({ strategy: 'Strategy A', numContracts: 1, pl: 60 }),
            createActualTrade({ strategy: 'Strategy B', numContracts: 2, pl: 60 }),
          ],
          totalMargin: 15000,
          hasBacktest: true,
          hasActual: true,
        })

        // Strategy matches for both strategies
        const strategyMatches: StrategyMatch[] = [
          { backtestStrategy: 'Strategy A', actualStrategy: 'Strategy A', isAutoMatched: false },
          { backtestStrategy: 'Strategy B', actualStrategy: 'Strategy B', isAutoMatched: false },
        ]

        // Raw mode: returns pre-aggregated totals
        expect(getScaledDayBacktestPl(dayData, 'raw')).toBe(700)
        expect(getScaledDayActualPl(dayData, 'raw')).toBe(120)

        // perContract mode: each strategy scaled by own contracts, then summed
        // Strategy A: 500 / 10 = 50
        // Strategy B: 200 / 5 = 40
        // Total: 50 + 40 = 90
        expect(getScaledDayBacktestPl(dayData, 'perContract')).toBe(90)

        // Actual perContract:
        // Strategy A: 60 / 1 = 60
        // Strategy B: 60 / 2 = 30
        // Total: 60 + 30 = 90
        expect(getScaledDayActualPl(dayData, 'perContract')).toBe(90)

        // toReported mode: backtest scaled to match actual contract count per strategy
        // Strategy A: 500 * (1/10) = 50
        // Strategy B: 200 * (2/5) = 80
        // Total: 50 + 80 = 130
        expect(getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)).toBe(130)

        // Actual is unchanged in toReported
        expect(getScaledDayActualPl(dayData, 'toReported')).toBe(120)

        // Margin in toReported:
        // Strategy A: 10000 * (1/10) = 1000
        // Strategy B: 5000 * (2/5) = 2000
        // Total: 1000 + 2000 = 3000
        expect(getScaledDayMargin(dayData, 'toReported')).toBe(3000)
      })

      it('should handle unmatched strategies in toReported mode', () => {
        // Strategy exists in backtest but not in actual
        const dayData = createDayData({
          backtestPl: 500,
          backtestTrades: [
            createBacktestTrade({ strategy: 'Matched', numContracts: 10, pl: 300 }),
            createBacktestTrade({ strategy: 'Unmatched', numContracts: 5, pl: 200 }),
          ],
          actualTrades: [
            createActualTrade({ strategy: 'Matched', numContracts: 1, pl: 25 }),
          ],
          hasBacktest: true,
          hasActual: true,
        })

        // Only the 'Matched' strategy has a match - 'Unmatched' falls back to raw
        const strategyMatches: StrategyMatch[] = [{ backtestStrategy: 'Matched', actualStrategy: 'Matched', isAutoMatched: false }]

        // toReported mode:
        // Matched strategy: 300 * (1/10) = 30
        // Unmatched strategy: no actual → uses raw value = 200
        // Total: 30 + 200 = 230
        expect(getScaledDayBacktestPl(dayData, 'toReported', strategyMatches)).toBe(230)
      })
    })
  })
})
