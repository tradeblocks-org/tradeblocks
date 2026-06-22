import { jest } from "@jest/globals";
import { ThetaDataProvider } from "../../../src/utils/providers/thetadata.ts";
import type {
  optionHistoryGreeksFirstOrder,
  optionHistoryGreeksFirstOrderBand,
  optionHistoryQuote,
  optionListContracts,
  ThetaContractListRow,
  ThetaFirstOrderGreekRow,
  ThetaMddsClient,
  ThetaQuoteRow,
} from "../../../src/utils/providers/thetadata/index.ts";

type QuoteEndpoint = typeof optionHistoryQuote;
type FirstOrderEndpoint = typeof optionHistoryGreeksFirstOrder;
type FirstOrderBandEndpoint = typeof optionHistoryGreeksFirstOrderBand;
type ContractListEndpoint = typeof optionListContracts;

interface ThetaProviderTestDeps {
  client?: ThetaMddsClient;
  quoteEndpoint?: QuoteEndpoint;
  firstOrderEndpoint?: FirstOrderEndpoint;
  firstOrderBandEndpoint?: FirstOrderBandEndpoint;
  contractListEndpoint?: ContractListEndpoint;
}

function createProvider(deps: ThetaProviderTestDeps): ThetaDataProvider {
  return new (ThetaDataProvider as unknown as {
    new (deps: ThetaProviderTestDeps): ThetaDataProvider;
  })(deps);
}

function createClient(): ThetaMddsClient {
  return {} as ThetaMddsClient;
}

function quoteRow(overrides: Partial<ThetaQuoteRow> = {}): ThetaQuoteRow {
  return {
    symbol: "SPXW",
    expiration: "2024-08-16",
    strike: 5725,
    right: "call",
    timestamp: "2024-08-05 09:30",
    bid: 12.1,
    ask: 12.4,
    ...overrides,
  };
}

function firstOrderRow(overrides: Partial<ThetaFirstOrderGreekRow> = {}): ThetaFirstOrderGreekRow {
  return {
    ...quoteRow(overrides),
    delta: 0.42,
    theta: -0.18,
    vega: 0.31,
    iv: 0.19,
    underlyingTimestamp: "2024-08-05 09:30",
    underlyingPrice: 5720,
    ...overrides,
  };
}

describe("ThetaDataProvider.fetchQuotes", () => {
  it("uses injected MDDS quote and first-order endpoints and preserves quote/greek provenance", async () => {
    const client = createClient();
    const quoteEndpoint = jest.fn<QuoteEndpoint>().mockResolvedValue([quoteRow()]);
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([firstOrderRow()]);
    const provider = createProvider({ client, quoteEndpoint, firstOrderEndpoint });

    const quotes = await provider.fetchQuotes("SPXW240816C05725000", "2024-08-05", "2024-08-05");

    expect(quoteEndpoint).toHaveBeenCalledWith(client, {
      symbol: "SPXW",
      expiration: "2024-08-16",
      strike: "5725.000",
      right: "call",
      date: "2024-08-05",
      interval: "1m",
    });
    expect(firstOrderEndpoint).toHaveBeenCalledWith(client, {
      symbol: "SPXW",
      expiration: "2024-08-16",
      strike: "5725.000",
      right: "call",
      date: "2024-08-05",
      interval: "1m",
      rateType: "sofr",
    });
    expect(quotes.get("2024-08-05 09:30")).toEqual({
      bid: 12.1,
      ask: 12.4,
      source: "nbbo",
      delta: 0.42,
      gamma: expect.any(Number),
      theta: -0.18,
      vega: 0.31,
      iv: 0.19,
      greeks_source: "thetadata",
      greeks_revision: 3,
      rate_type: "sofr",
      rate_value: expect.any(Number),
      gamma_source: "computed_sofr_q0",
    });
  });

  it("enumerates each date in the range as separate single-date MDDS requests", async () => {
    const quoteEndpoint = jest.fn<QuoteEndpoint>().mockResolvedValue([]);
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([]);
    const provider = createProvider({
      client: createClient(),
      quoteEndpoint,
      firstOrderEndpoint,
    });

    await provider.fetchQuotes("SPXW240816P05725000", "2024-08-05", "2024-08-07");

    expect(quoteEndpoint.mock.calls.map(([, params]) => params.date)).toEqual([
      "2024-08-05",
      "2024-08-06",
      "2024-08-07",
    ]);
    expect(firstOrderEndpoint.mock.calls.map(([, params]) => params.date)).toEqual([
      "2024-08-05",
      "2024-08-06",
      "2024-08-07",
    ]);
  });
});

