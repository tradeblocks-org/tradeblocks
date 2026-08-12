/**
 * Exact derivation of the dollar thresholds exit analysis compares against.
 *
 * An exit threshold is decimal money: a decimal percentage of a decimal entry
 * cost, reported back to the caller in decimals. Deriving it in binary floating
 * point produces a threshold that is not the one anybody asked for.
 *
 * The concrete failure this exists to remove: a 1% stop against a $35 entry cost
 * evaluates to `0.35000000000000003`, while the analysis reports the threshold as
 * `-$0.35`. A position whose P&L is exactly `-$0.35` therefore sits a hair inside
 * a stop it is being told it has reached, and the analysis answers that the stop
 * did not fire. The comparison and the reported figure were different numbers.
 *
 * SCOPE. This module governs the monetary amounts the exit-analysis tool computes:
 * direct thresholds and trails, percentage thresholds from an entry cost, a
 * step's arm and stop, and replayed P&L. Each replay leg enters the domain before
 * its price difference is taken, then leg values are resolved and added in the
 * domain. Integral position scaling stays integer throughout; fractional scaling
 * accepted by the public replay interface resolves back into the domain per leg.
 * A P&L leaves the domain only once, after the position or leg group has been
 * accumulated. Differences used for exit decisions and comparisons are also
 * taken in the domain.
 *
 * REPRESENTATION. A fixed-point integer count of micro-dollars (1e-6 USD) held in
 * an ordinary number. Integers below 2^53 are exact, covering roughly
 * $9,007,199,254 — far beyond any position these tools analyse — and the guards
 * below fail loudly rather than silently losing precision in that integer count.
 * Micro-dollars rather than cents is deliberate: option-price midpoints can land
 * on half-cent increments, so a percentage of an entry cost routinely lands on
 * fractions of a cent, and a cent domain would have to round real money away.
 *
 * RESOLUTION. Every finite amount in range resolves to the nearest micro-dollar.
 * Comparison and reporting are then produced from that same exact integer value.
 * This applies equally to a configured dollar amount and to a value produced by
 * earlier caller or handler arithmetic: `$0.0000006` resolves to `$0.000001`, and
 * binary noise around a micro-dollar resolves to that micro-dollar. The boundary
 * does not try to infer which finer digits are intentional because the number
 * alone cannot answer that question.
 */

/** Micro-dollars per dollar. */
const SCALE = 1_000_000;

/** Largest whole-dollar magnitude whose scaled count is a safe integer. */
const MONEY_MAX_DOLLARS = Math.floor(Number.MAX_SAFE_INTEGER / SCALE);

/** A monetary amount as an exact integer count of micro-dollars. */
export type Money = number;

/**
 * Raised when an amount cannot be carried in this domain. Tool handlers return
 * it as an error message identifying the affected field.
 */
export class MoneyDomainError extends Error {}

/**
 * Bring a dollar amount into the domain, naming the field it came from.
 *
 * Non-finite inputs and values beyond the exact integer range are refused. Every
 * other amount resolves to the nearest micro-dollar, including amounts finer than
 * that resolution and binary noise left by arithmetic before this boundary.
 */
export function toMoneyField(amount: number, field: string): Money {
  if (!Number.isFinite(amount)) {
    throw new MoneyDomainError(`${field} must be a finite dollar amount`);
  }
  const scaled = Math.round(amount * SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyDomainError(
      `${field} is beyond the largest dollar amount this analysis can represent (about ${MONEY_MAX_DOLLARS.toLocaleString("en-US")})`,
    );
  }
  return scaled === 0 ? 0 : scaled;
}

function checkedMoney(value: number, field: string): Money {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyDomainError(`${field} is beyond the exact monetary range`);
  }
  return value === 0 ? 0 : value;
}

/** Add two monetary values without leaving the fixed-point domain. */
export function addMoney(left: Money, right: Money, field: string): Money {
  return checkedMoney(left + right, field);
}

/** Subtract two monetary values without leaving the fixed-point domain. */
export function subMoney(left: Money, right: Money, field: string): Money {
  return addMoney(left, -right, field);
}

