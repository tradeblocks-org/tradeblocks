import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPublishedRates, getEffectiveRateDate, TREASURY_RATES } from "@tradeblocks/lib";
import { SOFR_RATES } from "../../../lib/data/sofr-rates.ts";
import { loadPublishedRates } from "../../src/market/published-rates.ts";
import { computeQuoteGreeks } from "../../src/utils/option-quote-greeks.ts";

const tail = Object.keys(TREASURY_RATES).at(-1)!;
const next = new Date(`${tail}T00:00:00Z`);
next.setUTCDate(next.getUTCDate() + 1);
const day = next.toISOString().slice(0, 10);
const greekInput = {
  optionPrice: 52,
  underlyingPrice: 6500,
  strike: 6500,
  date: day,
  time: "10:00",
  expiration: "2026-10-16",
  contractType: "call" as const,
};
const publication = () => ({
  schemaVersion: 1,
  source: "Federal Reserve Economic Data (FRED), Federal Reserve Bank of St. Louis",
  fetchedAt: "2026-09-27T06:00:00Z",
  series: {
    DTB3: {
      unit: "annual-percent",
      firstDate: Object.keys(TREASURY_RATES)[0],
      lastDate: day,
      rates: { ...TREASURY_RATES, [day]: 4.09 },
    },
    SOFR: {
      unit: "annual-percent",
      firstDate: Object.keys(SOFR_RATES)[0],
      lastDate: day,
      rates: { ...SOFR_RATES, [day]: 3.73 },
    },
  },
});
const originalFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), "mcp-published-rates-"));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearPublishedRates();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP published-rate reader", () => {
  it("switches between network, validated disk copy, and bundled rates", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    const originalGreek = computeQuoteGreeks(greekInput);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(publication())));
    expect(await loadPublishedRates(dir)).toEqual({ source: "network", dtb3Through: day });
    const publishedGreek = computeQuoteGreeks(greekInput);
    expect(publishedGreek?.rate_value).toBe(0.0373);
    expect(publishedGreek?.iv).not.toBe(originalGreek?.iv);
    expect(existsSync(join(dir, "market-meta", "rates.json"))).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await loadPublishedRates(dir)).toEqual({ source: "cache", dtb3Through: day });
    rmSync(dir, { recursive: true, force: true });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await loadPublishedRates(dir)).toEqual({ source: "bundle", dtb3Through: tail });
    expect(computeQuoteGreeks(greekInput)?.rate_value).toBe(originalGreek?.rate_value);
    expect(getEffectiveRateDate("SOFR")).toBe(Object.keys(SOFR_RATES).at(-1));
  });

  it("uses only the bundle and makes no request when the published-rate fetch is turned off", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(publication())));
    process.env.TRADEBLOCKS_PUBLISHED_RATES = "off";
    try {
      expect(await loadPublishedRates(dir)).toEqual({ source: "bundle", dtb3Through: tail });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.TRADEBLOCKS_PUBLISHED_RATES;
    }
  });

  it("does not persist a conflicting rate or replace a valid cached publication", async () => {
    const local = mkdtempSync(join(tmpdir(), "mcp-published-rates-invalid-"));
    try {
      const fetchMock = jest.fn<typeof fetch>();
      globalThis.fetch = fetchMock;
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(publication())));
      expect((await loadPublishedRates(local)).source).toBe("network");
      const bad = publication();
      bad.series.DTB3.rates["2026-01-05"] = 9;
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(bad)));
      expect(await loadPublishedRates(local)).toEqual({ source: "cache", dtb3Through: day });
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});
