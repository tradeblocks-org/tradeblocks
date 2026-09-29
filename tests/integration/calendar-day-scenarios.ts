/**
 * Browser-storage scenarios that change the process timezone between writing and reading.
 *
 * Jest cannot change the timezone of a running test, so `calendar-day-storage.test.ts` runs this
 * file with Node: `node calendar-day-scenarios.ts <scenario> <writeZone> <readZone>`. It writes
 * under `writeZone`, switches `process.env.TZ` to `readZone`, reads back through the store
 * modules and prints what it observed as JSON.
 */

import "fake-indexeddb/auto";

import {
  addDailyLogEntries,
  addReportingTrades,
  addTrades,
  closeDatabase,
  createBlock,
  DB_NAME,
  deleteReportingTradesByBlock,
  getBlock,
  getDailyLogsByBlock,
  getEnrichedTradesCache,
  getPerformanceSnapshotCache,
  getReportingTradesByBlock,
  getTradesByBlock,
  getTradesByBlockWithOptions,
  initializeDatabase,
  STORES,
  storeCombinedTradesCache,
  storeEnrichedTradesCache,
  storePerformanceSnapshotCache,
  updateDailyLogsForBlock,
  updateTradesForBlock,
} from "../../packages/lib/db/index.ts";
import { getTradesByDateRange } from "../../packages/lib/db/trades-store.ts";
import { getDailyLogsByDateRange } from "../../packages/lib/db/daily-logs-store.ts";
import { formatDateKey } from "../../packages/lib/calculations/trade-matching.ts";
import { combineAllLegGroups } from "../../packages/lib/utils/combine-leg-groups.ts";
import type { Trade } from "../../packages/lib/models/trade.ts";
import type { DailyLogEntry } from "../../packages/lib/models/daily-log.ts";
import type { ReportingTrade } from "../../packages/lib/models/reporting-trade.ts";
import type { ProcessedBlock } from "../../packages/lib/models/block.ts";
import type { SnapshotChartData } from "../../packages/lib/services/performance-snapshot.ts";

/** Days on both sides of US and EU daylight-saving changes, and a zone's midnight gap (Chile). */
const DAYS = ["2024-01-02", "2024-03-10", "2024-03-31", "2024-07-01", "2024-09-08"];

type Json = Record<string, unknown>;

/** A calendar day as the CSV parsers hold it: local midnight in the current zone. */
function localDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function nextDay(day: string): string {
  const date = localDay(day);
  date.setDate(date.getDate() + 1);
  return formatDateKey(date);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  return promise;
}

function done(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
  return promise;
}

function trade(day: string, overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: localDay(day),
    timeOpened: "10:00:00",
    openingPrice: 5000,
    legs: "SPX 5000P/4950P",
    premium: 2.5,
    dateClosed: localDay(nextDay(day)),
    timeClosed: "15:00:00",
    closingPrice: 5010,
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100_100,
    marginReq: 1000,
    strategy: "Put Spread",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0.5,
    ...overrides,
  };
}

function dailyLog(day: string): DailyLogEntry {
  return {
    date: localDay(day),
    netLiquidity: 100_000,
    currentFunds: 100_000,
    withdrawn: 0,
    tradingFunds: 100_000,
    dailyPl: 100,
    dailyPlPct: 0.1,
    drawdownPct: 0,
  };
}

function reportingTrade(day: string): ReportingTrade {
  return {
    strategy: "Put Spread",
    dateOpened: localDay(day),
    openingPrice: 5000,
    legs: "SPX 5000P/4950P",
    initialPremium: 2.5,
    numContracts: 1,
    pl: 100,
    dateClosed: localDay(nextDay(day)),
  };
}

function blockRecord(id: string, start: Date, end: Date) {
  return {
    id,
    name: id,
    isActive: false,
    created: new Date(),
    lastModified: new Date(),
    tradeLog: {
      fileName: `${id}-trades.csv`,
      fileSize: 1,
      originalRowCount: 1,
      processedRowCount: 1,
      uploadedAt: new Date(),
    },
    dateRange: { start, end },
    processingStatus: "completed" as const,
    dataReferences: { tradesStorageKey: `${id}_trades` },
    analysisConfig: { useBusinessDaysOnly: false, annualizationFactor: 252, confidenceLevel: 0.95 },
  };
}

