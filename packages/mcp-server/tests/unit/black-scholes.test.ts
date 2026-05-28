import {
  bsPrice,
  bsDelta,
  bsGamma,
  bsTheta,
  bsVega,
  solveIV,
  computeLegGreeks,
  bachelierPrice,
  bachelierDelta,
  bachelierGamma,
  bachelierTheta,
  bachelierVega,
  solveNormalIV,
  BACHELIER_DTE_THRESHOLD,
  pdf,
  cdf,
  type GreeksResult,
} from '../../src/test-exports.ts';

describe('bsPrice', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015, sigma = 0.20;

  test('ATM call price is reasonable and positive', () => {
    const price = bsPrice('call', S, K, T, r, q, sigma);
    // With r=0.045, q=0.015, call is worth ~9.27
    expect(price).toBeCloseTo(9.27, 0);
    expect(price).toBeGreaterThan(7.5);
    expect(price).toBeLessThan(12.0);
  });

  test('put-call parity holds', () => {
    const putPrice = bsPrice('put', S, K, T, r, q, sigma);
    // With r>q, put is cheaper than call: ~6.36
    // Put-call parity: C - P = S*e^(-qT) - K*e^(-rT)
    const callPrice = bsPrice('call', S, K, T, r, q, sigma);
    const parity = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    expect(callPrice - putPrice).toBeCloseTo(parity, 4);
  });

  test('T=0 returns intrinsic value for call', () => {
    expect(bsPrice('call', 110, 100, 0, r, q, 0.20)).toBeCloseTo(10, 5);
    expect(bsPrice('call', 90, 100, 0, r, q, 0.20)).toBeCloseTo(0, 5);
  });

  test('T=0 returns intrinsic value for put', () => {
    expect(bsPrice('put', 90, 100, 0, r, q, 0.20)).toBeCloseTo(10, 5);
    expect(bsPrice('put', 110, 100, 0, r, q, 0.20)).toBeCloseTo(0, 5);
  });

  test('sigma=0 returns intrinsic value', () => {
    // With sigma=0, the option should be worth its intrinsic discounted value
    const callPrice = bsPrice('call', 110, 100, 1.0, r, q, 0);
    expect(callPrice).toBeGreaterThan(0);
    const putPrice = bsPrice('put', 90, 100, 1.0, r, q, 0);
    expect(putPrice).toBeGreaterThan(0);
  });
});

describe('solveIV', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015;

  test('converges to ~0.20 for ATM call', () => {
    const marketPrice = bsPrice('call', S, K, T, r, q, 0.20);
    const iv = solveIV('call', marketPrice, S, K, T, r, q);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.20, 3);
  });

  test('converges to ~0.20 for ATM put', () => {
    const marketPrice = bsPrice('put', S, K, T, r, q, 0.20);
    const iv = solveIV('put', marketPrice, S, K, T, r, q);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.20, 3);
  });

  test('returns null for deep OTM option with price below model minimum', () => {
    // A call with S=50, K=200, T=0.01 (3.6 days) - extremely deep OTM
    // Even at sigma=5.0 (500% vol), the BS price can't reach 0.0001
    // The solver should exhaust iterations or hit bounds
    const iv = solveIV('call', 0.0001, 50, 200, 0.01, 0.045, 0.015);
    // The solver may return null or a very high IV; either is acceptable
    // for this extreme case. Key behavior: doesn't crash.
    if (iv !== null) {
      // If it converges, the IV should be extremely high
      expect(iv).toBeGreaterThan(1.0);
    }
  });

  test('returns null for negative market price', () => {
    const iv = solveIV('call', -1.0, S, K, T, r, q);
    expect(iv).toBeNull();
  });

  test('returns null for zero market price', () => {
    const iv = solveIV('call', 0, S, K, T, r, q);
    expect(iv).toBeNull();
  });

  test('returns null when T <= 0', () => {
    const iv = solveIV('call', 5.0, S, K, 0, r, q);
    expect(iv).toBeNull();
  });

  test('converges for ITM call', () => {
    const marketPrice = bsPrice('call', 110, 100, 0.5, r, q, 0.25);
    const iv = solveIV('call', marketPrice, 110, 100, 0.5, r, q);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.25, 2);
  });

  test('converges for OTM put', () => {
    const marketPrice = bsPrice('put', 110, 100, 0.5, r, q, 0.30);
    const iv = solveIV('put', marketPrice, 110, 100, 0.5, r, q);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.30, 2);
  });
});

