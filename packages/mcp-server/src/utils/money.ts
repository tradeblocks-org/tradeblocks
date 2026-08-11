/**
 * Exact decimal money for exit-threshold comparisons.
 *
 * Money in an options position is DECIMAL money: premiums quote in decimal
 * increments, an exit threshold is a decimal percentage of a decimal entry cost,
 * and the figures reported back to the caller are decimal. Computing that in
 * binary floating point produces a threshold that is not the one anybody asked
 * for.
 *
 * The concrete failure this exists to remove: a 1% stop against a $35 entry cost
 * evaluates to 0.35000000000000003 in binary, while the analysis reports the
 * threshold as "-$0.35". A position whose P&L is exactly -$0.35 therefore sits a
 * hair inside a stop it is being told it has reached, and the analysis answers
 * that the stop did not fire. The comparison and the reported figure were
 * different numbers.
 *
 * The repair is representational rather than a tolerance. There is no epsilon
 * here and no rounding policy to choose, because an exactly representable domain
 * has no "just below half" case to have a policy about.
 *
 * REPRESENTATION. A fixed-point integer count of micro-dollars (1e-6 USD) held in
 * an ordinary number. Integers below 2^53 are exact, covering roughly
 * $9,007,199,254 — far beyond any position these tools analyse — and the guards
 * below fail loudly rather than silently losing precision if that is ever untrue.
 * Micro-dollars rather than cents is deliberate: premiums quote in half-cent
 * steps, so a percentage of an entry cost lands on fractions of a cent routinely,
 * and a cent domain would have to round real money away.
 *
 * INPUT CONTRACT. Conversion assumes a decimal input with at most six places,
 * which is what every price, percentage and threshold in this surface is. Within
 * that contract `Math.round(x * SCALE)` recovers the exact intended integer: the
 * error of a single multiplication is far below the half unit that would tip the
 * rounding. A value already carrying binary noise — 0.35000000000000003 — snaps
 * back to the decimal it was always meant to be, which is exactly the repair
 * wanted at the boundary.
 *
 * WHAT THIS DOES NOT DECIDE. It makes exact equality reachable and deterministic;
 * it does not change what happens there. Every comparison below stays INCLUSIVE,
 * which is the long-standing behaviour of these tools and of the thresholds they
 * report.
 */

/** Micro-dollars per dollar. */
const SCALE = 1_000_000;

/** A monetary amount as an exact integer count of micro-dollars. */
export type Money = number;

function assertExact(value: number, what: string, source: unknown): Money {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${what}: monetary value is outside the exact range of this money domain (got ${String(source)})`,
    );
  }
  // Normalise signed zero so -0 and 0 never compare or serialise differently.
  return value === 0 ? 0 : value;
}

/**
 * Convert a decimal dollar amount into the money domain.
 *
 * Throws rather than guessing on a non-finite amount, so a corrupt operand
 * surfaces at its source instead of silently deciding whether an exit fired.
 * Callers holding a sentinel rather than an amount — an unarmed running maximum,
 * for instance — must not pass it here.
 */
export function toMoney(amount: number): Money {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`toMoney: expected a finite amount, got ${String(amount)}`);
  }
  return assertExact(Math.round(amount * SCALE), "toMoney", amount);
}

/** Convert back to dollars for reporting. */
export function fromMoney(value: Money): number {
  return value / SCALE;
}

/** Exact difference. */
export function subMoney(a: Money, b: Money): Money {
  return assertExact(a - b, "subMoney", `${a} - ${b}`);
}

/** Exact negation. */
export function negMoney(a: Money): Money {
  return a === 0 ? 0 : -a;
}

/**
 * Multiply a monetary amount by a decimal ratio — a percentage threshold against
 * an entry cost. The ratio is applied directly to the integer amount rather than
 * being scaled into the domain first, which would form a product at
 * micro-times-micro magnitude and overflow exact-integer range on ordinary
 * operands.
 */
export function applyRatio(amount: Money, ratio: number): Money {
  if (!Number.isFinite(ratio)) {
    throw new RangeError(`applyRatio: expected a finite ratio, got ${String(ratio)}`);
  }
  return assertExact(Math.round(amount * ratio), "applyRatio", `${amount} x ${ratio}`);
}

/** Inclusive "at least" — the profit-target direction. */
export function moneyAtLeast(amount: Money, threshold: Money): boolean {
  return amount >= threshold;
}

/** Inclusive "at most" — the stop-loss direction. */
export function moneyAtMost(amount: Money, threshold: Money): boolean {
  return amount <= threshold;
}

/**
 * Render a monetary amount for a reported detail line without misstating it.
 *
 * Two decimals stays the house style: a whole number of cents formats exactly as
 * `toFixed(2)` always did, so the overwhelming majority of detail strings are
 * unchanged. An amount carrying real sub-cent precision keeps the digits it
 * actually has, so the figure reported is the figure compared.
 */
export function formatMoney(value: Money): string {
  if (value % 10_000 === 0) return (value / SCALE).toFixed(2);
  return (value / SCALE).toFixed(6).replace(/(\.\d\d[0-9]*?)0+$/, "$1");
}
