import { jest } from "@jest/globals";

/**
 * Unit tests for MassiveProvider — Massive.com market data adapter.
 *
 * Migrated from:
 * - massive-client-utils.test.ts (ticker normalization, timestamp conversion, Zod schemas)
 * - massive-client-fetch.test.ts (fetchBars with mocked fetch)
 * - massive-snapshot.test.ts (fetchOptionSnapshot with mocked fetch)
 */

import {
  MassiveProvider,
  toMassiveTicker,
  fromMassiveTicker,
  massiveTimestampToETDate,
  nanosToETMinuteKey,
  MassiveBarSchema,
  MassiveAggregateResponseSchema,
  MassiveSnapshotResponseSchema,
  MassiveQuoteSchema,
  MassiveQuotesResponseSchema,
} from "../../../src/utils/providers/massive.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const provider = new MassiveProvider();

const VALID_BAR = { v: 1000, vw: 100.5, o: 100, c: 101, h: 102, l: 99, t: 1736253000000, n: 50 };

const VALID_RESPONSE = {
  ticker: "I:VIX",
  queryCount: 1,
  resultsCount: 1,
  adjusted: false,
  results: [
    { v: 1000, vw: 20.5, o: 20.0, c: 21.0, h: 21.5, l: 19.5, t: 1736253000000, n: 50 },
  ],
  status: "OK",
  request_id: "req-123",
};

function mockResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeContract(overrides: Record<string, unknown> = {}) {
  return {
    break_even_price: 5050.0,
    implied_volatility: 0.18,
    open_interest: 1500,
    greeks: { delta: 0.45, gamma: 0.012, theta: -0.85, vega: 2.5 },
    day: {
      open: 12.0, high: 14.0, low: 11.5, close: 13.0, change: 1.0,
      change_percent: 8.33, volume: 500, vwap: 12.8, previous_close: 12.0,
      last_updated: 1736253000000000000,
    },
    last_quote: {
      bid: 12.5, ask: 13.5, midpoint: 13.0, bid_size: 10, ask_size: 15,
      last_updated: 1736253000000000000, timeframe: "REAL-TIME",
    },
    last_trade: {
      price: 13.0, size: 5, sip_timestamp: 1736253000000000000,
      conditions: [1], timeframe: "REAL-TIME",
    },
    details: {
      ticker: "O:SPX251219C05000000", contract_type: "call",
      strike_price: 5000, expiration_date: "2025-12-19",
      exercise_style: "european", shares_per_contract: 100,
    },
    underlying_asset: {
      ticker: "I:SPX", price: 5050.0, change_to_break_even: 0.0,
      last_updated: 1736253000000000000, timeframe: "REAL-TIME",
    },
    ...overrides,
  };
}

