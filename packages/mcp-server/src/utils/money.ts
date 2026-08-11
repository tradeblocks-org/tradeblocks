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
 * SCOPE, AND WHY IT STOPS WHERE IT DOES. This module governs the amounts this
 * tool DERIVES — a threshold from a percentage and an entry cost, a step's arm
 * and stop. It deliberately does not touch the P&L path, which arrives already
 * computed from the replay. Making claims about the intended decimal value of a
 * number this tool did not compute means inventing a rounding policy for values
 * with no ground truth, and every such rule has an edge: promoting a sub-micro
 * P&L to keep its sign flips its decision against a one-micro threshold, while
 * rounding it to zero flips its decision against a zero threshold. Neither is
 * correct, because the question is unanswerable from here. So the tool derives
 * its own thresholds exactly, compares the P&L it was handed against them as
 * given, and claims nothing further.
 *
 * REPRESENTATION. A fixed-point integer count of micro-dollars (1e-6 USD) held in
 * an ordinary number. Integers below 2^53 are exact, covering roughly
 * $9,007,199,254 — far beyond any position these tools analyse — and the guards
 * below fail loudly rather than silently losing precision if that is ever untrue.
 * Micro-dollars rather than cents is deliberate: premiums quote in half-cent
 * steps, so a percentage of an entry cost lands on fractions of a cent routinely,
 * and a cent domain would have to round real money away.
 *
 * The repair is representational rather than a tolerance. There is no epsilon
 * here and no rounding policy to choose between, because an exactly representable
 * derivation has no "just below half" case to have a policy about.
 */

/** Micro-dollars per dollar. */
const SCALE = 1_000_000;

/** Largest magnitude representable exactly, in dollars. */
const MONEY_MAX_DOLLARS = Math.floor(Number.MAX_SAFE_INTEGER / SCALE);

/** A monetary amount as an exact integer count of micro-dollars. */
export type Money = number;

/**
 * Raised when an amount cannot be carried in this domain without changing what it
 * means. The registered tool handlers surface it as a field-named input error.
 */
export class MoneyDomainError extends Error {}

/**
 * Bring a dollar amount into the domain, naming the field it came from.
 *
 * Two conversions are refused, because both would silently change an exit
 * decision rather than merely round it:
 *
 *  - one that ANNIHILATES a non-zero amount. A threshold of a millionth of a cent
 *    becomes zero, and a zero threshold is met by every position, so a stop nobody
 *    could reach turns into one that fires immediately.
 *  - one that OVERFLOWS the exact range, which would otherwise surface as an
 *    unexplained failure part-way through an analysis.
 *
 * Everything else converts. Ordinary binary noise — `0.35000000000000003` from a
 * percentage times an entry cost — snaps back to the decimal it was always meant
 * to be, which is the whole point.
 *
 * The check is on the RESULT of the conversion rather than the shape of the
 * input, so it holds identically for an amount a caller typed and one derived
 * from caller-supplied prices. An input-shaped check cannot do that: it never
 * sees the derived value at all.
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
  // Refuse ANY amount the domain cannot carry exactly, not only one that would
  // vanish. Rounding $0.0000006 UP to $0.000001 silently substitutes a threshold
  // the caller did not set; that the result stays non-zero makes it less visible
  // than rounding to zero, not less wrong. The vanishing case keeps its own
  // message because it is the one with an obvious consequence: a zero threshold
  // is met by every position.
  if (scaled === 0 && amount !== 0) {
    throw new MoneyDomainError(
      `${field} is smaller than the smallest amount this analysis can represent (a millionth of a dollar)`,
    );
  }
  if (Math.abs(scaled - amount * SCALE) > Math.abs(amount * SCALE) * 8 * Number.EPSILON) {
    throw new MoneyDomainError(
      `${field} is finer than this analysis can represent (a millionth of a dollar)`,
    );
  }
  return scaled === 0 ? 0 : scaled;
}

/**
 * Apply a caller-supplied ratio to a monetary amount, naming the field.
 *
 * A percentage is a ratio rather than money and is not itself constrained — but
 * the dollars it produces are, and that product is where an unusable percentage
 * actually bites.
 */
