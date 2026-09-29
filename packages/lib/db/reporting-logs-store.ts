/**
 * Reporting Logs Store - CRUD operations for reporting (backtest) trade data
 */

import type { ReportingTrade } from "../models/reporting-trade.ts";
import {
  STORES,
  INDEXES,
  withReadTransaction,
  withWriteTransaction,
  promisifyRequest,
} from "./index.ts";
import { clearUnverifiedCalendarDays } from "./blocks-store.ts";
import {
  decodeCalendarDays,
  encodeCalendarDays,
  type StoredCalendarDays,
  TRADE_DAY_FIELDS,
  type TradeDayField,
} from "./calendar-days.ts";

export interface StoredReportingTrade extends ReportingTrade {
  blockId: string;
  id?: number;
}

type PersistedReportingTrade = StoredCalendarDays<StoredReportingTrade, TradeDayField>;

export async function addReportingTrades(blockId: string, trades: ReportingTrade[]): Promise<void> {
  if (trades.length === 0) return;

  await withWriteTransaction(STORES.REPORTING_LOGS, async (transaction) => {
    const store = transaction.objectStore(STORES.REPORTING_LOGS);
    const promises = trades.map((trade) =>
      promisifyRequest(store.add(encodeCalendarDays({ ...trade, blockId }, TRADE_DAY_FIELDS))),
    );

    await Promise.all(promises);
  });
}

export async function getReportingTradesByBlock(blockId: string): Promise<StoredReportingTrade[]> {
  return withReadTransaction(STORES.REPORTING_LOGS, async (transaction) => {
    const store = transaction.objectStore(STORES.REPORTING_LOGS);
    const index = store.index(INDEXES.REPORTING_LOGS_BY_BLOCK);
    const result: PersistedReportingTrade[] = await promisifyRequest(index.getAll(blockId));

    // Chronological order: `YYYY-MM-DD` days sort as text.
    result.sort((a, b) => (a.dateOpened < b.dateOpened ? -1 : a.dateOpened > b.dateOpened ? 1 : 0));
    return result.map((trade) =>
      decodeCalendarDays<StoredReportingTrade, TradeDayField>(trade, TRADE_DAY_FIELDS),
    );
  });
}

export async function getReportingTradeCountByBlock(blockId: string): Promise<number> {
  return withReadTransaction(STORES.REPORTING_LOGS, async (transaction) => {
    const store = transaction.objectStore(STORES.REPORTING_LOGS);
    const index = store.index(INDEXES.REPORTING_LOGS_BY_BLOCK);
    return promisifyRequest(index.count(blockId));
  });
}

export async function getReportingStrategiesByBlock(blockId: string): Promise<string[]> {
  const trades = await getReportingTradesByBlock(blockId);
  const strategies = new Set(trades.map((trade) => trade.strategy));
  return Array.from(strategies).sort();
}

export async function deleteReportingTradesByBlock(blockId: string): Promise<void> {
  await withWriteTransaction([STORES.REPORTING_LOGS, STORES.BLOCKS], async (transaction) => {
    const store = transaction.objectStore(STORES.REPORTING_LOGS);
    const index = store.index(INDEXES.REPORTING_LOGS_BY_BLOCK);
    const request = index.openCursor(IDBKeyRange.only(blockId));

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
    await clearUnverifiedCalendarDays(transaction, blockId, STORES.REPORTING_LOGS);
  });
}

export async function updateReportingTradesForBlock(
  blockId: string,
  trades: ReportingTrade[],
): Promise<void> {
  await withWriteTransaction([STORES.REPORTING_LOGS, STORES.BLOCKS], async (transaction) => {
    const store = transaction.objectStore(STORES.REPORTING_LOGS);
    const index = store.index(INDEXES.REPORTING_LOGS_BY_BLOCK);
    const deleteRequest = index.openCursor(IDBKeyRange.only(blockId));

    await new Promise<void>((resolve, reject) => {
      deleteRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      deleteRequest.onerror = () => reject(deleteRequest.error);
    });

    const promises = trades.map((trade) =>
      promisifyRequest(store.add(encodeCalendarDays({ ...trade, blockId }, TRADE_DAY_FIELDS))),
    );

    await Promise.all(promises);
    await clearUnverifiedCalendarDays(transaction, blockId, STORES.REPORTING_LOGS);
  });
}
