export function sweepThresholds<T>(
  items: T[],
  valueOf: (item: T) => number | null,
  thresholds?: number[],
  percentileSteps = [5, 10, 25, 50, 75, 90, 95],
) {
  const values = items
    .map(valueOf)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const candidates = thresholds?.length
    ? thresholds
    : percentileSteps.map((p) => {
        const index = (Math.max(0, Math.min(100, p)) / 100) * (values.length - 1);
        const low = Math.floor(index);
        const fraction = index - low;
        return (
          values[low] + (values[Math.min(low + 1, values.length - 1)] - values[low]) * fraction
        );
      });
  return [...new Set(candidates)]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .map((threshold) => ({
      threshold,
      lt: items.filter((item) => {
        const value = valueOf(item);
        return value !== null && value < threshold;
      }),
      gt: items.filter((item) => {
        const value = valueOf(item);
        return value !== null && value > threshold;
      }),
    }));
}