/** Days of a list of calendar values as this browser shows them. */
const days = (dates: (Date | undefined)[]) => dates.map((date) => date && formatDateKey(date));

/** Every stored record with its primary key, date objects written as ISO text. */
async function rawDump(): Promise<Json> {
  const db = await request(indexedDB.open(DB_NAME));
  const dump: Json = { version: db.version };
  for (const name of [
    STORES.BLOCKS,
    STORES.TRADES,
    STORES.DAILY_LOGS,
    STORES.REPORTING_LOGS,
    STORES.CALCULATIONS,
  ]) {
    const store = db.transaction(name, "readonly").objectStore(name);
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    dump[name] = keys.map((key, index) => ({
      key,
      value: JSON.parse(JSON.stringify(values[index])),
      dateTypes: Object.fromEntries(
        Object.entries(values[index] as Json)
          .filter(([, value]) => Object.prototype.toString.call(value) === "[object Date]")
          .map(([field]) => [field, "Date"]),
      ),
    }));
  }
  db.close();
  return dump;
}

/**
 * Seed a pre-v7 database exactly as a v5 or v6 browser left it: calendar days are `Date`
 * instants from the importing zone (local midnight), from older parsers (UTC midnight), or from
 * a timestamp (off the quarter-hour grid).
 */
async function seedLegacy(version: 5 | 6): Promise<void> {
  const open = indexedDB.open(DB_NAME, version);
  open.onupgradeneeded = () => {
    const db = open.result;
    const blocks = db.createObjectStore(STORES.BLOCKS, { keyPath: "id" });
    blocks.createIndex("name", "name");
    blocks.createIndex("isActive", "isActive");
    const trades = db.createObjectStore(STORES.TRADES, { autoIncrement: true });
    trades.createIndex("blockId", "blockId");
    trades.createIndex("dateOpened", "dateOpened");
    trades.createIndex("composite_block_date", ["blockId", "dateOpened"]);
    const dailyLogs = db.createObjectStore(STORES.DAILY_LOGS, { autoIncrement: true });
    dailyLogs.createIndex("blockId", "blockId");
    dailyLogs.createIndex("composite_block_date", ["blockId", "date"]);
    const reporting = db.createObjectStore(STORES.REPORTING_LOGS, { autoIncrement: true });
    reporting.createIndex("blockId", "blockId");
    reporting.createIndex("composite_block_date", ["blockId", "dateOpened"]);
    const calculations = db.createObjectStore(STORES.CALCULATIONS, { keyPath: "id" });
    calculations.createIndex("blockId", "blockId");
  };
  const db = await request(open);
  const tx = db.transaction(
    [STORES.BLOCKS, STORES.TRADES, STORES.DAILY_LOGS, STORES.REPORTING_LOGS, STORES.CALCULATIONS],
    "readwrite",
  );
  const blocks = tx.objectStore(STORES.BLOCKS);
  blocks.put(blockRecord("legacy", localDay(DAYS[0]), localDay(DAYS.at(-1)!)));
  blocks.put(blockRecord("utc-parser", new Date("2024-01-05"), new Date("2024-01-05")));
  blocks.put(blockRecord("oo-strategy", localDay(DAYS[0]), localDay(DAYS[0])));
  blocks.put(blockRecord("oo-zoned", localDay(DAYS[0]), localDay(DAYS[0])));

  const trades = tx.objectStore(STORES.TRADES);
  DAYS.forEach((day, index) =>
    trades.put({ ...trade(day, { timeOpened: `10:0${index}:00` }), blockId: "legacy" }),
  );
  trades.put({
    ...trade(DAYS[1], { dateClosed: undefined, timeOpened: "11:00:00" }),
    blockId: "legacy",
  });
  // A v5 record: premiumPrecision says dollars, so v6 rescaled 2.5 to 250. At v6 it is final.
  trades.put({
    ...trade(DAYS[2], { timeOpened: "12:00:00", premium: 2.5 }),
    ...(version === 5 && { premiumPrecision: "dollars" }),
    blockId: "legacy",
  });
  // Written from a timestamp: 14:37:12 UTC is off the quarter-hour grid.
  trades.put({
    ...trade(DAYS[0], { timeOpened: "13:00:00" }),
    dateOpened: new Date("2024-01-08T14:37:12Z"),
    dateClosed: new Date("2024-01-08T14:37:12Z"),
    blockId: "legacy",
  });
  // Already a calendar-day string: the upgrade leaves it alone and does not count it.
  trades.put({
    ...trade(DAYS[0], { timeOpened: "14:00:00" }),
    dateOpened: "2024-01-04",
    dateClosed: "2024-01-04",
    blockId: "legacy",
  });
  // Older parsers wrote UTC midnight.
  trades.put({
    ...trade(DAYS[0]),
    dateOpened: new Date("2024-01-05"),
    dateClosed: new Date("2024-01-05"),
    blockId: "utc-parser",
  });

  const dailyLogs = tx.objectStore(STORES.DAILY_LOGS);
  DAYS.forEach((day) => dailyLogs.put({ ...dailyLog(day), blockId: "legacy" }));
  const reporting = tx.objectStore(STORES.REPORTING_LOGS);
  DAYS.forEach((day) => reporting.put({ ...reportingTrade(day), blockId: "legacy" }));
  // Option Omega strategy logs write days with a time; the importer's `new Date(cell)` stored a
  // local instant off the quarter-hour grid. Since v3.2.0 each row also keeps its source cells.
  const opened = " 2025-05-30T10:15:40.546199";
  const closed = "2025-06-02T15:45:12.1";
  reporting.put({
    ...reportingTrade(DAYS[0]),
    dateOpened: new Date(opened.trim()),
    dateClosed: new Date(closed),
    sourceFields: { "Date Opened": opened, "Date Closed": closed, Strategy: "OO" },
    blockId: "oo-strategy",
  });
  reporting.put({
    ...reportingTrade(DAYS[0]),
    dateOpened: new Date(opened.trim()),
    dateClosed: new Date(closed),
    blockId: "oo-strategy",
  });
  // A whole-day cell is exact even in the zones `recoverCalendarDay` cannot prove.
  reporting.put({
    ...reportingTrade("2025-06-03"),
    dateClosed: undefined,
    sourceFields: { "Date Opened": "2025-06-03", "Date Closed": "" },
    blockId: "oo-strategy",
  });
  // Cells with a zone were read as that instant, so their prefix is not the day the user saw;
  // `T24:00` was read as the next day's midnight; `2025-02-30` (a whole day) was rolled to
  // 2 March by the importer's local `Date` constructor.
  for (const cell of [
    "2025-05-30T02:00:00Z",
    "2025-05-30T20:00:00Z",
    "2025-05-30T23:30:00-04:00",
    "2025-05-30T24:00",
    "2025-02-30",
  ]) {
    reporting.put({
      ...reportingTrade(DAYS[0]),
      dateOpened: cell === "2025-02-30" ? new Date(2025, 1, 30) : new Date(cell),
      dateClosed: undefined,
      sourceFields: { "Date Opened": cell },
      blockId: "oo-zoned",
    });
  }

  const calculations = tx.objectStore(STORES.CALCULATIONS);
  for (const [id, calculationType] of [
    ["combined_trades_v2_legacy", "combined_trades"],
    ["enriched_trades_legacy", "enriched_trades"],
    ["performance_snapshot_v4_legacy", "performance_snapshot"],
  ]) {
    calculations.put({ id, blockId: "legacy", calculationType, trades: [trade(DAYS[0])] });
  }
  await done(tx);
  db.close();
}

