/**
 * Black-Scholes option pricing, greeks computation, and IV solver.
 * Includes Bachelier (normal) model as fallback for short-dated options.
 *
 * Pure math module — no I/O, no DuckDB, no fetch.
 * European-style BS formula with continuous dividend yield.
 *
 * References:
 * - CDF approximation: Abramowitz & Stegun 26.2.17 (rational approximation)
 * - IV solver: Newton-Raphson with bisection fallback (D-11: maxIter=100, tolerance=1e-6)
 * - Bachelier model: Brenner-Subrahmanyam (1988) normal model for near-zero DTE
 */

/**
 * DTE threshold below which Bachelier normal model is used instead of Black-Scholes.
 * At very short DTE (<0.1 days / ~2.4 hours), BS gamma explodes and the lognormal assumption breaks down.
 * Bachelier (normal) model handles near-zero DTE gracefully.
 */
export const BACHELIER_DTE_THRESHOLD = 0.1; // days (~2.4 hours)

/**
 * Result of computing greeks for a single option leg.
 */
export interface GreeksResult {
  delta: number | null;
  gamma: number | null;
  theta: number | null; // per day
  vega: number | null; // per 1% IV move
  iv: number | null; // annualized implied volatility (0-N, not percentage)
  model?: "bs" | "bachelier"; // which pricing model was used; undefined if IV solve failed
}

// --- Internal helpers (exported for Bachelier model and testing) ---

/** Standard normal probability density function */
export function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Cumulative standard normal distribution function.
 * Uses Abramowitz & Stegun 26.2.17 rational approximation.
 * Accuracy: |error| < 7.5e-8
 */
export function cdf(x: number): number {
  if (x < -10) return 0;
  if (x > 10) return 1;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const p = 0.2316419;
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const poly = b1 * t + b2 * t2 + b3 * t3 + b4 * t4 + b5 * t5;
  const result = 1.0 - pdf(absX) * poly;

  return sign === 1 ? result : 1.0 - result;
}

/** Compute d1 and d2 for Black-Scholes formula */
function d1d2(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2 };
}

// --- Exported functions ---

/**
 * European Black-Scholes option price with continuous dividend yield.
 *
 * @param type - "call" or "put"
 * @param S - Underlying price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate (e.g., 0.045)
 * @param q - Continuous dividend yield (e.g., 0.015 for SPX)
 * @param sigma - Volatility (annualized, e.g., 0.20 for 20%)
 * @returns Option price
 */
export function bsPrice(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): number {
  // Edge case: at or past expiry
  if (T <= 0) {
    return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }

  // Edge case: zero volatility — return discounted intrinsic
  if (sigma <= 0) {
    const forward = S * Math.exp((r - q) * T);
    if (type === "call") {
      return Math.max(forward - K, 0) * Math.exp(-r * T);
    } else {
      return Math.max(K - forward, 0) * Math.exp(-r * T);
    }
  }

  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);

  if (type === "call") {
    return S * Math.exp(-q * T) * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
  } else {
    return K * Math.exp(-r * T) * cdf(-d2) - S * Math.exp(-q * T) * cdf(-d1);
  }
}

/**
 * Black-Scholes delta.
 * Call: N(d1) * e^(-qT)
 * Put: (N(d1) - 1) * e^(-qT)
 */
export function bsDelta(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) {
    if (type === "call") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }

  const { d1 } = d1d2(S, K, T, r, q, sigma);
  const eqT = Math.exp(-q * T);

  if (type === "call") {
    return cdf(d1) * eqT;
  } else {
    return (cdf(d1) - 1) * eqT;
  }
}

/**
 * Black-Scholes gamma. Same for calls and puts.
 * Gamma = N'(d1) * e^(-qT) / (S * sigma * sqrt(T))
 */
export function bsGamma(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) return 0;

  const { d1 } = d1d2(S, K, T, r, q, sigma);
  return (pdf(d1) * Math.exp(-q * T)) / (S * sigma * Math.sqrt(T));
}

