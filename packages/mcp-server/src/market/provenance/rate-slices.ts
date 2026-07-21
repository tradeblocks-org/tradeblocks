import { resolveSofrRateByKey, resolveTreasuryRateByKey } from "@tradeblocks/lib";
import type { PutContentObjectResult } from "./content-object-store.ts";
import type { ContentObjectStore } from "./content-object-store.ts";
import { isXnysSessionDate } from "./xnys-session-calendar.ts";

export const CANONICAL_RATE_SLICE_KIND = "tradeblocks.market-data.rate-slice" as const;
export const CANONICAL_RATE_SLICE_VERSION = 1 as const;

export type CanonicalRateDataClass = "sofr_rates" | "treasury_rates";
export type CanonicalRateSeries = "sofr" | "treasury_3m";

export interface CanonicalRateSliceV1 {
  kind: typeof CANONICAL_RATE_SLICE_KIND;
  version: typeof CANONICAL_RATE_SLICE_VERSION;
  series: CanonicalRateSeries;
  requestedDate: string;
  effectiveDate: string;
  annualRateBasisPoints: number;
  resolution: "exact" | "prior" | "clamped-earliest";
}

export async function publishCanonicalRateSlice(
  objects: ContentObjectStore,
  dataClass: CanonicalRateDataClass,
  requestedDate: string,
): Promise<PutContentObjectResult<CanonicalRateSliceV1>> {
  if (dataClass !== "sofr_rates" && dataClass !== "treasury_rates") {
    throw new TypeError(`Unsupported canonical rate data class: ${JSON.stringify(dataClass)}`);
  }
  if (!isXnysSessionDate(requestedDate)) {
    throw new TypeError(
      `Canonical rate slice date is not an XNYS session: ${JSON.stringify(requestedDate)}`,
    );
  }
  const resolved =
    dataClass === "sofr_rates"
      ? resolveSofrRateByKey(requestedDate)
      : resolveTreasuryRateByKey(requestedDate);
  if (resolved.resolution === "stale-after-latest") {
    throw new Error(
      `Canonical ${dataClass} input is stale after ${resolved.effectiveDate}; ` +
        `refusing requested session ${requestedDate}`,
    );
  }
  return objects.put({
    kind: CANONICAL_RATE_SLICE_KIND,
    version: CANONICAL_RATE_SLICE_VERSION,
    series: dataClass === "sofr_rates" ? "sofr" : "treasury_3m",
    requestedDate: resolved.requestedDate,
    effectiveDate: resolved.effectiveDate,
    annualRateBasisPoints: resolved.annualRateBasisPoints,
    resolution: resolved.resolution,
  });
}
