import {
  computeStrategyPnlPath,
  type ReplayLeg,
  type BarRow,
  type GreeksConfig,
} from '../../src/test-exports.ts';

/**
 * Tests for greeks integration in the P&L path computation.
 * Verifies per-leg greeks, net position greeks, IVP, backwards compat,
 * missing underlying price, and DTE <= 0 edge cases.
 */

// Helper: build a single bar
function bar(date: string, time: string, high: number, low: number, ticker: string): BarRow {
  return { date, time, open: low, high, low, close: high, volume: 100, ticker };
}

describe('computeStrategyPnlPath with greeksConfig', () => {
  const legs: ReplayLeg[] = [
    { occTicker: 'SPXW250321C05800000', quantity: 1, entryPrice: 20.0, multiplier: 100 },
    { occTicker: 'SPXW250321P05700000', quantity: -1, entryPrice: 15.0, multiplier: 100 },
  ];

  const barsByLeg: BarRow[][] = [
    [
      bar('2025-03-19', '09:31', 22.0, 20.0, 'SPXW250321C05800000'),
      bar('2025-03-19', '09:32', 23.0, 21.0, 'SPXW250321C05800000'),
    ],
    [
      bar('2025-03-19', '09:31', 16.0, 14.0, 'SPXW250321P05700000'),
      bar('2025-03-19', '09:32', 17.0, 13.0, 'SPXW250321P05700000'),
    ],
  ];

  const underlyingPrices = new Map<string, number>();
  underlyingPrices.set('2025-03-19 09:31', 5750);
  underlyingPrices.set('2025-03-19 09:32', 5760);

  const greeksConfig: GreeksConfig = {
    underlyingPrices,
    legs: [
      { strike: 5800, type: 'C', expiryDate: '2025-03-21' },
      { strike: 5700, type: 'P', expiryDate: '2025-03-21' },
    ],
    riskFreeRate: 0.045,
    dividendYield: 0.015,
  };

  it('produces PnlPoints with legGreeks array when greeksConfig provided', () => {
    const result = computeStrategyPnlPath(legs, barsByLeg, greeksConfig);
    expect(result).toHaveLength(2);
    expect(result[0].underlyingPrice).toBe(5750);
    expect(result[1].underlyingPrice).toBe(5760);
    expect(result[0].legGreeks).toBeDefined();
    expect(result[0].legGreeks).toHaveLength(2);
    // Each leg should have a GreeksResult with delta, gamma, theta, vega, iv
    for (const g of result[0].legGreeks!) {
      expect(g).toHaveProperty('delta');
      expect(g).toHaveProperty('gamma');
      expect(g).toHaveProperty('theta');
      expect(g).toHaveProperty('vega');
      expect(g).toHaveProperty('iv');
    }
  });

  it('computes net greeks as quantity-weighted sums across legs', () => {
    const result = computeStrategyPnlPath(legs, barsByLeg, greeksConfig);
    const point = result[0];
    // Net greeks should be defined (not all null since IV should solve for reasonable inputs)
    expect(point.netDelta).not.toBeNull();
    expect(point.netGamma).not.toBeNull();
    expect(point.netTheta).not.toBeNull();
    expect(point.netVega).not.toBeNull();
    // Net delta should be a number (quantity-weighted sum)
    expect(typeof point.netDelta).toBe('number');

    // Verify net delta = leg0.delta * (1 * 100/100) + leg1.delta * (-1 * 100/100)
    const g0 = point.legGreeks![0];
    const g1 = point.legGreeks![1];
    if (g0.delta !== null && g1.delta !== null) {
      const expectedNetDelta = g0.delta * 1 + g1.delta * -1;
      expect(point.netDelta).toBeCloseTo(expectedNetDelta, 10);
    }
  });

  it('produces PnlPoints WITHOUT greeks when greeksConfig is omitted (backwards compat)', () => {
    const result = computeStrategyPnlPath(legs, barsByLeg);
    expect(result).toHaveLength(2);
    expect(result[0].legGreeks).toBeUndefined();
    expect(result[0].netDelta).toBeUndefined();
    expect(result[0].netGamma).toBeUndefined();
    expect(result[0].netTheta).toBeUndefined();
    expect(result[0].netVega).toBeUndefined();
    expect(result[0].ivp).toBeUndefined();
  });

  it('leaves greeks fields undefined when underlying price missing for a timestamp', () => {
    // Only provide underlying price for 09:31, not 09:32
    const sparseUnderlyingPrices = new Map<string, number>();
    sparseUnderlyingPrices.set('2025-03-19 09:31', 5750);

    const sparseConfig: GreeksConfig = {
      ...greeksConfig,
      underlyingPrices: sparseUnderlyingPrices,
    };

    const result = computeStrategyPnlPath(legs, barsByLeg, sparseConfig);
    expect(result).toHaveLength(2);
    // 09:31 should have greeks
    expect(result[0].legGreeks).toBeDefined();
    expect(result[0].underlyingPrice).toBe(5750);
    // 09:32 should NOT have greeks (underlying price missing)
    expect(result[1].legGreeks).toBeUndefined();
    expect(result[1].netDelta).toBeUndefined();
    expect(result[1].underlyingPrice).toBeUndefined();
  });

  it('computes greeks for same-day expiry (DTE > 0 until 4 PM close)', () => {
    // Expiry same day as bars — but bars are at 09:31, expiry is 4 PM, so DTE ≈ 0.27
    const sameDayConfig: GreeksConfig = {
      ...greeksConfig,
      legs: [
        { strike: 5800, type: 'C', expiryDate: '2025-03-19' },
        { strike: 5700, type: 'P', expiryDate: '2025-03-19' },
      ],
    };

    const result = computeStrategyPnlPath(legs, barsByLeg, sameDayConfig);
    expect(result).toHaveLength(2);
    expect(result[0].legGreeks).toBeDefined();
    // With DTE ≈ 0.27 (same day, hours until close), greeks should be computed
    for (const g of result[0].legGreeks!) {
      expect(g.delta).not.toBeNull();
    }
    expect(result[0].netDelta).not.toBeNull();
  });

  it('returns null greeks values when DTE <= 0 (past expiry)', () => {
    // Set expiry to day BEFORE the bars — truly past expiry
    const pastExpiryConfig: GreeksConfig = {
      ...greeksConfig,
      legs: [
        { strike: 5800, type: 'C', expiryDate: '2025-03-18' },
        { strike: 5700, type: 'P', expiryDate: '2025-03-18' },
      ],
    };

    const result = computeStrategyPnlPath(legs, barsByLeg, pastExpiryConfig);
    expect(result).toHaveLength(2);
    expect(result[0].legGreeks).toBeDefined();
    // With DTE <= 0 (expired yesterday), individual greeks should be null
    for (const g of result[0].legGreeks!) {
      expect(g.delta).toBeNull();
      expect(g.gamma).toBeNull();
      expect(g.theta).toBeNull();
      expect(g.vega).toBeNull();
      expect(g.iv).toBeNull();
    }
    // Net greeks should be null when all legs are null
    expect(result[0].netDelta).toBeNull();
  });

  it('includes IVP from ivpByDate when provided', () => {
    const ivpByDate = new Map<string, number>();
    ivpByDate.set('2025-03-19', 42.5);

    const configWithIvp: GreeksConfig = {
      ...greeksConfig,
      ivpByDate,
    };

    const result = computeStrategyPnlPath(legs, barsByLeg, configWithIvp);
    expect(result[0].ivp).toBe(42.5);
    expect(result[1].ivp).toBe(42.5); // same date
  });

  it('sets ivp to null when ivpByDate is not provided', () => {
    const result = computeStrategyPnlPath(legs, barsByLeg, greeksConfig);
    expect(result[0].ivp).toBeNull();
  });

  it('uses daily fallback (date-only key) when minute key misses', () => {
    // Provide only date-keyed underlying prices (simulates daily fallback)
    const dailyPrices = new Map<string, number>();
    dailyPrices.set('2025-03-19', 5755);

    const dailyConfig: GreeksConfig = {
      ...greeksConfig,
      underlyingPrices: dailyPrices,
    };

    const result = computeStrategyPnlPath(legs, barsByLeg, dailyConfig);
    expect(result[0].legGreeks).toBeDefined();
    expect(result[0].netDelta).not.toBeNull();
    expect(result[0].underlyingPrice).toBe(5755);
    // Both timestamps should resolve to the same daily price
    expect(result[1].legGreeks).toBeDefined();
    expect(result[1].underlyingPrice).toBe(5755);
  });
});
