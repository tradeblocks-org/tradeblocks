export interface DatedEquity {
  date: string;
  equity: number;
}

export interface DrawdownEpisode {
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
  depthPct: number;
  underwaterDays: number;
}

/** Input is one positive, finite account equity per Eastern calendar day, in date order. */
export function drawdownEpisodesFromEquity(series: ReadonlyArray<DatedEquity>): DrawdownEpisode[] {
  const episodes: DrawdownEpisode[] = [];
  let peak = 0;
  let peakDate = "";
  let current: DrawdownEpisode | null = null;
  for (const point of series) {
    if (!(point.equity > 0) || !Number.isFinite(point.equity)) {
      throw new RangeError("Equity must be finite and positive");
    }
    if (point.equity >= peak) {
      if (current) {
        current.recoveryDate = point.date;
        episodes.push(current);
        current = null;
      }
      peak = point.equity;
      peakDate = point.date;
    } else {
      const depthPct = ((peak - point.equity) / peak) * 100;
      if (!current) {
        current = {
          peakDate,
          troughDate: point.date,
          recoveryDate: null,
          depthPct,
          underwaterDays: 0,
        };
      } else if (depthPct > current.depthPct) {
        current.troughDate = point.date;
        current.depthPct = depthPct;
      }
      current.underwaterDays++;
    }
  }
  if (current) episodes.push(current);
  return episodes;
}

/** Observation counts, not elapsed civil days; recovery day itself is not underwater. */
export function drawdownDurationFromEquity(series: ReadonlyArray<DatedEquity>): {
  underwaterDays: number;
  observedDays: number;
  timeUnderwaterPct: number | undefined;
  longestUnderwaterDays: number;
} {
  const episodes = drawdownEpisodesFromEquity(series);
  const underwaterDays = episodes.reduce((sum, episode) => sum + episode.underwaterDays, 0);
  return {
    underwaterDays,
    observedDays: series.length,
    timeUnderwaterPct: series.length ? (underwaterDays / series.length) * 100 : undefined,
    longestUnderwaterDays: Math.max(0, ...episodes.map((episode) => episode.underwaterDays)),
  };
}

/** Each calendar period is measured against the previous period's last equity; the first period starts at its first observation. */
export function calendarReturnsFromEquity(
  series: ReadonlyArray<DatedEquity>,
  period: "month" | "year",
): Array<{ period: string; startDate: string; endDate: string; returnPct: number }> {
  const result: Array<{ period: string; startDate: string; endDate: string; returnPct: number }> =
    [];
  let previousEnd: DatedEquity | undefined;
  let first: DatedEquity | undefined;
  let last: DatedEquity | undefined;
  let key: string | undefined;
  const finish = () => {
    if (first && last && key) {
      result.push({
        period: key,
        startDate: first.date,
        endDate: last.date,
        returnPct: (last.equity / (previousEnd?.equity ?? first.equity) - 1) * 100,
      });
      previousEnd = last;
    }
  };
  for (const point of series) {
    if (!(point.equity > 0) || !Number.isFinite(point.equity)) {
      throw new RangeError("Equity must be finite and positive");
    }
    const nextKey = period === "month" ? point.date.slice(0, 7) : point.date.slice(0, 4);
    if (nextKey !== key) {
      finish();
      key = nextKey;
      first = point;
    }
    last = point;
  }
  finish();
  return result;
}
