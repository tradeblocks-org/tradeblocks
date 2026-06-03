import { buildOccTicker } from "../trade-replay.ts";
import {
  ThetaMddsClient,
  indexHistoryEod,
  indexHistoryOhlc,
  joinThetaQuotesAndFirstOrderGreeks,
  optionHistoryGreeksFirstOrder,
  optionHistoryGreeksFirstOrderBand,
  optionHistoryOpenInterest,
  optionHistoryQuote,
  optionListContracts,
  stockHistoryEod,
  stockHistoryOhlc,
  type ThetaContractListRow,
  type ThetaFirstOrderGreekRow,
  type ThetaOpenInterestRow,
  type ThetaQuoteRow,
  type ThetaRight,
  type ThetaStockEodRow,
  type ThetaStockOhlcRow,
} from "./thetadata/index.ts";
import type {
  BarRow,
  BulkOpenInterestOptions,
  BulkQuoteRow,
  BulkQuotesOptions,
  ContractReference,
  FetchBarsOptions,
  FetchContractListOptions,
  FetchContractListResult,
  FetchSnapshotOptions,
  FetchSnapshotResult,
  MarketDataProvider,
  MinuteQuote,
  OpenInterestRow,
  ProviderCapabilities,
} from "../market-provider.ts";

const BULK_YIELD_CHUNK = 50_000;
const BULK_GREEKS_STRIKE_RANGE = 20;

export interface ThetaProviderDeps {
  client?: ThetaMddsClient;
  quoteEndpoint?: typeof optionHistoryQuote;
  firstOrderEndpoint?: typeof optionHistoryGreeksFirstOrder;
  firstOrderBandEndpoint?: typeof optionHistoryGreeksFirstOrderBand;
  contractListEndpoint?: typeof optionListContracts;
  openInterestEndpoint?: typeof optionHistoryOpenInterest;
  stockHistoryOhlc?: typeof stockHistoryOhlc;
  stockHistoryEod?: typeof stockHistoryEod;
  indexHistoryOhlc?: typeof indexHistoryOhlc;
  indexHistoryEod?: typeof indexHistoryEod;
}

type GreekBandCache = Map<string, Promise<ThetaFirstOrderGreekRow[]>>;

interface ParsedOccTicker {
  root: string;
  expiration: string;
  right: ThetaRight;
  strike: number;
}

function parseOccTicker(ticker: string): ParsedOccTicker {
  const match = ticker.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})(C|P)(\d{8})$/);
  if (!match) {
    throw new Error(`Invalid OCC option ticker: ${ticker}`);
  }

  return {
    root: match[1],
    expiration: `20${match[2]}-${match[3]}-${match[4]}`,
    right: match[5] === "C" ? "call" : "put",
    strike: Number.parseInt(match[6], 10) / 1000,
  };
}

