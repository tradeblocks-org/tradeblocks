import { drawdownEpisodesFromEquity } from "./marked-equity.ts";
import type { DatedEquity, DrawdownEpisode } from "./marked-equity.ts";

export interface CalibrationPosition {
  id: string;
  memberId: string;
  quantity: number;
}

export interface CalibrationEntry extends CalibrationPosition {
  /** Net USD per entry contract; the caller has already accounted for fees. */
  netPlPerContract: number;
}

export interface CalibrationLedger {
  entries: readonly CalibrationEntry[];
  markedEquity: readonly DatedEquity[];
  endingCash: number;
  openPositions: readonly CalibrationPosition[];
}

export interface CalibrationTolerances {
  cashUsd: number;
  markedDrawdownPp: number;
}

export interface CalibrationMismatch<T> {
  id: string;
  expected: T;
  observed: T;
}

export interface CalibrationPositionCheck {
  pass: boolean;
  missingIds: string[];
  extraIds: string[];
  memberMismatches: CalibrationMismatch<string>[];
  quantityMismatches: CalibrationMismatch<number>[];
}

export interface CalibrationResidual {
  date: string;
  expected: number | null;
  observed: number | null;
  /** Observed minus expected; null when either date is absent. */
  delta: number | null;
}

export interface ReplayCalibrationResult {
  verdict: "PASS" | "FAIL";
  tolerances: CalibrationTolerances;
  checks: {
    entries: CalibrationPositionCheck;
    quantities: { pass: boolean; mismatches: CalibrationMismatch<number>[] };
    perUnitPnl: { pass: boolean; mismatches: CalibrationMismatch<number>[] };
    openPositions: CalibrationPositionCheck;
    curveDates: { pass: boolean; missingDates: string[]; extraDates: string[] };
    cash: { pass: boolean; expected: number; observed: number; delta: number };
    markedDrawdown: {
      pass: boolean;
      expected: number;
      observed: number;
      delta: number;
      expectedEpisode: DrawdownEpisode | null;
      observedEpisode: DrawdownEpisode | null;
    };
  };
  /** All dates, including absent observations; no intersection or interpolation. */
  residuals: CalibrationResidual[];
  episodeResiduals: Array<
    CalibrationResidual & {
      side: "expected" | "observed";
      point: "peak" | "trough";
    }
  >;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function positions<T extends CalibrationPosition>(
  rows: readonly T[],
  label: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows) {
    if (!row.id || !row.memberId) throw new RangeError(`${label} requires id and memberId`);
    if (indexed.has(row.id)) throw new RangeError(`${label} duplicate id: ${row.id}`);
    if (!Number.isSafeInteger(row.quantity) || row.quantity <= 0) {
      throw new RangeError(`${label}[${row.id}] quantity must be positive whole contracts`);
    }
    indexed.set(row.id, row);
  }
  return indexed;
}

function validate(ledger: CalibrationLedger, label: string) {
  const entries = positions(ledger.entries, `${label}.entries`);
  for (const row of ledger.entries)
    finite(row.netPlPerContract, `${label}.entries[${row.id}].netPlPerContract`);
  const open = positions(ledger.openPositions, `${label}.openPositions`);
  for (const row of open.values()) {
    const entry = entries.get(row.id);
    if (!entry || entry.memberId !== row.memberId || row.quantity > entry.quantity) {
      throw new RangeError(`${label}.openPositions[${row.id}] must match an entry`);
    }
  }
  finite(ledger.endingCash, `${label}.endingCash`);
  if (!ledger.markedEquity.length) throw new RangeError(`${label}.markedEquity must not be empty`);
  const curve = new Map<string, number>();
  let previous = "";
  for (const point of ledger.markedEquity) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(point.date) ||
      new Date(`${point.date}T00:00:00Z`).toISOString().slice(0, 10) !== point.date
    ) {
      throw new RangeError(`${label}.markedEquity invalid calendar date: ${point.date}`);
    }
    if (point.date <= previous)
      throw new RangeError(`${label}.markedEquity dates must be strictly increasing`);
    finite(point.equity, `${label}.markedEquity[${point.date}]`);
    if (point.equity <= 0) throw new RangeError(`${label}.markedEquity requires positive equity`);
    curve.set(point.date, point.equity);
    previous = point.date;
  }
  return { entries, open, curve };
}

function comparePositions(
  expected: Map<string, CalibrationPosition>,
  observed: Map<string, CalibrationPosition>,
): CalibrationPositionCheck {
  const missingIds: string[] = [],
    extraIds: string[] = [];
  const memberMismatches: CalibrationMismatch<string>[] = [];
  const quantityMismatches: CalibrationMismatch<number>[] = [];
  for (const [id, entry] of expected) {
    const native = observed.get(id);
    if (!native) missingIds.push(id);
    else {
      if (entry.memberId !== native.memberId)
        memberMismatches.push({ id, expected: entry.memberId, observed: native.memberId });
      if (entry.quantity !== native.quantity)
        quantityMismatches.push({ id, expected: entry.quantity, observed: native.quantity });
    }
  }
  for (const id of observed.keys()) if (!expected.has(id)) extraIds.push(id);
  return {
    pass:
      !missingIds.length &&
      !extraIds.length &&
      !memberMismatches.length &&
      !quantityMismatches.length,
    missingIds,
    extraIds,
    memberMismatches,
    quantityMismatches,
  };
}