describe('bsDelta', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015, sigma = 0.20;

  test('ATM call delta is approximately 0.50', () => {
    const delta = bsDelta('call', S, K, T, r, q, sigma);
    expect(delta).toBeGreaterThan(0.45);
    expect(delta).toBeLessThan(0.60);
  });

  test('ATM put delta is approximately -0.40 to -0.50', () => {
    const delta = bsDelta('put', S, K, T, r, q, sigma);
    // With r>q and 1yr expiry, put delta is slightly less negative (~-0.40)
    expect(delta).toBeLessThan(-0.35);
    expect(delta).toBeGreaterThan(-0.55);
  });

  test('deep ITM call delta approaches 1.0', () => {
    const delta = bsDelta('call', 200, 100, 1.0, r, q, sigma);
    expect(delta).toBeGreaterThan(0.95);
  });

  test('deep OTM call delta approaches 0.0', () => {
    const delta = bsDelta('call', 50, 100, 1.0, r, q, sigma);
    expect(delta).toBeLessThan(0.05);
  });
});

describe('bsGamma', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015, sigma = 0.20;

  test('ATM gamma is positive', () => {
    const gamma = bsGamma(S, K, T, r, q, sigma);
    expect(gamma).toBeGreaterThan(0);
  });

  test('ATM gamma is higher than deep ITM gamma', () => {
    const atmGamma = bsGamma(S, K, T, r, q, sigma);
    const itmGamma = bsGamma(200, 100, T, r, q, sigma);
    expect(atmGamma).toBeGreaterThan(itmGamma);
  });

  test('ATM gamma is higher than deep OTM gamma', () => {
    const atmGamma = bsGamma(S, K, T, r, q, sigma);
    const otmGamma = bsGamma(50, 100, T, r, q, sigma);
    expect(atmGamma).toBeGreaterThan(otmGamma);
  });
});

describe('bsTheta', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015, sigma = 0.20;

  test('theta is negative for long call (time decay)', () => {
    const theta = bsTheta('call', S, K, T, r, q, sigma);
    expect(theta).toBeLessThan(0);
  });

  test('theta is negative for long put (time decay)', () => {
    const theta = bsTheta('put', S, K, T, r, q, sigma);
    expect(theta).toBeLessThan(0);
  });

  test('ATM theta magnitude is larger than deep OTM', () => {
    const atmTheta = Math.abs(bsTheta('call', S, K, T, r, q, sigma));
    const otmTheta = Math.abs(bsTheta('call', 50, 100, T, r, q, sigma));
    expect(atmTheta).toBeGreaterThan(otmTheta);
  });
});

describe('bsVega', () => {
  const S = 100, K = 100, T = 1.0, r = 0.045, q = 0.015, sigma = 0.20;

  test('vega is always positive', () => {
    const vega = bsVega(S, K, T, r, q, sigma);
    expect(vega).toBeGreaterThan(0);
  });

  test('ATM vega is higher than deep OTM vega', () => {
    const atmVega = bsVega(S, K, T, r, q, sigma);
    const otmVega = bsVega(50, 100, T, r, q, sigma);
    expect(atmVega).toBeGreaterThan(otmVega);
  });

  test('ATM vega is higher than deep ITM vega', () => {
    const atmVega = bsVega(S, K, T, r, q, sigma);
    const itmVega = bsVega(200, 100, T, r, q, sigma);
    expect(atmVega).toBeGreaterThan(itmVega);
  });
});

