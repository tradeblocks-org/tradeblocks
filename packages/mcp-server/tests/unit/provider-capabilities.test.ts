/**
 * Unit tests for ProviderCapabilities on MassiveProvider and ThetaDataProvider.
 *
 * Tests verify that each provider's capabilities() method returns the correct
 * flags, including env-var-driven behavior (MASSIVE_DATA_TIER for quotes).
 */

import { MassiveProvider } from "../../src/utils/providers/massive.ts";
import { ThetaDataProvider } from "../../src/utils/providers/thetadata.ts";

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV };
});

afterEach(() => {
  process.env = ORIG_ENV;
});

// ===========================================================================
// MassiveProvider capabilities
// ===========================================================================

describe("MassiveProvider.capabilities()", () => {
  it("tradeBars is true", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().tradeBars).toBe(true);
  });

  it("greeks is false — Massive does not provide greeks", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().greeks).toBe(false);
  });

  it("bulkByRoot is false — Massive is per-ticker", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().bulkByRoot).toBe(false);
  });

  it("perTicker is true", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().perTicker).toBe(true);
  });

  it("flatFiles is true", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().flatFiles).toBe(true);
  });

  it("minuteBars is true", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().minuteBars).toBe(true);
  });

  it("dailyBars is true", () => {
    const provider = new MassiveProvider();
    expect(provider.capabilities().dailyBars).toBe(true);
  });

  it("quotes is false when MASSIVE_DATA_TIER is not set", () => {
    delete process.env.MASSIVE_DATA_TIER;
    const provider = new MassiveProvider();
    expect(provider.capabilities().quotes).toBe(false);
  });

  it("quotes is false when MASSIVE_DATA_TIER=ohlc", () => {
    process.env.MASSIVE_DATA_TIER = "ohlc";
    const provider = new MassiveProvider();
    expect(provider.capabilities().quotes).toBe(false);
  });

  it("quotes is false when MASSIVE_DATA_TIER=trades", () => {
    process.env.MASSIVE_DATA_TIER = "trades";
    const provider = new MassiveProvider();
    expect(provider.capabilities().quotes).toBe(false);
  });

  it("quotes is true when MASSIVE_DATA_TIER=quotes", () => {
    process.env.MASSIVE_DATA_TIER = "quotes";
    const provider = new MassiveProvider();
    expect(provider.capabilities().quotes).toBe(true);
  });

  it("quotes is true when MASSIVE_DATA_TIER=QUOTES (case-insensitive)", () => {
    process.env.MASSIVE_DATA_TIER = "QUOTES";
    const provider = new MassiveProvider();
    expect(provider.capabilities().quotes).toBe(true);
  });
});

// ===========================================================================
// ThetaDataProvider capabilities
// ===========================================================================

describe("ThetaDataProvider.capabilities()", () => {
  it("bulkByRoot is true — ThetaData returns all strikes for a root", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().bulkByRoot).toBe(true);
  });

  it("greeks is true — ThetaData provides BSM greeks", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().greeks).toBe(true);
  });

  it("perTicker is false — ThetaData is bulk-oriented", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().perTicker).toBe(false);
  });

  it("quotes is true — ThetaData supports bulk_at_time quotes", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().quotes).toBe(true);
  });

  it("tradeBars is true", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().tradeBars).toBe(true);
  });

  it("flatFiles is false — ThetaData flat files not yet integrated", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().flatFiles).toBe(false);
  });

  it("minuteBars is true", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().minuteBars).toBe(true);
  });

  it("dailyBars is true", () => {
    const provider = new ThetaDataProvider();
    expect(provider.capabilities().dailyBars).toBe(true);
  });
});