// Symmetric nearest-cent rounding; exact half cents round away from zero.
function cents(value: number): number {
  const scaled = Math.abs(value) * 100;
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  if (!Number.isSafeInteger(rounded)) throw new RangeError("USD value exceeds safe cent precision");
  return Math.sign(value) * rounded;
}

function maximum(series: readonly DatedEquity[]): DrawdownEpisode | null {
  let max: DrawdownEpisode | null = null;
  for (const episode of drawdownEpisodesFromEquity(series)) {
    if (!max || episode.depthPct > max.depthPct) max = episode;
  }
  return max;
}

/**
 * Compare provider-neutral, caller-normalized ledgers without I/O or mutation.
 * Entries are executed rows with stable IDs (partial closes need distinct IDs).
 * Quantities and member identities are exact; per-unit net P&L compares rounded
 * integer cents, nearest cent with half cents away from zero. Cash compares the
 * same cent-rounded values, default tolerance zero USD. Raw residuals are retained.
 * Curves require positive finite equity on strictly increasing calendar dates.
 * Both DDs use drawdownEpisodesFromEquity; the default inclusive ceiling is
 * 0.01 percentage point. Only machine-roundoff at that ceiling is absorbed.
 * Missing dates fail, never intersect silently. Empty entry/open sets are valid;
 * missing/empty curves, invalid numbers, duplicate IDs and negative tolerances throw.
 * Any non-negative declared tolerance is accepted; policy belongs to the caller.
 */
export function compareReplayToNative(
  expected: CalibrationLedger,
  observed: CalibrationLedger,
  options: Partial<CalibrationTolerances> = {},
): ReplayCalibrationResult {
  const tolerances = {
    cashUsd: options.cashUsd ?? 0,
    markedDrawdownPp: options.markedDrawdownPp ?? 0.01,
  };
  for (const [key, value] of Object.entries(tolerances)) {
    finite(value, key);
    if (value < 0) throw new RangeError(`${key} must be non-negative`);
  }
  const a = validate(expected, "expected"),
    b = validate(observed, "observed");
  const entries = comparePositions(a.entries, b.entries);
  const pnlMismatches: CalibrationMismatch<number>[] = [];
  for (const [id, entry] of a.entries) {
    const native = b.entries.get(id);
    const expectedCents = cents(entry.netPlPerContract);
    if (native && expectedCents !== cents(native.netPlPerContract))
      pnlMismatches.push({
        id,
        expected: entry.netPlPerContract,
        observed: native.netPlPerContract,
      });
  }
  // Validate precision even for unmatched observed entries.
  for (const entry of b.entries.values()) cents(entry.netPlPerContract);
  const missingDates = [...a.curve.keys()].filter((date) => !b.curve.has(date));
  const extraDates = [...b.curve.keys()].filter((date) => !a.curve.has(date));
  const datesPass = !missingDates.length && !extraDates.length;
  const residual = (date: string): CalibrationResidual => {
    const expectedValue = a.curve.get(date) ?? null,
      observedValue = b.curve.get(date) ?? null;
    return {
      date,
      expected: expectedValue,
      observed: observedValue,
      delta:
        expectedValue === null || observedValue === null ? null : observedValue - expectedValue,
    };
  };
  const expectedEpisode = maximum(expected.markedEquity),
    observedEpisode = maximum(observed.markedEquity);
  const expectedDd = expectedEpisode?.depthPct ?? 0,
    observedDd = observedEpisode?.depthPct ?? 0;
  const ddDelta = observedDd - expectedDd;
  const roundoff =
    tolerances.markedDrawdownPp === 0
      ? 0
      : 8 * Number.EPSILON * Math.max(1, expectedDd, observedDd);
  const checks: ReplayCalibrationResult["checks"] = {
    entries: {
      ...entries,
      pass:
        !entries.missingIds.length && !entries.extraIds.length && !entries.memberMismatches.length,
    },
    quantities: {
      pass:
        !entries.missingIds.length &&
        !entries.extraIds.length &&
        !entries.quantityMismatches.length,
      mismatches: entries.quantityMismatches,
    },
    perUnitPnl: {
      pass: !entries.missingIds.length && !entries.extraIds.length && !pnlMismatches.length,
      mismatches: pnlMismatches,
    },
    openPositions: comparePositions(a.open, b.open),
    curveDates: { pass: datesPass, missingDates, extraDates },
    cash: {
      pass:
        Math.abs(cents(observed.endingCash) - cents(expected.endingCash)) / 100 <=
        tolerances.cashUsd,
      expected: expected.endingCash,
      observed: observed.endingCash,
      delta: observed.endingCash - expected.endingCash,
    },
    markedDrawdown: {
      pass: datesPass && Math.abs(ddDelta) <= tolerances.markedDrawdownPp + roundoff,
      expected: expectedDd,
      observed: observedDd,
      delta: ddDelta,
      expectedEpisode,
      observedEpisode,
    },
  };
  const episodeResiduals: ReplayCalibrationResult["episodeResiduals"] = [];
  for (const [side, episode] of [
    ["expected", expectedEpisode],
    ["observed", observedEpisode],
  ] as const) {
    if (episode) {
      episodeResiduals.push({ side, point: "peak", ...residual(episode.peakDate) });
      episodeResiduals.push({ side, point: "trough", ...residual(episode.troughDate) });
    }
  }
  return {
    verdict: Object.values(checks).every((check) => check.pass) ? "PASS" : "FAIL",
    tolerances,
    checks,
    residuals: [...new Set([...a.curve.keys(), ...b.curve.keys()])].sort().map(residual),
    episodeResiduals,
  };
}