/**
 * Black-Scholes theta (per calendar day).
 * Returns the daily time decay (negative for long options).
 */
export function bsTheta(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) return 0;

  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);
  const sqrtT = Math.sqrt(T);
  const eqT = Math.exp(-q * T);
  const erT = Math.exp(-r * T);

  // First term: -(S * e^(-qT) * N'(d1) * sigma) / (2 * sqrt(T))
  const term1 = -(S * eqT * pdf(d1) * sigma) / (2 * sqrtT);

  if (type === "call") {
    const term2 = q * S * eqT * cdf(d1);
    const term3 = -r * K * erT * cdf(d2);
    return (term1 - term2 - term3) / 365;
  } else {
    const term2 = q * S * eqT * cdf(-d1);
    const term3 = -r * K * erT * cdf(-d2);
    return (term1 + term2 + term3) / 365;
  }
}

/**
 * Black-Scholes vega (per 1% IV move).
 * Vega = S * e^(-qT) * N'(d1) * sqrt(T) / 100
 */
export function bsVega(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) return 0;

  const { d1 } = d1d2(S, K, T, r, q, sigma);
  return (S * Math.exp(-q * T) * pdf(d1) * Math.sqrt(T)) / 100;
}

/**
 * Solve for implied volatility using Newton-Raphson with bisection fallback.
 *
 * @param type - "call" or "put"
 * @param marketPrice - Observed market price of the option
 * @param S - Underlying price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate
 * @param q - Dividend yield
 * @param maxIter - Maximum iterations (default 100, per D-11)
 * @param tolerance - Convergence tolerance (default 1e-6, per D-11)
 * @returns Implied volatility or null if convergence fails
 */
export function solveIV(
  type: "call" | "put",
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  maxIter: number = 100,
  tolerance: number = 1e-6,
): number | null {
  // Guard: invalid inputs
  if (marketPrice <= 0 || T <= 0) return null;

  let sigma = 0.3; // initial guess
  let lo = 0.001;
  let hi = 5.0;

  for (let i = 0; i < maxIter; i++) {
    const price = bsPrice(type, S, K, T, r, q, sigma);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return sigma;
    }

    // Vega for Newton-Raphson step (raw vega, not per-1%-move)
    const { d1 } = d1d2(S, K, T, r, q, sigma);
    const rawVega = S * Math.exp(-q * T) * pdf(d1) * Math.sqrt(T);

    if (rawVega < 1e-10) {
      // Bisection fallback when vega is near zero
      const mid = (lo + hi) / 2;
      if (diff > 0) {
        hi = sigma;
      } else {
        lo = sigma;
      }
      sigma = mid;
    } else {
      // Newton-Raphson step
      const newSigma = sigma - diff / rawVega;
      // Clamp to reasonable range
      if (newSigma <= 0 || newSigma > 10) {
        // Fall back to bisection
        if (diff > 0) {
          hi = sigma;
        } else {
          lo = sigma;
        }
        sigma = (lo + hi) / 2;
      } else {
        sigma = newSigma;
      }
    }
  }

  // Did not converge
  return null;
}

// --- Bachelier (Normal) Model ---

/**
 * Bachelier (normal) European option price with continuous dividend yield.
 * Uses forward price F = S * e^((r-q)*T) as the underlying.
 *
 * For near-zero DTE, the lognormal assumption in Black-Scholes breaks down.
 * Bachelier's model (normal distribution of returns) handles this gracefully.
 *
 * @param type - "call" or "put"
 * @param S - Underlying price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate (e.g., 0.045)
 * @param q - Continuous dividend yield (e.g., 0.015 for SPX)
 * @param sigma_n - Normal (dollar) volatility (e.g., 800 for SPX ~$800/year normal vol)
 * @returns Option price
 */
