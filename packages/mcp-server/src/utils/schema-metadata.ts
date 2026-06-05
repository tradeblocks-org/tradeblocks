/**
 * Schema Metadata
 *
 * Hardcoded descriptions for DuckDB tables and columns, plus example queries.
 * Used by describe_database tool to provide context for SQL query writing.
 *
 * Tables are organized by schema:
 *   - trades: Trade data from CSV files
 *   - market: Canonical market datasets post-v3.0 —
 *       * spot (raw minute bars, ticker-first)
 *       * spot_daily (view-backed RTH-aggregated daily OHLCV)
 *       * enriched (per-ticker computed indicators + ivr/ivp — NO OHLCV)
 *       * enriched_context (cross-ticker derived fields: Vol_Regime, Term_Structure_State)
 *       * option_chain / option_quote_minutes (option contract universe + quote cache)
 *     OHLCV callers must LEFT JOIN market.spot_daily on ticker+date; enriched alone does not carry open/high/low/close.
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface ColumnDescription {
  /** Human-readable description of what this column contains */
  description: string;
  /** True if this column is useful for hypothesis testing (filtering, grouping, analysis) */
  hypothesis: boolean;
  /** When this field's value is known relative to market open.
   *  - 'open': Known at/before market open (Prior_Close, Gap_Pct, VIX_Open, etc.)
   *  - 'close': Only known after market close (RSI_14, Vol_Regime, Close, etc.)
   *  - 'static': Calendar/metadata facts known before the day (Day_of_Week, Month, Is_Opex)
   *  Only applicable to market.enriched and market.enriched_context columns. Omit for non-market tables.
   */
  timing?: 'open' | 'close' | 'static';
}

export interface TableDescription {
  /** Human-readable description of this table's purpose */
  description: string;
  /** Key columns that are most important for analysis */
  keyColumns: string[];
  /** Column descriptions by column name */
  columns: Record<string, ColumnDescription>;
}

export interface SchemaDescription {
  /** Human-readable description of this schema's purpose */
  description: string;
  /** Tables in this schema */
  tables: Record<string, TableDescription>;
}

export interface SchemaMetadata {
  trades: SchemaDescription;
  market: SchemaDescription;
}

export interface ExampleQuery {
  /** What this query does */
  description: string;
  /** The SQL query */
  sql: string;
}

export interface ExampleQueries {
  /** Basic single-table queries */
  basic: ExampleQuery[];
  /** JOIN queries between trades and market data */
  joins: ExampleQuery[];
  /** Hypothesis testing patterns */
  hypothesis: ExampleQuery[];
}

// ============================================================================
// Schema Descriptions
// ============================================================================