describe("ThetaDataProvider.fetchBulkQuotes", () => {
  it("issues one wildcard-strike quote call per (root, expiration, right) and reports a per-group completion event", async () => {
    const client = createClient();
    const contractListEndpoint = jest.fn<ContractListEndpoint>(
      async (_client, params): Promise<ThetaContractListRow[]> => {
        if (params.symbol === "SPX") {
          return [
            { symbol: "SPX", expiration: "2024-08-16", strike: 5725, right: "call" },
            { symbol: "SPX", expiration: "2024-08-16", strike: 5730, right: "call" },
            { symbol: "SPX", expiration: "2024-08-23", strike: 5700, right: "put" },
          ];
        }
        return [
          { symbol: "SPXW", expiration: "2024-08-05", strike: 5725, right: "call" },
          { symbol: "SPXW", expiration: "2024-08-06", strike: 5700, right: "put" },
        ];
      },
    );
    const quoteEndpoint = jest.fn<QuoteEndpoint>(
      async (_client, params): Promise<ThetaQuoteRow[]> => {
        if (
          params.symbol !== "SPX" ||
          params.expiration !== "2024-08-16" ||
          params.right !== "call"
        ) {
          return [];
        }
        return [
          quoteRow({
            symbol: "SPX",
            expiration: "2024-08-16",
            strike: 5725,
            right: "call",
            timestamp: "2024-08-05 09:30",
          }),
          quoteRow({
            symbol: "SPX",
            expiration: "2024-08-16",
            strike: 5730,
            right: "call",
            timestamp: "2024-08-05 09:30",
          }),
        ];
      },
    );
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([]);
    const firstOrderBandEndpoint = jest.fn<FirstOrderBandEndpoint>().mockResolvedValue([]);
    const onGroupComplete = jest.fn(() => {
      throw new Error("hook errors must not escape");
    });
    const provider = createProvider({
      client,
      quoteEndpoint,
      firstOrderEndpoint,
      firstOrderBandEndpoint,
      contractListEndpoint,
    });

    const rows: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.fetchBulkQuotes({
          underlying: "SPX",
          date: "2024-08-05",
          onGroupComplete,
        })) {
          rows.push(...chunk);
        }
      })(),
    ).resolves.toBeUndefined();

    // One contract-list call per wire root; SPX expands to ["SPX", "SPXW"].
    expect(contractListEndpoint).toHaveBeenCalledTimes(2);
    expect(contractListEndpoint.mock.calls.map(([, params]) => params.symbol)).toEqual([
      "SPX",
      "SPXW",
    ]);
    // Quote calls use strike="*" — one per (root, expiration, right).
    expect(quoteEndpoint.mock.calls.every(([, params]) => params.strike === "*")).toBe(true);
    // ThetaData greeks endpoints are not used; greeks compute downstream via SOFR+q=0.
    expect(firstOrderEndpoint).not.toHaveBeenCalled();
    expect(firstOrderBandEndpoint).not.toHaveBeenCalled();
    // The two SPX/2024-08-16/call wildcard rows are emitted as a single chunk.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ticker: "SPX240816C05725000",
      bid: 12.1,
      ask: 12.4,
      greeks_source: null,
      source: "nbbo",
    });
    // One terminal completion per (root, right) group — 2 roots × 2 rights = 4 calls,
    // and reporter throws must not propagate out of the stream.
    expect(onGroupComplete).toHaveBeenCalledTimes(4);
    expect(
      onGroupComplete.mock.calls.map(([info]) => ({
        root: info.root,
        right: info.right,
        status: info.status,
        phase: info.phase,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ root: "SPX", right: "call", status: "ok", phase: "complete" }),
        expect.objectContaining({ root: "SPX", right: "put", status: "ok", phase: "complete" }),
        expect.objectContaining({ root: "SPXW", right: "call", status: "ok", phase: "complete" }),
        expect.objectContaining({ root: "SPXW", right: "put", status: "ok", phase: "complete" }),
      ]),
    );
  });

  it("emits checkpoint progress events for each completed expiration within a (root, right) group", async () => {
    const client = createClient();
    const contractListEndpoint = jest.fn<ContractListEndpoint>(
      async (): Promise<ThetaContractListRow[]> => [
        { symbol: "NDX", expiration: "2024-08-16", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-23", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-30", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-16", strike: 19000, right: "put" },
      ],
    );
    const quoteEndpoint = jest.fn<QuoteEndpoint>(
      async (_client, params): Promise<ThetaQuoteRow[]> => [
        quoteRow({
          symbol: "NDX",
          expiration: params.expiration,
          strike: 19000,
          right: params.right,
          timestamp: "2024-08-05 09:30",
        }),
      ],
    );
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([]);
    const firstOrderBandEndpoint = jest.fn<FirstOrderBandEndpoint>().mockResolvedValue([]);
    const onGroupComplete = jest.fn();
    const provider = createProvider({
      client,
      quoteEndpoint,
      firstOrderEndpoint,
      firstOrderBandEndpoint,
      contractListEndpoint,
    });

    const rows: unknown[] = [];
    for await (const chunk of provider.fetchBulkQuotes({
      underlying: "NDX",
      date: "2024-08-05",
      onGroupComplete,
    })) {
      rows.push(...chunk);
    }

    expect(rows).toHaveLength(4);
    // Calls dispatched in order: 3 NDX/call expirations, then 1 NDX/put expiration.
    const callEvents = onGroupComplete.mock.calls.map(([info]) => ({
      right: info.right,
      phase: info.phase,
      completedContracts: info.completedContracts,
      totalContracts: info.totalContracts,
    }));
    expect(callEvents).toEqual([
      { right: "call", phase: "checkpoint", completedContracts: 1, totalContracts: 3 },
      { right: "call", phase: "checkpoint", completedContracts: 2, totalContracts: 3 },
      { right: "call", phase: "complete", completedContracts: 3, totalContracts: 3 },
      { right: "put", phase: "complete", completedContracts: 1, totalContracts: 1 },
    ]);
  });

  it("treats provider NOT_FOUND on an expiration as a skip rather than aborting the whole bulk fetch", async () => {
    const client = createClient();
    const contractListEndpoint = jest.fn<ContractListEndpoint>(
      async (): Promise<ThetaContractListRow[]> => [
        { symbol: "NDX", expiration: "2024-08-16", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-23", strike: 19000, right: "call" },
      ],
    );
    const quoteEndpoint = jest.fn<QuoteEndpoint>(
      async (_client, params): Promise<ThetaQuoteRow[]> => {
        if (params.expiration === "2024-08-16") {
          throw new Error("NOT_FOUND: no quotes for this expiration");
        }
        return [
          quoteRow({
            symbol: "NDX",
            expiration: params.expiration,
            strike: 19000,
            right: params.right,
            timestamp: "2024-08-05 09:30",
          }),
        ];
      },
    );
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([]);
    const firstOrderBandEndpoint = jest.fn<FirstOrderBandEndpoint>().mockResolvedValue([]);
    const provider = createProvider({
      client,
      quoteEndpoint,
      firstOrderEndpoint,
      firstOrderBandEndpoint,
      contractListEndpoint,
    });

    const rows: unknown[] = [];
    for await (const chunk of provider.fetchBulkQuotes({
      underlying: "NDX",
      date: "2024-08-05",
    })) {
      rows.push(...chunk);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: "NDX240823C19000000" });
  });

  it("emits phase=complete when the final expiration in a (root, right) group NOT_FOUNDs", async () => {
    // Regression guard: the per-(root, right) loop previously took a
    // `continue` path on NOT_FOUND that bypassed the per-iteration
    // notifyGroupComplete call. When the FINAL expiration in a non-empty
    // group NOT_FOUNDed, MCP progress consumers never saw a phase="complete"
    // event for that group even though the bulk fetch completed normally.
    // The fix treats NOT_FOUND as an empty result and falls through to the
    // existing per-iteration notify; the final-iteration completion check
    // naturally upgrades the event to phase="complete".
    const client = createClient();
    const contractListEndpoint = jest.fn<ContractListEndpoint>(
      async (): Promise<ThetaContractListRow[]> => [
        { symbol: "NDX", expiration: "2024-08-16", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-23", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-30", strike: 19000, right: "call" },
        { symbol: "NDX", expiration: "2024-08-16", strike: 19000, right: "put" },
      ],
    );
    const quoteEndpoint = jest.fn<QuoteEndpoint>(
      async (_client, params): Promise<ThetaQuoteRow[]> => {
        if (params.strike !== "*") return [];
        // FINAL call expiration NOT_FOUNDs; earlier two succeed.
        if (params.right === "call" && params.expiration === "2024-08-30") {
          throw new Error("NOT_FOUND: No data found for the specified request");
        }
        return [
          quoteRow({
            symbol: "NDX",
            expiration: params.expiration,
            strike: 19000,
            right: params.right,
            timestamp: "2024-08-05 09:30",
          }),
        ];
      },
    );
    const firstOrderEndpoint = jest.fn<FirstOrderEndpoint>().mockResolvedValue([]);
    const firstOrderBandEndpoint = jest.fn<FirstOrderBandEndpoint>().mockResolvedValue([]);
    const onGroupComplete = jest.fn();
    const provider = createProvider({
      client,
      quoteEndpoint,
      firstOrderEndpoint,
      firstOrderBandEndpoint,
      contractListEndpoint,
    });

    const rows: unknown[] = [];
    for await (const chunk of provider.fetchBulkQuotes({
      underlying: "NDX",
      date: "2024-08-05",
      onGroupComplete,
    })) {
      rows.push(...chunk);
    }

    // 2 successful call expirations + 1 put = 3 rows; the NOT_FOUND
    // expiration contributes none.
    expect(rows).toHaveLength(3);

    // The load-bearing assertion: the NDX/call group emits THREE events
    // — two checkpoints for the successful expirations, then a complete
    // for the final NOT_FOUND iteration. Pre-fix this group only emitted
    // two checkpoints; the complete was dropped.
    const callEvents = onGroupComplete.mock.calls
      .map(([info]) => info)
      .filter((info) => info.root === "NDX" && info.right === "call");
    expect(callEvents).toHaveLength(3);
    expect(callEvents[0]).toMatchObject({
      phase: "checkpoint",
      completedContracts: 1,
      totalContracts: 3,
    });
    expect(callEvents[1]).toMatchObject({
      phase: "checkpoint",
      completedContracts: 2,
      totalContracts: 3,
    });
    expect(callEvents[2]).toMatchObject({
      phase: "complete",
      completedContracts: 3,
      totalContracts: 3,
    });

    const putEvents = onGroupComplete.mock.calls
      .map(([info]) => info)
      .filter((info) => info.root === "NDX" && info.right === "put");
    expect(putEvents).toHaveLength(1);
    expect(putEvents[0]).toMatchObject({
      phase: "complete",
      completedContracts: 1,
      totalContracts: 1,
    });
  });
});

