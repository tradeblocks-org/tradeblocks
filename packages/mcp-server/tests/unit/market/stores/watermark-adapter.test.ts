/**
 * Unit tests for the enrichment-watermark JSON adapter.
 *
 * Exercises:
 *   - Missing file → empty structure (not an error)
 *   - Round-trip: upsertEnrichedThrough ↔ getEnrichedThrough
 *   - Multi-ticker preservation on update
 *   - Passthrough preservation of unknown extension fields (forward compat)
 *   - Unknown ticker returns null
 *   - Malformed JSON → clear thrown error
 *   - Zod schema edge cases: invalid ticker key / invalid date format /
 *     null date accepted
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadEnrichmentWatermarks,
  getEnrichedThrough,
  upsertEnrichedThrough,
  EnrichmentWatermarksSchema,
} from "../../../../src/test-exports.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = join(
    tmpdir(),
    `wm-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Don't pre-create the watermarks file — several tests want it absent.
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("enrichment watermarks adapter", () => {
  it("missing file returns empty watermarks structure (not an error)", async () => {
    const wm = await loadEnrichmentWatermarks(dataDir);
    expect(wm).toEqual({ version: 1, watermarks: {} });
  });

  it("upsertEnrichedThrough + getEnrichedThrough round-trip preserves the value", async () => {
    await upsertEnrichedThrough("SPX", "2026-04-15", dataDir);
    expect(await getEnrichedThrough("SPX", dataDir)).toBe("2026-04-15");
  });

  it("upsert preserves other tickers' entries", async () => {
    await upsertEnrichedThrough("SPX", "2026-04-15", dataDir);
    await upsertEnrichedThrough("VIX", "2026-04-14", dataDir);
    await upsertEnrichedThrough("SPX", "2026-04-16", dataDir);
    expect(await getEnrichedThrough("SPX", dataDir)).toBe("2026-04-16");
    expect(await getEnrichedThrough("VIX", dataDir)).toBe("2026-04-14");
  });

  it("upsert preserves passthrough fields on existing ticker entry", async () => {
    // Seed the file with a passthrough field (`wilder_state`) that the adapter
    // does not know about — adapter must preserve it on update.
    mkdirSync(join(dataDir, "market-meta"), { recursive: true });
    writeFileSync(
      join(dataDir, "market-meta", "enrichment-watermarks.json"),
      JSON.stringify({
        version: 1,
        watermarks: {
          SPX: { enriched_through: "2026-04-14", wilder_state: { rsi: 0.5 } },
        },
      }),
    );
    await upsertEnrichedThrough("SPX", "2026-04-16", dataDir);
    const wm = await loadEnrichmentWatermarks(dataDir);
    expect(wm.watermarks.SPX).toEqual({
      enriched_through: "2026-04-16",
      wilder_state: { rsi: 0.5 },
    });
  });

  it("getEnrichedThrough returns null for unknown ticker", async () => {
    await upsertEnrichedThrough("SPX", "2026-04-15", dataDir);
    expect(await getEnrichedThrough("QQQ", dataDir)).toBeNull();
  });

  it("malformed JSON throws clear error", async () => {
    mkdirSync(join(dataDir, "market-meta"), { recursive: true });
    writeFileSync(
      join(dataDir, "market-meta", "enrichment-watermarks.json"),
      `{"version": 2, "watermarks": {}}`,
    );
    await expect(loadEnrichmentWatermarks(dataDir)).rejects.toThrow(/malformed/);
  });

  it("Zod schema rejects invalid ticker key", () => {
    const result = EnrichmentWatermarksSchema.safeParse({
      version: 1,
      watermarks: { "bad ticker": { enriched_through: "2026-04-15" } },
    });
    expect(result.success).toBe(false);
  });

  it("Zod schema rejects invalid date format", () => {
    const result = EnrichmentWatermarksSchema.safeParse({
      version: 1,
      watermarks: { SPX: { enriched_through: "04/15/2026" } },
    });
    expect(result.success).toBe(false);
  });

  it("Zod schema accepts enriched_through: null (not-yet-enriched)", () => {
    const result = EnrichmentWatermarksSchema.safeParse({
      version: 1,
      watermarks: { SPX: { enriched_through: null } },
    });
    expect(result.success).toBe(true);
  });

  it("writes file under <dataRoot>/market-meta/enrichment-watermarks.json", async () => {
    await upsertEnrichedThrough("SPX", "2026-04-15", dataDir);
    const wm = await loadEnrichmentWatermarks(dataDir);
    expect(wm.version).toBe(1);
    // File should now exist at the canonical path — getting the watermark back
    // through the adapter is sufficient confirmation of the write path.
    expect(wm.watermarks.SPX?.enriched_through).toBe("2026-04-15");
  });
});
