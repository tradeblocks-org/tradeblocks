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

/** Decimal places this domain represents exactly. */
export const MONEY_DECIMAL_PLACES = 6;

/** Largest magnitude representable exactly, in dollars. */
export const MONEY_MAX_DOLLARS = Math.floor(Number.MAX_SAFE_INTEGER / SCALE);

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

/**
 * Convert an amount this code COMPUTED and must compare — a replay-derived P&L,
 * a drop from a running peak — never annihilating it.
 *
 * A threshold that cannot be represented is refused, because a caller can pick a
 * different one. A computed P&L cannot be refused: the position has the P&L it
 * has, and aborting an analysis over a fraction of a millionth of a dollar would
 * be worse than any rounding. But it must not be rounded to ZERO either, because
 * zero is not just an imprecise answer — it is the wrong SIDE of every threshold
 * at or around zero. A stop at $0 fired on a positive P&L of $0.0000004 for
 * exactly that reason.
 *
 * So a non-zero amount too small to represent becomes the smallest amount of its
 * OWN SIGN rather than zero. The magnitude shifts by less than a millionth of a
 * dollar, far below any resolution money is decided at here, and the sign and
 * ordering that actually decide the exit are preserved.
 */
export function toMoneyOperand(amount: number): Money {
  const value = toMoney(amount);
  if (value === 0 && amount !== 0) return amount > 0 ? 1 : -1;
  return value;
}

/**
 * Raised when an amount cannot be carried in this domain without changing what
 * it means. Callers at the tool boundary turn it into a field-named input error.
 */
export class MoneyDomainError extends Error {}

/**
 * Convert a monetary amount that ORIGINATES OUTSIDE this module — typed by a
 * caller, or derived from caller-supplied prices — naming the field it came from.
 *
 * Two conversions are refused, because both would silently change an exit
 * decision rather than merely round it:
 *
 *  - one that ANNIHILATES a non-zero amount. A threshold of a millionth of a
 *    cent becomes zero, and a zero threshold is met by every position, so a stop
 *    nobody could reach turns into one that fires immediately.
 *  - one that OVERFLOWS the exact range, which would otherwise surface as an
 *    unexplained failure part-way through an analysis.
 *
 * Everything else converts. Ordinary binary noise on a derived value —
 * `7.780000000000001` from a price times a multiplier — is snapped back to the
 * decimal it represents, which is the whole point. Rounding at the millionth of
 * a dollar is below any resolution money is decided at here, and is not treated
 * as an error.
 *
 * This is deliberately checked on the RESULT of the conversion rather than on the
 * shape of the input, so it holds identically for a value a caller typed and one
 * this code derived. An input-shaped check cannot do that: it never sees the
 * derived value at all.
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
  if (scaled === 0 && amount !== 0) {
    throw new MoneyDomainError(
      `${field} is smaller than the smallest amount this analysis can represent (a millionth of a dollar)`,
    );
  }
  return scaled === 0 ? 0 : scaled;
}

/**
 * Apply a caller-supplied ratio to a monetary amount, naming the field, and
 * refuse a result the domain cannot carry. A percentage is a ratio rather than
 * money and is not itself constrained — but the dollars it produces are, and
 * that product is where an unusable percentage actually bites.
 */
export function applyRatioField(amount: Money, ratio: number, field: string): Money {
  if (!Number.isFinite(ratio)) {
    throw new MoneyDomainError(`${field} must be a finite number`);
  }
  return toMoneyField(fromMoney(amount) * ratio, field);
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

/**
 * Render a ratio as a percentage without misstating it.
 *
 * Whole percentages print as before. A half-percent stop keeps its half: rounding
 * to a whole number reported a 0.5% stop as "1%", so the detail line named a
 * threshold the caller had not configured.
 */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  const rounded = Math.round(pct * 1000) / 1000;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}%`;
}
