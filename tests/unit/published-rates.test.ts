import {
  clearPublishedRates,
  getEffectiveRateDate,
  getRiskFreeRateByKey,
  getSofrRateByKey,
  resolveTreasuryRateByKey,
  setPublishedRates,
  validatePublishedRates,
  TREASURY_RATES,
} from "@tradeblocks/lib";
import { SOFR_RATES } from "../../packages/lib/data/sofr-rates";

const nextDate = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};
const treasuryTail = Object.keys(TREASURY_RATES).at(-1)!;
const sofrTail = Object.keys(SOFR_RATES).at(-1)!;
const nextTreasury = nextDate(treasuryTail);
const nextSofr = nextDate(sofrTail);
const published = () => ({
  schemaVersion: 1,
  source: "Federal Reserve Economic Data (FRED), Federal Reserve Bank of St. Louis",
  fetchedAt: "2026-09-27T06:00:00Z",
  series: {
    DTB3: {
      unit: "annual-percent",
      firstDate: Object.keys(TREASURY_RATES)[0],
      lastDate: nextTreasury,
      rates: { ...TREASURY_RATES, [nextTreasury]: 4.09 },
    },
    SOFR: {
      unit: "annual-percent",
      firstDate: Object.keys(SOFR_RATES)[0],
      lastDate: nextSofr,
      rates: { ...SOFR_RATES, [nextSofr]: 3.73 },
    },
  },
});

afterEach(() => clearPublishedRates());

describe("published risk-free rates", () => {
  it("leaves legacy lookups identical without an overlay and uses new observations when applied", () => {
    expect(getEffectiveRateDate("DTB3")).toBe(treasuryTail);
    expect(getEffectiveRateDate("SOFR")).toBe(sofrTail);
    for (const [date, rate] of Object.entries(TREASURY_RATES)) {
      expect(getRiskFreeRateByKey(date)).toBe(rate);
      expect(resolveTreasuryRateByKey(date)).toEqual({
        requestedDate: date,
        effectiveDate: date,
        annualRateBasisPoints: Math.round(rate * 100),
        resolution: "exact",
      });
    }
    for (const [date, rate] of Object.entries(SOFR_RATES)) {
      expect(getSofrRateByKey(date)).toBe(rate);
    }
    expect(resolveTreasuryRateByKey(nextTreasury)).toMatchObject({
      effectiveDate: treasuryTail,
      resolution: "stale-after-latest",
    });
    setPublishedRates(published());
    expect(getEffectiveRateDate("DTB3")).toBe(nextTreasury);
    expect(getEffectiveRateDate("SOFR")).toBe(nextSofr);
    expect(getRiskFreeRateByKey(nextTreasury)).toBe(4.09);
    expect(getSofrRateByKey(nextSofr)).toBe(3.73);
    expect(resolveTreasuryRateByKey(nextTreasury)).toMatchObject({
      effectiveDate: nextTreasury,
      annualRateBasisPoints: 409,
      resolution: "exact",
    });
    clearPublishedRates();
    expect(getEffectiveRateDate("DTB3")).toBe(treasuryTail);
    expect(getRiskFreeRateByKey(nextTreasury)).toBe(TREASURY_RATES[treasuryTail]);
  });

  it("rejects a conflicting bundled observation without replacing the active rates", () => {
    setPublishedRates(published());
    const divergent = published();
    divergent.series.DTB3.rates["2026-01-05"] = 9;
    expect(() => setPublishedRates(divergent)).toThrow(/disagrees with bundled rate on 2026-01-05/);
    expect(getRiskFreeRateByKey(nextTreasury)).toBe(4.09);
    clearPublishedRates();
    expect(() => setPublishedRates(divergent)).toThrow(/disagrees with bundled rate on 2026-01-05/);
    expect(getEffectiveRateDate("DTB3")).toBe(treasuryTail);
    delete divergent.series.DTB3.rates["2026-01-05"];
    expect(() => validatePublishedRates(divergent)).toThrow(
      /disagrees with bundled rate on 2026-01-05/,
    );
  });

  it("rejects unordered or non-cent observations before they affect metrics", () => {
    const reversed = published();
    reversed.series.SOFR.rates = { [nextSofr]: 3.73, ...SOFR_RATES };
    expect(() => setPublishedRates(reversed)).toThrow(/Invalid published SOFR date range/);
    const fractional = published();
    fractional.series.DTB3.rates[nextTreasury] = 4.091;
    expect(() => setPublishedRates(fractional)).toThrow(/Invalid published DTB3 observation/);
    expect(getEffectiveRateDate("DTB3")).toBe(treasuryTail);
  });
});
