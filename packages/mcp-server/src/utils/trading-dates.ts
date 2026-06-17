/**
 * Compute yesterday's calendar date in America/New_York (ET) as YYYY-MM-DD.
 *
 * Used by the daily market-data refresh script: even though the homelab runs
 * in America/Chicago, the script must always target ET trading dates because
 * that's what ThetaData and the market data partitions are keyed on.
 *
 * Implementation: format `now` in ET to extract today's ET calendar date,
 * then subtract one day via UTC arithmetic on a date constructed from those
 * Y/M/D components. Subtracting via UTC avoids local-timezone DST drift on
 * the host because we never round-trip the result back through a local TZ.
 *
 * @param now Reference timestamp; defaults to current wall clock.
 */
export function yesterdayET(now: Date = new Date()): string {
  // en-CA gives "YYYY-MM-DD" formatting directly.
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const [y, m, d] = todayET.split("-").map(Number);
  // Subtract one day via UTC arithmetic; setUTCDate(0) on the first of the
  // month rolls back to the last day of the prior month, etc.
  const prior = new Date(Date.UTC(y, m - 1, d));
  prior.setUTCDate(prior.getUTCDate() - 1);

  const py = prior.getUTCFullYear();
  const pm = String(prior.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(prior.getUTCDate()).padStart(2, "0");
  return `${py}-${pm}-${pd}`;
}