export function bachelierPrice(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma_n: number,
): number {
  if (T <= 0) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (sigma_n <= 0) {
    const forward = S * Math.exp((r - q) * T);
    return (
      Math.exp(-r * T) * (type === "call" ? Math.max(forward - K, 0) : Math.max(K - forward, 0))
    );
  }
  const forward = S * Math.exp((r - q) * T);
  const sqrtT = Math.sqrt(T);
  const d = (forward - K) / (sigma_n * sqrtT);
  const discount = Math.exp(-r * T);
  if (type === "call") {
    return discount * ((forward - K) * cdf(d) + sigma_n * sqrtT * pdf(d));
  } else {
    return discount * ((K - forward) * cdf(-d) + sigma_n * sqrtT * pdf(d));
  }
}

/**
 * Bachelier delta.
 * Call: e^(-rT) * N(d)
 * Put: -e^(-rT) * N(-d)
 */
export function bachelierDelta(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma_n: number,
): number {
  if (T <= 0 || sigma_n <= 0) {
    if (type === "call") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const forward = S * Math.exp((r - q) * T);
  const d = (forward - K) / (sigma_n * Math.sqrt(T));
  const discount = Math.exp(-r * T);
  return type === "call" ? discount * cdf(d) : -discount * cdf(-d);
}

/**
 * Bachelier gamma (same for calls and puts).
 * Gamma = e^(-rT) * n(d) / (sigma_n * sqrt(T))
 */
export function bachelierGamma(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma_n: number,
): number {
  if (T <= 0 || sigma_n <= 0) return 0;
  const forward = S * Math.exp((r - q) * T);
  const sqrtT = Math.sqrt(T);
  const d = (forward - K) / (sigma_n * sqrtT);
  return (Math.exp(-r * T) * pdf(d)) / (sigma_n * sqrtT);
}

/**
 * Bachelier theta (per calendar day).
 * Returns the daily time decay (negative for long options).
 * Formula: -(e^(-rT) * sigma_n * n(d) / (2 * sqrt(T)) - r * price) / 365
 */
export function bachelierTheta(
  type: "call" | "put",
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma_n: number,
): number {
  if (T <= 0 || sigma_n <= 0) return 0;
  const forward = S * Math.exp((r - q) * T);
  const sqrtT = Math.sqrt(T);
  const d = (forward - K) / (sigma_n * sqrtT);
  const discount = Math.exp(-r * T);
  const price = bachelierPrice(type, S, K, T, r, q, sigma_n);
  // dV/dT = -e^(-rT) * sigma_n * n(d) / (2*sqrt(T)) + r * price  (positive = more time = more value)
  // theta = -dV/dT per year, then / 365 for per-calendar-day
  // annualTheta is negative for long options (time decay)
  const annualTheta = (-discount * sigma_n * pdf(d)) / (2 * sqrtT) + r * price;
  return annualTheta / 365;
}

/**
 * Bachelier vega (per 1% normal vol move).
 * Raw vega = e^(-rT) * sqrt(T) * n(d). Per 1% = raw / 100.
 */
export function bachelierVega(
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma_n: number,
): number {
  if (T <= 0 || sigma_n <= 0) return 0;
  const forward = S * Math.exp((r - q) * T);
  const d = (forward - K) / (sigma_n * Math.sqrt(T));
  return (Math.exp(-r * T) * Math.sqrt(T) * pdf(d)) / 100;
}

/**
 * Solve for normal (Bachelier) implied volatility using Newton-Raphson.
 *
 * @param type - "call" or "put"
 * @param marketPrice - Observed market price of the option
 * @param S - Underlying price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate
 * @param q - Dividend yield
 * @param maxIter - Maximum iterations (default 100)
 * @param tolerance - Convergence tolerance (default 1e-6)
 * @returns Normal implied volatility (dollar vol, e.g., ~800 for SPX) or null
 */
export function solveNormalIV(
  type: "call" | "put",
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  maxIter: number = 100,
  tolerance: number = 1e-6,
): number | null {
  if (marketPrice <= 0 || T <= 0) return null;
  // Initial guess: Brenner-Subrahmanyam for normal model
  // sigma_n ~ marketPrice / sqrt(T/(2*pi))
  let sigma_n = marketPrice / Math.sqrt(T / (2 * Math.PI));
  // Clamp initial guess to reasonable range
  sigma_n = Math.max(sigma_n, 1); // at least $1 normal vol

  // Bisection bounds — normal vol is in dollar terms (typically 10-10000 for index options)
  let lo = 0.01;
  let hi = 50000;

  for (let i = 0; i < maxIter; i++) {
    const price = bachelierPrice(type, S, K, T, r, q, sigma_n);
    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) return sigma_n;
    // Raw vega for Newton step (without /100 per-1% scaling)
    const forward = S * Math.exp((r - q) * T);
    const d = (forward - K) / (sigma_n * Math.sqrt(T));
    const rawVega = Math.exp(-r * T) * Math.sqrt(T) * pdf(d);

    if (rawVega < 1e-10) {
      // Bisection fallback when vega is near zero
      if (diff > 0) {
        hi = sigma_n;
      } else {
        lo = sigma_n;
      }
      sigma_n = (lo + hi) / 2;
    } else {
      // Newton-Raphson step
      const newSigma = sigma_n - diff / rawVega;
      if (newSigma <= 0 || newSigma > 100000) {
        // Fall back to bisection
        if (diff > 0) {
          hi = sigma_n;
        } else {
          lo = sigma_n;
        }
        sigma_n = (lo + hi) / 2;
      } else {
        sigma_n = newSigma;
      }
    }
  }
  return null;
}

