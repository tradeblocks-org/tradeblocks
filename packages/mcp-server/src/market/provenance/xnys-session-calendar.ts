import {
  CLOSED_DATES,
  EARLY_CLOSE_DATES,
  XNYS_SESSION_CALENDAR_REVISION,
  XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
} from "./xnys-calendar-data.ts";

export {
  XNYS_SESSION_CALENDAR_REVISION,
  XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
};

// The published MCP package cannot import the private library at runtime.
// Membership snapshots are generated from that library's sole calendar authority.
function supportedDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(
      `${label} must be an ISO calendar date (YYYY-MM-DD): ${JSON.stringify(value)}`,
    );
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is not a real calendar date: ${JSON.stringify(value)}`);
  }
  if (
    value < XNYS_SESSION_CALENDAR_SUPPORTED_FROM ||
    value > XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH
  ) {
    throw new RangeError(
      `${label} ${JSON.stringify(value)} is outside XNYS calendar revision ${XNYS_SESSION_CALENDAR_REVISION} ` +
        `[${XNYS_SESSION_CALENDAR_SUPPORTED_FROM}, ${XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH}]`,
    );
  }
  return date;
}

export function isXnysSessionDate(value: string): boolean {
  const date = supportedDate(value, "XNYS session date");
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !CLOSED_DATES.has(value);
}

export function isEarlyCloseSession(value: string): boolean {
  return isXnysSessionDate(value) && EARLY_CLOSE_DATES.has(value);
}

export function enumerateXnysSessions(from: string, through: string): readonly string[] {
  const first = supportedDate(from, "XNYS session range from");
  const last = supportedDate(through, "XNYS session range through");
  if (first.getTime() > last.getTime()) {
    throw new RangeError(
      `XNYS session range from ${JSON.stringify(from)} exceeds through ${JSON.stringify(through)}`,
    );
  }
  const sessions: string[] = [];
  for (
    let cursor = first;
    cursor.getTime() <= last.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    if (isXnysSessionDate(date)) sessions.push(date);
  }
  return Object.freeze(sessions);
}