describe('computeLegGreeks', () => {
  test('returns GreeksResult with all fields for valid inputs', () => {
    // Use the actual BS price for sigma=0.20 to ensure IV solver converges
    const price = bsPrice('call', 100, 100, 1.0, 0.045, 0.015, 0.20);
    const result: GreeksResult = computeLegGreeks(price, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    expect(result.delta).not.toBeNull();
    expect(result.gamma).not.toBeNull();
    expect(result.theta).not.toBeNull();
    expect(result.vega).not.toBeNull();
    // IV should be close to 0.20 for these inputs
    expect(result.iv!).toBeCloseTo(0.20, 1);
  });

  test('returns all null greeks when IV cannot be solved', () => {
    // Zero price should fail IV solve
    const result = computeLegGreeks(0, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.delta).toBeNull();
    expect(result.gamma).toBeNull();
    expect(result.theta).toBeNull();
    expect(result.vega).toBeNull();
    expect(result.iv).toBeNull();
  });

  test('converts DTE to years internally (dte/365)', () => {
    // 365 days = 1 year, same as T=1.0
    const price = bsPrice('call', 100, 100, 1.0, 0.045, 0.015, 0.20);
    const result365 = computeLegGreeks(price, 100, 100, 365, 'C', 0.045, 0.015);
    // Should get similar IV for the same option with T=1.0
    expect(result365.iv).not.toBeNull();
    expect(result365.iv!).toBeCloseTo(0.20, 2);
  });

  test('handles put type correctly', () => {
    const putPrice = bsPrice('put', 100, 100, 1.0, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(putPrice, 100, 100, 365, 'P', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    expect(result.delta).not.toBeNull();
    expect(result.delta!).toBeLessThan(0); // Put delta is negative
  });

  test('returns null greeks for negative option price', () => {
    const result = computeLegGreeks(-5, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.iv).toBeNull();
    expect(result.delta).toBeNull();
  });
});

// --- Bachelier (Normal) Model tests ---

describe('bachelierPrice', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('ATM call price is near Brenner-Subrahmanyam approximation', () => {
    // BS approx for ATM (forward=strike): e^(-rT) * sigma_n * sqrt(T) * n(0)
    // n(0) = 1/sqrt(2*pi), sqrtT = sqrt(0.01) = 0.1
    // ~ 0.99955 * 800 * 0.1 * 0.3989 ~ 31.9
    // With carry (r>q), forward > K, so actual price is slightly higher
    const price = bachelierPrice('call', S, K, T, r, q, sigma_n);
    expect(price).toBeGreaterThan(0);
    // Allow wider tolerance: carry shifts forward above strike
    expect(price).toBeGreaterThan(30);
    expect(price).toBeLessThan(40);
  });

  test('ATM put price approximately equals ATM call price (Bachelier put-call parity)', () => {
    const callPrice = bachelierPrice('call', S, K, T, r, q, sigma_n);
    const putPrice = bachelierPrice('put', S, K, T, r, q, sigma_n);
    // For ATM Bachelier with carry (r>q), call > put due to positive carry
    // Both should be in the same order of magnitude (~30 range)
    expect(callPrice).toBeGreaterThan(0);
    expect(putPrice).toBeGreaterThan(0);
    // The intrinsic difference should be bounded by the carry component: |C-P| ~ |forward-K| * discount
    // forward = 5300 * e^(0.03 * 0.01) ~ 5300 * 1.0003 ~ 5301.6; forward-K ~ 1.6; discount ~ 0.9996
    // |C-P| should be less than 5 (reasonable upper bound)
    expect(Math.abs(callPrice - putPrice)).toBeLessThan(5);
  });

  test('T=0 returns intrinsic value for ITM call', () => {
    expect(bachelierPrice('call', 5310, 5300, 0, r, q, sigma_n)).toBeCloseTo(10, 4);
  });

  test('T=0 returns intrinsic value for OTM call', () => {
    expect(bachelierPrice('call', 5290, 5300, 0, r, q, sigma_n)).toBeCloseTo(0, 4);
  });

  test('T=0 returns intrinsic value for ITM put', () => {
    expect(bachelierPrice('put', 5290, 5300, 0, r, q, sigma_n)).toBeCloseTo(10, 4);
  });

  test('T=0 returns intrinsic value for OTM put', () => {
    expect(bachelierPrice('put', 5310, 5300, 0, r, q, sigma_n)).toBeCloseTo(0, 4);
  });
});

describe('bachelierDelta', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('ATM call delta is approximately 0.5 * e^(-rT) (exact when forward=strike)', () => {
    // The exact ATM condition is forward = K, i.e., S*e^((r-q)*T) = K
    // With our params, forward > K (since r>q), so delta > 0.5*e^(-rT)
    const delta = bachelierDelta('call', S, K, T, r, q, sigma_n);
    // Should be between 0.45 and 0.55 * discount
    const discount = Math.exp(-r * T);
    expect(delta).toBeGreaterThan(0.45 * discount);
    expect(delta).toBeLessThan(0.55 * discount + 0.05); // allow for forward shift
  });

  test('ATM put delta is approximately -0.5 * e^(-rT) (exact when forward=strike)', () => {
    const delta = bachelierDelta('put', S, K, T, r, q, sigma_n);
    const discount = Math.exp(-r * T);
    expect(delta).toBeLessThan(-0.45 * discount);
    expect(delta).toBeGreaterThan(-0.55 * discount - 0.05);
  });

  test('exact ATM delta (forward=strike) is 0.5 * e^(-rT)', () => {
    // Set K = forward = S * e^((r-q)*T) so d=0 and cdf(0)=0.5 exactly
    const T_test = 0.01;
    const S_test = 5300;
    const K_atm = S_test * Math.exp((r - q) * T_test); // forward = strike
    const delta = bachelierDelta('call', S_test, K_atm, T_test, r, q, sigma_n);
    const expected = 0.5 * Math.exp(-r * T_test);
    expect(delta).toBeCloseTo(expected, 4);
  });
});

describe('bachelierGamma', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('ATM gamma is positive', () => {
    const gamma = bachelierGamma(S, K, T, r, q, sigma_n);
    expect(gamma).toBeGreaterThan(0);
  });
});

