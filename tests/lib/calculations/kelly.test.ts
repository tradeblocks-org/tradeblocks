import { calculateKellyMetrics, Trade } from '@tradeblocks/lib'
import { describe, expect, it } from '@jest/globals'

describe('calculateKellyMetrics', () => {
  it('calculates correct metrics for a set of combined trades', () => {
    // Simulate combined trades (e.g. Iron Condors)
    // Trade 1: Win (Risk 1000, Profit 500) -> 50% return
    // Trade 2: Loss (Risk 1000, Loss -1000) -> -100% return
    // Trade 3: Win (Risk 1000, Profit 500) -> 50% return
    
    const trades: Trade[] = [
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-01'),
        pl: 500,
        marginReq: 1000,
        strategy: 'Iron Condor',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      },
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-02'),
        pl: -1000,
        marginReq: 1000,
        strategy: 'Iron Condor',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      },
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-03'),
        pl: 500,
        marginReq: 1000,
        strategy: 'Iron Condor',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      }
    ]

    const metrics = calculateKellyMetrics(trades)

    // Win Rate: 2 wins / 3 trades = 66.67%
    expect(metrics.winRate).toBeCloseTo(2/3)

    // Avg Win: 500
    expect(metrics.avgWin).toBe(500)
    
    // Avg Loss: 1000
    expect(metrics.avgLoss).toBe(1000)

    // Payoff Ratio: 500 / 1000 = 0.5
    expect(metrics.payoffRatio).toBe(0.5)

    // Kelly Fraction (f) = (p(b+1) - 1) / b
    // where p = win probability, b = odds received (payoff ratio)
    // f = (0.6667 * (0.5 + 1) - 1) / 0.5
    // f = (0.6667 * 1.5 - 1) / 0.5
    // f = (1.0 - 1) / 0.5 = 0
    // Wait, let's re-check formula used in code:
    // kellyFraction = (payoffRatio * winRate - lossRate) / payoffRatio
    // payoffRatio = 0.5
    // winRate = 2/3 (~0.6667)
    // lossRate = 1/3 (~0.3333)
    // f = (0.5 * 0.6667 - 0.3333) / 0.5
    // f = (0.3333 - 0.3333) / 0.5 = 0
    expect(metrics.fraction).toBeCloseTo(0)
  })

  it('calculates positive Kelly for a winning strategy', () => {
    // Trade 1: Win 1000 (Risk 1000) -> 100% return
    // Trade 2: Win 1000 (Risk 1000) -> 100% return
    // Trade 3: Loss -500 (Risk 1000) -> -50% return
    
    const trades: Trade[] = [
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-01'),
        pl: 1000,
        marginReq: 1000,
        strategy: 'Test',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      },
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-02'),
        pl: 1000,
        marginReq: 1000,
        strategy: 'Test',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      },
      {
        timeOpened: '09:30:00',
        openingPrice: 100,
        dateOpened: new Date('2024-01-03'),
        pl: -500,
        marginReq: 1000,
        strategy: 'Test',
        numContracts: 1,
        legs: 'Combined',
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        premium: 0,
        fundsAtClose: 0
      }
    ]

    const metrics = calculateKellyMetrics(trades)

    // Win Rate: 2/3
    expect(metrics.winRate).toBeCloseTo(2/3)

    // Avg Win: 1000
    expect(metrics.avgWin).toBe(1000)
    
    // Avg Loss: 500
    expect(metrics.avgLoss).toBe(500)

    // Payoff Ratio: 1000 / 500 = 2.0
    expect(metrics.payoffRatio).toBe(2.0)

    // Kelly: (2.0 * 0.6667 - 0.3333) / 2.0
    // (1.3334 - 0.3333) / 2.0 = 1.0 / 2.0 = 0.5
    expect(metrics.fraction).toBeCloseTo(0.5)
  })
})
