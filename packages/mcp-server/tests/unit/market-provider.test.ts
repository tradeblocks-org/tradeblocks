/**
 * Unit tests for the MarketDataProvider factory (getProvider / _resetProvider).
 */

import { getProvider, _resetProvider } from "../../src/utils/market-provider.ts";

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  _resetProvider();
});

afterEach(() => {
  process.env = ORIG_ENV;
  _resetProvider();
});

describe("getProvider factory", () => {
  it("returns MassiveProvider by default", () => {
    delete process.env.MARKET_DATA_PROVIDER;
    expect(getProvider().name).toBe("massive");
  });

  it("returns MassiveProvider when explicitly set", () => {
    process.env.MARKET_DATA_PROVIDER = "massive";
    expect(getProvider().name).toBe("massive");
  });

  it("returns ThetaDataProvider when set", () => {
    process.env.MARKET_DATA_PROVIDER = "thetadata";
    expect(getProvider().name).toBe("thetadata");
  });

  it("is case-insensitive", () => {
    process.env.MARKET_DATA_PROVIDER = "ThetaData";
    expect(getProvider().name).toBe("thetadata");
  });

  it("throws on unknown provider", () => {
    process.env.MARKET_DATA_PROVIDER = "unknown";
    expect(() => getProvider()).toThrow('Unknown MARKET_DATA_PROVIDER: "unknown"');
  });

  it("caches provider across calls", () => {
    const a = getProvider();
    const b = getProvider();
    expect(a).toBe(b);
  });

  it("_resetProvider clears the cache", () => {
    const a = getProvider();
    _resetProvider();
    const b = getProvider();
    expect(a).not.toBe(b);
    expect(a.name).toBe(b.name);
  });
});
