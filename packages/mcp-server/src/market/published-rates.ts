import * as fs from "node:fs/promises";
import path from "node:path";
import {
  clearPublishedRates,
  getEffectiveRateDate,
  PUBLISHED_RATES_URL,
  setPublishedRates,
  validatePublishedRates,
} from "@tradeblocks/lib";
import { getDataRoot } from "../db/data-root.ts";

export type RateSource = "network" | "cache" | "bundle";

/** Load current published rates for the MCP process; an offline reader may use its validated disk copy. */
export async function loadPublishedRates(
  dataDir: string,
): Promise<{ source: RateSource; dtb3Through: string }> {
  const cachePath = path.join(getDataRoot(dataDir), "market-meta", "rates.json");
  clearPublishedRates();
  try {
    const response = await fetch(PUBLISHED_RATES_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Published rates HTTP ${response.status}`);
    const validated = validatePublishedRates(await response.json());
    setPublishedRates(validated);
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(validated) + "\n");
      await fs.rename(temp, cachePath);
    } catch (error) {
      console.error(`[rates] Cannot cache published rates at ${cachePath}: ${String(error)}`);
    }
    return { source: "network", dtb3Through: getEffectiveRateDate("DTB3") };
  } catch (error) {
    console.error(`[rates] Published rates unavailable; trying cached rates: ${String(error)}`);
  }
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    setPublishedRates(cached);
    return { source: "cache", dtb3Through: getEffectiveRateDate("DTB3") };
  } catch (error) {
    console.error(`[rates] Valid cached rates unavailable; using bundled rates: ${String(error)}`);
    clearPublishedRates();
    return { source: "bundle", dtb3Through: getEffectiveRateDate("DTB3") };
  }
}