export const SCHEMA_DESCRIPTIONS: SchemaMetadata = {
  trades: {
    description:
      "Trading data synced from CSV files. Contains trade records from all portfolio blocks, including both backtest (trade_data) and actual/reported (reporting_data) trades.",
    tables: {
      trade_data: {
        description:
          "Individual backtest trade records. Each row = one trade with entry/exit details, P&L, and strategy. Filter by block_id to query specific portfolios.",
        keyColumns: ["block_id", "date_opened", "strategy", "pl"],
        columns: {
          block_id: {
            description: "Portfolio block ID - filter by this to query specific portfolios",
            hypothesis: true,
          },
          date_opened: {
            description: "Trade entry date (DATE format, use for joins with market data)",
            hypothesis: true,
          },
          time_opened: {
            description: "Trade entry time in Eastern Time (e.g., '09:35:00')",
            hypothesis: false,
          },
          strategy: {
            description: "Strategy name (e.g., 'IronCondor', 'PutSpread')",
            hypothesis: true,
          },
          legs: {
            description: "Option legs description (e.g., 'SPY 450P/445P')",
            hypothesis: false,
          },
          premium: {
            description: "Credit received (+) or debit paid (-)",
            hypothesis: false,
          },
          num_contracts: {
            description: "Number of contracts traded",
            hypothesis: false,
          },
          pl: {
            description: "Gross P&L before commissions (DOUBLE)",
            hypothesis: true,
          },
          date_closed: {
            description: "Trade exit date (NULL if still open)",
            hypothesis: false,
          },
          time_closed: {
            description: "Trade exit time in Eastern Time",
            hypothesis: false,
          },
          reason_for_close: {
            description: "Exit reason (e.g., 'Target', 'Stop', 'Expiration')",
            hypothesis: true,
          },
          margin_req: {
            description: "Margin requirement for the position ($)",
            hypothesis: false,
          },
          opening_commissions: {
            description: "Commissions paid at entry ($)",
            hypothesis: false,
          },
          closing_commissions: {
            description: "Commissions paid at exit ($)",
            hypothesis: false,
          },
        },
      },
      reporting_data: {
        description:
          "Actual/reported trade records from reportinglog.csv. Each row = one live trade executed. Compare with trade_data (backtest) to analyze slippage and execution differences. Filter by block_id to query specific portfolios.",
        keyColumns: ["block_id", "date_opened", "strategy", "legs", "pl"],
        columns: {
          block_id: {
            description: "Portfolio block ID - filter by this to query specific portfolios",
            hypothesis: true,
          },
          date_opened: {
            description: "Trade entry date (DATE format, use for joins with market data)",
            hypothesis: true,
          },
          time_opened: {
            description: "Trade entry time in Eastern Time (e.g., '09:35:00')",
            hypothesis: false,
          },
          strategy: {
            description: "Strategy name (e.g., 'IronCondor', 'PutSpread')",
            hypothesis: true,
          },
          legs: {
            description: "Option legs description with strikes (e.g., 'SPY 450P/445P') - compare with trade_data.legs to identify strike differences",
            hypothesis: true,
          },
          initial_premium: {
            description: "Credit received (+) or debit paid (-) at entry",
            hypothesis: false,
          },
          num_contracts: {
            description: "Number of contracts traded (often fewer than backtest)",
            hypothesis: false,
          },
          pl: {
            description: "Actual P&L realized (DOUBLE)",
            hypothesis: true,
          },
          date_closed: {
            description: "Trade exit date (NULL if still open)",
            hypothesis: false,
          },
          time_closed: {
            description: "Trade exit time in Eastern Time",
            hypothesis: false,
          },
          closing_price: {
            description: "Price at exit",
            hypothesis: false,
          },
          avg_closing_cost: {
            description: "Average cost to close the position",
            hypothesis: false,
          },
          reason_for_close: {
            description: "Exit reason (e.g., 'Target', 'Stop', 'Expiration')",
            hypothesis: true,
          },
          opening_price: {
            description: "Price at entry",
            hypothesis: false,
          },
        },
      },
    },
  },
  market: {
    description:
      "Canonical market data for hypothesis testing (v3.0 layout). Normalized into six datasets: spot (raw minute bars, ticker-first), spot_daily (view-backed RTH-aggregated daily OHLCV derived from market.spot), enriched (per-ticker computed Tier 1 indicators + ivr/ivp for VIX-family tickers; NO OHLCV), enriched_context (cross-ticker derived fields like Vol_Regime), option_chain (contract universe by date), and option_quote_minutes (dense option quote cache by minute, including persisted minute greeks when provider or computed fallback data is available). OHLCV-using queries must LEFT JOIN market.spot_daily on ticker+date because market.enriched does not carry open/high/low/close. Source: market/ Parquet files and provider imports.",
    tables: {
      enriched: {
        description:
          "Per-ticker computed enrichment indicators and calendar fields. One row per ticker per trading day. OHLCV is NOT stored here — LEFT JOIN market.spot_daily on ticker+date for open/high/low/close/bid/ask. JOIN with trades on ticker+date (e.g., d.ticker = 'SPX' AND t.date_opened = d.date). VIX-family tickers (VIX, VIX9D, VIX3M, etc.) also have ivr/ivp columns populated. For trade-entry queries, use LAG() on close-derived fields. Join market.enriched_context (LEFT JOIN on date) for Vol_Regime, Term_Structure_State, etc.",
        keyColumns: ["ticker", "date", "RSI_14", "ATR_Pct", "Realized_Vol_20D"],
        columns: {
          ticker: {
            description: "Underlying ticker symbol (part of composite primary key with date).",
            hypothesis: true,
          },
          date: {
            description: "Trading date (VARCHAR, format YYYY-MM-DD). Composite primary key with ticker.",
            hypothesis: true,
          },
          // Raw OHLCV
          open: {
            description: "Underlying open price",
            hypothesis: false,
            timing: 'open',
          },
          high: {
            description: "Underlying high price",
            hypothesis: false,
            timing: 'close',
          },
          low: {
            description: "Underlying low price",
            hypothesis: false,
            timing: 'close',
          },
          close: {
            description: "Underlying close price",
            hypothesis: false,
            timing: 'close',
          },
          Prior_Close: {
            description: "Previous day's close price",
            hypothesis: false,
            timing: 'open',
          },
          // Tier 1 enrichment — open-known
          Gap_Pct: {
            description: "Overnight gap percentage ((Open - Prior_Close) / Prior_Close * 100)",
            hypothesis: true,
            timing: 'open',
          },
          Prev_Return_Pct: {
            description: "Previous day's total return percentage (prior close to prior close)",
            hypothesis: true,
            timing: 'open',
          },
          Prior_Range_vs_ATR: {
            description: "Prior trading day's (high - low) / ATR ratio, measures prior day's range relative to average true range",
            hypothesis: true,
            timing: 'open',
          },
          // Tier 1 enrichment — close-derived
          ATR_Pct: {
            description: "Average True Range as percentage of price (14-day Wilder smoothing)",
            hypothesis: true,
            timing: 'close',
          },
          RSI_14: {
            description: "14-day RSI (0-100, >70 overbought, <30 oversold)",
            hypothesis: true,
            timing: 'close',
          },
          Price_vs_EMA21_Pct: {
            description: "Price vs 21-day EMA as percentage ((close - EMA21) / EMA21 * 100)",
            hypothesis: true,
            timing: 'close',
          },
          Price_vs_SMA50_Pct: {
            description: "Price vs 50-day SMA as percentage ((close - SMA50) / SMA50 * 100)",
            hypothesis: true,
            timing: 'close',
          },
          Realized_Vol_5D: {
            description: "5-day realized volatility (annualized standard deviation of log returns)",
            hypothesis: true,
            timing: 'close',
          },
          Realized_Vol_20D: {
            description: "20-day realized volatility (annualized standard deviation of log returns)",
            hypothesis: true,
            timing: 'close',
          },
          Return_5D: {
            description: "5-day cumulative return percentage",
            hypothesis: true,
            timing: 'close',
          },
          Return_20D: {
            description: "20-day cumulative return percentage",
            hypothesis: true,
            timing: 'close',
          },
          Intraday_Range_Pct: {
            description: "Intraday range as percentage ((High - Low) / Open * 100)",
            hypothesis: true,
            timing: 'close',
          },
          Intraday_Return_Pct: {
            description: "Open to close return percentage ((Close - Open) / Open * 100)",
            hypothesis: true,
            timing: 'close',
          },
          Close_Position_In_Range: {
            description: "Where close is in day's range (0 = low, 1 = high)",
            hypothesis: true,
            timing: 'close',
          },
          Gap_Filled: {
            description: "Whether overnight gap was filled (1 = yes, 0 = no)",
            hypothesis: true,
            timing: 'close',
          },
          Consecutive_Days: {
            description: "Consecutive up/down days (positive=up, negative=down)",
            hypothesis: true,
            timing: 'close',
          },
          // Tier 3 intraday timing (columns exist in schema, enrichment deferred)
          High_Time: {
            description: "Time of day high as decimal hours (e.g., 10.5 = 10:30 AM ET)",
            hypothesis: true,
            timing: 'close',
          },
          Low_Time: {
            description: "Time of day low as decimal hours (e.g., 14.25 = 2:15 PM ET)",
            hypothesis: true,
            timing: 'close',
          },
          High_Before_Low: {
            description: "Did high occur before low? (1=yes, 0=no)",
            hypothesis: true,
            timing: 'close',
          },
          Reversal_Type: {
            description: "Reversal pattern type (1=morning reversal up, -1=morning reversal down, 0=trend day)",
            hypothesis: true,
            timing: 'close',
          },
          Opening_Drive_Strength: {
            description: "First-30-min range / full-day range ratio (0-1); higher = strong opening drive",
            hypothesis: true,
            timing: 'close',
          },
          Intraday_Realized_Vol: {
            description: "Annualized realized volatility from intraday bar returns (decimal, e.g., 0.15 = 15%)",
            hypothesis: true,
            timing: 'close',
          },
          // Calendar fields — static
          Day_of_Week: {
            description: "Day of week (2=Monday through 6=Friday)",
            hypothesis: true,
            timing: 'static',
          },
          Month: {
            description: "Month number (1-12)",
            hypothesis: true,
            timing: 'static',
          },
          Is_Opex: {
            description: "Options expiration day flag (1=opex, 0=not)",
            hypothesis: true,
            timing: 'static',
          },
          // VIX-family ticker IVR/IVP (populated for VIX, VIX9D, VIX3M, etc.)
          ivr: {
            description: "Implied Volatility Rank (252-day): where current close sits in range (0=min, 100=max). Populated for VIX-family tickers only.",
            hypothesis: true,
            timing: 'close',
          },
          ivp: {
            description: "Implied Volatility Percentile (252-day): percentage of prior 251 trading days where close was at or below current level (0-100). Populated for VIX-family tickers only.",
            hypothesis: true,
            timing: 'close',
          },
        },
      },
      enriched_context: {
        description:
          "Cross-ticker derived market context fields per trading day. Contains Vol_Regime, Term_Structure_State, and other fields derived from multiple VIX tickers. JOIN with market.enriched on date. VIX IVR/IVP live in market.enriched (ticker='VIX', 'VIX9D', etc.); VIX OHLCV lives in market.spot_daily.",
        keyColumns: ["date", "Vol_Regime", "Term_Structure_State"],
        columns: {
          date: {
            description: "Trading date (VARCHAR, format YYYY-MM-DD). Primary key.",
            hypothesis: true,
          },
          Vol_Regime: {
            description: "Volatility regime classification based on VIX close (1=very low <10, 2=low 10-15, 3=normal 15-20, 4=elevated 20-25, 5=high 25-30, 6=extreme >30)",
            hypothesis: true,
            timing: 'close',
          },
          Term_Structure_State: {
            description: "VIX term structure state based on VIX9D/VIX ratio (-1=backwardation/inverted, 0=flat, 1=contango/normal). NULL when VIX9D data is absent.",
            hypothesis: true,
            timing: 'close',
          },
          Trend_Direction: {
            description: "Trend direction classification based on 20-day return: up (>1%), down (<-1%), flat (-1% to 1%). NULL if Return_20D unavailable.",
            hypothesis: true,
            timing: 'close',
          },
          VIX_Spike_Pct: {
            description: "VIX spike from open to high as percentage",
            hypothesis: true,
            timing: 'close',
          },
          VIX_Gap_Pct: {
            description: "VIX overnight gap percentage ((VIX_Open - prior VIX_Close) / prior VIX_Close * 100)",
            hypothesis: true,
            timing: 'open',
          },
        },
      },
      spot: {
        description:
          "Raw minute bars per ticker (ticker-first Hive partitioned Parquet). One row per bar. Use for ORB calculations and intraday context enrichment. Time column is Eastern Time HH:MM format (e.g., '09:30'). Filter by ticker='VIX' to get VIX intraday data.",
        keyColumns: ["ticker", "date", "time"],
        columns: {
          ticker: {
            description: "Underlying ticker symbol (part of composite primary key with date and time).",
            hypothesis: true,
          },
          date: {
            description: "Trading date (VARCHAR, format YYYY-MM-DD). Part of composite primary key.",
            hypothesis: true,
          },
          time: {
            description: "Bar time in HH:MM Eastern Time format (e.g., '09:30', '10:00'). Part of composite primary key.",
            hypothesis: false,
          },
          open: {
            description: "Bar open price",
            hypothesis: false,
          },
          high: {
            description: "Bar high price",
            hypothesis: false,
          },
          low: {
            description: "Bar low price",
            hypothesis: false,
          },
          close: {
            description: "Bar close price",
            hypothesis: false,
          },
          bid: {
            description: "Bar best bid",
            hypothesis: false,
          },
          ask: {
            description: "Bar best ask",
            hypothesis: false,
          },
        },
      },
      spot_daily: {
        description:
          "View-backed RTH-aggregated daily OHLCV derived from market.spot (first-open, max-high, min-low, last-close, first-bid, last-ask over 09:30–16:00 bars). One row per ticker per trading day. LEFT JOIN on ticker+date to retrieve OHLCV alongside market.enriched indicators (e.g., market.enriched d LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date).",
        keyColumns: ["ticker", "date", "open", "high", "low", "close"],
        columns: {
          ticker: {
            description: "Underlying ticker symbol (composite key with date).",
            hypothesis: true,
          },
          date: {
            description: "Trading date (VARCHAR YYYY-MM-DD). Composite key with ticker.",
            hypothesis: true,
          },
          open: {
            description: "RTH open (first bar at/after 09:30 ET).",
            hypothesis: false,
          },
          high: {
            description: "RTH high (max across 09:30–16:00 ET bars).",
            hypothesis: false,
          },
          low: {
            description: "RTH low (min across 09:30–16:00 ET bars).",
            hypothesis: false,
          },
          close: {
            description: "RTH close (last bar at/before 16:00 ET).",
            hypothesis: false,
          },
          bid: {
            description: "RTH first bid (first bar's bid at/after 09:30 ET).",
            hypothesis: false,
          },
          ask: {
            description: "RTH last ask (last bar's ask at/before 16:00 ET).",
            hypothesis: false,
          },
        },
      },
      option_chain: {
        description:
          "Option contract universe by underlying and trading date. One row per listed option contract, used for strike resolution and candidate selection in backtests.",
        keyColumns: ["underlying", "date", "ticker"],
        columns: {
          underlying: {
            description: "Underlying root symbol for the option chain snapshot.",
            hypothesis: true,
          },
          date: {
            description: "Trading date for the chain snapshot (VARCHAR YYYY-MM-DD).",
            hypothesis: true,
          },
          ticker: {
            description: "Canonical OCC option ticker for the contract.",
            hypothesis: true,
          },
          contract_type: {
            description: "Option side: call or put.",
            hypothesis: true,
          },
          strike: {
            description: "Option strike price.",
            hypothesis: true,
          },
          expiration: {
            description: "Expiration date for the contract (VARCHAR YYYY-MM-DD).",
            hypothesis: true,
          },
          dte: {
            description: "Days to expiration as of the chain snapshot date.",
            hypothesis: true,
          },
          exercise_style: {
            description: "Exercise style reported by the provider when available.",
            hypothesis: false,
          },
        },
      },
      option_quote_minutes: {
        description:
          "Dense minute-level option quote cache keyed by ticker/date/time. Used to fill sparse option trade bars with bid/ask-derived marks during replay and backtests.",
        keyColumns: ["ticker", "date", "time"],
        columns: {
          ticker: {
            description: "Canonical OCC option ticker.",
            hypothesis: true,
          },
          date: {
            description: "Trading date (VARCHAR YYYY-MM-DD).",
            hypothesis: true,
          },
          time: {
            description: "Quote minute in HH:MM Eastern Time format.",
            hypothesis: false,
          },
          bid: {
            description: "Best bid at or carried into that minute.",
            hypothesis: false,
          },
          ask: {
            description: "Best ask at or carried into that minute.",
            hypothesis: false,
          },
          mid: {
            description: "Bid/ask midpoint for the minute.",
            hypothesis: false,
          },
          last_updated_ns: {
            description: "Monotonic write-order field used for quote upsert precedence.",
            hypothesis: false,
          },
          source: {
            description: "Quote source label used for debugging and provenance.",
            hypothesis: false,
          },
          delta: {
            description: "Option delta for the minute when available from provider data or computed fallback.",
            hypothesis: true,
          },
          gamma: {
            description: "Option gamma for the minute when available from provider data or computed fallback.",
            hypothesis: false,
          },
          theta: {
            description: "Option theta for the minute when available from provider data or computed fallback.",
            hypothesis: false,
          },
          vega: {
            description: "Option vega (per 1% IV move) for the minute when available from provider data or computed fallback.",
            hypothesis: false,
          },
          iv: {
            description: "Implied volatility used for the stored minute greeks when available.",
            hypothesis: true,
          },
          greeks_source: {
            description: "Origin of the stored minute greeks: provider-native or computed fallback.",
            hypothesis: false,
          },
          greeks_revision: {
            description: "Computation revision for stored computed greeks; null for provider-native values.",
            hypothesis: false,
          },
          rate_type: {
            description: "Interest-rate curve or rate label used by the provider or computed-greeks path.",
            hypothesis: false,
          },
          rate_value: {
            description: "Interest-rate value used by the provider or computed-greeks path.",
            hypothesis: false,
          },
          gamma_source: {
            description: "Provenance label for the stored gamma value when it differs from the broader greeks source.",
            hypothesis: false,
          },
        },
      },
    },
  },
};

