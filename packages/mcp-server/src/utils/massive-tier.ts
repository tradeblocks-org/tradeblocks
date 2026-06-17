export type MassiveDataTier = 'ohlc' | 'trades' | 'quotes';

export function resolveMassiveDataTier(
  env: NodeJS.ProcessEnv = process.env,
): MassiveDataTier {
  const tier = (env.MASSIVE_DATA_TIER ?? '').toLowerCase();
  if (tier === 'quotes' || tier === 'trades' || tier === 'ohlc') {
    return tier;
  }
  return 'ohlc';
}