async function readLegacy(): Promise<Json> {
  const legacy = await getBlock("legacy");
  const trades = await getTradesByBlock("legacy");
  const cached = await getTradesByBlockWithOptions("legacy", { combineLegGroups: true });
  return {
    trades: trades.map((t) => ({
      time: t.timeOpened,
      opened: formatDateKey(t.dateOpened),
      closed: t.dateClosed && formatDateKey(t.dateClosed),
      premium: t.premium,
    })),
    utcParserTrades: days((await getTradesByBlock("utc-parser")).map((t) => t.dateOpened)),
    dailyLogs: days((await getDailyLogsByBlock("legacy")).map((d) => d.date)),
    reportingOpened: days((await getReportingTradesByBlock("legacy")).map((r) => r.dateOpened)),
    reportingClosed: days((await getReportingTradesByBlock("legacy")).map((r) => r.dateClosed)),
    dateRange: legacy?.dateRange && days([legacy.dateRange.start, legacy.dateRange.end]),
    unverified: legacy?.unverifiedCalendarDays ?? null,
    utcParserUnverified: (await getBlock("utc-parser"))?.unverifiedCalendarDays ?? null,
    ooReporting: (await getReportingTradesByBlock("oo-strategy")).map((r) => ({
      opened: formatDateKey(r.dateOpened),
      closed: r.dateClosed && formatDateKey(r.dateClosed),
      hasSource: r.sourceFields !== undefined,
    })),
    ooUnverified: (await getBlock("oo-strategy"))?.unverifiedCalendarDays ?? null,
    ooZonedUnverified: (await getBlock("oo-zoned"))?.unverifiedCalendarDays ?? null,
    combinedFromMigratedTrades: days(cached.map((t) => t.dateOpened)),
    tradeRange: days(
      (await getTradesByDateRange("legacy", localDay(DAYS[1]), localDay(DAYS[3]))).map(
        (t) => t.dateOpened,
      ),
    ),
    dailyLogRange: days(
      (await getDailyLogsByDateRange("legacy", localDay(DAYS[1]), localDay(DAYS[3]))).map(
        (d) => d.date,
      ),
    ),
  };
}