function makeSnapshotResponse(contracts: unknown[] = [makeContract()], nextUrl?: string) {
  return {
    request_id: "req-snap-001",
    status: "OK",
    results: contracts,
    ...(nextUrl ? { next_url: nextUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Setup/Teardown
// ---------------------------------------------------------------------------

const ORIG_ENV = process.env;
let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  process.env.MASSIVE_API_KEY = "test-key-abc123";
  fetchSpy = jest.spyOn(globalThis, "fetch");
});

afterEach(() => {
  process.env = ORIG_ENV;
  jest.restoreAllMocks();
});

// ===========================================================================
// Ticker Normalization (from massive-client-utils.test.ts)
// ===========================================================================

describe("massiveTimestampToETDate", () => {
  it("converts 9:30 AM ET bar to correct date (2025-01-07)", () => {
    expect(massiveTimestampToETDate(1736253000000)).toBe("2025-01-07");
  });

  it("handles EST (winter) correctly — Nov 4, 2024 9:30 AM ET", () => {
    expect(massiveTimestampToETDate(1730727000000)).toBe("2024-11-04");
  });

  it("handles EDT (summer) correctly — Jul 10, 2024 9:30 AM ET", () => {
    expect(massiveTimestampToETDate(1720615800000)).toBe("2024-07-10");
  });

  it("handles late-night ET boundary — 11:59 PM ET stays on same calendar date", () => {
    expect(massiveTimestampToETDate(1736312340000)).toBe("2025-01-07");
  });
});

describe("toMassiveTicker", () => {
  it("prepends I: for index tickers", () => {
    expect(toMassiveTicker("VIX", "index")).toBe("I:VIX");
  });

  it("does not double-prefix index tickers already formatted", () => {
    expect(toMassiveTicker("I:VIX", "index")).toBe("I:VIX");
  });

  it("prepends O: for option tickers (plain OCC format)", () => {
    expect(toMassiveTicker("SPX251219C05000000", "option")).toBe("O:SPX251219C05000000");
  });

  it("does not double-prefix option tickers already formatted", () => {
    expect(toMassiveTicker("O:SPX251219C05000000", "option")).toBe("O:SPX251219C05000000");
  });

  it("returns stock tickers unchanged", () => {
    expect(toMassiveTicker("AAPL", "stock")).toBe("AAPL");
  });

  it("VIX9D gets I: index prefix", () => {
    expect(toMassiveTicker("VIX9D", "index")).toBe("I:VIX9D");
  });

  it("SPX stock ticker is returned unchanged (no prefix for stocks)", () => {
    expect(toMassiveTicker("SPX", "stock")).toBe("SPX");
  });
});

describe("fromMassiveTicker", () => {
  it("strips I: prefix from index ticker", () => {
    expect(fromMassiveTicker("I:VIX")).toBe("VIX");
  });

  it("strips I: prefix from VIX9D", () => {
    expect(fromMassiveTicker("I:VIX9D")).toBe("VIX9D");
  });

  it("strips O: prefix from options ticker", () => {
    expect(fromMassiveTicker("O:SPX251219C05000000")).toBe("SPX251219C05000000");
  });

  it("leaves plain (unprefixed) stock tickers unchanged", () => {
    expect(fromMassiveTicker("AAPL")).toBe("AAPL");
  });
});

// ===========================================================================
// Zod Schemas (from massive-client-utils.test.ts)
// ===========================================================================

describe("MassiveBarSchema", () => {
  it("accepts a valid bar with all 8 required fields", () => {
    expect(MassiveBarSchema.safeParse(VALID_BAR).success).toBe(true);
  });

  it("rejects a bar missing required field h (high)", () => {
    const withoutH = { ...VALID_BAR };
    delete (withoutH as Record<string, unknown>).h;
    expect(MassiveBarSchema.safeParse(withoutH).success).toBe(false);
  });

  it("rejects a bar with string timestamp instead of number", () => {
    expect(MassiveBarSchema.safeParse({ ...VALID_BAR, t: "not-a-number" }).success).toBe(false);
  });

  it("rejects a bar missing multiple required fields", () => {
    expect(MassiveBarSchema.safeParse({ v: 1000, o: 100, c: 101 }).success).toBe(false);
  });
});

describe("MassiveAggregateResponseSchema", () => {
  const VALID_AGG_RESPONSE = {
    ticker: "I:VIX", queryCount: 1, resultsCount: 1, adjusted: false,
    results: [VALID_BAR], status: "OK", request_id: "abc123",
  };

  it("accepts a valid aggregate response with one bar", () => {
    expect(MassiveAggregateResponseSchema.safeParse(VALID_AGG_RESPONSE).success).toBe(true);
  });

  it("accepts a response with next_url", () => {
    const withNextUrl = { ...VALID_AGG_RESPONSE, next_url: "https://api.massive.com/v2/aggs?cursor=abc123" };
    expect(MassiveAggregateResponseSchema.safeParse(withNextUrl).success).toBe(true);
  });

  it("accepts a response with empty results array", () => {
    expect(MassiveAggregateResponseSchema.safeParse({ ...VALID_AGG_RESPONSE, results: [], resultsCount: 0 }).success).toBe(true);
  });

  it("defaults to empty array when results field missing", () => {
    const withoutResults = { ...VALID_AGG_RESPONSE };
    delete (withoutResults as Record<string, unknown>).results;
    const result = MassiveAggregateResponseSchema.safeParse(withoutResults);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.results).toEqual([]);
  });

  it("rejects a response where results is not an array", () => {
    expect(MassiveAggregateResponseSchema.safeParse({ ...VALID_AGG_RESPONSE, results: "not-an-array" }).success).toBe(false);
  });
});

// ===========================================================================
// MassiveProvider.fetchBars (from massive-client-fetch.test.ts)
// ===========================================================================

describe("MassiveProvider.fetchBars", () => {
  describe("API key handling", () => {
    it("throws when MASSIVE_API_KEY is not set", async () => {
      delete process.env.MASSIVE_API_KEY;
      await expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("Set MASSIVE_API_KEY environment variable");
    });

    it("sends Authorization Bearer header with the API key", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      const options = fetchSpy.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
      expect(options.headers.Authorization).toBe("Bearer test-key-abc123");
    });

    it("throws distinct error on 401", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ error: "Unauthorized" }, 401));
      await expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("MASSIVE_API_KEY rejected by Massive.com");
    });
  });

  describe("URL construction", () => {
    it("builds correct aggregates URL for index ticker", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/v2/aggs/ticker/I%3AVIX/range/1/day/2025-01-01/2025-01-31");
      expect(url).toContain("adjusted=false");
      expect(url).toContain("limit=50000");
    });

    it("uses default timespan day and multiplier 1", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      expect((fetchSpy.mock.calls[0][0] as string)).toContain("/range/1/day/");
    });

    it("accepts custom timespan and multiplier", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ ...VALID_RESPONSE, ticker: "I:VIX" }));
      await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index", timespan: "minute", multiplier: 5 });
      expect((fetchSpy.mock.calls[0][0] as string)).toContain("/range/5/minute/");
    });

    it("uses stock ticker without I: prefix", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ ...VALID_RESPONSE, ticker: "AAPL" }));
      await provider.fetchBars({ ticker: "AAPL", from: "2025-01-01", to: "2025-01-31", assetClass: "stock" });
      expect((fetchSpy.mock.calls[0][0] as string)).toContain("/ticker/AAPL/");
    });
  });

  describe("response parsing", () => {
    it("converts bars to BarRow with ET date", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      const rows = await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("2025-01-07");
      expect(rows[0].open).toBe(20.0);
      expect(rows[0].close).toBe(21.0);
      expect(rows[0].high).toBe(21.5);
      expect(rows[0].low).toBe(19.5);
      expect(rows[0].volume).toBe(1000);
    });

    it("strips I: prefix from ticker in returned rows", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      const rows = await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      expect(rows[0].ticker).toBe("VIX");
    });

    it("returns empty array when results is empty", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ ...VALID_RESPONSE, results: [], queryCount: 0, resultsCount: 0 }));
      const rows = await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      expect(rows).toHaveLength(0);
    });
  });

  describe("Zod validation", () => {
    it("throws on malformed response", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ bad: "data" }));
      await expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("validation failed");
    });
  });

  describe("pagination", () => {
    it("follows next_url to collect all pages", async () => {
      const page1 = { ...VALID_RESPONSE, next_url: "https://api.massive.com/v2/aggs/next?cursor=abc123" };
      const page2 = { ...VALID_RESPONSE, results: [{ v: 2000, vw: 22.0, o: 22.0, c: 23.0, h: 23.5, l: 21.5, t: 1736339400000, n: 60 }] };
      fetchSpy.mockResolvedValueOnce(mockResponse(page1)).mockResolvedValueOnce(mockResponse(page2));
      const rows = await provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(rows).toHaveLength(2);
    });

    it("throws on repeated cursor (pagination loop guard)", async () => {
      const resp = { ...VALID_RESPONSE, next_url: "https://api.massive.com/v2/aggs/next?cursor=same-cursor" };
      fetchSpy.mockResolvedValueOnce(mockResponse(resp)).mockResolvedValueOnce(mockResponse(resp));
      await expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("Pagination loop detected");
    });
  });

  describe("rate limiting", () => {
    it("retries on 429 then succeeds", async () => {
      jest.useFakeTimers();
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "Content-Type": "application/json", "Retry-After": "1" } }))
        .mockResolvedValueOnce(mockResponse(VALID_RESPONSE));
      const promise = provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" });
      await jest.runAllTimersAsync();
      const rows = await promise;
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(rows).toHaveLength(1);
      jest.useRealTimers();
    });

    it("throws after max retries on 429", async () => {
      jest.useFakeTimers();
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "Content-Type": "application/json", "Retry-After": "1" } }));
      const errorPromise = expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("rate limit exceeded");
      await jest.runAllTimersAsync();
      await errorPromise;
      jest.useRealTimers();
    });
  });

  describe("HTTP errors", () => {
    it("throws on 500 with status code in message", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "server error" }), { status: 500, statusText: "Internal Server Error", headers: { "Content-Type": "application/json" } }));
      await expect(
        provider.fetchBars({ ticker: "VIX", from: "2025-01-01", to: "2025-01-31", assetClass: "index" })
      ).rejects.toThrow("HTTP 500");
    });
  });
});

