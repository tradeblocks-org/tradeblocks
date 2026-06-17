import { describe, expect, it, jest } from "@jest/globals";
import { ThetaDataProvider } from "../../../../src/utils/providers/thetadata.ts";
import type { ThetaMddsClient } from "../../../../src/utils/providers/thetadata/index.ts";

interface StockOhlcRow {
  date: string;
  msOfDay: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

interface StockEodRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

type StockOhlcEndpoint = (
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
    interval: string;
    startTime?: string;
    endTime?: string;
  },
) => Promise<StockOhlcRow[]>;

type StockEodEndpoint = (
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
  },
) => Promise<StockEodRow[]>;

interface ThetaProviderFetchBarsTestDeps {
  client?: ThetaMddsClient;
  stockHistoryOhlc?: StockOhlcEndpoint;
  stockHistoryEod?: StockEodEndpoint;
  indexHistoryOhlc?: StockOhlcEndpoint;
  indexHistoryEod?: StockEodEndpoint;
}

function createProvider(deps: ThetaProviderFetchBarsTestDeps): ThetaDataProvider {
  return new (ThetaDataProvider as unknown as {
    new(deps: ThetaProviderFetchBarsTestDeps): ThetaDataProvider;
  })(deps);
}

function createClient(): ThetaMddsClient {
  return {} as ThetaMddsClient;
}