async function legacy(version: 5 | 6, writeZone: string, readZone: string): Promise<Json> {
  process.env.TZ = writeZone;
  await seedLegacy(version);
  const before = await rawDump();
  process.env.TZ = readZone;
  await initializeDatabase();
  closeDatabase();
  const after = await rawDump();
  await initializeDatabase();
  closeDatabase();
  const reopened = await rawDump();
  await initializeDatabase();
  const read = await readLegacy();
  closeDatabase();
  return { before, after, reopened, read };
}

/** A new import under `writeZone`, with every cache the web app persists, read under `readZone`. */
async function newImport(writeZone: string, readZone: string): Promise<Json> {
  process.env.TZ = writeZone;
  await initializeDatabase();
  const trades = DAYS.map((day) => trade(day));
  const dailyLogs = DAYS.map(dailyLog);
  const block = await createBlock({
    ...blockRecord("ignored", trades[0].dateOpened, trades.at(-1)!.dateOpened),
  } as Omit<ProcessedBlock, "id" | "created" | "lastModified">);
  await addTrades(block.id, trades);
  await addDailyLogEntries(block.id, dailyLogs);
  await addReportingTrades(block.id, DAYS.map(reportingTrade));
  await storeCombinedTradesCache(block.id, combineAllLegGroups(trades));
  await storeEnrichedTradesCache(
    block.id,
    trades.map((t) => ({ ...t, dateOpenedTimestamp: t.dateOpened.getTime() })),
  );
  await storePerformanceSnapshotCache(block.id, {
    portfolioStats: {} as never,
    chartData: {
      mfeMaeData: trades.map((t, index) => ({ tradeNumber: index + 1, date: t.dateOpened })),
    } as unknown as SnapshotChartData,
    filteredTrades: trades,
    filteredDailyLogs: dailyLogs,
  });
  const stored = await rawDump();
  closeDatabase();

  process.env.TZ = readZone;
  await initializeDatabase();
  const loaded = await getBlock(block.id);
  const hit = await getTradesByBlockWithOptions(block.id, { combineLegGroups: true });
  const miss = await getTradesByBlockWithOptions(block.id, {
    combineLegGroups: true,
    skipCache: true,
  });
  const enriched = (await getEnrichedTradesCache(block.id)) ?? [];
  const snapshot = await getPerformanceSnapshotCache(block.id);
  const reporting = await getReportingTradesByBlock(block.id);
  closeDatabase();
  return {
    stored,
    read: {
      trades: days((await getTradesByBlock(block.id)).map((t) => t.dateOpened)),
      tradesClosed: days((await getTradesByBlock(block.id)).map((t) => t.dateClosed)),
      dailyLogs: days((await getDailyLogsByBlock(block.id)).map((d) => d.date)),
      reportingOpened: days(reporting.map((r) => r.dateOpened)),
      reportingClosed: days(reporting.map((r) => r.dateClosed)),
      dateRange: loaded?.dateRange && days([loaded.dateRange.start, loaded.dateRange.end]),
      unverified: loaded?.unverifiedCalendarDays ?? null,
      combinedCacheHit: days(hit.map((t) => t.dateOpened)),
      combinedCacheMiss: days(miss.map((t) => t.dateOpened)),
      enriched: days(enriched.map((t) => t.dateOpened)),
      enrichedTimestampsAreLocalMidnight: enriched.every(
        (t) => t.dateOpenedTimestamp === t.dateOpened.getTime(),
      ),
      snapshotTrades: days(snapshot?.filteredTrades.map((t) => t.dateOpened) ?? []),
      snapshotDailyLogs: days(snapshot?.filteredDailyLogs.map((d) => d.date) ?? []),
      snapshotMfeMae: days(snapshot?.chartData.mfeMaeData.map((p) => p.date) ?? []),
    },
  };
}