// ===========================================================================
// MassiveProvider.fetchOptionSnapshot (from massive-snapshot.test.ts)
// ===========================================================================

describe("MassiveProvider.fetchOptionSnapshot", () => {
  describe("single-page response", () => {
    it("returns flat array of OptionContract objects with all fields mapped", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      const result = await provider.fetchOptionSnapshot({ underlying: "SPX" });
      expect(result.contracts).toHaveLength(1);
      const c = result.contracts[0];
      expect(c.ticker).toBe("SPX251219C05000000");
      expect(c.underlying_ticker).toBe("SPX");
      expect(c.underlying_price).toBe(5050.0);
      expect(c.contract_type).toBe("call");
      expect(c.strike).toBe(5000);
      expect(c.expiration).toBe("2025-12-19");
      expect(c.delta).toBe(0.45);
      expect(c.gamma).toBe(0.012);
      expect(c.theta).toBe(-0.85);
      expect(c.vega).toBe(2.5);
      expect(c.iv).toBe(0.18);
      expect(c.greeks_source).toBe("massive");
      expect(c.bid).toBe(12.5);
      expect(c.ask).toBe(13.5);
      expect(c.midpoint).toBe(13.0);
      expect(c.last_price).toBe(13.0);
      expect(c.open_interest).toBe(1500);
      expect(c.volume).toBe(500);
      expect(c.break_even).toBe(5050.0);
      expect(result.underlying_price).toBe(5050.0);
      expect(result.underlying_ticker).toBe("SPX");
    });
  });

  describe("pagination", () => {
    it("auto-paginates when next_url is present", async () => {
      const page1 = makeSnapshotResponse([makeContract()], "https://api.massive.com/v3/snapshot/options/next?cursor=page2cursor");
      const page2 = makeSnapshotResponse([makeContract({
        details: { ticker: "O:SPX251219P05000000", contract_type: "put", strike_price: 5000, expiration_date: "2025-12-19", exercise_style: "european", shares_per_contract: 100 },
      })]);
      fetchSpy.mockResolvedValueOnce(mockResponse(page1)).mockResolvedValueOnce(mockResponse(page2));
      const result = await provider.fetchOptionSnapshot({ underlying: "SPX" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.contracts).toHaveLength(2);
      expect(result.contracts[0].contract_type).toBe("call");
      expect(result.contracts[1].contract_type).toBe("put");
    });

    it("throws on repeated pagination cursor", async () => {
      const repeating = makeSnapshotResponse([makeContract()], "https://api.massive.com/v3/snapshot/options/next?cursor=same-cursor");
      fetchSpy.mockResolvedValueOnce(mockResponse(repeating)).mockResolvedValueOnce(mockResponse(repeating));
      await expect(provider.fetchOptionSnapshot({ underlying: "SPX" })).rejects.toThrow("Pagination loop detected");
    });
  });

  describe("greeks fallback", () => {
    it("uses BS fallback when greeks object is null", async () => {
      const noGreeks = makeContract({
        greeks: undefined, implied_volatility: 0.20,
        last_trade: { price: 120.0, size: 5, sip_timestamp: 1736253000000000000, timeframe: "REAL-TIME" },
        details: { ticker: "O:SPX261219C05200000", contract_type: "call", strike_price: 5200, expiration_date: "2027-12-19", exercise_style: "european", shares_per_contract: 100 },
        underlying_asset: { ticker: "I:SPX", price: 5050.0, change_to_break_even: 0.0, last_updated: 1736253000000000000, timeframe: "REAL-TIME" },
      });
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse([noGreeks])));
      const result = await provider.fetchOptionSnapshot({ underlying: "SPX" });
      expect(result.contracts[0].greeks_source).toBe("computed");
      expect(result.contracts[0].delta).not.toBeNull();
      expect(result.contracts[0].iv).not.toBeNull();
    });
  });

  describe("API greeks", () => {
    it("passes through API greeks with greeks_source='massive'", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      const result = await provider.fetchOptionSnapshot({ underlying: "SPX" });
      const c = result.contracts[0];
      expect(c.greeks_source).toBe("massive");
      expect(c.delta).toBe(0.45);
      expect(c.iv).toBe(0.18);
    });
  });

  describe("Zod validation", () => {
    it("rejects response with missing required fields", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ request_id: "req-001", status: "OK", results: [{ break_even_price: 100, implied_volatility: 0.2, open_interest: 50 }] }));
      await expect(provider.fetchOptionSnapshot({ underlying: "SPX" })).rejects.toThrow("validation failed");
    });

    it("schema validates a well-formed response", () => {
      expect(MassiveSnapshotResponseSchema.safeParse(makeSnapshotResponse()).success).toBe(true);
    });
  });

  describe("API key handling", () => {
    it("throws when MASSIVE_API_KEY is not set", async () => {
      delete process.env.MASSIVE_API_KEY;
      await expect(provider.fetchOptionSnapshot({ underlying: "SPX" })).rejects.toThrow("MASSIVE_API_KEY");
    });
  });

  describe("HTTP errors", () => {
    it("throws auth error on 401", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ error: "Unauthorized" }, 401));
      await expect(provider.fetchOptionSnapshot({ underlying: "SPX" })).rejects.toThrow("rejected");
    });

    it("retries on 429 with backoff then succeeds", async () => {
      jest.useFakeTimers();
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "Content-Type": "application/json", "Retry-After": "1" } }))
        .mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      const promise = provider.fetchOptionSnapshot({ underlying: "SPX" });
      await jest.runAllTimersAsync();
      const result = await promise;
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.contracts).toHaveLength(1);
      jest.useRealTimers();
    });
  });

  describe("filter params", () => {
    it("includes strike_price and expiration_date filters in URL", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      await provider.fetchOptionSnapshot({ underlying: "SPX", strike_price_gte: 4900, strike_price_lte: 5100, expiration_date_gte: "2025-12-01", expiration_date_lte: "2025-12-31" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("strike_price.gte=4900");
      expect(url).toContain("strike_price.lte=5100");
      expect(url).toContain("expiration_date.gte=2025-12-01");
      expect(url).toContain("expiration_date.lte=2025-12-31");
    });
  });

  describe("URL construction", () => {
    it("uses I: prefix for index tickers (SPX)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      await provider.fetchOptionSnapshot({ underlying: "SPX" });
      expect((fetchSpy.mock.calls[0][0] as string)).toContain("/v3/snapshot/options/I%3ASPX");
    });

    it("uses plain ticker for stock tickers (AAPL)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      await provider.fetchOptionSnapshot({ underlying: "AAPL" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/v3/snapshot/options/AAPL");
      expect(url).not.toContain("I%3A");
    });

    it("includes limit=250 in query string", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(makeSnapshotResponse()));
      await provider.fetchOptionSnapshot({ underlying: "SPX" });
      expect((fetchSpy.mock.calls[0][0] as string)).toContain("limit=250");
    });
  });
});