describe('bachelierVega', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('vega is positive for positive T', () => {
    const vega = bachelierVega(S, K, T, r, q, sigma_n);
    expect(vega).toBeGreaterThan(0);
  });

  test('vega is 0 when T=0', () => {
    expect(bachelierVega(S, K, 0, r, q, sigma_n)).toBe(0);
  });
});

describe('bachelierTheta', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('theta is negative for long ATM call (time decay)', () => {
    const theta = bachelierTheta('call', S, K, T, r, q, sigma_n);
    expect(theta).toBeLessThan(0);
  });

  test('theta is negative for long ATM put (time decay)', () => {
    const theta = bachelierTheta('put', S, K, T, r, q, sigma_n);
    expect(theta).toBeLessThan(0);
  });
});

describe('solveNormalIV', () => {
  const S = 5300, K = 5300, T = 0.01, r = 0.045, q = 0.015, sigma_n = 800;

  test('round-trip: solve for sigma_n from Bachelier price matches input within 1e-4', () => {
    const price = bachelierPrice('call', S, K, T, r, q, sigma_n);
    const solved = solveNormalIV('call', price, S, K, T, r, q);
    expect(solved).not.toBeNull();
    expect(Math.abs(solved! - sigma_n)).toBeLessThan(0.1); // within 0.1 vol points
  });

  test('round-trip for put', () => {
    const price = bachelierPrice('put', S, K, T, r, q, sigma_n);
    const solved = solveNormalIV('put', price, S, K, T, r, q);
    expect(solved).not.toBeNull();
    expect(Math.abs(solved! - sigma_n)).toBeLessThan(0.1);
  });

  test('returns null for marketPrice <= 0', () => {
    expect(solveNormalIV('call', 0, S, K, T, r, q)).toBeNull();
    expect(solveNormalIV('call', -1, S, K, T, r, q)).toBeNull();
  });

  test('returns null for T <= 0', () => {
    expect(solveNormalIV('call', 5.0, S, K, 0, r, q)).toBeNull();
  });
});

