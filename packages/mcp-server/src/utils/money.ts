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
 * SCOPE, AND WHY IT STOPS WHERE IT DOES. This module governs the monetary amounts
 * this tool converts or derives — direct thresholds and trails, percentage
 * thresholds from an entry cost, and a step's arm and stop. It deliberately does
 * not touch the P&L path, which arrives already computed from the replay. Making
 * claims about the intended decimal value of a number this tool did not compute
 * means inventing a rounding policy for values with no ground truth, and every
 * such rule has an edge: promoting a sub-micro P&L to keep its sign flips its
 * decision against a one-micro threshold, while rounding it to zero flips its
 * decision against a zero threshold. Neither is correct, because the question is
 * unanswerable from here. So the tool derives its own fixed-point thresholds
 * exactly, compares the P&L it was handed against them as given, and claims
 * nothing further.
 *
 * REPRESENTATION. A fixed-point integer count of micro-dollars (1e-6 USD) held in
 * an ordinary number. Integers below 2^53 are exact, covering roughly
 * $9,007,199,254 — far beyond any position these tools analyse — and the guards
 * below fail loudly rather than silently losing precision in that integer count.
 * Micro-dollars rather than cents is deliberate: option-price midpoints can land
 * on half-cent increments, so a percentage of an entry cost routinely lands on
 * fractions of a cent, and a cent domain would have to round real money away.
 *
 * DERIVATION AND BOUNDARY TOLERANCE. The thresholds this module derives are exact
 * fixed-point amounts: comparison and reporting are produced from the same exact
 * integer micro-dollar value. Bringing in a value produced by a caller's
 * arithmetic does use a tolerance, however. Operations before this boundary can
 * leave binary noise, so conversion absorbs noise at that scale and refuses
 * anything larger.
 * That is why `$0.0000010000000000287557` is accepted as one micro-dollar while
 * `$0.0000006` is refused. This is a tolerance, not a representation-only repair;
 * it is intended to repair boundary noise rather than generally round nearby
 * monetary values. Its behavior at the extreme end of the domain is documented
 * where it is defined.
 *
 * The tolerance could be removed for entry costs by deriving the entry cost
 * through this module at its source in the handler: convert its operands before
 * subtracting or reducing them instead of doing raw arithmetic and converting
 * only the result. That broader change is not made here.
 */

/** Micro-dollars per dollar. */
const SCALE = 1_000_000;

/** Largest whole-dollar magnitude whose scaled count is a safe integer. */
const MONEY_MAX_DOLLARS = Math.floor(Number.MAX_SAFE_INTEGER / SCALE);

/** A monetary amount as an exact integer count of micro-dollars. */
export type Money = number;

/**
 * Raised when an amount cannot be carried in this domain under its conversion
 * rules. Tool handlers return it as an error message identifying the affected
 * field.
 */
export class MoneyDomainError extends Error {}

/**
 * Bring a dollar amount into the domain, naming the field it came from.
 *
 * Non-finite inputs are refused first. Lossy conversions are then refused when:
 *
 *  - the conversion ANNIHILATES a non-zero amount. A small non-zero stop becomes
 *    zero, materially broadening it to fire at any non-positive P&L.
 *  - it OVERFLOWS the exact range, which would otherwise surface as an
 *    unexplained failure part-way through an analysis.
 *  - it differs from the nearest micro-dollar by more than the boundary
 *    tolerance, which would otherwise substitute a nearby threshold the caller
 *    did not set.
 *
 * Ordinary binary noise within the tolerance — `0.35000000000000003` from a
 * percentage times an entry cost, including noise introduced by cancellation
 * before this boundary — snaps back to the decimal it was always meant to be.
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
  // The vanishing case keeps its own message because its consequence is distinct:
  // a small non-zero stop becomes zero and fires at any non-positive P&L.
  if (scaled === 0 && amount !== 0) {
    throw new MoneyDomainError(
      `${field} is smaller than the smallest amount this analysis can represent (a millionth of a dollar)`,
    );
  }
  const scaledAmount = amount * SCALE;
  // Caller-side cancellation noise scales with the operands that produced a
  // small result, not with the result itself, so a relative tolerance alone can
  // collapse near zero. The 1e-9 absolute floor is a judgment about the noise
  // this conversion should absorb, not a derived constant. At roughly $281M the
  // relative term reaches half a micro-dollar and therefore admits every
  // fractional value within a micro-dollar interval; that is well beyond intended
  // position sizes.
  const conversionTolerance = Math.max(1e-9, Math.abs(scaledAmount) * 8 * Number.EPSILON);
  if (Math.abs(scaled - scaledAmount) > conversionTolerance) {
    throw new MoneyDomainError(
      `${field} is finer than this analysis can represent (a millionth of a dollar)`,
    );
  }
  return scaled === 0 ? 0 : scaled;
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
  return toMoneyField(fromMoney(amount) * ratio, field);
}

/** Convert back to dollars, for comparison against a P&L and for reporting. */
export function fromMoney(value: Money): number {
  return value / SCALE;
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

/**
 * Render a ratio as a percentage rounded to three decimal percentage points.
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
