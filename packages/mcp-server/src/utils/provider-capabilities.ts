import {
  getProvider,
  type MarketDataProvider,
  type ProviderCapabilities,
} from "./market-provider.ts";
import {
  resolveMassiveDataTier,
  type MassiveDataTier,
} from "./massive-tier.ts";

export interface ResolvedProviderCapabilities extends ProviderCapabilities {
  provider: MarketDataProvider;
  providerName: string;
  massiveDataTier: MassiveDataTier | null;
  quoteHydration: boolean;
  contractList: boolean;
}

export function resolveProviderCapabilities(
  provider: MarketDataProvider = getProvider(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderCapabilities {
  const base = provider.capabilities();
  const massiveDataTier = provider.name === "massive" ? resolveMassiveDataTier(env) : null;
  // The right question for hydration dispatch is "can I call fetchQuotes?",
  // not "is the data NBBO-grade?" — provenance is captured per-row via
  // QuoteRow.source. Massive's fetchQuotes branches internally on
  // MASSIVE_DATA_TIER (true NBBO via /v3/quotes vs synthesized from /v2/aggs);
  // either path returns useful per-minute data.
  const quoteHydration = typeof provider.fetchQuotes === "function";

  return {
    ...base,
    provider,
    providerName: provider.name,
    massiveDataTier,
    quoteHydration,
    contractList: typeof provider.fetchContractList === "function",
  };
}

export function getResolvedProviderCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderCapabilities {
  return resolveProviderCapabilities(getProvider(), env);
}

export { resolveMassiveDataTier };
export type { MassiveDataTier };