export function applyRatioField(amount: Money, ratio: number, field: string): Money {
  if (!Number.isFinite(ratio)) {
    throw new MoneyDomainError(`${field} must be a finite number`);
  }
  return toMoneyField(fromMoney(amount) * ratio, field);
}

/**
 * The dollar value of one option leg: (mark - entry) x quantity x multiplier.
 *
 * Prices enter the domain BEFORE the subtraction, which is what makes the result
 * exact. A mark of `1.0003` against an entry of `1.00` at a multiplier of 100 is
 * three cents, not `0.029999999999996696` — and a three-cent threshold should be
 * reached by a three-cent move.
 *
 * Integer addition is also associative, so the order legs are summed in cannot
 * change the total.
 */
export function legValue(
  markPrice: number,
  entryPrice: number,
  quantity: number,
  multiplier: number,
): Money {
  if (!Number.isInteger(quantity) || !Number.isInteger(multiplier)) {
    throw new MoneyDomainError("leg quantity and multiplier must be whole numbers");
  }
  const delta =
    toMoneyField(markPrice, "leg mark price") - toMoneyField(entryPrice, "leg entry price");
  const value = delta * quantity * multiplier;
  if (!Number.isSafeInteger(value)) {
    throw new MoneyDomainError("leg value is beyond the range this analysis can represent");
  }
  return value === 0 ? 0 : value;
}

/**
 * Bring a P&L this package DERIVED back into the domain.
 *
 * Safe without a refusal branch because of an invariant this package now
 * establishes: `legValue` yields whole micro-dollars, so every P&L built from it
 * already sits on the domain's grid and converting it loses nothing. This is not
 * a rounding policy for arbitrary values — a leg price finer than the domain is
 * refused at `legValue`, so such a P&L cannot reach here through the public
 * tools.
 */
export function toMoneyPnl(amount: number): Money {
  const scaled = Math.round(amount * SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyDomainError("P&L is beyond the range this analysis can represent");
  }
  return scaled === 0 ? 0 : scaled;
}

/** Exact difference. */
export function subMoney(a: Money, b: Money): Money {
  const value = a - b;
  if (!Number.isSafeInteger(value)) {
    throw new MoneyDomainError("difference is beyond the range this analysis can represent");
  }
  return value === 0 ? 0 : value;
}

/** Exact sum of leg values. */
export function sumMoney(values: Money[]): Money {
  let total = 0;
  for (const v of values) total += v;
  if (!Number.isSafeInteger(total)) {
    throw new MoneyDomainError("total value is beyond the range this analysis can represent");
  }
  return total === 0 ? 0 : total;
}

/** Convert back to dollars, for comparison against a P&L and for reporting. */
export function fromMoney(value: Money): number {
  return value / SCALE;
}

/**
 * Render a derived threshold without misstating it.
 *
 * Two decimals stays the house style: a whole number of cents formats exactly as
 * `toFixed(2)` always did, so the overwhelming majority of reported thresholds are
 * unchanged. One carrying real sub-cent precision keeps the digits it has, so the
 * figure reported is the figure compared — a stepped floor of `$0.175` reports as
 * `$0.175` rather than as `$0.17` or `$0.18`.
 */
export function formatMoney(value: Money): string {
  if (value % 10_000 === 0) return (value / SCALE).toFixed(2);
  return (value / SCALE).toFixed(6).replace(/(\.\d\d[0-9]*?)0+$/, "$1");
}

/**
 * Render a ratio as a percentage without misstating it.
 *
 * Whole percentages print as before. A half-percent stop keeps its half: rounding
 * to a whole number reported a 0.5% stop as "1%", naming a threshold the caller
 * had not configured.
 */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  const rounded = Math.round(pct * 1000) / 1000;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}%`;
}
