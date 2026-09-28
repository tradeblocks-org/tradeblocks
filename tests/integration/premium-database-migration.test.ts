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
  trades.put({
    blockId: "legacy",
    premium: 2.5,
    premiumPrecision: "dollars",
    numContracts: 1,
    marginReq: 1000,
  });
  trades.put({
    blockId: "legacy",
    premium: 420,
    premiumPrecision: "cents",
    numContracts: 3,
    marginReq: 43740,
  });
  trades.put({
    blockId: "legacy",
    premium: -6000,
    premiumPrecision: "dollars",
    numContracts: 0,
    marginReq: 1000,
  });
  trades.put({ blockId: "legacy", premium: -2.5, premiumPrecision: "dollars", numContracts: 2 });
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
    expect(DB_VERSION).toBe(6);
    expect(db.version).toBe(6);
    const upgraded = await getTradesByBlock("legacy");
    expect(upgraded.map((trade) => computeTotalPremium(trade))).toEqual([250, 1260, 6000, 500]);
    expect(upgraded.map((trade) => trade.premium)).toEqual([250, 420, -6000, -250]);
    expect(upgraded.every((trade) => !Object.hasOwn(trade, "premiumPrecision"))).toBe(true);
    expect(await getEnrichedTradesCache("legacy")).toBeNull();
  } finally {
    closeDatabase();
    await deleteDatabase();
  }
});
