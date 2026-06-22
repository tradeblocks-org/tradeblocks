/**
 * Trade Replay Tools
 *
 * MCP tool for replaying trades using historical minute-level option bars
 * read from the local market-data cache. Supports two modes:
 *   A) Hypothetical replay — explicit legs with strikes/expiry/dates
 *   B) Tradelog replay — block_id + trade_index to replay from existing trade data
 *
 * Tools registered:
 *   - replay_trade — Replay a trade and compute minute-by-minute P&L path with MFE/MAE
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConnection } from "../db/connection.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import type { MarketStores } from "../market/stores/index.ts";
import { extractRoot } from "../market/tickers/resolver.ts";
import type { QuoteRow } from "../market/stores/types.ts";
import {
  parseLegsString,
  buildOccTicker,
  computeStrategyPnlPath,
  computeReplayMfeMae,
  markPrice,
  type ReplayLeg,
  type ReplayResult,
  type GreeksConfig,
} from "../utils/trade-replay.ts";
import type { BarRow } from "../utils/market-provider.ts";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const replayTradeSchema = z.object({
  // Mode A: Hypothetical / explicit legs
  legs: z
    .array(
      z.object({
        ticker: z.string().describe("Underlying ticker, e.g., 'SPY', 'SPX'"),
        strike: z.number().describe("Strike price"),
        type: z.enum(["C", "P"]).describe("Call or Put"),
        expiry: z.string().describe("Expiration date YYYY-MM-DD"),
        quantity: z.number().describe("Positive = long, negative = short"),
        entry_price: z.number().describe("Per-contract entry price (premium paid/received)"),
      }),
    )
    .optional()
    .describe("Explicit leg definitions for hypothetical replay"),

  // Mode B: Tradelog replay
  block_id: z.string().optional().describe("Block ID to load trade from"),
  trade_index: z
    .number()
    .optional()
    .describe("0-based index of trade in block's tradelog (ordered by date_opened)"),

  // Common fields
  open_date: z
    .string()
    .optional()
    .describe(
      "Trade open date YYYY-MM-DD (required for hypothetical mode, auto-resolved for tradelog mode)",
    ),
  close_date: z
    .string()
    .optional()
    .describe(
      "Trade close date YYYY-MM-DD (required for hypothetical, auto-resolved for tradelog)",
    ),
  multiplier: z
    .number()
    .default(100)
    .describe("Contract multiplier (default 100 for standard options)"),
  format: z
    .enum(["full", "summary", "sampled"])
    .default("sampled")
    .describe(
      "Output format: 'sampled' returns path sampled at ~15min intervals (default), " +
        "'full' returns complete minute-by-minute P&L path, " +
        "'summary' returns MFE/MAE/P&L without minute-level path",
    ),
  close_at: z
    .enum(["trade", "expiry"])
    .default("trade")
    .describe(
      "When to end the P&L path: 'trade' (default) truncates at the trade's actual close time, " +
        "'expiry' shows full path through option expiry. Only applies to tradelog mode.",
    ),
  skip_quotes: z
    .boolean()
    .default(false)
    .describe(
      "Skip NBBO quote enrichment for option bars. Faster, but uses cached trade bars / HL2 marks.",
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** Convert OO expiry hint "Mar 13" + year "2026" → "2026-03-13" */
function resolveOOExpiryHint(hint: string, year: string): string {
  const [mon, day] = hint.split(" ");
  const mm = MONTH_MAP[mon] ?? "01";
  const dd = day.padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Derive fetch date range from OO leg expiryHints.
 *
 * For calendar spreads (different expiries): min(expiry)→max(expiry).
 * For single-expiry trades: tradeOpenDate→expiry.
 * Returns null if no legs have expiryHint (caller falls back to trade dates).
 */
export function resolveOODateRange(
  parsedLegs: import("../utils/trade-replay.ts").ParsedLegOO[],
  tradeYear: string,
  tradeOpenDate: string,
): { from: string; to: string } | null {
  const hints = parsedLegs
    .filter((l) => l.expiryHint)
    .map((l) => resolveOOExpiryHint(l.expiryHint!, tradeYear));

  if (hints.length === 0) return null;

  const sorted = [...hints].sort();
  const maxDate = sorted[sorted.length - 1];

  // Always start from trade open date — bars are needed from entry, not from expiry.
  // End at the latest expiry to cover the full path.
  return { from: tradeOpenDate, to: maxDate };
}

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleReplayTrade(
  params: z.infer<typeof replayTradeSchema>,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<ReplayResult> {
  const { legs: inputLegs, block_id, trade_index, multiplier, close_at, skip_quotes } = params;
  let { open_date, close_date } = params;
  let tradeCloseTimestamp: string | undefined; // "YYYY-MM-DD HH:MM" when trade actually closed

  let replayLegs: ReplayLeg[];

  if (inputLegs && inputLegs.length > 0) {
    // ----- Mode A: Hypothetical replay -----
    if (!open_date || !close_date) {
      throw new Error("open_date and close_date are required for hypothetical replay mode");
    }

    replayLegs = inputLegs.map((leg) => ({
      occTicker: buildOccTicker(leg.ticker, leg.expiry, leg.type, leg.strike),
      quantity: leg.quantity,
      entryPrice: leg.entry_price,
      multiplier,
    }));
  } else if (block_id !== undefined && trade_index !== undefined) {
    // ----- Mode B: Tradelog replay -----
    const conn = injectedConn ?? (await getConnection(baseDir));

    const result = await conn.runAndReadAll(
      `SELECT legs, premium, date_opened, date_closed, ticker, num_contracts, time_closed
       FROM trades.trade_data
       WHERE block_id = '${block_id.replace(/'/g, "''")}'
       ORDER BY date_opened, rowid
       LIMIT 1 OFFSET ${trade_index}`,
    );

    const rows = result.getRows();
    if (rows.length === 0) {
      throw new Error(`No trade found at index ${trade_index} in block "${block_id}"`);
    }

    const row = rows[0];
    const legsStr = String(row[0] ?? "");
    const premium = Number(row[1] ?? 0);
    const dateOpened = String(row[2] ?? "");
    const dateClosed = String(row[3] ?? "");
    const ticker = String(row[4] ?? "");
    const numContracts = Number(row[5] ?? 1);
    const timeClosed = String(row[6] ?? "");

    // Build actual trade close timestamp for path truncation
    if (dateClosed && timeClosed) {
      // time_closed is "HH:MM:SS" or "HH:MM" — normalize to "HH:MM"
      const normalizedTime = timeClosed.slice(0, 5);
      tradeCloseTimestamp = `${dateClosed} ${normalizedTime}`;
    }

    // Use trade dates if not provided
    open_date = open_date || dateOpened;
    close_date = close_date || dateClosed;

    // Parse legs from tradelog
    let parsedLegs;
    try {
      parsedLegs = parseLegsString(legsStr);
    } catch {
      throw new Error(
        `Cannot parse legs "${legsStr}" from tradelog — use hypothetical mode with explicit strikes`,
      );
    }

    // Build ReplayLeg[] from parsed legs
    const root = ticker || parsedLegs[0].root;
    const perContractPremium = numContracts > 0 ? premium / numContracts : premium;

    // OO format provides per-leg entry price, contract count, and expiry hint
    const hasOOData = parsedLegs.some((l) => l.entryPrice !== undefined);

    // Resolve per-leg expiry: OO expiryHint ("Mar 13") + year from trade date
    const tradeYear = (open_date || dateOpened).split("-")[0];

    // Override fetch date range from OO expiryHints when available
    if (hasOOData) {
      const ooRange = resolveOODateRange(parsedLegs, tradeYear, open_date || dateOpened);
      if (ooRange) {
        open_date = ooRange.from;
        close_date = ooRange.to;
      }
    }

    replayLegs = parsedLegs.map((leg) => {
      let legExpiry = close_date!;
      if (hasOOData && leg.expiryHint) {
        legExpiry = resolveOOExpiryHint(leg.expiryHint, tradeYear);
      }
      return {
        occTicker: buildOccTicker(root, legExpiry, leg.type, leg.strike),
        quantity: hasOOData
          ? leg.quantity * (leg.contracts ?? 1)
          : leg.quantity * (numContracts > 0 ? numContracts : 1),
        entryPrice: hasOOData ? leg.entryPrice! : perContractPremium / parsedLegs.length,
        multiplier,
      };
    });
  } else {
    throw new Error(
      "Provide either legs[] for hypothetical mode or block_id + trade_index for tradelog mode",
    );
  }

  // ----- Fetch minute quotes for each option leg via QuoteStore -----
  // Adapt QuoteRow → BarRow with mid = (bid+ask)/2 as open/high/low/close
  // (mid-price is the canonical mark for option-leg pricing).
  //
  // Group OCC tickers by underlying before each readQuotes call: the store
  // enforces a single-underlying invariant per call so partitioned reads
  // can be served from one parquet partition root. Typical replays have
  // all legs under one underlying (single SPX trade); multi-underlying
  // replays issue one readQuotes per underlying.
  //
  // Fallback root logic (SPX→SPXW etc.) is implicit: the QuoteStore's
  // tickers.resolve(extractRoot(...)) maps both SPX and SPXW to underlying
  // 'SPX'. The OCC ticker prefix in the chain is whatever the data layer
  // ingested (typically SPXW); keying on underlying makes the same data
  // reachable via either root.
  //
  // skip_quotes is a no-op for option-leg reads — quotes ARE the source of
  // truth here. Parameter remains in the schema for backward compat with
  // callers.
  void skip_quotes;

  const byUnderlying = new Map<string, string[]>();
  for (const leg of replayLegs) {
    const underlying = stores.quote.tickers.resolve(extractRoot(leg.occTicker));
    const arr = byUnderlying.get(underlying) ?? [];
    arr.push(leg.occTicker);
    byUnderlying.set(underlying, arr);
  }

  const quotesByOcc = new Map<string, QuoteRow[]>();
  for (const [, occs] of byUnderlying) {
    try {
      const result = await stores.quote.readQuotes(occs, open_date!, close_date!);
      for (const [occ, rows] of result) quotesByOcc.set(occ, rows);
    } catch {
      // Best-effort: a missing partition / read error returns empty for these legs.
    }
  }

  const barsByLeg: BarRow[][] = replayLegs.map((leg) => {
    const quotes = quotesByOcc.get(leg.occTicker) ?? [];
    return quotes.map((q) => {
      const [date, time] = q.timestamp.split(" ");
      const mid = (q.bid + q.ask) / 2;
      return {
        ticker: q.occ_ticker,
        date,
        time,
        open: mid,
        high: mid,
        low: mid,
        close: mid,
        bid: q.bid,
        ask: q.ask,
        volume: 0,
      };
    });
  });

  // ----- Fetch underlying bars + build greeks config -----
  // Reverse-map weekly roots back to standard root for underlying fetch
  const REVERSE_ROOT_MAP: Record<string, string> = {
    SPXW: "SPX",
    NDXP: "NDX",
    RUTW: "RUT",
  };
  const DIVIDEND_YIELDS: Record<string, number> = {
    SPX: 0.015,
    SPXW: 0.015,
    NDX: 0.015,
    NDXP: 0.015,
  };

  // Extract root from first leg's OCC ticker
  const firstRootMatch = replayLegs[0]?.occTicker.match(/^([A-Z]+)/);
  const rawRoot = firstRootMatch ? firstRootMatch[1] : "";
  const underlyingTicker = REVERSE_ROOT_MAP[rawRoot] ?? rawRoot;
  const dividendYield = DIVIDEND_YIELDS[rawRoot] ?? 0;

  // Read underlying minute bars via SpotStore, falling back to the daily
  // aggregate (readDailyBars) when minute bars are absent. The daily
  // fallback keeps greeks computable on dates with sparse intraday
  // coverage.
  let underlyingBars: BarRow[] = await stores.spot.readBars(
    underlyingTicker,
    open_date!,
    close_date!,
  );
  if (underlyingBars.length === 0) {
    try {
      underlyingBars = await stores.spot.readDailyBars(underlyingTicker, open_date!, close_date!);
    } catch {
      // No fallback available — greeks will be omitted
    }
  }
  // Defense-in-depth: drop any underlying bar with a zero/null OHLC value.
  // SPX/QQQ/etc. always have a real price — a zero in spot is a provider
  // gap (see ParquetSpotStore writer guard), and feeding it into Black-
  // Scholes greeks computation produces nonsense (S=0 → infinite delta etc.).
  // Raw bars are left unfiltered upstream so option tickers can keep
  // legitimate "no trade" zero rows; the filtering responsibility lives
  // here at the underlying-consumer site.
  if (underlyingBars.length > 0) {
    underlyingBars = underlyingBars.filter(
      (b) =>
        Number.isFinite(b.open) &&
        b.open > 0 &&
        Number.isFinite(b.high) &&
        b.high > 0 &&
        Number.isFinite(b.low) &&
        b.low > 0 &&
        Number.isFinite(b.close) &&
        b.close > 0,
    );
  }

  // Build underlying price map for greeks config
  const underlyingPrices = new Map<string, number>();
  for (const b of underlyingBars) {
    const ts = `${b.date} ${b.time ?? ""}`.trim();
    underlyingPrices.set(ts, markPrice(b));
  }

  // Build sorted timestamps for tolerant nearest-timestamp lookup: when a
  // leg's quote timestamp doesn't have an exact underlying-price match
  // (e.g. one source skipped a minute), greeks computation falls back to
  // the nearest underlying timestamp within tolerance.
  const sortedTimestamps = Array.from(underlyingPrices.keys())
    .filter((k) => k.includes(" ")) // Only intraday timestamps, not date-only keys
    .sort();

  // VIX IVP lookup via EnrichedStore.read — used as an optional input to
  // the greeks model when implied-vol percentile context is available.
  let ivpByDate: Map<string, number> | undefined;
  try {
    const vixEnriched = await stores.enriched.read({
      ticker: "VIX",
      from: open_date!,
      to: close_date!,
      includeContext: false,
    });
    const map = new Map<string, number>();
    for (const row of vixEnriched) {
      const ivp = row.ivp;
      if (ivp != null) {
        map.set(String(row.date), Number(ivp));
      }
    }
    if (map.size > 0) {
      ivpByDate = map;
    }
  } catch {
    // IVP is optional enrichment — don't fail
  }

  // Build GreeksConfig
  let greeksConfig: GreeksConfig | undefined;
  if (underlyingPrices.size > 0) {
    greeksConfig = {
      underlyingPrices,
      sortedTimestamps,
      legs: replayLegs.map((leg) => {
        // Extract strike, type, expiry from OCC ticker: ROOT{YYMMDD}{C|P}{strike*1000}
        const occMatch = leg.occTicker.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
        if (!occMatch) return { strike: 0, type: "C" as const, expiryDate: "" };
        const yymmdd = occMatch[1];
        const type = occMatch[2] as "C" | "P";
        const strike = parseInt(occMatch[3], 10) / 1000;
        const expiryDate = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
        return { strike, type, expiryDate };
      }),
      riskFreeRate: 0.045,
      dividendYield,
      ivpByDate,
    };
  }

  // ----- Compute P&L path + MFE/MAE -----
  let fullPath = computeStrategyPnlPath(replayLegs, barsByLeg, greeksConfig);
  let { mfe, mae, mfeTimestamp, maeTimestamp } = computeReplayMfeMae(fullPath);
  let totalPnl = fullPath.length > 0 ? fullPath[fullPath.length - 1].strategyPnl : 0;

  // Surface a warning when >50% of leg-timestamps have null greeks — the
  // most common cause is sparse IV data or 0DTE legs falling outside the
  // pricing model's valid range.
  let greeksNullCount = 0;
  let greeksTotalCount = 0;
  for (const point of fullPath) {
    if (point.legGreeks) {
      for (const lg of point.legGreeks) {
        greeksTotalCount++;
        if (lg.delta === null) greeksNullCount++;
      }
    }
  }
  const greeksWarning =
    greeksTotalCount > 0 && greeksNullCount / greeksTotalCount > 0.5
      ? `Greeks unavailable for ${greeksNullCount} of ${greeksTotalCount} leg-timestamps (0DTE options use Bachelier model; some legs may have insufficient time value for IV computation)`
      : null;

  // Apply format filter
  // Truncate path at trade close timestamp when close_at === "trade" (default)
  // This ensures decompose_greeks and exit triggers only analyze the actual holding period
  if (close_at === "trade" && tradeCloseTimestamp && fullPath.length > 0) {
    const truncIdx = fullPath.findIndex((p) => p.timestamp > tradeCloseTimestamp!);
    if (truncIdx > 0) {
      fullPath = fullPath.slice(0, truncIdx);
      // Recompute MFE/MAE/totalPnl on truncated path
      mfe = -Infinity;
      mae = Infinity;
      for (const p of fullPath) {
        if (p.strategyPnl > mfe) {
          mfe = p.strategyPnl;
          mfeTimestamp = p.timestamp;
        }
        if (p.strategyPnl < mae) {
          mae = p.strategyPnl;
          maeTimestamp = p.timestamp;
        }
      }
      totalPnl = fullPath[fullPath.length - 1].strategyPnl;
    }
  }

  const { format } = params;
  let pnlPath: typeof fullPath;
  if (format === "summary") {
    // Return only MFE, MAE, and boundary points (first, last, MFE timestamp, MAE timestamp)
    const keyTimestamps = new Set([
      fullPath[0]?.timestamp,
      fullPath[fullPath.length - 1]?.timestamp,
      mfeTimestamp,
      maeTimestamp,
    ]);
    pnlPath = fullPath.filter((p) => keyTimestamps.has(p.timestamp));
  } else if (format === "sampled") {
    // Sample at ~15min intervals (keep every 15th bar, plus first/last/MFE/MAE)
    const keyTimestamps = new Set([mfeTimestamp, maeTimestamp]);
    pnlPath = fullPath.filter(
      (p, i) =>
        i === 0 || i === fullPath.length - 1 || i % 15 === 0 || keyTimestamps.has(p.timestamp),
    );
  } else {
    pnlPath = fullPath;
  }

  return {
    pnlPath,
    mfe,
    mae,
    mfeTimestamp,
    maeTimestamp,
    totalPnl,
    totalBars: fullPath.length,
    legs: replayLegs,
    greeksWarning,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerReplayTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  server.registerTool(
    "replay_trade",
    {
      description:
        "Replay a trade using historical minute-level option bars. " +
        "Reads option-leg quotes via QuoteStore and underlying bars via SpotStore (cache only); " +
        "missing data yields a degenerate replay. Use the data-pipeline tools to backfill cache. " +
        "Returns minute-by-minute P&L path with MFE (Maximum Favorable Excursion) and MAE (Maximum Adverse Excursion). " +
        "Two modes: (A) Hypothetical — provide explicit legs with strikes, expiry, entry prices. " +
        "(B) Tradelog — provide block_id + trade_index to replay an existing trade from your data.",
      inputSchema: replayTradeSchema,
    },
    async (params) => {
      try {
        const result = await handleReplayTrade(params, baseDir, stores);

        const summary =
          `Replayed ${result.legs.length}-leg strategy from ${params.open_date ?? "trade dates"} to ${params.close_date ?? "trade dates"}: ` +
          `$${result.totalPnl.toFixed(2)} P&L, MFE=$${result.mfe.toFixed(2)}, MAE=$${result.mae.toFixed(2)}, ` +
          `${result.pnlPath.length} minute bars, greeks=${result.pnlPath[0]?.legGreeks ? "yes" : "no"}`;

        return createToolOutput(summary, result);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error replaying trade: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