// ===========================================================================
// Zod Schemas — Quotes (MassiveQuoteSchema, MassiveQuotesResponseSchema)
// ===========================================================================

describe("MassiveQuoteSchema", () => {
  const VALID_QUOTE = {
    bid_price: 12.5,
    ask_price: 13.5,
    sip_timestamp: 1736253000000 * 1_000_000,
    bid_size: 10,
    ask_size: 15,
    sequence_number: 99001234,
  };

  it("validates a well-formed quote with all required fields", () => {
    expect(MassiveQuoteSchema.safeParse(VALID_QUOTE).success).toBe(true);
  });

  it("rejects a quote missing bid_price", () => {
    const { bid_price: _bid, ...rest } = VALID_QUOTE;
    expect(MassiveQuoteSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a quote with string sip_timestamp", () => {
    expect(MassiveQuoteSchema.safeParse({ ...VALID_QUOTE, sip_timestamp: "not-a-number" }).success).toBe(false);
  });

  it("rejects a quote missing sequence_number", () => {
    const { sequence_number: _seq, ...rest } = VALID_QUOTE;
    expect(MassiveQuoteSchema.safeParse(rest).success).toBe(false);
  });
});

describe("MassiveQuotesResponseSchema", () => {
  const VALID_QUOTE = {
    bid_price: 12.5,
    ask_price: 13.5,
    sip_timestamp: 1736253000000 * 1_000_000,
    bid_size: 10,
    ask_size: 15,
    sequence_number: 99001234,
  };

  it("validates a well-formed response with results array", () => {
    const resp = { status: "OK", request_id: "req-quotes-001", results: [VALID_QUOTE] };
    expect(MassiveQuotesResponseSchema.safeParse(resp).success).toBe(true);
  });

  it("accepts a response with next_url", () => {
    const resp = { status: "OK", request_id: "req-quotes-002", results: [VALID_QUOTE], next_url: "https://api.massive.com/v3/quotes/next?cursor=abc" };
    expect(MassiveQuotesResponseSchema.safeParse(resp).success).toBe(true);
  });

  it("defaults results to empty array when field is missing", () => {
    const resp = { status: "OK", request_id: "req-quotes-003" };
    const parsed = MassiveQuotesResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.results).toEqual([]);
  });

  it("rejects response missing required status field", () => {
    const resp = { request_id: "req-quotes-004", results: [] };
    expect(MassiveQuotesResponseSchema.safeParse(resp).success).toBe(false);
  });
});

