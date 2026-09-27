import { drawdownEpisodesFromEquity } from "./marked-equity.ts";

export interface ReplayLeg {
  /** Contract expiry as YYYYMMDD (OO) or YYYY-MM-DD (market provider). */
  expiration: string;
  strike: number;
  optionType: "Call" | "Put";
  buySell: "Buy" | "Sell";
  numberOfContracts: number;
  /** Dollars per contract, already multiplied by 100 in the OO trade log. */
  pricePerContract: number;
}

export interface ReplayTrade {
  dateOpened: string;
  dateClosed: string;
  underlying: string;
  strategyId: string;
  strategyName: string;
  legs: readonly ReplayLeg[];
  openingFees: number;
  profit: number;
  isIgnored?: boolean;
}

export interface ReplayQuote {
  bid: number;
  ask: number;
}
export type ReplayQuoteLookup = (
  date: string,
  ticker: string,
  markTime: string,
) => ReplayQuote | undefined;
export type ReplayQuoteObservation =
  | { date: string; ticker: string; bid: number; ask: number; mid: number }
  | { date: string; ticker: string; missing: true };

export interface ReplayMethodParameters {
  mark_time: string;
  opening_fee_factor: number;
  tolerance_fraction: number;
  root_resolution: "spxw-spx/v1";
  root_precedence: readonly ["SPXW", "SPX"];
}
export type ReplayMethodOverrides = Partial<
  Pick<ReplayMethodParameters, "mark_time" | "opening_fee_factor" | "tolerance_fraction">
>;

export const DEFAULT_REPLAY_METHOD_PARAMETERS: ReplayMethodParameters = {
  mark_time: "15:59",
  opening_fee_factor: 2,
  tolerance_fraction: 0.0005,
  root_resolution: "spxw-spx/v1",
  root_precedence: ["SPXW", "SPX"],
};

export interface ReplayMark {
  value: number | null;
  missing_tickers: string[];
  observations: ReplayQuoteObservation[];
}

export interface ReplayContribution {
  strategy_id: string;
  strategy_name: string;
  ignored: boolean;
  amount: number;
}

export type ReplayUnavailableReason =
  | { code: "missing_quote"; tickers: string[] }
  | { code: "missing_prior_mark" }
  | { code: "over_tolerance"; residual: number };

export interface ReplayDaily {
  date: string;
  oo_change: number;
  contributions: ReplayContribution[] | null;
  residual: number | null;
  status: "available" | "unavailable";
  reason?: ReplayUnavailableReason;
}

export interface ReplayStrategyTotal {
  strategy_id: string;
  strategy_name: string;
  ignored: boolean;
  total: number;
  drawdown: { amount: number; peak_date: string; trough_date: string };
}

export interface ReplayEpisode {
  peak_date: string;
  trough_date: string;
  oo_drawdown: number;
  contributions: Record<string, number>;
  trades?: { trade_id: string; contribution: number }[];
}

export interface OoReplayAttribution {
  method_id: "oo-replay-method/v1";
  method_parameters: ReplayMethodParameters;
  stats: {
    schema_id: "tradeblocks.oo-replay-attribution-stats/v1";
    basis: "replay_marked";
    daily: ReplayDaily[];
    by_strategy: ReplayStrategyTotal[];
    episodes: ReplayEpisode[];
    coverage: {
      available_days: number;
      total_days: number;
      unavailable_reasons: Record<string, number>;
    };
  };
  quotes: {
    schema_id: "tradeblocks.oo-replay-quote-observations/v1";
    observations: ReplayQuoteObservation[];
  };
}

/** SPXW is the observed OO-preferred PM-settled series, including on third Fridays. */
export function occReplayTickers(leg: ReplayLeg, underlying: string): string[] {
  const match = /^(\d{4})(?:-(\d{2})-(\d{2})|(\d{2})(\d{2}))$/.exec(leg.expiration);
  const year = Number(match?.[1]);
  const monthText = match?.[2] ?? match?.[4];
  const dayText = match?.[3] ?? match?.[5];
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new RangeError(`Invalid leg expiration: ${leg.expiration}`);
  }
  const tail = `${match[1].slice(2)}${monthText}${dayText}${leg.optionType[0]}${Math.round(
    leg.strike * 1000,
  )
    .toString()
    .padStart(8, "0")}`;
  if (underlying !== "SPX") return [`${underlying}${tail}`];
  return [`SPXW${tail}`, `SPX${tail}`];
}

function observe(
  date: string,
  ticker: string,
  lookup: ReplayQuoteLookup,
  markTime: string,
): ReplayQuoteObservation {
  const quote = lookup(date, ticker, markTime);
  if (!quote) return { date, ticker, missing: true };
  if (
    !Number.isFinite(quote.bid) ||
    !Number.isFinite(quote.ask) ||
    quote.bid < 0 ||
    quote.ask < 0
  ) {
    throw new RangeError(`Invalid quote for ${ticker} on ${date}`);
  }
  return { date, ticker, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2 };
}

