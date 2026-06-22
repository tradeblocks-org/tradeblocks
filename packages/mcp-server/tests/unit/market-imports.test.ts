/**
 * Unit tests for tools/market-imports.ts auto-enrich composition.
 *
 * Covers the tool-handler-level composition contract that the integration
 * suite at `tests/integration/market-imports-v2.test.ts` exercises
 * end-to-end:
 *
 *   1. spot.writeBars BEFORE enriched.compute (composition order)
 *   2. VIX-family triggers enriched.computeContext AFTER compute (compose order)
 *   3. Non-VIX ticker does NOT trigger computeContext
 *   4. skip_enrichment=true → writeBars only, no compute / computeContext
 *   5. dry_run=true → neither writeBars nor compute / computeContext
 *   6. Error propagation: writeBars throws → isError:true, compute NOT called
 *   7. Error propagation: compute throws AFTER writeBars succeeds → isError:true
 *      (loud failure — spot data was written but enrichment failed)
 *
 * Mocking strategy: every store method is replaced with a jest.fn() spy that
 * appends a typed marker into a shared `calls` array. We assert composition by
 * inspecting the array — no real DuckDB I/O.
 *
 * The tool handler still calls `upgradeToReadWrite(baseDir)` /
 * `downgradeToReadOnly` which act on a real `<baseDir>/analytics.duckdb`
 * file. We give it a tmp baseDir so the lifecycle is harmless. The store
 * conns are independent (mocked) so the RW lifecycle does not invalidate
 * them.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { registerMarketImportTools } from "../../src/tools/market-imports.ts";
import { closeConnection } from "../../src/test-exports.ts";
import type { MarketStores } from "../../src/market/stores/index.ts";
import type { BarRow } from "../../src/market/stores/types.ts";

// ---------------------------------------------------------------------------
// Tool capture harness
// ---------------------------------------------------------------------------

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text" | "resource"; text?: string; resource?: { text: string } }>;
  isError?: boolean;
}>;

interface CapturedTool {
  config: unknown;
  handler: ToolHandler;
}

function makeServer() {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    server: {
      registerTool(name: string, config: unknown, handler: ToolHandler) {
        tools.set(name, { config, handler });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock stores — record call order via a shared `calls` array.
// ---------------------------------------------------------------------------

interface MockStoresHandle {
  stores: MarketStores;
  calls: string[];
  spotWriteBars: jest.Mock;
  enrichedCompute: jest.Mock;
  enrichedComputeContext: jest.Mock;
}

function makeMockStores(
  opts: {
    writeBarsRejects?: Error;
    computeRejects?: Error;
  } = {},
): MockStoresHandle {
  const calls: string[] = [];
  const spotWriteBars = jest.fn(async (ticker: string, date: string, bars: BarRow[]) => {
    calls.push(`spot.writeBars(${ticker},${date},${bars.length})`);
    if (opts.writeBarsRejects) throw opts.writeBarsRejects;
  });
  const enrichedCompute = jest.fn(async (ticker: string, from: string, to: string) => {
    calls.push(`enriched.compute(${ticker},${from},${to})`);
    if (opts.computeRejects) throw opts.computeRejects;
  });
  const enrichedComputeContext = jest.fn(async (from: string, to: string) => {
    calls.push(`enriched.computeContext(${from},${to})`);
  });

  // Cast through unknown — the handler only touches spot.writeBars + enriched
  // .compute / .computeContext. Other methods are untouched and never invoked.
  const stores = {
    spot: { writeBars: spotWriteBars },
    enriched: { compute: enrichedCompute, computeContext: enrichedComputeContext },
    chain: {},
    quote: {},
  } as unknown as MarketStores;

  return { stores, calls, spotWriteBars, enrichedCompute, enrichedComputeContext };
}

// ---------------------------------------------------------------------------
// Fixture CSV — written to a tmp file in beforeEach, reused across tests.
// ---------------------------------------------------------------------------

const FIXTURE_CSV =
  "date,time,open,high,low,close,volume\n" +
  "2025-01-02,09:30,4700,4705,4699,4702,1000\n" +
  "2025-01-02,16:00,4750,4751,4748,4749,1500\n";

const COLUMN_MAPPING: Record<string, string> = {
  date: "date",
  time: "time",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tools/market-imports — auto-enrich composition", () => {
  let baseDir: string;
  let csvPath: string;

  beforeEach(async () => {
    await closeConnection();
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tb-import-unit-"));
    csvPath = path.join(baseDir, "spx.csv");
    await fs.writeFile(csvPath, FIXTURE_CSV);
  });

  afterEach(async () => {
    await closeConnection();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("calls writeBars BEFORE enriched.compute", async () => {
    const { stores, calls, spotWriteBars, enrichedCompute } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: false,
    });
    expect(out.isError).toBeFalsy();
    expect(spotWriteBars).toHaveBeenCalled();
    expect(enrichedCompute).toHaveBeenCalled();
    const writeIdx = calls.findIndex((c) => c.startsWith("spot.writeBars"));
    const computeIdx = calls.findIndex((c) => c.startsWith("enriched.compute("));
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(computeIdx).toBeGreaterThan(writeIdx);
  });

  it("VIX ticker calls enriched.computeContext AFTER enriched.compute", async () => {
    const { stores, calls, enrichedComputeContext } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    // Reuse the SPX CSV — only ticker matters for the VIX gate.
    const out = await handler({
      file_path: csvPath,
      ticker: "VIX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: false,
    });
    expect(out.isError).toBeFalsy();
    expect(enrichedComputeContext).toHaveBeenCalled();
    const computeIdx = calls.findIndex((c) => c.startsWith("enriched.compute(VIX"));
    const ctxIdx = calls.findIndex((c) => c.startsWith("enriched.computeContext"));
    expect(computeIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(computeIdx);
  });

  it("non-VIX ticker does NOT call enriched.computeContext", async () => {
    const { stores, enrichedCompute, enrichedComputeContext } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: false,
    });
    expect(out.isError).toBeFalsy();
    expect(enrichedCompute).toHaveBeenCalledWith("SPX", "2025-01-02", "2025-01-02");
    expect(enrichedComputeContext).not.toHaveBeenCalled();
  });

  it("skip_enrichment=true → writeBars only, no compute or computeContext", async () => {
    const { stores, spotWriteBars, enrichedCompute, enrichedComputeContext } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: true,
    });
    expect(out.isError).toBeFalsy();
    expect(spotWriteBars).toHaveBeenCalled();
    expect(enrichedCompute).not.toHaveBeenCalled();
    expect(enrichedComputeContext).not.toHaveBeenCalled();
  });

  it("dry_run=true → neither writeBars nor compute / computeContext", async () => {
    const { stores, spotWriteBars, enrichedCompute, enrichedComputeContext } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: true,
      skip_enrichment: false,
    });
    expect(out.isError).toBeFalsy();
    expect(spotWriteBars).not.toHaveBeenCalled();
    expect(enrichedCompute).not.toHaveBeenCalled();
    expect(enrichedComputeContext).not.toHaveBeenCalled();
  });

  it("writeBars throws → handler returns isError:true, compute NOT called", async () => {
    const { stores, enrichedCompute, enrichedComputeContext } = makeMockStores({
      writeBarsRejects: new Error("disk full"),
    });
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: false,
    });
    expect(out.isError).toBe(true);
    expect(enrichedCompute).not.toHaveBeenCalled();
    expect(enrichedComputeContext).not.toHaveBeenCalled();
    // Verify the error message surfaces.
    const text = out.content.find((c) => c.type === "text") as { text?: string } | undefined;
    expect(text?.text ?? "").toMatch(/disk full/i);
  });

  it("compute throws AFTER writeBars succeeds → handler returns isError:true (loud failure)", async () => {
    const { stores, spotWriteBars, enrichedCompute } = makeMockStores({
      computeRejects: new Error("enrichment math broke"),
    });
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    const out = await handler({
      file_path: csvPath,
      ticker: "SPX",
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: false,
    });
    // Spot data was written, but enrichment failed — the handler must
    // surface the failure (not silently swallow).
    expect(spotWriteBars).toHaveBeenCalled();
    expect(enrichedCompute).toHaveBeenCalled();
    expect(out.isError).toBe(true);
    const text = out.content.find((c) => c.type === "text") as { text?: string } | undefined;
    expect(text?.text ?? "").toMatch(/enrichment math broke/i);
  });

  // ---------------------------------------------------------------------------
  // Bonus coverage — single-test gate that the spot ticker reaches writeBars
  // with the expected (ticker, date, BarRow[]) shape. Exercises the parser →
  // groupByDate → writeBars wiring without touching enrichment.
  // ---------------------------------------------------------------------------

  it("writeBars receives normalized ticker + ISO date + parsed bars", async () => {
    const { stores, spotWriteBars } = makeMockStores();
    const { server, tools } = makeServer();
    registerMarketImportTools(server as never, baseDir, stores);
    const handler = tools.get("import_market_csv")!.handler;

    await handler({
      file_path: csvPath,
      ticker: "spx", // lowercase — should be normalized to SPX
      column_mapping: COLUMN_MAPPING,
      dry_run: false,
      skip_enrichment: true,
    });
    expect(spotWriteBars).toHaveBeenCalledTimes(1);
    const callArgs = spotWriteBars.mock.calls[0] as [string, string, BarRow[]];
    expect(callArgs[0]).toBe("SPX"); // normalized
    expect(callArgs[1]).toBe("2025-01-02");
    expect(callArgs[2]).toHaveLength(2); // 2 minute bars in the fixture CSV
    expect(callArgs[2][0].open).toBe(4700);
    expect(callArgs[2][1].close).toBe(4749);
  });
});
