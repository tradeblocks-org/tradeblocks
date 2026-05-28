/**
 * Unit tests for MassiveProvider.downloadBulkData()
 *
 * Tests the skip-if-exists behavior. Full integration tests that exercise
 * rclone + DuckDB Parquet conversion are in the integration test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("MassiveProvider.downloadBulkData", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `parquet-dl-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips download if output Parquet already exists", async () => {
    const { MassiveProvider } = await import("../../src/utils/providers/massive.ts");
    const provider = new MassiveProvider();
    const outputPath = join(tmpDir, "data.parquet");
    writeFileSync(outputPath, "dummy");

    const result = await provider.downloadBulkData!({
      date: "2025-01-06",
      dataset: "minute_bars",
      assetClass: "option",
      tickers: ["SPX", "SPXW"],
      outputPath,
    });

    expect(result.skipped).toBe(true);
    expect(result.rowCount).toBe(0);
  });
});