function formatStrike(strike: number): string {
  return strike.toFixed(3);
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function formatIsoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function enumerateDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = parseIsoDate(from);
  const end = parseIsoDate(to);
  while (cursor <= end) {
    dates.push(formatIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function timespanToThetaInterval(
  timespan: FetchBarsOptions["timespan"],
  multiplier: number | undefined,
): string | null {
  if (timespan === "day") return null;
  const resolvedMultiplier = multiplier ?? 1;
  if (!Number.isInteger(resolvedMultiplier) || resolvedMultiplier <= 0) {
    throw new Error("ThetaData fetchBars multiplier must be a positive integer");
  }
  if (timespan === "hour") return `${resolvedMultiplier * 60}m`;
  return `${resolvedMultiplier}m`;
}

function msOfDayToEtMinute(msOfDay: number): string {
  if (!Number.isFinite(msOfDay) || msOfDay < 0) {
    throw new Error(`ThetaData stock OHLC row invalid ms_of_day: ${String(msOfDay)}`);
  }
  const totalMinutes = Math.floor(msOfDay / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 23 || (hours === 23 && minutes > 59)) {
    throw new Error(`ThetaData stock OHLC row invalid ms_of_day: ${String(msOfDay)}`);
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function stockEodRowToBar(ticker: string, row: ThetaStockEodRow): BarRow {
  return {
    ticker,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? 0,
  };
}

function stockOhlcRowToBar(ticker: string, row: ThetaStockOhlcRow): BarRow {
  return {
    ...stockEodRowToBar(ticker, row),
    time: msOfDayToEtMinute(row.msOfDay),
  };
}

/**
 * Wire-level roots that bulk quote ingestion expands an underlying into. SPX has
 * monthly (`SPX`) and weekly/daily (`SPXW`) option roots in ThetaData.
 */
export function bulkQuoteRootsForUnderlying(underlying: string): string[] {
  const upper = underlying.toUpperCase();
  return upper === "SPX" ? ["SPX", "SPXW"] : [upper];
}

/**
 * Number of final root/right groups per date. Providers may emit additional
 * checkpoint events while processing those groups.
 */
export function countBulkQuoteGroupsPerDate(underlying: string): number {
  return bulkQuoteRootsForUnderlying(underlying).length * 2;
}

function inferExerciseStyle(symbol: string): "american" | "european" {
  const europeanRoots = new Set([
    "SPX",
    "SPXW",
    "XSP",
    "NDX",
    "NDXP",
    "RUT",
    "RUTW",
    "VIX",
    "VIX9D",
    "DJX",
  ]);
  return europeanRoots.has(symbol.toUpperCase()) ? "european" : "american";
}

function isGreekForBulkContract(
  row: ThetaFirstOrderGreekRow,
  root: string,
  right: ThetaRight,
  contract: ThetaContractListRow,
): boolean {
  return row.symbol.toUpperCase() === root.toUpperCase()
    && row.expiration === contract.expiration
    && formatStrike(row.strike) === formatStrike(contract.strike)
    && row.right === right;
}

function toMinuteQuote(row: BulkQuoteRow & { greeks_revision?: number | null }): MinuteQuote {
  return {
    bid: row.bid,
    ask: row.ask,
    source: "nbbo",
    delta: row.delta ?? null,
    gamma: row.gamma ?? null,
    theta: row.theta ?? null,
    vega: row.vega ?? null,
    iv: row.iv ?? null,
    greeks_source: row.greeks_source ?? null,
    greeks_revision: row.greeks_revision ?? null,
    rate_type: row.rate_type ?? null,
    rate_value: row.rate_value ?? null,
    gamma_source: row.gamma_source ?? null,
  };
}

function occTickerFromQuote(row: ThetaQuoteRow): string {
  const rightChar = row.right === "call" ? "C" : "P";
  return buildOccTicker(row.symbol, row.expiration, rightChar, row.strike);
}

function contractReference(row: ThetaContractListRow): ContractReference {
  const rightChar = row.right === "call" ? "C" : "P";
  return {
    ticker: buildOccTicker(row.symbol, row.expiration, rightChar, row.strike),
    contract_type: row.right,
    strike: row.strike,
    expiration: row.expiration,
    exercise_style: inferExerciseStyle(row.symbol),
  };
}

export class ThetaDataProvider implements MarketDataProvider {
  readonly name = "thetadata";
  private readonly client: ThetaMddsClient;
  private readonly quoteEndpoint: typeof optionHistoryQuote;
  private readonly firstOrderEndpoint: typeof optionHistoryGreeksFirstOrder;
  private readonly firstOrderBandEndpoint: typeof optionHistoryGreeksFirstOrderBand;
  private readonly contractListEndpoint: typeof optionListContracts;
  private readonly openInterestEndpoint: typeof optionHistoryOpenInterest;
  private readonly stockHistoryOhlcEndpoint: typeof stockHistoryOhlc;
  private readonly stockHistoryEodEndpoint: typeof stockHistoryEod;
  private readonly indexHistoryOhlcEndpoint: typeof indexHistoryOhlc;
  private readonly indexHistoryEodEndpoint: typeof indexHistoryEod;

  constructor(deps: ThetaProviderDeps = {}) {
    this.client = deps.client ?? new ThetaMddsClient();
    this.quoteEndpoint = deps.quoteEndpoint ?? optionHistoryQuote;
    this.firstOrderEndpoint = deps.firstOrderEndpoint ?? optionHistoryGreeksFirstOrder;
    this.firstOrderBandEndpoint = deps.firstOrderBandEndpoint ?? optionHistoryGreeksFirstOrderBand;
    this.contractListEndpoint = deps.contractListEndpoint ?? optionListContracts;
    this.openInterestEndpoint = deps.openInterestEndpoint ?? optionHistoryOpenInterest;
    this.stockHistoryOhlcEndpoint = deps.stockHistoryOhlc ?? stockHistoryOhlc;
    this.stockHistoryEodEndpoint = deps.stockHistoryEod ?? stockHistoryEod;
    this.indexHistoryOhlcEndpoint = deps.indexHistoryOhlc ?? indexHistoryOhlc;
    this.indexHistoryEodEndpoint = deps.indexHistoryEod ?? indexHistoryEod;
  }

  capabilities(): ProviderCapabilities {
    return {
      tradeBars: true,
      quotes: true,
      greeks: true,
      flatFiles: false,
      bulkByRoot: true,
      perTicker: false,
      minuteBars: true,
      dailyBars: true,
    };
  }

  async fetchBars(options: FetchBarsOptions): Promise<BarRow[]> {
    await this.client.connect?.();

    const ticker = options.ticker;
    const symbol = ticker.trim().toUpperCase();
    const timespan = options.timespan;
    const interval = timespanToThetaInterval(timespan, options.multiplier);
    const isIndex = options.assetClass === "index";
    const eodEndpoint = isIndex ? this.indexHistoryEodEndpoint : this.stockHistoryEodEndpoint;
    const ohlcEndpoint = isIndex ? this.indexHistoryOhlcEndpoint : this.stockHistoryOhlcEndpoint;

    if (interval == null) {
      const rows = await eodEndpoint(this.client, {
        symbol,
        startDate: options.from,
        endDate: options.to,
      });
      return rows.map((row) => stockEodRowToBar(ticker, row));
    }

    const bars: BarRow[] = [];
    for (const date of enumerateDates(options.from, options.to)) {
      const rows = await ohlcEndpoint(this.client, {
        symbol,
        startDate: date,
        endDate: date,
        interval,
      });
      bars.push(...rows.map((row) => stockOhlcRowToBar(ticker, row)));
    }
    return bars;
  }

  async fetchQuotes(ticker: string, from: string, to: string): Promise<Map<string, MinuteQuote>> {
    await this.client.connect?.();
    const occ = parseOccTicker(ticker);
    const result = new Map<string, MinuteQuote>();

    for (const date of enumerateDates(from, to)) {
      const request = {
        symbol: occ.root,
        expiration: occ.expiration,
        strike: formatStrike(occ.strike),
        right: occ.right,
        date,
        interval: "1m",
      } as const;
      const [quotes, providerGreeks] = await Promise.all([
        this.quoteEndpoint(this.client, request),
        this.firstOrderEndpoint(this.client, { ...request, rateType: "sofr" }),
      ]);
      const joined = joinThetaQuotesAndFirstOrderGreeks({ quotes, providerGreeks });
      for (const row of joined.rows) {
        result.set(row.timestamp, toMinuteQuote(row));
      }
    }

    return result;
  }

  async *fetchBulkQuotes(options: BulkQuotesOptions): AsyncGenerator<BulkQuoteRow[], void, void> {
    // Wildcard fetch path: instead of one quote request per contract (which on
    // a dense post-2024 SPX chain is 5000+ sequential gRPC calls), issue one
    // `strike="*"` request per (root, expiration, right). That collapses the
    // wall time from ~hours to ~minutes per date. Greeks are not fetched from
    // ThetaData here — downstream applyQuoteGreeks computes them inline under
    // the SOFR+q=0 convention (see option-quote-greeks.ts).
    await this.client.connect?.();
    const roots = bulkQuoteRootsForUnderlying(options.underlying);
    const rights: ThetaRight[] = ["call", "put"];
    let chunk: BulkQuoteRow[] = [];

    const flush = function* (): Generator<BulkQuoteRow[], void, void> {
      if (chunk.length === 0) return;
      const ready = chunk;
      chunk = [];
      yield ready;
    };

    for (const root of roots) {
      const contracts = await this.contractListEndpoint(this.client, {
        symbol: root,
        date: options.date,
        requestType: "quote",
      });
      // Expirations present in the chain for this root, sorted for determinism.
      const expirationsByRight = new Map<ThetaRight, string[]>();
      for (const right of rights) {
        const expirations = new Set<string>();
        for (const c of contracts) {
          if (c.right === right) expirations.add(c.expiration);
        }
        expirationsByRight.set(right, [...expirations].sort());
      }

      for (const right of rights) {
        const expirations = expirationsByRight.get(right) ?? [];
        let completedExpirations = 0;

        try {
          for (const expiration of expirations) {
            let quotes: ThetaQuoteRow[];
            try {
              quotes = await this.quoteEndpoint(this.client, {
                symbol: root,
                expiration,
                strike: "*",
                right,
                date: options.date,
                interval: "1m",
              });
            } catch (error) {
              // ThetaData returns NOT_FOUND for (root, expiration, right)
              // combos that have no quotes on this date (e.g., zero-volume
              // expirations near the current month boundary). Treat as an
              // empty result and fall through to the per-iteration notify
              // so the final expiration in a group still emits a
              // phase="complete" event when it NOT_FOUNDs.
              const msg = error instanceof Error ? error.message : String(error);
              if (!/NOT_FOUND|No data found/i.test(msg)) {
                throw error;
              }
              quotes = [];
            }
            for (const q of quotes) {
              // Drop rows missing bid or ask; the parquet schema is DOUBLE
              // NOT NULL on the price columns, and downstream applyQuoteGreeks
              // skips them anyway. Some (root, expiration, right) tuples
              // include zero-volume strikes that come back null/NaN.
              if (!Number.isFinite(q.bid as number) || !Number.isFinite(q.ask as number)) {
                continue;
              }
              chunk.push({
                ticker: occTickerFromQuote(q),
                timestamp: q.timestamp,
                bid: q.bid,
                ask: q.ask,
                delta: null,
                gamma: null,
                theta: null,
                vega: null,
                iv: null,
                greeks_source: null,
                rate_type: null,
                rate_value: null,
                gamma_source: null,
                source: "nbbo",
              } as BulkQuoteRow);
              if (chunk.length >= BULK_YIELD_CHUNK) {
                yield* flush();
              }
            }
            completedExpirations += 1;
            this.notifyGroupComplete(options, root, right, "ok", {
              phase: completedExpirations >= expirations.length ? "complete" : "checkpoint",
              completedContracts: completedExpirations,
              totalContracts: expirations.length,
            });
          }

          if (expirations.length === 0) {
            this.notifyGroupComplete(options, root, right, "ok", {
              phase: "complete",
              completedContracts: 0,
              totalContracts: 0,
            });
          }
          yield* flush();
        } catch (error) {
          this.notifyGroupComplete(options, root, right, "error", { phase: "complete" });
          throw error;
        }
      }
    }

    yield* flush();
  }

  async fetchContractList(options: FetchContractListOptions): Promise<FetchContractListResult> {
    await this.client.connect?.();
    const underlying = options.underlying.toUpperCase();
    const contracts: ContractReference[] = [];

    for (const root of bulkQuoteRootsForUnderlying(underlying)) {
      const rows = await this.contractListEndpoint(this.client, {
        symbol: root,
        date: options.as_of,
        requestType: "quote",
      });
      for (const row of rows) {
        if (options.expiration_date_gte && row.expiration < options.expiration_date_gte) continue;
        if (options.expiration_date_lte && row.expiration > options.expiration_date_lte) continue;
        contracts.push(contractReference(row));
      }
    }

    contracts.sort((left, right) => left.ticker.localeCompare(right.ticker));
    return { contracts, underlying };
  }

  async fetchOpenInterest(options: BulkOpenInterestOptions): Promise<OpenInterestRow[]> {
    await this.client.connect?.();
    const underlying = options.underlying.toUpperCase();
    const rows: OpenInterestRow[] = [];

    for (const root of bulkQuoteRootsForUnderlying(underlying)) {
      // One wildcard-expiration, wildcard-strike, both-rights stream per root
      // returns every contract's daily open interest across the range.
      let oiRows: ThetaOpenInterestRow[];
      try {
        oiRows = await this.openInterestEndpoint(this.client, {
          symbol: root,
          expiration: "*",
          startDate: options.from,
          endDate: options.to,
        });
      } catch (error) {
        // NOT_FOUND for a root with no contracts in the range is benign — fall
        // through to the next root rather than failing the whole fetch.
        const msg = error instanceof Error ? error.message : String(error);
        if (!/NOT_FOUND|No data found/i.test(msg)) throw error;
        oiRows = [];
      }
      for (const r of oiRows) {
        rows.push({
          ticker: r.ticker,
          underlying,
          date: r.date,
          expiration: r.expiration,
          strike: r.strike,
          right: r.right,
          open_interest: r.openInterest,
        });
      }
    }

    return rows;
  }

  async fetchOptionSnapshot(_options: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
    throw new Error("ThetaData MDDS provider does not implement fetchOptionSnapshot yet");
  }

  private async fetchBulkContractRows(
    root: string,
    right: ThetaRight,
    date: string,
    contract: ThetaContractListRow,
    greekBandCache: GreekBandCache,
  ): Promise<BulkQuoteRow[]> {
    // Quote history remains concrete per contract. First-order greeks are
    // fetched as one strike band per expiration/day and reused across rights.
    const request = {
      symbol: root,
      expiration: contract.expiration,
      strike: formatStrike(contract.strike),
      right,
      date,
      interval: "1m",
    } as const;
    const [quotes, bandGreeks]: [ThetaQuoteRow[], ThetaFirstOrderGreekRow[]] =
      await Promise.all([
        this.quoteEndpoint(this.client, request),
        this.fetchBulkGreekBand(root, contract.expiration, date, greekBandCache),
      ]);
    const contractBandGreeks = bandGreeks.filter((row) =>
      isGreekForBulkContract(row, root, right, contract)
    );
    const bandJoined = joinThetaQuotesAndFirstOrderGreeks({
      quotes,
      providerGreeks: contractBandGreeks,
    });
    if (quotes.length === 0 || bandJoined.stats.missingGreekRows === 0) {
      return bandJoined.rows;
    }

    const contractGreeks = await this.firstOrderEndpoint(this.client, {
      ...request,
      rateType: "sofr",
    });
    return joinThetaQuotesAndFirstOrderGreeks({
      quotes,
      providerGreeks: [...contractBandGreeks, ...contractGreeks],
    }).rows;
  }

  private fetchBulkGreekBand(
    root: string,
    expiration: string,
    date: string,
    greekBandCache: GreekBandCache,
  ): Promise<ThetaFirstOrderGreekRow[]> {
    const key = `${root}|${expiration}|${date}`;
    let promise = greekBandCache.get(key);
    if (!promise) {
      promise = this.firstOrderBandEndpoint(this.client, {
        symbol: root,
        expiration,
        date,
        interval: "1m",
        rateType: "sofr",
        strikeRange: BULK_GREEKS_STRIKE_RANGE,
      });
      greekBandCache.set(key, promise);
    }
    return promise;
  }

  private notifyGroupComplete(
    options: BulkQuotesOptions,
    root: string,
    right: ThetaRight,
    status: "ok" | "error",
    progress: {
      phase?: "checkpoint" | "complete";
      completedContracts?: number;
      totalContracts?: number;
    } = {},
  ): void {
    if (!options.onGroupComplete) return;
    try {
      options.onGroupComplete({ root, right, date: options.date, status, ...progress });
    } catch {
      // Progress hooks are best-effort; provider data flow owns the error path.
    }
  }
}
