import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ReportingTradeProcessor,
  addReportingTrades,
  getReportingTradesByBlock,
  deleteReportingTradesByBlock,
  calculateAvgPremiumCapture,
  calculateTradeMetrics,
  combineReportingLegGroup,
  hasReportingPremiumQuote,
  type ReportingTrade,
} from "@tradeblocks/lib";
import type { CalendarDayData } from "@tradeblocks/lib/stores";

const emaCsv = readFileSync(
  join(__dirname, "../data/EMA Test Data/ema-strategy-trade-log.csv"),
  "utf8",
);
const tatRow = {
  TradeID: "15780",
  ProfitLoss: "1929.35",
  BuyingPower: "26550",
  OpenDate: "2026-01-30",
  PriceOpen: "-53.1",
  TotalPremium: "-26550",
  Qty: "5",
  Template: "MEDC 3/7",
  ShortPut: "6945",
  LongPut: "6945",
  ShortCall: "6945",
  LongCall: "6945",
};
const tatCsv = `${Object.keys(tatRow).join(",")}\n${Object.values(tatRow).join(",")}`;

function dayOf(trades: ReportingTrade[], date: string): Map<string, CalendarDayData> {
  const actualPl = trades.reduce((sum, trade) => sum + trade.pl, 0);
  return new Map([
    [
      date,
      {
        date,
        backtestTrades: [],
        actualTrades: trades,
        backtestPl: 0,
        actualPl,
        backtestTradeCount: 0,
        actualTradeCount: trades.length,
        hasBacktest: false,
        hasActual: true,
        matchedStrategies: [],
        unmatchedBacktestStrategies: [],
        unmatchedActualStrategies: [],
        totalMargin: 0,
      },
    ],
  ]);
}