// ===========================================================================
// MassiveProvider.capabilities — strictly NBBO availability
// ===========================================================================

describe("MassiveProvider.capabilities.quotes — strictly NBBO availability", () => {
  afterEach(() => {
    delete process.env.MASSIVE_DATA_TIER;
  });

  it("reports quotes=false when MASSIVE_DATA_TIER is unset (Developer/Starter plan, no /v3/quotes access)", () => {
    delete process.env.MASSIVE_DATA_TIER;
    expect(new MassiveProvider().capabilities().quotes).toBe(false);
  });

  it("reports quotes=false when MASSIVE_DATA_TIER=ohlc", () => {
    process.env.MASSIVE_DATA_TIER = "ohlc";
    expect(new MassiveProvider().capabilities().quotes).toBe(false);
  });

  it("reports quotes=false when MASSIVE_DATA_TIER=trades", () => {
    process.env.MASSIVE_DATA_TIER = "trades";
    expect(new MassiveProvider().capabilities().quotes).toBe(false);
  });

  it("reports quotes=true ONLY when MASSIVE_DATA_TIER=quotes (true NBBO via /v3/quotes)", () => {
    process.env.MASSIVE_DATA_TIER = "quotes";
    expect(new MassiveProvider().capabilities().quotes).toBe(true);
  });
});