// ============================================================================
// Example Queries
// ============================================================================

export const EXAMPLE_QUERIES: ExampleQueries = {
  basic: [
    {
      description: "Count trades by strategy with total P&L",
      sql: `SELECT strategy, COUNT(*) as trades, SUM(pl) as total_pl
FROM trades.trade_data
GROUP BY strategy
ORDER BY total_pl DESC`,
    },
    {
      description: "Daily P&L for a specific block",
      sql: `SELECT date_opened, SUM(pl) as daily_pl
FROM trades.trade_data
WHERE block_id = 'my-block'
GROUP BY date_opened
ORDER BY date_opened`,
    },
    {
      description: "Recent market conditions (last 20 days)",
      sql: `SELECT d.date, s.close, d.RSI_14, d.ATR_Pct,
  vix_s.close AS VIX_Close, cd.Vol_Regime, cd.Term_Structure_State, evix.ivr AS VIX_IVR, evix.ivp AS VIX_IVP
FROM market.enriched d
LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'
LEFT JOIN market.enriched_context cd ON cd.date = d.date
WHERE d.ticker = 'SPX'
ORDER BY d.date DESC
LIMIT 20`,
    },
    {
      description: "Win/loss summary by block",
      sql: `SELECT
  block_id,
  COUNT(*) as total_trades,
  SUM(CASE WHEN pl > 0 THEN 1 ELSE 0 END) as winners,
  SUM(CASE WHEN pl <= 0 THEN 1 ELSE 0 END) as losers,
  ROUND(100.0 * SUM(CASE WHEN pl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
FROM trades.trade_data
GROUP BY block_id
ORDER BY block_id`,
    },
    {
      description: "Filter and paginate trades (replaces get_trades)",
      sql: `SELECT date_opened, time_opened, strategy, legs, pl, num_contracts
FROM trades.trade_data
WHERE block_id = 'my-block'
  AND strategy ILIKE '%iron%'
  AND pl > 0
ORDER BY date_opened DESC
LIMIT 50 OFFSET 0`,
    },
    {
      description: "Market data query with VIX context",
      sql: `SELECT d.date, s.close, d.Gap_Pct, vix_s.close AS VIX_Close, cd.Vol_Regime, cd.Term_Structure_State
FROM market.enriched d
LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
LEFT JOIN market.enriched_context cd ON cd.date = d.date
WHERE d.ticker = 'SPX'
  AND d.date BETWEEN '2024-01-01' AND '2024-06-30'
  AND vix_s.close > 20
ORDER BY d.date`,
    },
    {
      description: "Compare backtest vs actual trades by date/strategy",
      sql: `SELECT
  t.date_opened, t.strategy, t.legs as bt_legs, r.legs as actual_legs,
  t.pl as bt_pl, r.pl as actual_pl, r.pl - t.pl as slippage
FROM trades.trade_data t
JOIN trades.reporting_data r
  ON t.block_id = r.block_id
  AND t.date_opened = r.date_opened
  AND t.strategy = r.strategy
WHERE t.block_id = 'my-block'
ORDER BY t.date_opened`,
    },
  ],
  joins: [
    {
      description: "Trade P&L with market context (lag-aware: multi-table JOIN before LAG for correctness)",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date,
    d.Gap_Pct, d.Prior_Close, d.Prev_Return_Pct,
    vix_s.open AS VIX_Open,
    d.RSI_14, d.Realized_Vol_20D,
    vix_s.close AS VIX_Close, evix.ivp AS VIX_IVP, cd.Vol_Regime, cd.Term_Structure_State
  FROM market.enriched d
  LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
  LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
  LEFT JOIN market.enriched evix ON evix.date = d.date AND evix.ticker = 'VIX'
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(RSI_14) OVER (PARTITION BY ticker ORDER BY date) AS prev_RSI_14,
    LAG(VIX_IVP) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_IVP,
    LAG(VIX_Close) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_Close,
    LAG(Vol_Regime) OVER (PARTITION BY ticker ORDER BY date) AS prev_Vol_Regime
  FROM joined
)
SELECT
  t.date_opened, t.strategy, t.pl,
  m.Gap_Pct, m.VIX_Open,
  m.prev_RSI_14, m.prev_VIX_IVP, m.prev_VIX_Close, m.prev_Vol_Regime
FROM trades.trade_data t
JOIN lagged m ON t.date_opened = m.date
WHERE t.block_id = 'my-block'
ORDER BY t.date_opened DESC`,
    },
    {
      description: "Trades with ORB context (opening range breakout from minute bars in market.spot)",
      sql: `WITH orb_range AS (
  SELECT ticker, date,
    MAX(high) AS ORB_High,
    MIN(low)  AS ORB_Low,
    MAX(high) - MIN(low) AS ORB_Range
  FROM market.spot
  WHERE ticker = 'SPX'
    AND time >= '09:30' AND time <= '09:45'
    -- Drop minute bars with zero/null OHLC (occasional provider gaps).
    -- Without this, MIN(low) collapses to 0 on contaminated minutes
    -- and ORB_Range balloons to ~100% of price.
    AND open IS NOT NULL AND open > 0
    AND high IS NOT NULL AND high > 0
    AND low  IS NOT NULL AND low  > 0
    AND close IS NOT NULL AND close > 0
  GROUP BY ticker, date
)
SELECT
  t.date_opened, t.strategy, t.pl,
  r.ORB_High, r.ORB_Low, r.ORB_Range
FROM trades.trade_data t
LEFT JOIN orb_range r ON t.date_opened = r.date
WHERE t.block_id = 'my-block'
ORDER BY t.date_opened`,
    },
    {
      description: "VIX intraday data for a specific date (VIX bars are in market.spot with ticker='VIX')",
      sql: `SELECT time, open, high, low, close
FROM market.spot
WHERE ticker = 'VIX'
  AND date = '2024-03-15'
ORDER BY time`,
    },
    {
      description: "Trades on reversal days (lag-aware: Reversal_Type uses prior trading day via LAG)",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date,
    d.High_Before_Low, d.Reversal_Type
  FROM market.enriched d
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(Reversal_Type) OVER (PARTITION BY ticker ORDER BY date) AS prev_Reversal_Type,
    LAG(High_Before_Low) OVER (PARTITION BY ticker ORDER BY date) AS prev_High_Before_Low
  FROM joined
)
SELECT
  t.date_opened, t.strategy, t.pl,
  m.prev_Reversal_Type, m.prev_High_Before_Low
FROM trades.trade_data t
JOIN lagged m ON t.date_opened = m.date
WHERE m.prev_Reversal_Type != 0
  AND t.block_id = 'my-block'`,
    },
    {
      description: "Enrich trades with market data (lag-aware: use enrich_trades tool for full enrichment)",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date,
    d.Gap_Pct, d.Prior_Close,
    vix_s.open AS VIX_Open,
    d.RSI_14, d.ATR_Pct,
    vix_s.close AS VIX_Close, cd.Vol_Regime
  FROM market.enriched d
  LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
  LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(VIX_Close) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_Close,
    LAG(Vol_Regime) OVER (PARTITION BY ticker ORDER BY date) AS prev_Vol_Regime
  FROM joined
)
SELECT t.date_opened, t.strategy, t.pl,
  m.Gap_Pct, m.VIX_Open, m.prev_VIX_Close, m.prev_Vol_Regime
FROM trades.trade_data t
LEFT JOIN lagged m ON t.date_opened = m.date
WHERE t.block_id = 'my-block'`,
    },
  ],
  hypothesis: [
    {
      description: "Win rate by VIX regime (lag-aware: uses prior day's Vol_Regime from market.enriched_context)",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date, cd.Vol_Regime
  FROM market.enriched d
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(Vol_Regime) OVER (PARTITION BY ticker ORDER BY date) AS prev_Vol_Regime
  FROM joined
)
SELECT
  m.prev_Vol_Regime AS vol_regime,
  COUNT(*) as trades,
  SUM(CASE WHEN t.pl > 0 THEN 1 ELSE 0 END) as winners,
  ROUND(100.0 * SUM(CASE WHEN t.pl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
  SUM(t.pl) as total_pl
FROM trades.trade_data t
JOIN lagged m ON t.date_opened = m.date
WHERE t.block_id = 'my-block'
  AND m.prev_Vol_Regime IS NOT NULL
GROUP BY m.prev_Vol_Regime
ORDER BY m.prev_Vol_Regime`,
    },
    {
      description: "P&L by day of week",
      sql: `SELECT
  d.Day_of_Week,
  COUNT(*) as trades,
  SUM(t.pl) as total_pl,
  ROUND(AVG(t.pl), 2) as avg_pl
FROM trades.trade_data t
JOIN market.enriched d ON t.date_opened = d.date AND d.ticker = 'SPX'
WHERE t.block_id = 'my-block'
GROUP BY d.Day_of_Week
ORDER BY d.Day_of_Week`,
    },
    {
      description: "Performance by VIX term structure (lag-aware: uses prior day's Term_Structure_State from market.enriched_context)",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date, cd.Term_Structure_State
  FROM market.enriched d
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(Term_Structure_State) OVER (PARTITION BY ticker ORDER BY date) AS prev_Term_Structure_State
  FROM joined
)
SELECT
  CASE WHEN m.prev_Term_Structure_State = -1 THEN 'Backwardation'
       WHEN m.prev_Term_Structure_State = 1 THEN 'Contango'
       ELSE 'Flat' END as term_structure,
  COUNT(*) as trades,
  SUM(t.pl) as total_pl,
  ROUND(AVG(t.pl), 2) as avg_pl,
  ROUND(100.0 * SUM(CASE WHEN t.pl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
FROM trades.trade_data t
JOIN lagged m ON t.date_opened = m.date
WHERE t.block_id = 'my-block'
  AND m.prev_Term_Structure_State IS NOT NULL
GROUP BY term_structure`,
    },
    {
      description: "Aggregate by VIX buckets (lag-aware: uses prior day's VIX close from market.spot_daily ticker='VIX')",
      sql: `WITH joined AS (
  SELECT d.ticker, d.date, vix_s.close AS VIX_Close
  FROM market.enriched d
  LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
  WHERE d.ticker = 'SPX'
),
lagged AS (
  SELECT *,
    LAG(VIX_Close) OVER (PARTITION BY ticker ORDER BY date) AS prev_VIX_Close
  FROM joined
)
SELECT
  CASE
    WHEN m.prev_VIX_Close < 15 THEN '10-15'
    WHEN m.prev_VIX_Close < 20 THEN '15-20'
    WHEN m.prev_VIX_Close < 25 THEN '20-25'
    ELSE '25+'
  END as vix_bucket,
  COUNT(*) as trades,
  SUM(CASE WHEN t.pl > 0 THEN 1 ELSE 0 END)::FLOAT / COUNT(*) as win_rate,
  SUM(t.pl) as total_pl
FROM trades.trade_data t
JOIN lagged m ON t.date_opened = m.date
WHERE t.block_id = 'my-block'
  AND m.prev_VIX_Close IS NOT NULL
GROUP BY vix_bucket
ORDER BY vix_bucket`,
    },
    {
      description: "Find similar days by conditions",
      sql: `WITH ref AS (
  SELECT s.close, vix_s.close AS VIX_Close, cd.Vol_Regime, cd.Term_Structure_State
  FROM market.enriched d
  LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
  LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
  LEFT JOIN market.enriched_context cd ON cd.date = d.date
  WHERE d.ticker = 'SPX' AND d.date = '2024-01-15'
)
SELECT d.date, s.close, vix_s.close AS VIX_Close, cd.Vol_Regime, cd.Term_Structure_State
FROM market.enriched d
LEFT JOIN market.spot_daily s ON s.ticker = d.ticker AND s.date = d.date
LEFT JOIN market.spot_daily vix_s ON vix_s.date = d.date AND vix_s.ticker = 'VIX'
LEFT JOIN market.enriched_context cd ON cd.date = d.date, ref
WHERE d.ticker = 'SPX'
  AND d.date != '2024-01-15'
  AND cd.Vol_Regime = ref.Vol_Regime
  AND ABS(vix_s.close - ref.VIX_Close) < 3
ORDER BY ABS(vix_s.close - ref.VIX_Close)
LIMIT 20`,
    },
  ],
};
