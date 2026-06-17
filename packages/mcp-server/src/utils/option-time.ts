function parseDateUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function minutesFromTime(time: string): number {
  const [hour, minute] = time.slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

export function computeFractionalDte(
  date: string,
  time: string,
  expiration: string,
): number {
  const startDay = parseDateUtc(date).getTime();
  const expiryDay = parseDateUtc(expiration).getTime();
  const dayDiff = Math.round((expiryDay - startDay) / 86_400_000);
  const remainingMinutes = Math.max((16 * 60) - minutesFromTime(time), 0);
  return Math.max(dayDiff + (remainingMinutes / (24 * 60)), 0);
}