describe("Reporting premium capture from imported CSVs", () => {
  it("computes both Calendar paths from OO's per-share quote and full position size", async () => {
    const parsed = await new ReportingTradeProcessor().processText(emaCsv);
    const trade = parsed.trades.find((row) => row.pl === 1251)!;
    expect(parsed.errors).toEqual([]);
    expect(trade.initialPremium).toBe(4.2);
    expect(trade.numContracts).toBe(3);
    // $1,251 / (4.20 dollars/share * 100 shares/lot * 3 lots) * 100 = 99.2857%.
    expect(calculateAvgPremiumCapture([], [trade], true)).toBeCloseTo(99.2857142857, 6);
    expect(
      calculateTradeMetrics(dayOf([trade], "2025-10-08"), "2025-10-08", "2025-10-08", true)
        .avgPremiumCapture,
    ).toBeCloseTo(99.2857142857, 6);
  });

  it("preserves a signed OO debit quote without applying a second source conversion", async () => {
    const debitCsv = emaCsv.replace(",4.2,3,1251.0,", ",-4.2,3,-1251.0,");
    const parsed = await new ReportingTradeProcessor().processText(debitCsv);
    const debit = parsed.trades.find((row) => row.pl === -1251)!;
    expect(debit.initialPremium).toBe(-4.2);
    expect(calculateAvgPremiumCapture([], [debit], true)).toBeCloseTo(-99.2857142857, 6);
  });

  it("computes both Calendar paths from a real TAT row converted to per-share quote", async () => {
    const parsed = await new ReportingTradeProcessor().processText(tatCsv);
    const trade = parsed.trades[0];
    expect(parsed.errors).toEqual([]);
    expect(trade.initialPremium).toBe(-53.1); // -$26,550 / 5 lots / 100 shares.
    // $1,929.35 / $26,550 total opening debit * 100 = 7.2669%.
    expect(calculateAvgPremiumCapture([], [trade], true)).toBeCloseTo(7.26685499, 4);
    expect(
      calculateTradeMetrics(dayOf([trade], "2026-01-30"), "2026-01-30", "2026-01-30", true)
        .avgPremiumCapture,
    ).toBeCloseTo(7.26685499, 4);
  });

  it("keeps markerless legacy TAT and ambiguous IndexedDB rows unavailable", async () => {
    const parsed = await new ReportingTradeProcessor().processText(tatCsv);
    const oldTat = { ...parsed.trades[0], initialPremium: -5310, initialPremiumUnit: undefined };
    expect(calculateAvgPremiumCapture([], [oldTat], true)).toBeNull();
    expect(
      calculateTradeMetrics(dayOf([oldTat], "2026-01-30"), "2026-01-30", "2026-01-30", true)
        .avgPremiumCapture,
    ).toBeNull();
    const unknown = { ...oldTat, initialPremium: 4.2 };
    expect(calculateAvgPremiumCapture([], [unknown], true)).toBeNull();
    const zeroQtyCsv = tatCsv.replace(",-26550,5,", ",-26550,0,");
    const zeroQty = (await new ReportingTradeProcessor().processText(zeroQtyCsv)).trades[0];
    expect(zeroQty.initialPremiumUnit).toBeUndefined();
    expect(calculateAvgPremiumCapture([], [zeroQty], true)).toBeNull();
  });

  it("makes the aggregate unavailable when a confirmed quote row has zero premium", async () => {
    const parsed = await new ReportingTradeProcessor().processText(emaCsv);
    const valid = parsed.trades.find((row) => row.pl === 1251)!;
    const zeroQuote = { ...valid, initialPremium: 0, sourceFields: undefined };
    expect(hasReportingPremiumQuote(zeroQuote)).toBe(true);
    expect(calculateAvgPremiumCapture([], [valid, zeroQuote], true)).toBeNull();
    expect(
      calculateTradeMetrics(
        dayOf([valid, zeroQuote], "2025-10-08"),
        "2025-10-08",
        "2025-10-08",
        true,
      ).avgPremiumCapture,
    ).toBeNull();
  });

  it("preserves legacy OO rows with recorded source-column provenance", async () => {
    const parsed = await new ReportingTradeProcessor().processText(emaCsv);
    const oldOo = {
      ...parsed.trades.find((row) => row.pl === 1251)!,
      initialPremiumUnit: undefined,
    };
    expect(calculateAvgPremiumCapture([], [oldOo], true)).toBeCloseTo(99.2857142857, 6);
    expect(hasReportingPremiumQuote(oldOo)).toBe(true);
    expect(hasReportingPremiumQuote({ ...oldOo, initialPremium: 420 })).toBe(false);
    expect(
      calculateAvgPremiumCapture([], [{ ...oldOo, sourceFields: undefined }], true),
    ).toBeNull();
  });

  it("combines per-share leg quotes only when every leg has confirmed units", async () => {
    const parsed = await new ReportingTradeProcessor().processText(emaCsv);
    const leg = parsed.trades.find((row) => row.pl === 1251)!;
    const other = { ...leg, initialPremium: -0.25, pl: -75 };
    const combined = combineReportingLegGroup([leg, other]);
    expect(combined.initialPremium).toBeCloseTo(3.95);
    expect(combined.initialPremiumUnit).toBe("quote");
    expect(combined.numContracts).toBe(3);
    expect(
      combineReportingLegGroup([leg, { ...other, initialPremiumUnit: undefined }])
        .initialPremiumUnit,
    ).toBeUndefined();
  });

  it("reads legacy and new browser records without silently reinterpreting a TAT spread", async () => {
    const blockId = "reporting-premium-unit-store-test";
    const [oo, tat] = await Promise.all([
      new ReportingTradeProcessor().processText(emaCsv),
      new ReportingTradeProcessor().processText(tatCsv),
    ]);
    const quote = oo.trades.find((row) => row.pl === 1251)!;
    const legacyOo = { ...quote, initialPremiumUnit: undefined };
    const legacyTat = { ...tat.trades[0], initialPremium: -5310, initialPremiumUnit: undefined };
    try {
      await addReportingTrades(blockId, [legacyOo, legacyTat, tat.trades[0]]);
      const stored = await getReportingTradesByBlock(blockId);
      expect(stored).toHaveLength(3);
      expect(calculateAvgPremiumCapture([], stored, true)).toBeNull();
      expect(
        calculateAvgPremiumCapture(
          [],
          stored.filter((row) => row.pl === 1251),
          true,
        ),
      ).toBeCloseTo(99.2857142857, 6);
      expect(
        calculateAvgPremiumCapture(
          [],
          stored.filter((row) => row.initialPremiumUnit === "quote"),
          true,
        ),
      ).toBeCloseTo(7.26685499, 4);
    } finally {
      await deleteReportingTradesByBlock(blockId);
    }
  });

  it("leaves an extreme October EMA loss unclamped while correcting the aggregate", async () => {
    const parsed = await new ReportingTradeProcessor().processText(emaCsv);
    const october = parsed.trades.filter((trade) => trade.dateOpened.getMonth() === 9);
    expect(october).toHaveLength(12);
    // The 12 October rows averaged -2,324,478.9% when P/L dollars were divided by quote alone.
    // All have three lots: correcting the denominator multiplies each by 1/(100 * 3).
    expect(calculateAvgPremiumCapture([], october, true)).toBeCloseTo(-7748.26315219, 4);
    // The Oct 6 0.80 quote / 3 lots lost $52,278: -52278 / (0.80 * 100 * 3) * 100.
    expect(calculateAvgPremiumCapture([], [october.find((row) => row.pl === -52278)!], true)).toBe(
      -21782.5,
    );
  });
});
