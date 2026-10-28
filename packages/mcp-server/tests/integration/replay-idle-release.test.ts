/**
 * Integration test: explicit-leg replay after the analytics handle has been
 * released when idle (#445, tradeblocks#585).
 *
 * The tool lease only keeps an OPEN handle open; it does not reopen a released
 * one. Tradelog replay opens the handle itself, and explicit-leg replay must too,
 * or every store read throws "No active DuckDB connection" once the server has
 * sat idle for the release grace. Exercised through the registered tool behind
 * the production lease wrapper, over Parquet quotes read through a store context
 * that resolves the current handle on every access (as src/index.ts wires it).
 */
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { DuckDBInstance } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  acquireConnectionLease,
  closeConnection,
  getConnection,
  getConnectionLeaseCount,
  getCurrentConnection,
  isConnected,
  releaseConnectionLease,
} from "../../src/db/connection.ts";
import { leaseToolHandlers } from "../../src/tools/middleware/connection-lease.ts";
import { registerReplayTools, replayTradeSchema } from "../../src/tools/replay.ts";
import { createMarketStores, type MarketStores } from "../../src/market/stores/index.ts";
import { TickerRegistry } from "../../src/market/tickers/registry.ts";
import type { QuoteRow } from "../../src/market/stores/types.ts";
import { buildTestStores } from "../fixtures/market-stores/build-stores.ts";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (params: unknown, extra: unknown) => Promise<ToolResult>;

// Real time on purpose: the release under test is connection.ts's own timer
// closing a real DuckDB handle, so the suite polls for the observable state (as
// duckdb-idle-release.test.ts does) with a short grace instead of faking clocks.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const QUOTE_DATE = "2025-01-17";
const SHORT_PUT = "SPXW250124P05900000";
const LONG_PUT = "SPXW250124P05800000";

function quoteRows(): QuoteRow[] {
  const rows: QuoteRow[] = [];
  const marks: Array<[string, number, number]> = [
    ["09:32", 5.1, 3.05],
    ["09:33", 5.3, 3.2],
    ["09:34", 4.8, 2.7],
  ];
  for (const [time, shortMid, longMid] of marks) {
    rows.push({
      occ_ticker: SHORT_PUT,
      timestamp: `${QUOTE_DATE} ${time}`,
      bid: shortMid - 0.05,
      ask: shortMid + 0.05,
    });
    rows.push({
      occ_ticker: LONG_PUT,
      timestamp: `${QUOTE_DATE} ${time}`,
      bid: longMid - 0.05,
      ask: longMid + 0.05,
    });
  }
  return rows;
}

describe("replay_trade explicit legs after the idle handle release", () => {
  let testDir: string;
  let stores: MarketStores;
  let replayTool: ToolHandler;
  const savedIdleMs = process.env.DUCKDB_IDLE_RELEASE_MS;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "tb-replay-idle-"));
    process.env.DUCKDB_IDLE_RELEASE_MS = "150";

    // Seed the Parquet quote partition through a private writer connection; the
    // server's own handle opens read-only.
    const writer = await DuckDBInstance.create(":memory:");
    const writerConn = await writer.connect();
    await buildTestStores({
      conn: writerConn,
      dataDir: testDir,
      parquetMode: true,
    }).quote.writeQuotes("SPX", QUOTE_DATE, quoteRows());
    writerConn.closeSync();

    await getConnection(testDir);
    stores = createMarketStores({
      get conn() {
        return getCurrentConnection();
      },
      dataDir: testDir,
      parquetMode: true,
      tickers: new TickerRegistry([{ underlying: "SPX", roots: ["SPX", "SPXW"] }]),
    });

    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool(name: string, _config: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerReplayTools(leaseToolHandlers(server), testDir, stores);
    replayTool = handlers.get("replay_trade")!;
  }, 60000);

  afterEach(async () => {
    while (getConnectionLeaseCount() > 0) releaseConnectionLease();
    await closeConnection();
    if (savedIdleMs === undefined) delete process.env.DUCKDB_IDLE_RELEASE_MS;
    else process.env.DUCKDB_IDLE_RELEASE_MS = savedIdleMs;
    await fs.rm(testDir, { recursive: true, force: true });
  }, 60000);

  const callReplay = () =>
    replayTool(
      replayTradeSchema.parse({
        legs: [
          {
            ticker: "SPXW",
            strike: 5900,
            type: "P",
            expiry: "2025-01-24",
            quantity: -1,
            entry_price: 5.1,
          },
          {
            ticker: "SPXW",
            strike: 5800,
            type: "P",
            expiry: "2025-01-24",
            quantity: 1,
            entry_price: 3.05,
          },
        ],
        open_date: QUOTE_DATE,
        close_date: QUOTE_DATE,
        format: "full",
      }),
      {},
    );

  test("replays the same result with a released handle as with a live one", async () => {
    // Live: hold a lease so the handle cannot be released under the call.
    acquireConnectionLease();
    await getConnection(testDir);
    const live = await callReplay();
    releaseConnectionLease();
    expect(live.content[0].text).toMatch(/^Replayed 2-leg strategy/);
    expect((live.structuredContent?.pnlPath as unknown[]).length).toBe(3);

    await waitFor(() => !isConnected(), 5000, "the idle handle to be released");

    const released = await callReplay();

    expect(released.isError ? released.content[0].text : null).toBeNull();
    expect(released.structuredContent).toEqual(live.structuredContent);
    // Idle release still works afterwards: the call reopened, it did not pin.
    await waitFor(() => !isConnected(), 5000, "the reopened handle to be released");
  }, 60000);
});