export function valueReplayLegs(
  legs: readonly ReplayLeg[],
  underlying: string,
  date: string,
  quoteLookup: ReplayQuoteLookup,
  markTime = "15:59",
): ReplayMark {
  const observations = new Map<string, ReplayQuoteObservation>();
  const missing = new Set<string>();
  let value = 0;
  let missingLeg = false;
  for (const leg of legs) {
    let mid: number | undefined;
    for (const ticker of occReplayTickers(leg, underlying)) {
      let quote = observations.get(ticker);
      if (!quote) {
        quote = observe(date, ticker, quoteLookup, markTime);
        observations.set(ticker, quote);
      }
      if ("mid" in quote) {
        mid = quote.mid;
        break;
      }
      missing.add(ticker);
    }
    if (mid === undefined) {
      missingLeg = true;
      continue;
    }
    value += (leg.buySell === "Buy" ? 1 : -1) * leg.numberOfContracts * mid * 100;
  }
  return {
    value: missingLeg ? null : value,
    missing_tickers: [...missing].sort(),
    observations: [...observations.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
}

export function cumulativeReplayTradeMark(
  trade: ReplayTrade,
  date: string,
  quoteLookup: ReplayQuoteLookup,
  parameters: ReplayMethodOverrides = {},
): ReplayMark {
  const method = { ...DEFAULT_REPLAY_METHOD_PARAMETERS, ...parameters };
  const marked = valueReplayLegs(trade.legs, trade.underlying, date, quoteLookup, method.mark_time);
  if (marked.value === null) return marked;
  const entry = trade.legs.reduce(
    (sum, leg) =>
      sum + (leg.buySell === "Buy" ? 1 : -1) * leg.numberOfContracts * leg.pricePerContract,
    0,
  );
  return { ...marked, value: marked.value - entry - method.opening_fee_factor * trade.openingFees };
}

export function calculateOoReplayAttribution({
  trades,
  curve,
  quoteLookup,
  parameters = {},
}: {
  trades: readonly ReplayTrade[];
  curve: readonly { date: string; netLiquidity: number }[];
  quoteLookup: ReplayQuoteLookup;
  parameters?: ReplayMethodOverrides;
}): OoReplayAttribution {
  const method = { ...DEFAULT_REPLAY_METHOD_PARAMETERS, ...parameters };
  if (
    !Number.isFinite(method.opening_fee_factor) ||
    !Number.isFinite(method.tolerance_fraction) ||
    method.tolerance_fraction < 0
  ) {
    throw new RangeError("Invalid replay method parameters");
  }
  const book = [...curve].sort((a, b) => a.date.localeCompare(b.date));
  const observations = new Map<string, ReplayQuoteObservation>();
  const memoLookup: ReplayQuoteLookup = (date, ticker, markTime) => {
    const key = `${date}|${ticker}`;
    const cached = observations.get(key);
    if (cached) return "missing" in cached ? undefined : cached;
    const observation = observe(date, ticker, quoteLookup, markTime);
    observations.set(key, observation);
    return "missing" in observation ? undefined : observation;
  };
  const markCache = new Map<string, ReplayMark>();
  const mark = (index: number, date: string): ReplayMark => {
    const key = `${index}|${date}`;
    let result = markCache.get(key);
    if (!result) {
      result = cumulativeReplayTradeMark(trades[index], date, memoLookup, method);
      markCache.set(key, result);
    }
    return result;
  };
  const strategyInfo = new Map<string, { strategy_name: string; ignored: boolean }>();
  for (const trade of trades) {
    const id = trade.strategyId + (trade.isIgnored ? ":ignored" : "");
    strategyInfo.set(id, {
      strategy_name: trade.strategyName.split("·")[0].trim(),
      ignored: !!trade.isIgnored,
    });
  }
  const daily: ReplayDaily[] = [];
  const tradeChanges = new Map<string, { index: number; amount: number }[]>();
  for (let day = 1; day < book.length; day++) {
    const current = book[day];
    const prior = book[day - 1];
    const amounts = new Map<string, number>();
    const parts: { index: number; amount: number }[] = [];
    const missing = new Set<string>();
    let missingPrior = false;
    for (let index = 0; index < trades.length; index++) {
      const trade = trades[index];
      if (trade.dateClosed < current.date || trade.dateOpened > current.date) continue;
      let base = 0;
      if (trade.dateOpened < current.date) {
        const previousMark = mark(index, prior.date);
        if (previousMark.value === null) {
          missingPrior = true;
          continue;
        }
        base = previousMark.value;
      }
      let value: number;
      if (trade.dateClosed === current.date) {
        value = trade.isIgnored ? 0 : trade.profit;
      } else {
        const currentMark = mark(index, current.date);
        if (currentMark.value === null) {
          currentMark.missing_tickers.forEach((ticker) => missing.add(ticker));
          continue;
        }
        value = currentMark.value;
      }
      const amount = value - base;
      const id = trade.strategyId + (trade.isIgnored ? ":ignored" : "");
      amounts.set(id, (amounts.get(id) ?? 0) + amount);
      parts.push({ index, amount });
    }
    const ooChange = current.netLiquidity - prior.netLiquidity;
    if (missing.size || missingPrior) {
      daily.push({
        date: current.date,
        oo_change: ooChange,
        contributions: null,
        residual: null,
        status: "unavailable",
        reason: missing.size
          ? { code: "missing_quote", tickers: [...missing].sort() }
          : { code: "missing_prior_mark" },
      });
      continue;
    }
    const contributions = [...amounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([strategy_id, amount]) => ({
        strategy_id,
        ...strategyInfo.get(strategy_id)!,
        amount,
      }));
    const residual = ooChange - contributions.reduce((sum, row) => sum + row.amount, 0);
    const available =
      Math.abs(residual) <= Math.abs(prior.netLiquidity) * method.tolerance_fraction + 1e-8;
    daily.push({
      date: current.date,
      oo_change: ooChange,
      contributions,
      residual,
      status: available ? "available" : "unavailable",
      ...(!available && { reason: { code: "over_tolerance" as const, residual } }),
    });
    tradeChanges.set(current.date, parts);
  }
  const available = daily.filter((row) => row.status === "available");
  const by_strategy: ReplayStrategyTotal[] = [...strategyInfo]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([strategy_id, info]) => {
      let cumulative = 0,
        peak = 0,
        amount = 0;
      let peak_date = book[0]?.date ?? "",
        trough_date = book[0]?.date ?? "";
      let highDate = peak_date;
      for (const row of available) {
        cumulative +=
          row.contributions!.find((part) => part.strategy_id === strategy_id)?.amount ?? 0;
        if (cumulative > peak) {
          peak = cumulative;
          highDate = row.date;
        }
        if (peak - cumulative > amount) {
          amount = peak - cumulative;
          peak_date = highDate;
          trough_date = row.date;
        }
      }
      return {
        strategy_id,
        ...info,
        total: cumulative,
        drawdown: { amount, peak_date, trough_date },
      };
    });
  const episodes: ReplayEpisode[] = drawdownEpisodesFromEquity(
    book.map(({ date, netLiquidity }) => ({ date, equity: netLiquidity })),
  )
    .filter((episode) =>
      daily
        .filter((row) => row.date > episode.peakDate && row.date <= episode.troughDate)
        .every((row) => row.status === "available"),
    )
    .map((episode) => {
      const period = daily.filter(
        (row) => row.date > episode.peakDate && row.date <= episode.troughDate,
      );
      const contributions: Record<string, number> = {};
      const tradesInEpisode = new Map<number, number>();
      for (const row of period) {
        for (const part of row.contributions!)
          contributions[part.strategy_id] = (contributions[part.strategy_id] ?? 0) + part.amount;
        for (const part of tradeChanges.get(row.date) ?? [])
          tradesInEpisode.set(part.index, (tradesInEpisode.get(part.index) ?? 0) + part.amount);
      }
      const peak = book.find((row) => row.date === episode.peakDate)!;
      const trough = book.find((row) => row.date === episode.troughDate)!;
      return {
        peak_date: peak.date,
        trough_date: trough.date,
        oo_drawdown: peak.netLiquidity - trough.netLiquidity,
        contributions,
        ...(strategyInfo.size === 1 && {
          trades: [...tradesInEpisode]
            .sort(([a], [b]) => a - b)
            .map(([index, contribution]) => ({ trade_id: String(index), contribution })),
        }),
      };
    })
    .sort((a, b) => b.oo_drawdown - a.oo_drawdown || a.peak_date.localeCompare(b.peak_date));
  const unavailable_reasons: Record<string, number> = {};
  for (const row of daily)
    if (row.reason)
      unavailable_reasons[row.reason.code] = (unavailable_reasons[row.reason.code] ?? 0) + 1;
  return {
    method_id: "oo-replay-method/v1",
    method_parameters: method,
    stats: {
      schema_id: "tradeblocks.oo-replay-attribution-stats/v1",
      basis: "replay_marked",
      daily,
      by_strategy,
      episodes,
      coverage: { available_days: available.length, total_days: daily.length, unavailable_reasons },
    },
    quotes: {
      schema_id: "tradeblocks.oo-replay-quote-observations/v1",
      observations: [...observations.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker),
      ),
    },
  };
}
