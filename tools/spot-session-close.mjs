// Sourced close authority for spot partitions.
//
// Regular closes follow the published Cboe index hours (16:15 ET) and US
// equities core session (16:00 ET). Early-close rules follow the Cboe/NYSE
// annual holiday schedules. Full closures are owned by the caller's bounded
// XNYS session calendar; a date that is not a session must not be judged here.

const SPOT_REGULAR_EXPECTATION = new Map([
  // Cboe index RTH continues after the 16:00 core-equity close. These indices
  // are sparse, so they need not print at 16:15; requiring one observation in
  // the extended close window distinguishes a real session from the incident's
  // hard 16:00 cutoff without inventing a synthetic close print.
  ["SPX", { sessionClose: "16:15", minimumLastBar: "16:01" }],
  ["VIX", { sessionClose: "16:15", minimumLastBar: "16:01" }],
  ["VIX3M", { sessionClose: "16:15", minimumLastBar: "16:01" }],
  ["VIX9D", { sessionClose: "16:15", minimumLastBar: "16:01" }],
  // Equity minute bars are interval-start labeled: 15:59 covers the final
  // minute of the 16:00 core session.
  ["QQQ", { sessionClose: "16:00", minimumLastBar: "15:59" }],
  ["SPY", { sessionClose: "16:00", minimumLastBar: "15:59" }],
  ["IWM", { sessionClose: "16:00", minimumLastBar: "15:59" }],
]);
const CBOE_INDEX_TICKERS = new Set(["SPX", "VIX", "VIX3M", "VIX9D"]);

function nthWeekdayOfMonth(year, monthIndex, weekday, occurrence) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + offset + (occurrence - 1) * 7));
}

export function isEarlyCloseSession(date, isSession) {
  if (!isSession(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  if ((month === 6 && day === 3) || (month === 11 && day === 24)) return true;
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4);
  const fridayAfter = new Date(thanksgiving.getTime() + 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  return date === fridayAfter;
}

export function knownSpotSessionClose(ticker, date, isSession) {
  return spotSessionExpectation(ticker, date, isSession)?.sessionClose ?? null;
}

export function spotSessionExpectation(ticker, date, isSession) {
  const regular = SPOT_REGULAR_EXPECTATION.get(ticker);
  if (!regular) return null;
  if (!isEarlyCloseSession(date, isSession)) return regular;
  if (ticker === "SPX") {
    // Cboe can publish SPX observations through 13:15, but the official early
    // close itself is a valid final SPX observation (observed 2025-11-28).
    return { sessionClose: "13:15", minimumLastBar: "13:00" };
  }
  return CBOE_INDEX_TICKERS.has(ticker)
    ? { sessionClose: "13:15", minimumLastBar: "13:01" }
    : { sessionClose: "13:00", minimumLastBar: "12:59" };
}
