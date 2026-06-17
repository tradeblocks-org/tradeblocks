import {
  MassiveProvider,
  ThetaDataProvider,
  resolveMassiveDataTier,
  resolveProviderCapabilities,
} from '../../src/test-exports.ts';

describe('resolveMassiveDataTier', () => {
  test('defaults to ohlc when MASSIVE_DATA_TIER is unset', () => {
    expect(resolveMassiveDataTier({} as NodeJS.ProcessEnv)).toBe('ohlc');
  });

  test('accepts explicit ohlc tier', () => {
    expect(resolveMassiveDataTier({ MASSIVE_DATA_TIER: 'ohlc' })).toBe('ohlc');
  });

  test('accepts explicit trades tier', () => {
    expect(resolveMassiveDataTier({ MASSIVE_DATA_TIER: 'trades' })).toBe('trades');
  });

  test('accepts explicit quotes tier', () => {
    expect(resolveMassiveDataTier({ MASSIVE_DATA_TIER: 'quotes' })).toBe('quotes');
  });

  test('normalizes MASSIVE_DATA_TIER case', () => {
    expect(resolveMassiveDataTier({ MASSIVE_DATA_TIER: 'QUOTES' })).toBe('quotes');
  });

  test('falls back to ohlc for invalid tiers', () => {
    expect(resolveMassiveDataTier({ MASSIVE_DATA_TIER: 'premium' })).toBe('ohlc');
  });
});

describe('resolveProviderCapabilities', () => {
  test('Massive defaults to ohlc tier with correct base capabilities', () => {
    const capabilities = resolveProviderCapabilities(
      new MassiveProvider(),
      {} as NodeJS.ProcessEnv,
    );

    expect(capabilities.providerName).toBe('massive');
    expect(capabilities.massiveDataTier).toBe('ohlc');
    expect(capabilities.flatFiles).toBe(true);
    expect(capabilities.contractList).toBe(true);
  });

  test('quoteHydration is true for Massive whenever fetchQuotes exists, regardless of tier', () => {
    const provider = new MassiveProvider();
    expect(resolveProviderCapabilities(provider, { MASSIVE_DATA_TIER: 'ohlc' }).quoteHydration).toBe(true);
    expect(resolveProviderCapabilities(provider, { MASSIVE_DATA_TIER: 'trades' }).quoteHydration).toBe(true);
    expect(resolveProviderCapabilities(provider, { MASSIVE_DATA_TIER: 'quotes' }).quoteHydration).toBe(true);
    expect(resolveProviderCapabilities(provider, {}).quoteHydration).toBe(true);
  });

  test('ThetaData passes through provider capabilities and has no Massive tier', () => {
    const capabilities = resolveProviderCapabilities(
      new ThetaDataProvider(),
      {} as NodeJS.ProcessEnv,
    );

    expect(capabilities.providerName).toBe('thetadata');
    expect(capabilities.massiveDataTier).toBeNull();
    expect(capabilities.quoteHydration).toBe(true);
    expect(capabilities.flatFiles).toBe(false);
    expect(capabilities.contractList).toBe(true);
  });
});
