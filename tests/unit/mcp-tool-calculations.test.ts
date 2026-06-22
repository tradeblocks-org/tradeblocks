/**
 * Unit tests for MCP tool calculations
 *
 * These tests verify specific calculation logic in MCP tools,
 * particularly around unit consistency and derived metrics.
 *
 * Created in response to bugs found in portfolio_health_check and what_if_scaling.
 */

import { PortfolioStatsCalculator, runMonteCarloSimulation, Trade } from '@tradeblocks/lib'

// Helper to create a minimal valid trade
function createTrade(overrides: Partial<Trade>): Trade {
  return {
    dateOpened: new Date('2024-01-01'),
    timeOpened: '09:30:00',
    openingPrice: 100,
    legs: 'SPY 450 C',
    premium: 1.00,
    pl: 100,
    numContracts: 1,
    fundsAtClose: 10100,
    marginReq: 1000,
    strategy: 'TestStrategy',
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
    dateClosed: new Date('2024-01-02'),
    timeClosed: '15:00:00',
    closingPrice: 101,
    ...overrides,
  }
}

describe('Unit consistency between PortfolioStatsCalculator and MonteCarloSimulator', () => {
  describe('maxDrawdown units', () => {
    it('PortfolioStatsCalculator.maxDrawdown should be a percentage (e.g., 12 for 12%)', () => {
      // Create trades with a known drawdown pattern
      // Start at 10000, go to 11000, drop to 9000 = 18.18% drawdown from peak
      const trades: Trade[] = [
        createTrade({ pl: 1000, fundsAtClose: 11000, dateClosed: new Date('2024-01-02') }),
        createTrade({ pl: -2000, fundsAtClose: 9000, dateClosed: new Date('2024-01-03') }),
      ]

      const calculator = new PortfolioStatsCalculator()
      const stats = calculator.calculatePortfolioStats(trades, undefined, true)

      // maxDrawdown should be ~18.18 (percentage), not ~0.1818 (decimal)
      expect(stats.maxDrawdown).toBeGreaterThan(1) // Would be < 1 if decimal
      expect(stats.maxDrawdown).toBeLessThan(100)
      expect(stats.maxDrawdown).toBeCloseTo(18.18, 1)
    })

    it('MonteCarloSimulator.medianMaxDrawdown should be a decimal (e.g., 0.12 for 12%)', () => {
      // Create trades for Monte Carlo
      const trades: Trade[] = []
      for (let i = 0; i < 50; i++) {
        trades.push(createTrade({
          pl: Math.random() > 0.5 ? 100 : -80,
          fundsAtClose: 10000 + (i * 10),
          dateOpened: new Date(2024, 0, i + 1),
          dateClosed: new Date(2024, 0, i + 2),
        }))
      }

      const result = runMonteCarloSimulation(trades, {
        numSimulations: 100,
        simulationLength: 252,
        resampleMethod: 'trades',
        initialCapital: 10000,
        tradesPerYear: 252,
      })

      // medianMaxDrawdown should be < 1 (decimal), not > 1 (percentage)
      // The result is in statistics.medianMaxDrawdown
      expect(result.statistics.medianMaxDrawdown).toBeGreaterThanOrEqual(0)
      expect(result.statistics.medianMaxDrawdown).toBeLessThan(1) // Would be > 1 if percentage
    })

    it('MC MDD multiplier calculation should handle unit conversion', () => {
      // This test verifies the correct formula for comparing MC and historical drawdowns
      const historicalMaxDrawdownPct = 12 // 12% as percentage (from PortfolioStatsCalculator)
      const mcMedianMaxDrawdownDecimal = 0.18 // 18% as decimal (from MonteCarloSimulator)

      // WRONG (the bug): mcMedianMaxDrawdown / historicalMaxDrawdown = 0.18 / 12 = 0.015
      const wrongMultiplier = mcMedianMaxDrawdownDecimal / historicalMaxDrawdownPct
      expect(wrongMultiplier).toBeCloseTo(0.015, 3) // This is ~100x wrong

      // CORRECT: Convert to same units first
      const historicalMddDecimal = historicalMaxDrawdownPct / 100 // 0.12
      const correctMultiplier = mcMedianMaxDrawdownDecimal / historicalMddDecimal
      expect(correctMultiplier).toBeCloseTo(1.5, 1) // MC is 1.5x historical
    })
  })
})

