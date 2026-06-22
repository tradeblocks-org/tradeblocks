/**
 * Guide Tools
 *
 * Provides backtesting help content as an MCP tool.
 * Replaces the old optionomega-guide resource, since resources
 * aren't supported by most MCP clients (Codex, Julius AI, etc.).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolOutput } from "../utils/output-formatter.ts";

// ============================================================================
// Topic content
// ============================================================================

const TOPICS: Record<string, { title: string; content: string }> = {
  overview: {
    title: "Option Omega Backtest Overview",
    content: `## Supported Assets
SPY, SPX (afternoon expirations only), QQQ, IWM, AAPL, TSLA

## Date Range
- Start Date and End Date define the backtest period
- Quick-select presets for popular timeframes
- Arrow button to auto-populate the last available trading day

## Data Availability
- Historical data from January 1, 2013 through previous trading day
- Data updates overnight (3-5am ET), available before market open
- Uses mid-price from OPRA bid/ask data
- 1-minute resolution (open price for signals)
- RTH only (9:30-4:00 market time)
- SPX uses standard EOD contracts only (no AM expirations)
- Calendar days for DTE calculations

## High-Level Capabilities
- Backtest options strategies with up to 8 legs
- Pre-built strategies (iron condors, straddles, verticals, etc.) or fully custom
- Granular entry filters (VIX, technicals, ORB, gaps, short/long ratio)
- Flexible exit conditions (P/L targets, stops, time-based, delta-based)
- Risk controls (commissions, slippage, bid-ask filtering, blackout dates)
- Export trade logs as CSV for TradeBlocks analysis

## Data Quality Notes
- March 2020 / Spring 2025 show unusual volatility
- Afternoon SPX expirations only (no 0DTE AM contracts)`,
  },

  strategies: {
    title: "Pre-Built & Custom Strategies",
    content: `## Pre-Built Strategy Templates
Option Omega includes templates — don't default to simple strategies when more complex ones may fit better:
- **Single-leg**: Long Call, Long Put, Short Call, Short Put
- **Vertical spreads**: Long Call Spread, Long Put Spread, Short Call Spread
- **Iron strategies**: Iron Condor, Iron Fly (iron butterfly)
- **Volatility**: Short Straddle, Short Strangle
- **Calendar/time-based**: Calendar, Double Calendar
- **Multi-leg**: Butterfly, Ratio Spread, Jade Lizard
- Or fully custom with up to 8 legs

## Custom Legs
- Up to 8 legs per backtest
- Each leg: buy/sell, call/put, quantity, DTE, with independent strike selection
- Linked (dependent) legs for spreads where one leg's strike depends on another

## Linked Leg Details
- **Strike Offset**: child leg positioned by width from parent (e.g., buy put 5 strikes below short put)
- **Exact Strike Offset**: padlock toggle — when locked, uses exact offset; when unlocked, selects nearest directional strike
- **Delta/Premium with Max Width**: child leg selected by delta or premium, constrained by maximum width distance from parent

## Leg Groups
Single Entry Multi Exit — open all legs together but assign separate exit rules per group.
Useful for strategies like "take profit on one spread while trailing stop on another."`,
  },

  strike_selection: {
    title: "Strike Selection Methods",
    content: `## Delta
Select strikes by target delta value (e.g., 16-delta put).
Most common method — delta-neutral strategies use this.

## Percentage OTM
Target a specific percentage out-of-the-money distance from underlying.

## Fixed Premium
Choose the strike nearest a specified option price (e.g., $1.00 credit).

## Strike Offset
Position relative to a parent leg — used for linked legs in spreads.
Example: "buy the put 5 strikes below the short put."

## Rounding
Round strikes to nearest multiples for liquidity (e.g., round to nearest 5 on SPX).

## Exact DTE
Specify target days to expiration. Option Omega finds the nearest available expiration.`,
  },

  entry_conditions: {
    title: "Entry Conditions & Filters",
    content: `## Timing
- Entry window: 9:32am - 3:59pm ET (1-minute intervals)
- **Fixed time**: enter at a specific time each day (e.g., always at 9:35am)
- **Floating time**: enter at the first minute within a window where all entry conditions are met

## Frequency
- Daily: enter every trading day
- Weekly: specific day(s) of week
- Monthly: specific date(s) of month
- Specific Dates: manually chosen dates only

## VIX Filters
- **Min/Max VIX level**: absolute VIX value range (e.g., only enter when VIX between 15-30)
- **Overnight Move Up/Down**: min/max VIX moved up or down from prior close to current open (% or points)
- **Intraday Move Up/Down**: min/max VIX moved up or down since today's open (% or points)
- **VIX9D / VIX Ratio**: min/max ratio of 9-day VIX to standard VIX (term structure signal)

## Technical Indicators
- **RSI**: min/max RSI range filter (e.g., only enter when RSI between 30-70)
- **SMA Entry**: price above/below SMA, or Compare SMA (SMA of N days > SMA of M days). Period in days.
- **EMA Entry**: price above/below EMA, or Compare EMA (EMA of N min > EMA of M min). Period in minutes.

## Opening Range Breakout (ORB)
- **Opening Range End Time**: end of ORB window (starts at market open)
- **Breakout Condition**: High and Low, High-Only, Low-Only, or No Breakout
- **Use High-Low Values**: by default, only 1-minute opening prices are used to calculate the range; toggle to use high/low values instead

## Gap Conditions
- **Min/Max Gap Up %**: only enter when underlying gaps up within this range
- **Min/Max Gap Down %**: only enter when underlying gaps down within this range

## Intraday Movement
- **Min/Max Move Up %**: only enter when underlying has moved up from open within this range
- **Min/Max Move Down %**: only enter when underlying has moved down from open within this range

## Entry Short/Long Ratio
- **Min/Max Short/Long Ratio**: total short premium divided by total long premium. Filter trades that open within this ratio range.

## Multiple Entries
Can configure multiple entries per day if conditions are met at different times.`,
  },

  exit_conditions: {
    title: "Exit Conditions",
    content: `## Profit Target & Stop Loss
Profit target and stop loss modes:
- **Percentage of Premium (%)**: percentage of credit/debit received
- **Fixed Loss ($)**: dollar amount in terms of premium, not absolute (e.g., $5.00 not $500)
- **Closing Order (CO)**: exit when position can be closed at target price (in premium terms)

## Trailing Stop Loss
- **Start Trailing after minimum PT**: optionally set a minimum profit target before trailing begins. If no value, trails from trade open.
- **Mode**: Percentage of Premium (%) or Fixed Profit ($)
- **Trail type**: Recalculated (adjusts continuously as position moves favorably) or Fixed (locks in once threshold reached)

Additional stop options:
- **Per-Leg Stop Loss**: select specific leg(s) — entire trade is closed when any selected leg's stop loss is reached
- **0-DTE Intra-Minute Stop Loss**: uses high and low contract values within a 1-minute bar. Only available for SPX/SPY, and only when all contracts are 0 DTE. Options: NBBO + Trades, NBBO Only, Trades Only.

## Profit Actions
Staged profit-taking — add multiple actions that trigger at different profit levels:
- **At Profit Target %**: the profit threshold that triggers the action
- **Close Allocation %**: percentage of position to close at that target
- **Adjust Stop Loss To %**: move the stop loss to a new level when target is hit
- Can add multiple profit actions (e.g., close 50% at 50% profit, then trail the rest)

## Early Exit (Time-Based)
- **Early Exit Type**: DTE (days to expiration), DIT (days in trade), or MIT (minutes in trade)
- **Early Exit Time**: specific time of day to execute the early exit

## Time Actions
Staged time-based actions — add multiple actions that trigger at different time thresholds:
- **Action Type**: DTE, DIT, or MIT
- **Action Time**: the time value that triggers the action
- **Close Allocation %**: percentage of position to close
- **Adjust Stop Loss %**: move stop loss to a new level
- **Adjust Profit Target %**: move profit target to a new level
- Can add multiple time actions (e.g., tighten stops after 2 DIT, close 50% at 1 DTE)

## Technical Indicator Exits
Same options as entry but trigger an exit while in trade:
- **RSI**: exit when RSI moves outside min/max range
- **SMA Exit**: price above/below SMA, or Compare SMA. Period in days.
- **EMA Exit**: price above/below EMA, or Compare EMA. Period in minutes.

## Underlying Price Movement Exits
- **Exit When Underlying Price Moves Up/Down**: exit when underlying moves X% or X points from entry
- **Exit When OTM Short Put is X% or X points from underlying**: exit when short put gets close to being tested (only shown when trading puts)
- **Exit When OTM Short Call is X% or X points from underlying**: exit when short call gets close to being tested (only shown when trading calls)

## Delta-Based Exits
- **Exit Below/Above Position Delta**: exit when overall position delta crosses a threshold
- **Per-Leg Delta**: select a specific leg and set Exit Below/Above Leg Delta thresholds (can add multiple leg rules)

## VIX-Based Exits
- **Exit When VIX Moves Up/Down**: exit when VIX moves up or down by X% or X points while in trade
- **Exit When VIX9D Moves Up/Down**: exit when 9-day VIX moves up or down by X% or X points
- **Exit below/above VIX9D / VIX Ratio**: exit when the VIX9D/VIX ratio crosses a threshold

## Short/Long Ratio Exits
- **Exit When S/L Ratio is Below/Above**: exit when the short/long premium ratio crosses a threshold
- **Exit When S/L Ratio Moves Down/Up %**: exit when the ratio changes by X% while in trade

## Re-Entry
Automatically re-enter a trade after it closes, using the same strategy (deltas, DTE, etc.). Only re-enters if other entry conditions (VIX, GEX, SMA, etc.) are still satisfied. Cannot be used with multiple entry times.
- **Re-enter after exit conditions**: select which exit condition(s) trigger re-entry
- **Delay re-entry by**: wait N minutes after exit before re-entering
- **Don't re-enter if exited before/after**: time-of-day window restrictions
- **Maximum Daily Re-Entries**: cap on how many re-entries per day`,
  },

  risk_controls: {
    title: "Risk Controls (The Punisher)",
    content: `## Commission & Fee Modeling
Per-contract commissions for realistic P&L (e.g., $0.65/contract).

## Slippage Adjustments
Separate slippage settings for:
- Entry fills
- Exit fills
- Stop loss fills (typically wider)

## Bid-Ask Spread Filter
Default: 10,000 bps max spread. Skip entries where the spread is too wide (illiquid strikes).

## Consecutive Hits Requirement
Separate toggles for profit target and stop loss. Requires 2 consecutive 1-minute intervals at the target/stop before triggering. Reduces false fills from momentary spikes — important for trade robustness.

## Premium Filters
- **Min/Max Entry Premium**: dollar amount range for entry premium
- Toggle between **Credit** or **Debit** mode depending on strategy type

## Cap Non-Opening Profits/Losses
- **Cap Non-Opening Profits at Profit Target**: if a trade opens already past the profit target (e.g., gap), cap the profit at the target amount instead of using the inflated value. Important for realistic backtest results.
- **Cap Non-Opening Losses at Stop Loss**: same for losses — cap at stop loss amount instead of the actual (worse) fill.

## Blackout Days
Skip trading on specific dates or event types:
- FOMC meeting days
- OPEX (options expiration) days
- Short/holiday weeks (e.g., Thanksgiving week)
- Earnings dates (for single-stock underlyings)
- Custom dates (manually specified)`,
  },

  capital_allocation: {
    title: "Capital & Position Sizing",
    content: `## Starting Funds
Initial portfolio value for the backtest.

## Margin Percentage
Percentage of portfolio used for margin calculations.

## Max Contracts
Hard cap on contracts per trade.

## Max Allocation
Maximum percentage of portfolio allocated to any single trade.

## Max Open Trades
Limit on simultaneous open positions.

## Prune Oldest
When max open trades is hit, optionally close the oldest position to make room for new entries.

## Ignore Margin Requirements
Available when Max Contracts Per Trade is set. Useful for backtesting a thesis without margin constraints.`,
  },

  leg_groups: {
    title: "Leg Groups",
    content: `## What Are Leg Groups?
Leg groups allow entering as a single trade, while exiting the legs in separate groups (each with its own set of exit conditions).

## How It Works
1. Define legs as normal (up to 8)
2. Create named groups and assign legs to each group (drag to reorder)
3. Each group gets its own independent profit target and stop loss
4. Entry is unified — all legs open at the same time
5. Groups exit independently when their P/L conditions are met

## Use Cases
- Take profit on one spread while trailing stop on another
- Close short legs at target while letting long legs run
- Different time-based exits for different parts of the position
- Example: iron condor with put spread in Group A (tight stop) and call spread in Group B (wider stop)`,
  },

  exporting: {
    title: "Exporting for TradeBlocks",
    content: `## Export Steps
1. Run your backtest in Option Omega
2. Go to Results → Trade Log
3. Click Export/Download CSV
4. Create a new folder in your Trading Data Directory (e.g., \`my-strategy-2024\`)
5. Save the CSV as \`tradelog.csv\` in that folder
6. Run \`list_blocks\` to see your new block

## Expected Columns
TradeBlocks expects these columns (Option Omega exports them automatically):
- Date Opened, Time Opened
- Date Closed, Time Closed
- P/L, Strategy, Legs
- No. of Contracts, Premium
- Opening/Closing Prices
- Reason For Close

## Tips
- Use descriptive folder names — the folder name becomes the block ID
- You can organize backtests in subdirectories
- Re-export and overwrite tradelog.csv to update a block

**Note**: The visual context from Option Omega's trade log (replay, charts) is lost in CSV export. TradeBlocks provides its own analysis tools to compensate.`,
  },
};

// ============================================================================
// Tool registration
// ============================================================================

/**
 * Register guide tools (no baseDir needed — static content only)
 */