/** An upgrade whose write fails must leave the database at v6 with every record untouched. */
async function failedUpgrade(writeZone: string, readZone: string): Promise<Json> {
  process.env.TZ = writeZone;
  await seedLegacy(6);
  const before = await rawDump();
  process.env.TZ = readZone;
  const cursorPrototype = globalThis.IDBCursor.prototype;
  const update = cursorPrototype.update;
  let calls = 0;
  cursorPrototype.update = function (this: IDBCursor, value: unknown) {
    if (++calls === 3) throw new Error("simulated write failure");
    return update.call(this, value);
  };
  let error: string | null = null;
  try {
    await initializeDatabase();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  cursorPrototype.update = update;
  const afterFailure = await rawDump();
  await initializeDatabase();
  const retried = (await getTradesByBlock("legacy")).length;
  closeDatabase();
  return { before, afterFailure, error, retried };
}

/** Unverified-day counts after each later write to a flagged block. */
async function replaceCollections(writeZone: string, readZone: string): Promise<Json> {
  process.env.TZ = writeZone;
  await seedLegacy(6);
  process.env.TZ = readZone;
  await initializeDatabase();
  const counts = async () => {
    const block = await getBlock("legacy");
    return block && "unverifiedCalendarDays" in block ? block.unverifiedCalendarDays : "absent";
  };
  const steps: Json = { upgraded: await counts() };
  await addTrades("legacy", [trade(DAYS[0])]);
  steps.tradesAppended = await counts();
  await updateTradesForBlock("legacy", [trade(DAYS[0])]);
  steps.tradesReplaced = await counts();
  await addDailyLogEntries("legacy", [dailyLog(DAYS[0])]);
  steps.dailyLogsAppended = await counts();
  await updateDailyLogsForBlock("legacy", [dailyLog(DAYS[0])]);
  steps.dailyLogsReplaced = await counts();
  await deleteReportingTradesByBlock("legacy");
  steps.reportingLogsDeleted = await counts();
  const imported = await createBlock(
    blockRecord("new", localDay(DAYS[0]), localDay(DAYS[0])) as Omit<
      ProcessedBlock,
      "id" | "created" | "lastModified"
    >,
  );
  await updateTradesForBlock(imported.id, [trade(DAYS[0])]);
  await updateDailyLogsForBlock(imported.id, [dailyLog(DAYS[0])]);
  steps.newImport = (await getBlock(imported.id))?.unverifiedCalendarDays ?? "absent";
  closeDatabase();
  return steps;
}

const [scenario, writeZone, readZone] = process.argv.slice(2);
const run: Record<string, () => Promise<Json>> = {
  "legacy-v6": () => legacy(6, writeZone, readZone),
  "legacy-v5": () => legacy(5, writeZone, readZone),
  "new-import": () => newImport(writeZone, readZone),
  "failed-upgrade": () => failedUpgrade(writeZone, readZone),
  "replace-collections": () => replaceCollections(writeZone, readZone),
};
console.log(JSON.stringify(await run[scenario]()));
