import {
  clearPublishedRates,
  PUBLISHED_RATES_URL,
  setPublishedRates,
  validatePublishedRates,
} from "../utils/index.ts";
import { promisifyRequest, STORES, withReadTransaction, withWriteTransaction } from "./index.ts";

/** Fetch when enabled; keep validated IndexedDB data if the network is unavailable. */
export async function loadBrowserPublishedRates(
  enabled: boolean,
  signal?: AbortSignal,
): Promise<"network" | "cache" | "bundle"> {
  clearPublishedRates();
  if (!enabled) return "bundle";
  try {
    const response = await fetch(PUBLISHED_RATES_URL, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    if (signal?.aborted) return "bundle";
    if (!response.ok) throw new Error(`Published rates HTTP ${response.status}`);
    const published = validatePublishedRates(await response.json());
    if (signal?.aborted) return "bundle";
    setPublishedRates(published);
    try {
      await withWriteTransaction(STORES.PUBLISHED_RATES, async (transaction) => {
        await promisifyRequest(
          transaction.objectStore(STORES.PUBLISHED_RATES).put(published, "current"),
        );
      });
    } catch (error) {
      console.warn("Could not cache published risk-free rates:", error);
    }
    return "network";
  } catch (error) {
    console.warn("Published risk-free rates unavailable; trying local cache:", error);
    if (signal?.aborted) return "bundle";
  }
  try {
    const cached = await withReadTransaction(STORES.PUBLISHED_RATES, async (transaction) =>
      promisifyRequest(transaction.objectStore(STORES.PUBLISHED_RATES).get("current")),
    );
    if (signal?.aborted) return "bundle";
    setPublishedRates(cached);
    return "cache";
  } catch (error) {
    console.warn("No valid cached risk-free rates; using bundled data:", error);
    clearPublishedRates();
    return "bundle";
  }
}
