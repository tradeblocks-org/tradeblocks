/** @jest-environment node */

import "fake-indexeddb/auto";
import { computeTotalPremium } from "../../packages/lib/metrics/trade-efficiency";
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  closeDatabase,
  deleteDatabase,
  initializeDatabase,
  getTradesByBlock,
  getEnrichedTradesCache,
} from "../../packages/lib/db/index";

it("preserves displayed premiums while upgrading browser trades from v5", async () => {
  const open = indexedDB.open(DB_NAME, 5);
  open.onupgradeneeded = () => {
    const trades = open.result.createObjectStore(STORES.TRADES, { autoIncrement: true });
    trades.createIndex("blockId", "blockId");
    open.result.createObjectStore(STORES.CALCULATIONS, { keyPath: "id" });
  };
  const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const oldTransaction = oldDatabase.transaction([STORES.TRADES, STORES.CALCULATIONS], "readwrite");
  const trades = oldTransaction.objectStore(STORES.TRADES);
  // v5 parsers stored the opening day as UTC midnight; the v7 upgrade recovers it in one pass.
  let order = 0;
  const put = (record: Record<string, unknown>) =>
    trades.put({
      blockId: "legacy",
      dateOpened: new Date("2024-01-02T00:00:00Z"),
      timeOpened: `10:0${order++}:00`,
      ...record,
    });
  put({ premium: 2.5, premiumPrecision: "dollars", numContracts: 1, marginReq: 1000 });
  put({ premium: 420, premiumPrecision: "cents", numContracts: 3, marginReq: 43740 });
  put({ premium: -6000, premiumPrecision: "dollars", numContracts: 0, marginReq: 1000 });
  put({ premium: -2.5, premiumPrecision: "dollars", numContracts: 2 });
  // Untagged records predate premiumPrecision; v5 read them exactly like "dollars".
  put({ premium: 2.5, numContracts: 1, marginReq: 1000 });
  put({ premium: 420, numContracts: 3, marginReq: 1000 });
  // v5 required a positive ratio; an underflowed ratio was never scaled.
  put({ premium: Number.MIN_VALUE, marginReq: Number.MAX_VALUE });
  // v5 showed this cents record as $500: 50000 / 100, with the ratio at 0.5 so no ×100.
  put({ premium: 50000, premiumPrecision: "cents", numContracts: 1, marginReq: 1000 });
  oldTransaction.objectStore(STORES.CALCULATIONS).put({
    id: "enriched_trades_legacy",
    blockId: "legacy",
    calculationType: "enriched_trades",
    trades: [{ premium: 2.5, premiumPrecision: "dollars" }],
    tradeCount: 1,
    calculatedAt: new Date(),
  });
  await new Promise<void>((resolve, reject) => {
    oldTransaction.oncomplete = () => resolve();
    oldTransaction.onerror = () => reject(oldTransaction.error);
  });
  oldDatabase.close();

  try {
    const db = await initializeDatabase();
    expect(db.version).toBe(DB_VERSION);
    const upgraded = await getTradesByBlock("legacy");
    expect(upgraded.map((trade) => computeTotalPremium(trade))).toEqual([
      250,
      1260,
      6000,
      500,
      250,
      1260,
      Number.MIN_VALUE,
      500,
    ]);
    expect(upgraded.map((trade) => trade.premium)).toEqual([
      250,
      420,
      -6000,
      -250,
      250,
      420,
      Number.MIN_VALUE,
      500,
    ]);
    expect(upgraded.every((trade) => !Object.hasOwn(trade, "premiumPrecision"))).toBe(true);
    expect(upgraded.map((trade) => trade.dateOpened)).toEqual(Array(8).fill(new Date(2024, 0, 2)));
    expect(await getEnrichedTradesCache("legacy")).toBeNull();
  } finally {
    closeDatabase();
    await deleteDatabase();
  }
});
