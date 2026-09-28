import {
  clearPublishedRates,
  getEffectiveRateDate,
  loadBrowserPublishedRates,
  TREASURY_RATES,
} from "@tradeblocks/lib";
import { SOFR_RATES } from "../../packages/lib/data/sofr-rates";
import { closeDatabase, deleteDatabase } from "../../packages/lib/db/index";

const nextDate = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};
const published = () => {
  const dtb3Date = nextDate(Object.keys(TREASURY_RATES).at(-1)!);
  const sofrDate = nextDate(Object.keys(SOFR_RATES).at(-1)!);
  return {
    schemaVersion: 1,
    source: "Federal Reserve Economic Data (FRED), Federal Reserve Bank of St. Louis",
    fetchedAt: "2026-09-27T06:00:00Z",
    series: {
      DTB3: {
        unit: "annual-percent",
        firstDate: Object.keys(TREASURY_RATES)[0],
        lastDate: dtb3Date,
        rates: { ...TREASURY_RATES, [dtb3Date]: 4.09 },
      },
      SOFR: {
        unit: "annual-percent",
        firstDate: Object.keys(SOFR_RATES)[0],
        lastDate: sofrDate,
        rates: { ...SOFR_RATES, [sofrDate]: 3.73 },
      },
    },
  };
};

const originalFetch = global.fetch;
afterEach(async () => {
  global.fetch = originalFetch;
  clearPublishedRates();
  closeDatabase();
  await deleteDatabase();
});

describe("browser published-rate reader", () => {
  it("uses a valid network response and falls back to its IndexedDB copy when offline", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => published() });
    expect(await loadBrowserPublishedRates(true)).toBe("network");
    expect(getEffectiveRateDate("DTB3")).toBe(published().series.DTB3.lastDate);
    global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
    expect(await loadBrowserPublishedRates(true)).toBe("cache");
    expect(getEffectiveRateDate("SOFR")).toBe(published().series.SOFR.lastDate);
  });

  it("rejects conflicting network and cached data, and uses the bundle if disabled", async () => {
    const divergent = published();
    divergent.series.DTB3.rates["2026-01-05"] = 9;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => divergent });
    expect(await loadBrowserPublishedRates(true)).toBe("bundle");
    expect(getEffectiveRateDate("DTB3")).toBe(Object.keys(TREASURY_RATES).at(-1));
    expect(await loadBrowserPublishedRates(false)).toBe("bundle");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