export function registerGuideTools(server: McpServer): void {
  server.registerTool(
    "get_backtest_help",
    {
      description:
        "Get Option Omega backtesting guidance. Covers strategy setup, strike selection, " +
        "entry/exit conditions, risk controls, capital allocation, leg groups, and exporting " +
        "results for TradeBlocks analysis. Call with topic='overview' first for orientation.",
      inputSchema: z.object({
        topic: z
          .enum([
            "overview",
            "strategies",
            "strike_selection",
            "entry_conditions",
            "exit_conditions",
            "risk_controls",
            "capital_allocation",
            "leg_groups",
            "exporting",
          ])
          .describe("Help topic to retrieve"),
        subtopic: z
          .string()
          .optional()
          .describe(
            "Optional keyword to narrow results within the topic (e.g., 'trailing' within exit_conditions)",
          ),
      }),
    },
    async ({ topic, subtopic }) => {
      const entry = TOPICS[topic];
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Unknown topic: ${topic}` }],
          isError: true as const,
        };
      }

      let { content } = entry;

      // If subtopic provided, filter to sections containing the keyword
      if (subtopic) {
        const keyword = subtopic.toLowerCase();
        const sections = content.split(/\n(?=## )/);
        const matched = sections.filter((s) => s.toLowerCase().includes(keyword));
        if (matched.length > 0) {
          content = matched.join("\n\n");
        }
        // If no match, return full content (better than empty)
      }

      const allTopics = Object.keys(TOPICS);

      return createToolOutput(
        `${entry.title} — use other topics for more detail: ${allTopics.filter((t) => t !== topic).join(", ")}`,
        { topic, title: entry.title, content, availableTopics: allTopics },
      );
    },
  );
}