/**
 * Compute all greeks for a single option leg.
 *
 * First solves for IV from the market price, then computes delta, gamma, theta, vega.
 * Returns all nulls if IV cannot be determined.
 *
 * @param optionPrice - Market price of the option
 * @param underlyingPrice - Current underlying price (S)
 * @param strike - Option strike price (K)
 * @param dte - Days to expiry (fractional days, converted to years internally)
 * @param type - "C" for call, "P" for put
 * @param riskFreeRate - Risk-free interest rate
 * @param dividendYield - Continuous dividend yield
 * @returns GreeksResult with delta, gamma, theta, vega, iv (all nullable)
 */
export function computeLegGreeks(
  optionPrice: number,
  underlyingPrice: number,
  strike: number,
  dte: number,
  type: "C" | "P",
  riskFreeRate: number,
  dividendYield: number,
): GreeksResult {
  const T = dte / 365;
  const bsType = type === "C" ? "call" : "put";
  const nullResult: GreeksResult = { delta: null, gamma: null, theta: null, vega: null, iv: null };

  if (dte < BACHELIER_DTE_THRESHOLD) {
    // Bachelier normal model for short-dated options (dte < 0.1 days / ~2.4 hours).
    // iv field stores normal (dollar) volatility, not log-normal vol.
    const iv = solveNormalIV(
      bsType,
      optionPrice,
      underlyingPrice,
      strike,
      T,
      riskFreeRate,
      dividendYield,
    );
    if (iv === null) return nullResult;
    return {
      delta: bachelierDelta(bsType, underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
      gamma: bachelierGamma(underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
      theta: bachelierTheta(bsType, underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
      vega: bachelierVega(underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
      iv,
      model: "bachelier",
    };
  }

  // Black-Scholes for longer-dated options (dte >= 0.1 days).
  // iv field stores annualized log-normal volatility (0-N, not percentage).
  const iv = solveIV(bsType, optionPrice, underlyingPrice, strike, T, riskFreeRate, dividendYield);
  if (iv === null) return nullResult;
  return {
    delta: bsDelta(bsType, underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
    gamma: bsGamma(underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
    theta: bsTheta(bsType, underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
    vega: bsVega(underlyingPrice, strike, T, riskFreeRate, dividendYield, iv),
    iv,
    model: "bs",
  };
}