/** Negate a monetary value, keeping zero canonical. */
export function negMoney(value: Money): Money {
  return value === 0 ? 0 : -value;
}

/** Multiply a monetary value by an integer quantity or multiplier. */
export function scaleMoney(value: Money, factor: number, field: string): Money {
  if (!Number.isInteger(factor)) {
    throw new MoneyDomainError(`${field} must be an integer`);
  }
  return checkedMoney(value * factor, field);
}

/** Compute one replay leg's P&L with the price difference taken in the domain. */
export function legPnlMoney(
  markPrice: number,
  entryPrice: number,
  quantity: number,
  multiplier: number,
): Money {
  const priceDifference = addMoney(
    toMoneyField(markPrice, "mark price"),
    -toMoneyField(entryPrice, "entry price"),
    "price difference",
  );
  const scaled = priceDifference * quantity * multiplier;
  if (!Number.isFinite(scaled)) {
    throw new MoneyDomainError("leg P&L must be a finite dollar amount");
  }
  // Fractional scaling resolves each leg independently to the micro-dollar grid;
  // callers then add those integers, so the result remains independent of leg order.
  return Number.isSafeInteger(scaled)
    ? scaled === 0
      ? 0
      : scaled
    : toMoneyField(fromMoney(priceDifference) * quantity * multiplier, "leg P&L");
}

/**
 * Apply a caller-supplied ratio to a monetary amount, naming the field.
 *
 * A percentage is a ratio rather than money, so it is required to be finite but
 * is not constrained to the monetary grid. The dollars it produces are, and that
 * product is where an unusable percentage actually bites.
 */
export function applyRatioField(amount: Money, ratio: number, field: string): Money {
  if (!Number.isFinite(ratio)) {
    throw new MoneyDomainError(`${field} must be a finite number`);
  }
  // The amount is already resolved to an exact integer and the ratio is finite.
  // Their direct product avoids a micro-to-dollar round trip and is exact when
  // floating-point error cannot move the product across a half-integer boundary.
  const scaled = Math.round(amount * ratio);
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyDomainError(
      `${field} is beyond the largest dollar amount this analysis can represent (about ${MONEY_MAX_DOLLARS.toLocaleString("en-US")})`,
    );
  }
  return scaled === 0 ? 0 : scaled;
}

/**
 * Derive a percentage-of-entry-cost threshold as the domain operation call sites
 * intend, rather than as cosmetic duplication of general ratio application.
 */
export function thresholdFromEntryCost(entryCost: Money, ratio: number, field: string): Money {
  return applyRatioField(entryCost, ratio, field);
}

/** Convert back to dollars, for comparison against a P&L and for reporting. */
export function fromMoney(value: Money): number {
  return value / SCALE;
}

/**
 * Inclusive comparisons used by the public analyzer, whose trigger detail lines
 * already describe their boundaries with inclusive language.
 */
export function moneyAtLeast(amount: Money, threshold: Money): boolean {
  return amount >= threshold;
}

export function moneyAtMost(amount: Money, threshold: Money): boolean {
  return amount <= threshold;
}

/**
 * Render a derived threshold with up to six decimal places.
 *
 * Two decimals stays the house style: a whole number of cents formats exactly as
 * `toFixed(2)` always did. At ordinary position sizes, a value carrying real
 * sub-cent precision keeps its digits, so the figure reported is the figure
 * compared — a stepped floor of `$0.175` reports as `$0.175` rather than as
 * `$0.17` or `$0.18`.
 *
 * At the extreme edge of the safe-integer domain, converting the integer count
 * back to a binary dollar number can shift the final micro-dollar before it is
 * formatted. That range is far above the position sizes this module is designed
 * to analyse, but the safe-integer guard does not prevent that display effect.
 */
export function formatMoney(value: Money): string {
  if (value % 10_000 === 0) return (value / SCALE).toFixed(2);
  return (value / SCALE).toFixed(6).replace(/(\.\d\d[0-9]*?)0+$/, "$1");
}