// ===========================================================================
// nanosToETMinuteKey
// ===========================================================================

describe("nanosToETMinuteKey", () => {
  it("converts nanoseconds to 'YYYY-MM-DD HH:MM' ET key for 9:30 AM ET bar (EST)", () => {
    // 2025-01-07 9:30 AM ET (EST, UTC-5) = UTC 14:30:00 = 1736260200000 ms
    const nanos = 1736260200000 * 1_000_000;
    expect(nanosToETMinuteKey(nanos)).toBe("2025-01-07 09:30");
  });

  it("converts nanoseconds to correct ET key for EDT (summer) time", () => {
    // 2024-07-10 9:30 AM ET (EDT, UTC-4) = UTC 13:30:00 = 1720618200000 ms
    const nanos = 1720618200000 * 1_000_000;
    expect(nanosToETMinuteKey(nanos)).toBe("2024-07-10 09:30");
  });
});

// ===========================================================================
// Quotes enrichment — MassiveProvider.fetchBars with bid/ask
// ===========================================================================

// Bar timestamp: 2025-01-07 9:30 AM ET = 1736253000000 ms
const OPTION_BAR_TS = 1736253000000;

function makeOptionBarsResponse(nextUrl?: string) {
  return {
    ticker: "O:SPX250107C05000000",
    queryCount: 1,
    resultsCount: 1,
    adjusted: false,
    results: [
      { v: 50, vw: 13.0, o: 12.8, c: 13.2, h: 13.5, l: 12.5, t: OPTION_BAR_TS, n: 10 },
    ],
    status: "OK",
    request_id: "req-bars-001",
    ...(nextUrl ? { next_url: nextUrl } : {}),
  };
}

function makeQuotesResponse(quotes: Array<{ bid: number; ask: number; nanos: number }>, nextUrl?: string) {
  return {
    status: "OK",
    request_id: "req-quotes-001",
    results: quotes.map(({ bid, ask, nanos }) => ({
      bid_price: bid,
      ask_price: ask,
      sip_timestamp: nanos,
      bid_size: 10,
      ask_size: 15,
      sequence_number: 1001,
    })),
    ...(nextUrl ? { next_url: nextUrl } : {}),
  };
}

