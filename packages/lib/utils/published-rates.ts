import { z } from "zod";
import { SOFR_RATES } from "../data/sofr-rates.ts";
import { TREASURY_RATES } from "../data/treasury-rates.ts";

export const PUBLISHED_RATES_URL =
  "https://raw.githubusercontent.com/tradeblocks-org/tradeblocks/rates-data/rates.json";

const SeriesSchema = z.object({
  unit: z.literal("annual-percent"),
  firstDate: z.string(),
  lastDate: z.string(),
  rates: z.record(z.string(), z.number()),
});
const PublishedRatesSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("Federal Reserve Economic Data (FRED), Federal Reserve Bank of St. Louis"),
  fetchedAt: z.iso.datetime(),
  series: z.object({ DTB3: SeriesSchema, SOFR: SeriesSchema }),
});
export type PublishedRates = z.infer<typeof PublishedRatesSchema>;

function validateSeries(
  name: "DTB3" | "SOFR",
  series: PublishedRates["series"]["DTB3"],
  bundled: Record<string, number>,
): void {
  const keys = Object.keys(series.rates);
  if (!keys.length || series.firstDate !== keys[0] || series.lastDate !== keys.at(-1)) {
    throw new Error(`Invalid published ${name} date range`);
  }
  let previous = "";
  for (const date of keys) {
    const rate = series.rates[date];
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== date ||
      date <= previous ||
      !Number.isFinite(rate) ||
      !Number.isSafeInteger(Math.round(rate * 100)) ||
      Math.round(rate * 100) / 100 !== rate
    ) {
      throw new Error(`Invalid published ${name} observation: ${date}`);
    }
    previous = date;
  }
  for (const [date, rate] of Object.entries(bundled)) {
    if (series.rates[date] !== rate) {
      throw new Error(`Published ${name} disagrees with bundled rate on ${date}`);
    }
  }
}

export function validatePublishedRates(input: unknown): PublishedRates {
  const parsed = PublishedRatesSchema.parse(input);
  validateSeries("DTB3", parsed.series.DTB3, TREASURY_RATES);
  validateSeries("SOFR", parsed.series.SOFR, SOFR_RATES);
  return parsed;
}