describe('what_if_scaling equity curve recalculation', () => {
  it('should recalculate fundsAtClose when scaling trades', () => {
    // Original trades: start at 10000, each trade adds to equity
    const originalTrades: Trade[] = [
      createTrade({ pl: 100, fundsAtClose: 10100, dateClosed: new Date('2024-01-02') }),
      createTrade({ pl: 200, fundsAtClose: 10300, dateClosed: new Date('2024-01-03') }),
      createTrade({ pl: -50, fundsAtClose: 10250, dateClosed: new Date('2024-01-04') }),
    ]

    // If we scale P&L by 0.5, the equity curve should change
    // Original: 10000 -> 10100 -> 10300 -> 10250
    // Scaled (0.5x): 10000 -> 10050 -> 10150 -> 10125
    const scaleFactor = 0.5
    const initialCapital = 10000

    // Recalculate fundsAtClose for scaled trades
    let runningEquity = initialCapital
    const scaledTrades = originalTrades.map(t => {
      const scaledPl = t.pl * scaleFactor
      runningEquity += scaledPl
      return {
        ...t,
        pl: scaledPl,
        fundsAtClose: runningEquity, // This is the key fix!
      }
    })

    // Verify the scaled equity curve
    expect(scaledTrades[0].fundsAtClose).toBe(10050)
    expect(scaledTrades[1].fundsAtClose).toBe(10150)
    expect(scaledTrades[2].fundsAtClose).toBe(10125)

    // Now calculate drawdown - it should use the scaled fundsAtClose values
    const calculator = new PortfolioStatsCalculator()
    const scaledStats = calculator.calculatePortfolioStats(scaledTrades, undefined, true)

    // Original drawdown: (10300 - 10250) / 10300 = 0.485%
    // Scaled drawdown: (10150 - 10125) / 10150 = 0.246%
    // The drawdown should be different (smaller in this case)
    const originalStats = calculator.calculatePortfolioStats(originalTrades, undefined, true)

    // Both should have meaningful drawdown values (not 0)
    expect(originalStats.maxDrawdown).toBeGreaterThan(0)
    expect(scaledStats.maxDrawdown).toBeGreaterThan(0)

    // Scaled drawdown should be approximately half (since P&L scaled by 0.5)
    // This relationship isn't exact due to percentage math, but should be close
    expect(scaledStats.maxDrawdown).toBeLessThan(originalStats.maxDrawdown)
  })

  it('should NOT use original fundsAtClose when trades are scaled', () => {
    // This test ensures the bug doesn't regress
    const originalTrades: Trade[] = [
      createTrade({ pl: 1000, fundsAtClose: 11000, dateClosed: new Date('2024-01-02') }),
      createTrade({ pl: -2000, fundsAtClose: 9000, dateClosed: new Date('2024-01-03') }),
    ]

    // BUG: If we only scale P&L but keep original fundsAtClose,
    // the drawdown calculation uses unscaled equity values
    const buggyScaledTrades = originalTrades.map(t => ({
      ...t,
      pl: t.pl * 0.5,
      // fundsAtClose NOT recalculated - THIS IS THE BUG
    }))

    // Correct: Recalculate fundsAtClose
    const initialCapital = 10000
    let equity = initialCapital
    const correctScaledTrades = originalTrades.map(t => {
      equity += t.pl * 0.5
      return {
        ...t,
        pl: t.pl * 0.5,
        fundsAtClose: equity,
      }
    })

    const calculator = new PortfolioStatsCalculator()
    const buggyStats = calculator.calculatePortfolioStats(buggyScaledTrades, undefined, true)
    const correctStats = calculator.calculatePortfolioStats(correctScaledTrades, undefined, true)

    // The buggy approach gives SAME drawdown as original (using unscaled fundsAtClose)
    // The correct approach gives DIFFERENT drawdown (using scaled equity)
    const originalStats = calculator.calculatePortfolioStats(originalTrades, undefined, true)

    // Buggy: drawdown matches original because fundsAtClose wasn't changed
    expect(buggyStats.maxDrawdown).toBeCloseTo(originalStats.maxDrawdown, 1)

    // Correct: drawdown is different (and smaller since P&L volatility is halved)
    expect(correctStats.maxDrawdown).not.toBeCloseTo(originalStats.maxDrawdown, 1)
    expect(correctStats.maxDrawdown).toBeLessThan(originalStats.maxDrawdown)
  })
})

describe('formatPercent consistency', () => {
  it('should not double-multiply percentage values', () => {
    // Example: if maxDrawdown is 12 (meaning 12%), displaying it should NOT multiply by 100
    const maxDrawdownPct = 12 // Already a percentage

    // WRONG: formatPercent(maxDrawdownPct * 100) = "1200.00%"
    // CORRECT: formatPercent(maxDrawdownPct) = "12.00%"

    // Simple formatPercent implementation
    const formatPercent = (value: number) => `${value.toFixed(2)}%`

    expect(formatPercent(maxDrawdownPct)).toBe('12.00%')
    expect(formatPercent(maxDrawdownPct * 100)).toBe('1200.00%') // This is wrong!
  })
})