describe("Quotes enrichment", () => {
  beforeEach(() => { process.env.MASSIVE_DATA_TIER = "quotes"; });
  afterEach(() => { delete process.env.MASSIVE_DATA_TIER; });

  it("fetchBars returns raw OHLCV bars without bid/ask enrichment", async () => {
    // fetchBars() returns raw OHLCV bars; bid/ask enrichment is handled
    // out-of-band by the pipeline-side enrich_quotes tool.
    fetchSpy
      .mockResolvedValueOnce(mockResponse(makeOptionBarsResponse()));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "minute",
      assetClass: "option",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
    // Only one fetch call — no quotes endpoint call from fetchBars
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bars without matching quotes retain undefined bid/ask", async () => {
    // Bar at 9:30 AM, quote at 9:31 AM — no match
    const differentNanos = (OPTION_BAR_TS + 60_000) * 1_000_000; // +1 minute

    fetchSpy
      .mockResolvedValueOnce(mockResponse(makeOptionBarsResponse()))
      .mockResolvedValueOnce(mockResponse(makeQuotesResponse([{ bid: 12.4, ask: 13.6, nanos: differentNanos }])));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "minute",
      assetClass: "option",
    });

    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });

  it("does NOT call quotes endpoint for option daily bars (timespan=day)", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ...makeOptionBarsResponse(),
      results: [{ v: 50, vw: 13.0, o: 12.8, c: 13.2, h: 13.5, l: 12.5, t: OPTION_BAR_TS, n: 10 }],
    }));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "day",
      assetClass: "option",
    });

    expect(rows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // bars only, no quotes call
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });

  it("does NOT call quotes endpoint for non-option assets (assetClass=index)", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(VALID_RESPONSE));

    const rows = await provider.fetchBars({
      ticker: "VIX",
      from: "2025-01-01",
      to: "2025-01-31",
      timespan: "minute",
      assetClass: "index",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // bars only, no quotes call
    expect(rows[0]?.bid).toBeUndefined();
    expect(rows[0]?.ask).toBeUndefined();
  });

  it("returns bars without bid/ask when quotes endpoint returns 403 (tier restriction)", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(makeOptionBarsResponse()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, statusText: "Forbidden", headers: { "Content-Type": "application/json" } }));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "minute",
      assetClass: "option",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });

  it("returns bars without bid/ask when quotes endpoint returns 429", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(makeOptionBarsResponse()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rate limited" }), { status: 429, statusText: "Too Many Requests", headers: { "Content-Type": "application/json" } }));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "minute",
      assetClass: "option",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });

  it("returns bars without bid/ask when quotes fetch throws a network error", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(makeOptionBarsResponse()))
      .mockRejectedValueOnce(new Error("Network error"));

    const rows = await provider.fetchBars({
      ticker: "SPX250107C05000000",
      from: "2025-01-07",
      to: "2025-01-07",
      timespan: "minute",
      assetClass: "option",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].bid).toBeUndefined();
    expect(rows[0].ask).toBeUndefined();
  });
});

// ===========================================================================
// MassiveProvider.fetchQuotes — tier-aware endpoint selection
// ===========================================================================

