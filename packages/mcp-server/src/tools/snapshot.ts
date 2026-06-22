/**
 * Option Snapshot Tools
 *
 * MCP tool for fetching live option chain snapshots from Massive.com.
 * Returns current greeks, IV, open interest, and quotes for option contracts
 * on a specified underlying.
 *
 * Tools registered:
 *   - get_option_snapshot — Fetch live option chain with greeks/IV/OI
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProvider } from "../utils/market-provider.ts";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const getOptionSnapshotSchema = z.object({
  underlying: z.string().describe("Underlying ticker symbol (e.g., 'SPX', 'SPY', 'AAPL')"),
  strike_price_gte: z.number().optional().describe("Minimum strike price filter"),
  strike_price_lte: z.number().optional().describe("Maximum strike price filter"),
  expiration_date_gte: z.string().optional().describe("Earliest expiration date (YYYY-MM-DD)"),
  expiration_date_lte: z.string().optional().describe("Latest expiration date (YYYY-MM-DD)"),
  contract_type: z.enum(["call", "put"]).optional().describe("Filter by call or put"),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe("Max contracts to return (default 50, use higher for full chain)"),
});

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleGetOptionSnapshot(
  params: z.infer<typeof getOptionSnapshotSchema>,
): Promise<string> {
  try {
    const {
      underlying,
      strike_price_gte,
      strike_price_lte,
      expiration_date_gte,
      expiration_date_lte,
      contract_type,
      limit,
    } = params;

    const result = await getProvider().fetchOptionSnapshot({
      underlying,
      strike_price_gte,
      strike_price_lte,
      expiration_date_gte,
      expiration_date_lte,
      contract_type,
    });

    // Client-side limit truncation: API fetches all filtered contracts
    // (ensuring BS fallback runs on all), then we truncate for presentation
    const contractsTotal = result.contracts.length;
    const contracts =
      limit != null && contractsTotal > limit ? result.contracts.slice(0, limit) : result.contracts;

    return JSON.stringify({
      underlying_ticker: result.underlying_ticker,
      underlying_price: result.underlying_price,
      contracts_returned: contracts.length,
      contracts_total: contractsTotal,
      contracts,
    });
  } catch (error) {
    return JSON.stringify({
      error: (error as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSnapshotTools(server: McpServer): void {
  server.registerTool(
    "get_option_snapshot",
    {
      description:
        "Fetch live option chain snapshot with greeks, IV, open interest, and quotes from Massive.com. " +
        "Returns current market data for option contracts on the specified underlying. " +
        "Use filters to narrow by strike range, expiration range, or call/put type. " +
        "Replaces TastyTrade get_option_chain for analysis.",
      inputSchema: getOptionSnapshotSchema,
    },
    async (params) => {
      const text = await handleGetOptionSnapshot(params);
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
