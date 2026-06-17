import { jest } from "@jest/globals";
import { handleGetOptionSnapshot } from "../../src/tools/snapshot.ts";
import { getProvider, _resetProvider } from "../../src/utils/market-provider.ts";

/**
 * Unit tests for handleGetOptionSnapshot handler.
 * Mocks the provider's fetchOptionSnapshot via getProvider().
 */

function makeMockContract(overrides: Record<string, unknown> = {}) {
  return {
    ticker: "SPX251219C05000000",
    underlying_ticker: "SPX",
    underlying_price: 5234.56,
    contract_type: "call",
    strike: 5000,
    expiration: "2025-12-19",
    exercise_style: "european",
    delta: 0.45,
    gamma: 0.012,
    theta: -0.85,
    vega: 2.5,
    iv: 0.18,
    greeks_source: "massive" as const,
    bid: 12.5,
    ask: 13.5,
    midpoint: 13.0,
    last_price: 13.0,
    open_interest: 1500,
    volume: 500,
    break_even: 5050.0,
    ...overrides,
  };
}

function makeContracts(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeMockContract({ strike: 5000 + i })
  );
}

function mockProviderSnapshot(contracts: ReturnType<typeof makeMockContract>[]) {
  const provider = getProvider();
  jest.spyOn(provider, "fetchOptionSnapshot").mockResolvedValue({
    contracts,
    underlying_price: 5234.56,
    underlying_ticker: "SPX",
  });
}

function mockProviderSnapshotError(message: string) {
  const provider = getProvider();
  jest.spyOn(provider, "fetchOptionSnapshot").mockRejectedValue(new Error(message));
}

beforeEach(() => {
  _resetProvider();
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetProvider();
});

describe("handleGetOptionSnapshot", () => {
  it("returns JSON with underlying_ticker, underlying_price, contracts_returned, contracts_total, and contracts array", async () => {
    const contracts = makeContracts(10);
    mockProviderSnapshot(contracts);

    const output = await handleGetOptionSnapshot({ underlying: "SPX", limit: 50 });
    const parsed = JSON.parse(output);

    expect(parsed.underlying_ticker).toBe("SPX");
    expect(parsed.underlying_price).toBe(5234.56);
    expect(parsed.contracts_returned).toBe(10);
    expect(parsed.contracts_total).toBe(10);
    expect(Array.isArray(parsed.contracts)).toBe(true);
    expect(parsed.contracts).toHaveLength(10);
  });

  it("truncates contracts to limit when fetchOptionSnapshot returns more", async () => {
    const contracts = makeContracts(100);
    mockProviderSnapshot(contracts);

    const output = await handleGetOptionSnapshot({ underlying: "SPX", limit: 50 });
    const parsed = JSON.parse(output);

    expect(parsed.contracts_returned).toBe(50);
    expect(parsed.contracts_total).toBe(100);
    expect(parsed.contracts).toHaveLength(50);
  });

  it("applies limit truncation when explicit limit is provided", async () => {
    const contracts = makeContracts(80);
    mockProviderSnapshot(contracts);

    const output = await handleGetOptionSnapshot({ underlying: "SPX", limit: 25 });
    const parsed = JSON.parse(output);

    expect(parsed.contracts_returned).toBe(25);
    expect(parsed.contracts_total).toBe(80);
    expect(parsed.contracts).toHaveLength(25);
  });

  it("returns error JSON when fetchOptionSnapshot throws", async () => {
    mockProviderSnapshotError("MASSIVE_API_KEY environment variable is not set");

    const output = await handleGetOptionSnapshot({ underlying: "SPX", limit: 50 });
    const parsed = JSON.parse(output);

    expect(parsed.error).toBe("MASSIVE_API_KEY environment variable is not set");
    expect(parsed.contracts).toBeUndefined();
  });

  it("preserves all OptionContract fields in output contracts", async () => {
    const contract = makeMockContract();
    mockProviderSnapshot([contract]);

    const output = await handleGetOptionSnapshot({ underlying: "SPX", limit: 50 });
    const parsed = JSON.parse(output);
    const c = parsed.contracts[0];

    expect(c.ticker).toBe("SPX251219C05000000");
    expect(c.strike).toBe(5000);
    expect(c.delta).toBe(0.45);
    expect(c.greeks_source).toBe("massive");
    expect(c.bid).toBe(12.5);
    expect(c.open_interest).toBe(1500);
  });
});
