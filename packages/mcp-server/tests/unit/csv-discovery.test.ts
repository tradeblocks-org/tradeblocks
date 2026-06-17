/**
 * Unit tests for CSV discovery module
 *
 * Tests header-sniffing CSV type detection and folder discovery logic.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { detectCsvType, discoverCsvFiles } from "../../src/test-exports.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "csv-discovery-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Helper to create a CSV file with given header line
async function createCsv(name: string, headerLine: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, headerLine + "\n");
  return filePath;
}

describe("detectCsvType", () => {
  it("identifies a tradelog CSV (has Strategy, Date Opened, P/L columns)", async () => {
    const filePath = await createCsv(
      "trades.csv",
      "Strategy,Date Opened,Time Opened,P/L,Date Closed,Legs,Premium"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("tradelog");
  });

  it("identifies a tradelog with P&L alias", async () => {
    const filePath = await createCsv(
      "trades2.csv",
      "Strategy,Date Opened,P&L,Symbol,Legs"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("tradelog");
  });

  it("identifies a dailylog CSV (has Date, Portfolio Value columns)", async () => {
    const filePath = await createCsv(
      "daily.csv",
      "Date,Portfolio Value,Daily P&L"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("dailylog");
  });

  it("identifies a dailylog CSV with equity column", async () => {
    const filePath = await createCsv(
      "daily2.csv",
      "Date,Equity,Notes"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("dailylog");
  });

  it("identifies a reportinglog CSV (TAT format)", async () => {
    const filePath = await createCsv(
      "tat.csv",
      "TradeID,ProfitLoss,BuyingPower,EntryDate"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("reportinglog");
  });

  it("identifies a reportinglog CSV (OO format with Actual P/L)", async () => {
    const filePath = await createCsv(
      "reporting.csv",
      "Date Opened,Actual P/L,Legs"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("reportinglog");
  });

  it("identifies a reportinglog CSV (OO format with Initial Premium, no Actual P/L)", async () => {
    const filePath = await createCsv(
      "oo-reporting.csv",
      "Date Opened,Strategy,Legs,No. of Contracts,Initial Premium,P/L"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("reportinglog");
  });

  it("does not misclassify tradelog with Opening Price as reportinglog", async () => {
    const filePath = await createCsv(
      "tradelog-with-opening-price.csv",
      "Date Opened,Time Opened,Date Closed,Time Closed,Opening Price,Closing Price,Legs,Premium,No. of Contracts,P/L,Strategy"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBe("tradelog");
  });

  it("returns null for unrecognized CSV", async () => {
    const filePath = await createCsv(
      "unknown.csv",
      "Name,Age,City"
    );
    const result = await detectCsvType(filePath);
    expect(result).toBeNull();
  });

  it("returns null for non-existent file", async () => {
    const result = await detectCsvType(path.join(tmpDir, "nonexistent.csv"));
    expect(result).toBeNull();
  });

  it("handles BOM in CSV header", async () => {
    const filePath = path.join(tmpDir, "bom.csv");
    await fs.writeFile(filePath, "\uFEFFStrategy,Date Opened,P/L,Date Closed,Legs\n");
    const result = await detectCsvType(filePath);
    expect(result).toBe("tradelog");
  });
});

describe("discoverCsvFiles", () => {
  it("finds standard-named files (tradelog.csv, dailylog.csv)", async () => {
    await createCsv("tradelog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");
    await createCsv("dailylog.csv", "Date,Portfolio Value");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("tradelog.csv");
    expect(result.mappings.dailylog).toBe("dailylog.csv");
    expect(result.unrecognized).toEqual([]);
  });

  it("finds standard reportinglog.csv", async () => {
    await createCsv("tradelog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");
    await createCsv("reportinglog.csv", "TradeID,ProfitLoss,BuyingPower");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("tradelog.csv");
    expect(result.mappings.reportinglog).toBe("reportinglog.csv");
  });

  it("uses header sniffing for non-standard filenames", async () => {
    await createCsv("my-trades.csv", "Strategy,Date Opened,P/L,Date Closed,Legs,Premium");
    await createCsv("portfolio.csv", "Date,Portfolio Value,Daily P&L");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("my-trades.csv");
    expect(result.mappings.dailylog).toBe("portfolio.csv");
    expect(result.unrecognized).toEqual([]);
  });

  it("detects strategy-trade-log pattern as reportinglog", async () => {
    await createCsv("tradelog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");
    await createCsv("strategy-trade-log-2025.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("tradelog.csv");
    expect(result.mappings.reportinglog).toBe("strategy-trade-log-2025.csv");
  });

  it("returns unrecognized files in the unrecognized array", async () => {
    await createCsv("tradelog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");
    await createCsv("random-data.csv", "Name,Age,City");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("tradelog.csv");
    expect(result.unrecognized).toContain("random-data.csv");
  });

  it("returns empty mappings for non-existent directory", async () => {
    const result = await discoverCsvFiles(path.join(tmpDir, "nonexistent"));
    expect(result.mappings).toEqual({});
    expect(result.unrecognized).toEqual([]);
  });

  it("returns empty mappings for directory with no CSV files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "not a csv");
    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings).toEqual({});
    expect(result.unrecognized).toEqual([]);
  });

  it("detects strategylog pattern as reportinglog", async () => {
    await createCsv("tradelog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");
    await createCsv("strategylog.csv", "Strategy,Date Opened,P/L,Date Closed,Legs");

    const result = await discoverCsvFiles(tmpDir);
    expect(result.mappings.tradelog).toBe("tradelog.csv");
    expect(result.mappings.reportinglog).toBe("strategylog.csv");
  });
});