describe("MassiveProvider.fetchQuotes — tier-aware endpoint selection", () => {
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    process.env.MASSIVE_API_KEY = "test-key";
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    delete process.env.MASSIVE_API_KEY;
    delete process.env.MASSIVE_DATA_TIER;
    jest.restoreAllMocks();
  });

  it("uses /v3/quotes endpoint when MASSIVE_DATA_TIER=quotes and tags rows as nbbo", async () => {
    process.env.MASSIVE_DATA_TIER = "quotes";
    // 09:30 ET = 14:30 UTC = 1736260200000 ms; nanos = ms * 1_000_000
    const nanos = 1736260200000 * 1_000_000;
    fetchSpy.mockResolvedValue(mockResponse({
      status: "OK",
      request_id: "r1",
      results: [{ bid_price: 12.5, ask_price: 13.5, sip_timestamp: nanos, bid_size: 10, ask_size: 15, sequence_number: 1 }],
    }));

    const provider = new MassiveProvider();
    const quotes = await provider.fetchQuotes("SPX250107C05000000", "2025-01-07", "2025-01-07");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v3/quotes/");
    expect(url).toContain("O%3ASPX250107C05000000");

    const entry = quotes.get("2025-01-07 09:30");
    expect(entry).toBeDefined();
    expect(entry!.bid).toBe(12.5);
    expect(entry!.ask).toBe(13.5);
    expect(entry!.source).toBe("nbbo");
  });

  it("uses /v2/aggs minute-bars endpoint when MASSIVE_DATA_TIER is unset (Developer plan fallback)", async () => {
    delete process.env.MASSIVE_DATA_TIER;
    // 2025-01-07 09:30 ET = UTC 14:30 = 1736260200000 ms (EST/UTC-5).
    // See massive.test.ts:618 for the canonical timestamp reference.
    const barResponse = {
      ticker: "O:SPX250107C05000000",
      queryCount: 1,
      resultsCount: 1,
      adjusted: false,
      results: [{ v: 50, vw: 13.0, o: 12.8, c: 13.2, h: 13.5, l: 12.5, t: 1736260200000, n: 10 }],
      status: "OK",
      request_id: "req-aggs-001",
    };
    fetchSpy.mockResolvedValueOnce(mockResponse(barResponse));

    const provider = new MassiveProvider();
    const quotes = await provider.fetchQuotes("SPX250107C05000000", "2025-01-07", "2025-01-07");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v2/aggs/ticker/");
    expect(url).toContain("O%3ASPX250107C05000000");
    expect(url).toContain("/range/1/minute/2025-01-07/2025-01-07");

    // bid === ask === close, keyed by ET minute
    expect(quotes.size).toBe(1);
    const entry = quotes.get("2025-01-07 09:30");
    expect(entry).toBeDefined();
    expect(entry!.bid).toBe(13.2);
    expect(entry!.ask).toBe(13.2);
    expect(entry!.source).toBe("synth_close");
  });

  it("uses /v2/aggs minute-bars endpoint when MASSIVE_DATA_TIER=ohlc", async () => {
    process.env.MASSIVE_DATA_TIER = "ohlc";
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ticker: "O:SPX250107C05000000",
      queryCount: 0,
      resultsCount: 0,
      adjusted: false,
      results: [],
      status: "OK",
      request_id: "req-aggs-002",
    }));

    const provider = new MassiveProvider();
    await provider.fetchQuotes("SPX250107C05000000", "2025-01-07", "2025-01-07");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/v2/aggs/ticker/");
    expect(url).not.toContain("/v3/quotes/");
  });

  it("synthesizes bid=ask=close for every minute returned by /v2/aggs", async () => {
    delete process.env.MASSIVE_DATA_TIER;
    // 09:30 ET = 1736260200000, 09:31 ET = +60_000 ms.
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ticker: "O:SPX250107C05000000",
      queryCount: 1,
      resultsCount: 2,
      adjusted: false,
      results: [
        { v: 50, vw: 13.0, o: 12.8, c: 13.20, h: 13.5, l: 12.5, t: 1736260200000, n: 10 },
        { v: 60, vw: 13.4, o: 13.20, c: 13.50, h: 13.6, l: 13.1, t: 1736260260000, n: 12 },
      ],
      status: "OK",
      request_id: "req-aggs-003",
    }));

    const provider = new MassiveProvider();
    const quotes = await provider.fetchQuotes("SPX250107C05000000", "2025-01-07", "2025-01-07");

    expect(quotes.size).toBe(2);
    for (const [, q] of quotes) {
      expect(q.bid).toBe(q.ask);
      expect(q.source).toBe("synth_close");
    }
    expect(quotes.get("2025-01-07 09:30")!.bid).toBe(13.20);
    expect(quotes.get("2025-01-07 09:31")!.bid).toBe(13.50);
  });

  it("filters out bars outside RTH (09:30–16:00 ET)", async () => {
    delete process.env.MASSIVE_DATA_TIER;
    // 09:29 ET = 1736260140000 (in pre-market), 09:30 ET = 1736260200000 (in RTH),
    // 16:01 ET = 1736283660000 (after close).
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ticker: "O:SPX250107C05000000",
      queryCount: 1,
      resultsCount: 3,
      adjusted: false,
      results: [
        { v: 10, vw: 13.0, o: 12.8, c: 13.10, h: 13.2, l: 12.7, t: 1736260140000, n: 5 },
        { v: 50, vw: 13.0, o: 12.8, c: 13.20, h: 13.5, l: 12.5, t: 1736260200000, n: 10 },
        { v: 5,  vw: 13.0, o: 12.8, c: 13.30, h: 13.4, l: 12.9, t: 1736283660000, n: 3 },
      ],
      status: "OK",
      request_id: "req-aggs-004",
    }));

    const provider = new MassiveProvider();
    const quotes = await provider.fetchQuotes("SPX250107C05000000", "2025-01-07", "2025-01-07");

    expect(quotes.size).toBe(1);
    expect(quotes.has("2025-01-07 09:30")).toBe(true);
    expect(quotes.has("2025-01-07 09:29")).toBe(false);
    expect(quotes.has("2025-01-07 16:01")).toBe(false);
  });
});