describe("ThetaDataProvider.fetchBars", () => {
  it("uses indexHistoryEod for daily index bars and maps rows to BarRow", async () => {
    const client = createClient();
    const indexHistoryEod = jest.fn<StockEodEndpoint>().mockResolvedValue([{
      date: "2026-04-28",
      open: 5500.25,
      high: 5531.5,
      low: 5488,
      close: 5512.75,
      volume: 12345,
    }]);
    const stockHistoryEod = jest.fn<StockEodEndpoint>().mockResolvedValue([]);
    const stockHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([]);
    const provider = createProvider({
      client,
      stockHistoryEod,
      stockHistoryOhlc,
      indexHistoryEod,
      indexHistoryOhlc: jest.fn<StockOhlcEndpoint>().mockResolvedValue([]),
    });

    await expect(provider.fetchBars({
      ticker: "SPX",
      from: "2026-04-28",
      to: "2026-04-29",
      timespan: "day",
      assetClass: "index",
    })).resolves.toEqual([{
      ticker: "SPX",
      date: "2026-04-28",
      open: 5500.25,
      high: 5531.5,
      low: 5488,
      close: 5512.75,
      volume: 12345,
    }]);
    expect(indexHistoryEod).toHaveBeenCalledWith(client, {
      symbol: "SPX",
      startDate: "2026-04-28",
      endDate: "2026-04-29",
    });
    expect(stockHistoryEod).not.toHaveBeenCalled();
    expect(stockHistoryOhlc).not.toHaveBeenCalled();
  });

  it("uses indexHistoryOhlc with 1m interval for minute index bars", async () => {
    const client = createClient();
    const indexHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([{
      date: "2026-04-28",
      msOfDay: 34_200_000,
      open: 5501,
      high: 5502,
      low: 5500.5,
      close: 5501.25,
      volume: 100,
    }]);
    const stockHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([]);
    const stockHistoryEod = jest.fn<StockEodEndpoint>().mockResolvedValue([]);
    const provider = createProvider({
      client,
      stockHistoryOhlc,
      stockHistoryEod,
      indexHistoryOhlc,
      indexHistoryEod: jest.fn<StockEodEndpoint>().mockResolvedValue([]),
    });

    await expect(provider.fetchBars({
      ticker: "SPX",
      from: "2026-04-28",
      to: "2026-04-28",
      timespan: "minute",
      assetClass: "index",
    })).resolves.toEqual([{
      ticker: "SPX",
      date: "2026-04-28",
      time: "09:30",
      open: 5501,
      high: 5502,
      low: 5500.5,
      close: 5501.25,
      volume: 100,
    }]);
    expect(indexHistoryOhlc).toHaveBeenCalledWith(client, {
      symbol: "SPX",
      startDate: "2026-04-28",
      endDate: "2026-04-28",
      interval: "1m",
    });
    expect(stockHistoryOhlc).not.toHaveBeenCalled();
    expect(stockHistoryEod).not.toHaveBeenCalled();
  });

  it("uses indexHistoryOhlc with 60m interval for hourly index bars", async () => {
    const client = createClient();
    const indexHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([{
      date: "2026-04-28",
      msOfDay: 36_000_000,
      open: 5501,
      high: 5510,
      low: 5499,
      close: 5508,
      volume: 10,
    }]);
    const provider = createProvider({
      client,
      stockHistoryOhlc: jest.fn<StockOhlcEndpoint>().mockResolvedValue([]),
      indexHistoryOhlc,
      stockHistoryEod: jest.fn<StockEodEndpoint>().mockResolvedValue([]),
      indexHistoryEod: jest.fn<StockEodEndpoint>().mockResolvedValue([]),
    });

    await provider.fetchBars({
      ticker: "SPX",
      from: "2026-04-28",
      to: "2026-04-28",
      timespan: "hour",
      assetClass: "index",
    });

    expect(indexHistoryOhlc).toHaveBeenCalledWith(client, {
      symbol: "SPX",
      startDate: "2026-04-28",
      endDate: "2026-04-28",
      interval: "60m",
    });
  });

  it("uses stockHistoryOhlc for stock bars", async () => {
    const client = createClient();
    const stockHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([{
      date: "2026-05-13",
      msOfDay: 34_200_000,
      open: 520,
      high: 521,
      low: 519.5,
      close: 520.5,
      volume: 12_345,
    }]);
    const indexHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([]);
    const provider = createProvider({
      client,
      stockHistoryOhlc,
      stockHistoryEod: jest.fn<StockEodEndpoint>().mockResolvedValue([]),
      indexHistoryOhlc,
      indexHistoryEod: jest.fn<StockEodEndpoint>().mockResolvedValue([]),
    });

    await provider.fetchBars({
      ticker: "QQQ",
      from: "2026-05-13",
      to: "2026-05-13",
      timespan: "minute",
      assetClass: "stock",
    });

    expect(stockHistoryOhlc).toHaveBeenCalledWith(client, {
      symbol: "QQQ",
      startDate: "2026-05-13",
      endDate: "2026-05-13",
      interval: "1m",
    });
    expect(indexHistoryOhlc).not.toHaveBeenCalled();
  });

  it("defaults missing volume to zero for daily and intraday rows", async () => {
    const client = createClient();
    const stockHistoryEod = jest.fn<StockEodEndpoint>().mockResolvedValue([{
      date: "2026-04-28",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: null,
    }]);
    const stockHistoryOhlc = jest.fn<StockOhlcEndpoint>().mockResolvedValue([{
      date: "2026-04-28",
      msOfDay: 57_600_000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: null,
    }]);
    const provider = createProvider({
      client,
      stockHistoryEod,
      stockHistoryOhlc,
      indexHistoryEod: stockHistoryEod,
      indexHistoryOhlc: stockHistoryOhlc,
    });

    await expect(provider.fetchBars({
      ticker: "VIX",
      from: "2026-04-28",
      to: "2026-04-28",
      timespan: "day",
      assetClass: "index",
    })).resolves.toEqual([{
      ticker: "VIX",
      date: "2026-04-28",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 0,
    }]);

    await expect(provider.fetchBars({
      ticker: "VIX",
      from: "2026-04-28",
      to: "2026-04-28",
      timespan: "minute",
      assetClass: "index",
    })).resolves.toMatchObject([{
      ticker: "VIX",
      date: "2026-04-28",
      time: "16:00",
      volume: 0,
    }]);
  });
});