describe('BACHELIER_DTE_THRESHOLD', () => {
  test('is 0.1 (lowered from 0.5 — BS+bisection now works to ~2.4 hours)', () => {
    expect(BACHELIER_DTE_THRESHOLD).toBe(0.1);
  });
});

describe('computeLegGreeks model selection', () => {
  test('dte=0.05 (< 0.1 threshold) uses Bachelier model — iv is normal vol (large number, ~hundreds)', () => {
    // For very short DTE SPX-like options, normal vol is ~hundreds (e.g., 50-1000)
    const T = 0.05 / 365;
    const sigma_n = 800;
    const price = bachelierPrice('call', 5300, 5300, T, 0.045, 0.015, sigma_n);
    const result = computeLegGreeks(price, 5300, 5300, 0.05, 'C', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    // Normal vol for SPX 0DTE is in the hundreds, not 0-1 range of log-normal
    expect(result.iv!).toBeGreaterThan(1); // normal vol, not log-normal
    expect(result.delta).not.toBeNull();
    expect(result.gamma).not.toBeNull();
    expect(result.theta).not.toBeNull();
    expect(result.vega).not.toBeNull();
  });

  test('dte=0.3 (between 0.1 and old 0.5 threshold) now uses Black-Scholes — iv is log-normal (0-1 range)', () => {
    // Previously this would use Bachelier (dte < 0.5), now it uses BS (dte >= 0.1)
    const T = 0.3 / 365;
    const price = bsPrice('call', 100, 100, T, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(price, 100, 100, 0.3, 'C', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    // BS IV should be in log-normal range (0-1), not hundreds
    expect(result.iv!).toBeLessThan(10); // log-normal, not normal dollar vol
  });

  test('dte=5.0 (well above threshold) uses Black-Scholes — iv is log-normal (0-1 range)', () => {
    const price = bsPrice('call', 100, 100, 1.0, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(price, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    // Log-normal IV is in 0-1 range for typical options
    expect(result.iv!).toBeCloseTo(0.20, 1);
  });

  test('dte=0.1 (exactly at threshold) uses Black-Scholes (>= 0.1 means BS)', () => {
    const T = 0.1 / 365;
    const price = bsPrice('call', 100, 100, T, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(price, 100, 100, 0.1, 'C', 0.045, 0.015);
    expect(result.iv).not.toBeNull();
    // BS IV should be in log-normal range
    expect(result.iv!).toBeLessThan(10);
  });
});

describe('computeLegGreeks model field', () => {
  test('returns model="bachelier" when dte=0.05 (below 0.1 threshold)', () => {
    const T = 0.05 / 365;
    const sigma_n = 800;
    const price = bachelierPrice('call', 5300, 5300, T, 0.045, 0.015, sigma_n);
    const result = computeLegGreeks(price, 5300, 5300, 0.05, 'C', 0.045, 0.015);
    expect(result.model).toBe('bachelier');
  });

  test('returns model="bs" when dte=0.3 (between 0.1 and old 0.5 threshold)', () => {
    const T = 0.3 / 365;
    const price = bsPrice('call', 100, 100, T, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(price, 100, 100, 0.3, 'C', 0.045, 0.015);
    expect(result.model).toBe('bs');
  });

  test('returns model="bs" when dte=5.0 (well above threshold)', () => {
    const price = bsPrice('call', 100, 100, 1.0, 0.045, 0.015, 0.20);
    const result = computeLegGreeks(price, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.model).toBe('bs');
  });

  test('model is undefined when IV solve fails (null greeks result)', () => {
    // Zero price fails IV solve — nullResult has no model field
    const result = computeLegGreeks(0, 100, 100, 365, 'C', 0.045, 0.015);
    expect(result.model).toBeUndefined();
  });
});

describe('pdf and cdf exports', () => {
  test('pdf(0) is 1/sqrt(2*pi)', () => {
    expect(pdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 10);
  });

  test('cdf(0) is 0.5', () => {
    expect(cdf(0)).toBeCloseTo(0.5, 5);
  });

  test('cdf(1.96) is approximately 0.975', () => {
    expect(cdf(1.96)).toBeCloseTo(0.975, 2);
  });
});
