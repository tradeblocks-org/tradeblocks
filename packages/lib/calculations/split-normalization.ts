export interface SplitCorporateAction {
  ticker: string;
  /** Effective/ex-date as a calendar key, not an instant. */
  date: string;
  /** Native settlement contracts per original entry contract. */
  ratio: number;
}

export interface NativeSplitRow {
  underlying: string;
  dateOpened: string;
  timeOpened: string;
  dateClosed: string;
  numberOfContracts: number;
  /** Native net P/L, including any producer rounding and fees. */
  profit: number;
  buyingPowerRequired: number;
  /** Omitted means unadjusted. */
  wasAdjusted?: boolean;
}

export interface SplitNormalizedRow<T extends NativeSplitRow> {
  /** Original row, retained without mutation or copying. */
  row: T;
  rowIndex: number;
  nativeQuantity: number;
  entryQuantity: number;
  factor: number;
  netPlPerContract: number;
  buyingPowerPerContract: number;
  action: SplitCorporateAction | null;
}

export interface SplitAdjustedRowFact {
  row_index: number;
  entry_date: string;
  entry_time: string;
  factor: number;
  native_quantity: number;
  entry_quantity: number;
  action: SplitCorporateAction;
}

export type SplitNormalizationRefusal =
  | "split-invalid-action"
  | "split-invalid-row"
  | "split-unknown-adjusted-row"
  | "split-multiple-actions"
  | "split-invalid-entry-quantity"
  | "split-unadjusted-held-row";

export type SplitNormalizationResult<T extends NativeSplitRow> =
  | {
      ok: true;
      rows: SplitNormalizedRow<T>[];
      /** Derived from the same matched actions as rows; callers add member_id. */
      adjusted_rows: SplitAdjustedRowFact[];
    }
  | { ok: false; refused: SplitNormalizationRefusal; detail: string };

function calendarDate(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/**
 * Normalize native totals to entry contracts without reconstructing premiums or rounding.
 * Tickers match exactly; held across means dateOpened < action.date <= dateClosed.
 * Refuses the entire input on a contradiction, never returns a partially normalized tape.
 */
export function normalizeSplitAdjustedRows<T extends NativeSplitRow>(
  rows: readonly T[],
  actions: readonly SplitCorporateAction[],
): SplitNormalizationResult<T> {
  const refuse = (refused: SplitNormalizationRefusal, detail: string) =>
    ({ ok: false, refused, detail }) as const;
  const byTicker = new Map<string, number[]>();
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (
      typeof action.ticker !== "string" ||
      !/^[A-Za-z0-9.^/_-]+$/.test(action.ticker) ||
      !calendarDate(action.date) ||
      !Number.isFinite(action.ratio) ||
      action.ratio <= 0
    ) {
      return refuse(
        "split-invalid-action",
        `actions[${i}] requires a ticker, calendar date and positive finite ratio`,
      );
    }
    const indexes = byTicker.get(action.ticker);
    if (indexes) indexes.push(i);
    else byTicker.set(action.ticker, [i]);
  }
  const normalized: SplitNormalizedRow<T>[] = [];
  const adjusted_rows: SplitAdjustedRowFact[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      typeof row.underlying !== "string" ||
      !/^[A-Za-z0-9.^/_-]+$/.test(row.underlying) ||
      !calendarDate(row.dateOpened) ||
      !calendarDate(row.dateClosed) ||
      row.dateClosed < row.dateOpened ||
      typeof row.timeOpened !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(row.timeOpened) ||
      (row.wasAdjusted !== undefined && typeof row.wasAdjusted !== "boolean") ||
      !Number.isSafeInteger(row.numberOfContracts) ||
      row.numberOfContracts < 1 ||
      !Number.isFinite(row.profit) ||
      !Number.isFinite(row.buyingPowerRequired) ||
      row.buyingPowerRequired < 0
    ) {
      return refuse(
        "split-invalid-row",
        `rows[${i}] has invalid native identity, dates, quantity or economics`,
      );
    }
    let actionIndex: number | undefined;
    for (const index of byTicker.get(row.underlying) ?? []) {
      const action = actions[index];
      if (row.dateOpened < action.date && action.date <= row.dateClosed) {
        if (!row.wasAdjusted) {
          return refuse(
            "split-unadjusted-held-row",
            `rows[${i}] is unadjusted but held across actions[${index}], contradicting the native flag`,
          );
        }
        if (actionIndex !== undefined) {
          return refuse(
            "split-multiple-actions",
            `rows[${i}] is held across more than one declared action`,
          );
        }
        actionIndex = index;
      }
    }
    if (row.wasAdjusted && actionIndex === undefined) {
      return refuse(
        "split-unknown-adjusted-row",
        `rows[${i}] is adjusted without a matching declared action`,
      );
    }
    const action = actionIndex === undefined ? null : actions[actionIndex];
    const factor = action?.ratio ?? 1;
    const entryQuantity = row.numberOfContracts / factor;
    if (!Number.isSafeInteger(entryQuantity) || entryQuantity < 1) {
      return refuse(
        "split-invalid-entry-quantity",
        `rows[${i}] native quantity divided by ratio must be positive whole entry contracts`,
      );
    }
    normalized.push({
      row,
      rowIndex: i,
      nativeQuantity: row.numberOfContracts,
      entryQuantity,
      factor,
      netPlPerContract: row.profit / entryQuantity,
      buyingPowerPerContract: row.buyingPowerRequired / entryQuantity,
      action,
    });
    if (action && actionIndex !== undefined) {
      adjusted_rows.push({
        row_index: i,
        entry_date: row.dateOpened,
        entry_time: row.timeOpened,
        factor,
        native_quantity: row.numberOfContracts,
        entry_quantity: entryQuantity,
        action,
      });
    }
  }
  return { ok: true, rows: normalized, adjusted_rows };
}