describe("ThetaDataProvider.fetchContractList", () => {
  it("maps MDDS contract rows to references, filters expirations, and expands SPX roots", async () => {
    const client = createClient();
    const contractListEndpoint = jest.fn<ContractListEndpoint>(
      async (_client, params): Promise<ThetaContractListRow[]> => {
        if (params.symbol === "SPX") {
          return [
            { symbol: "SPX", expiration: "2024-08-16", strike: 5725, right: "call" },
            { symbol: "SPX", expiration: "2024-09-20", strike: 5800, right: "put" },
          ];
        }
        return [
          { symbol: "SPXW", expiration: "2024-08-05", strike: 5700, right: "put" },
          { symbol: "SPXW", expiration: "2024-08-23", strike: 5750, right: "call" },
        ];
      },
    );
    const provider = createProvider({ client, contractListEndpoint });

    const result = await provider.fetchContractList({
      underlying: "SPX",
      as_of: "2024-08-05",
      expired: true,
      expiration_date_gte: "2024-08-10",
      expiration_date_lte: "2024-08-31",
    });

    expect(contractListEndpoint).toHaveBeenCalledTimes(2);
    expect(contractListEndpoint.mock.calls.map(([, params]) => params)).toEqual([
      { symbol: "SPX", date: "2024-08-05", requestType: "quote" },
      { symbol: "SPXW", date: "2024-08-05", requestType: "quote" },
    ]);
    expect(result).toEqual({
      underlying: "SPX",
      contracts: [
        {
          ticker: "SPX240816C05725000",
          contract_type: "call",
          strike: 5725,
          expiration: "2024-08-16",
          exercise_style: "european",
        },
        {
          ticker: "SPXW240823C05750000",
          contract_type: "call",
          strike: 5750,
          expiration: "2024-08-23",
          exercise_style: "european",
        },
      ],
    });
  });
});

describe("ThetaDataProvider unsupported legacy surfaces", () => {
  // fetchBars is now implemented via index/stock history endpoints — see
  // fetchBars.test.ts for positive coverage.

  it("fails clearly for fetchOptionSnapshot until MDDS snapshot endpoints are implemented", async () => {
    const provider = createProvider({});

    await expect(
      provider.fetchOptionSnapshot({
        underlying: "SPX",
      }),
    ).rejects.toThrow("ThetaData MDDS provider does not implement fetchOptionSnapshot yet");
  });
});
