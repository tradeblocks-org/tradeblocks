/**
 * Apply Holm's step-down family-wise adjustment to raw p-values.
 *
 * Sorts stably in ascending order, multiplies each p-value by the number of
 * remaining hypotheses, caps at one, and enforces a running maximum. Results
 * are returned in input order without mutating the input. Empty families return
 * an empty array. Callers declare the complete family across comparisons;
 * unavailable p-values must be handled explicitly before calling this function.
 *
 * @throws {RangeError} If a p-value is not finite or outside [0, 1], naming its index.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const ranked = pValues.map((pValue, index) => {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new RangeError(`pValues[${index}] must be a finite number in [0, 1]`);
    }
    return { pValue, index };
  });
  ranked.sort((a, b) => a.pValue - b.pValue || a.index - b.index);

  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  for (let rank = 0; rank < ranked.length; rank++) {
    const { pValue, index } = ranked[rank];
    running = Math.max(running, Math.min(1, (ranked.length - rank) * pValue));
    adjusted[index] = running;
  }
  return adjusted;
}
