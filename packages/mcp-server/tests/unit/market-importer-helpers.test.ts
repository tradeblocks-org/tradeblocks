/**
 * Unit tests for the pure helpers in src/utils/market-importer.ts:
 *
 *   - parseCsvToBars(filePath, ticker, columnMapping)  → Promise<BarRow[]>
 *   - parseDatabaseRowsToBars(rows, ticker, mapping)   → BarRow[]
 *   - validateColumnMapping(mapping, targetTable)      → { valid, missingFields }
 *
 * These helpers form the input edge of the market-import tools. Coverage
 * here complements the integration suite
 * (`tests/integration/market-imports-v2`) and the auto-enrich composition
 * suite (`tests/unit/market-imports.test.ts`).
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  parseCsvToBars,
  parseDatabaseRowsToBars,
  validateColumnMapping,
} from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// validateColumnMapping
// ---------------------------------------------------------------------------

describe("validateColumnMapping", () => {
  it("daily — accepts mapping with date+OHLC", () => {
    const r = validateColumnMapping(
      { time: "date", o: "open", h: "high", l: "low", c: "close" },
      "daily",
    );
    expect(r.valid).toBe(true);
    expect(r.missingFields).toEqual([]);
  });

  it("daily — rejects missing OHLC", () => {
    const r = validateColumnMapping({ time: "date" }, "daily");
    expect(r.valid).toBe(false);
    expect(r.missingFields).toEqual(expect.arrayContaining(["open", "high", "low", "close"]));
  });

  it("intraday — allows missing time when date is mapped (auto-derived)", () => {
    const r = validateColumnMapping(
      { ts: "date", o: "open", h: "high", l: "low", c: "close" },
      "intraday",
    );
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCsvToBars
// ---------------------------------------------------------------------------

describe("parseCsvToBars", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tb-parse-csv-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses 3 minute bars with explicit date+time columns", async () => {
    const csvPath = path.join(tmpDir, "spx.csv");
    await fs.writeFile(
      csvPath,
      "date,time,open,high,low,close,volume\n" +
        "2025-01-02,09:30,4700,4705,4699,4702,1000\n" +
        "2025-01-02,09:31,4702,4706,4701,4704,1200\n" +
        "2025-01-02,16:00,4750,4751,4748,4749,1500\n",
    );
    const bars = await parseCsvToBars(csvPath, "SPX", {
      date: "date",
      time: "time",
      open: "open",
      high: "high",
      low: "low",
      close: "close",
    });
    expect(bars).toHaveLength(3);
    expect(bars[0].ticker).toBe("SPX");
    expect(bars[0].date).toBe("2025-01-02");
    expect(bars[0].time).toBe("09:30");
    expect(bars[0].open).toBe(4700);
    expect(bars[2].close).toBe(4749);
  });

  it("auto-extracts time from a Unix-timestamp date column when time is unmapped", async () => {
    const csvPath = path.join(tmpDir, "spx-unix.csv");
    // 1735828200 = 2025-01-02 14:30:00 UTC = 09:30 ET (no DST in early Jan).
    await fs.writeFile(csvPath, "ts,open,high,low,close\n" + "1735828200,4700,4705,4699,4702\n");
    const bars = await parseCsvToBars(csvPath, "SPX", {
      ts: "date",
      open: "open",
      high: "high",
      low: "low",
      close: "close",
    });
    expect(bars).toHaveLength(1);
    expect(bars[0].date).toBe("2025-01-02");
    expect(bars[0].time).toBe("09:30");
  });

  it("normalizes ticker to uppercase", async () => {
    const csvPath = path.join(tmpDir, "spx-lower.csv");
    await fs.writeFile(
      csvPath,
      "date,time,open,high,low,close\n" + "2025-01-02,09:30,4700,4705,4699,4702\n",
    );
    const bars = await parseCsvToBars(csvPath, "spx", {
      date: "date",
      time: "time",
      open: "open",
      high: "high",
      low: "low",
      close: "close",
    });
    expect(bars[0].ticker).toBe("SPX");
  });

  it("throws on unreadable file path", async () => {
    await expect(
      parseCsvToBars("/no/such/file.csv", "SPX", { date: "date", open: "open" }),
    ).rejects.toThrow(/Failed to read CSV file/);
  });

  it("throws when CSV has no data rows", async () => {
    const csvPath = path.join(tmpDir, "empty.csv");
    await fs.writeFile(csvPath, "date,open,high,low,close\n");
    await expect(
      parseCsvToBars(csvPath, "SPX", {
        date: "date",
        open: "open",
        high: "high",
        low: "low",
        close: "close",
      }),
    ).rejects.toThrow(/no data rows/);
  });

  it("returns [] when every row has an unparseable date (filtered out)", async () => {
    const csvPath = path.join(tmpDir, "bad-dates.csv");
    await fs.writeFile(
      csvPath,
      "date,time,open,high,low,close\n" + "not-a-date,09:30,4700,4705,4699,4702\n",
    );
    const bars = await parseCsvToBars(csvPath, "SPX", {
      date: "date",
      time: "time",
      open: "open",
      high: "high",
      low: "low",
      close: "close",
    });
    expect(bars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseDatabaseRowsToBars
// ---------------------------------------------------------------------------

describe("parseDatabaseRowsToBars", () => {
  it("parses pre-fetched DuckDB rows into BarRow[] with ticker injection", () => {
    const rows = [
      {
        trade_date: "2025-01-02",
        trade_time: "09:30",
        spx_open: "4700",
        spx_high: "4705",
        spx_low: "4699",
        spx_close: "4702",
      },
      {
        trade_date: "2025-01-02",
        trade_time: "09:31",
        spx_open: "4702",
        spx_high: "4706",
        spx_low: "4701",
        spx_close: "4704",
      },
    ];
    const bars = parseDatabaseRowsToBars(rows, "SPX", {
      trade_date: "date",
      trade_time: "time",
      spx_open: "open",
      spx_high: "high",
      spx_low: "low",
      spx_close: "close",
    });
    expect(bars).toHaveLength(2);
    expect(bars[0].ticker).toBe("SPX");
    expect(bars[0].date).toBe("2025-01-02");
    expect(bars[0].time).toBe("09:30");
    expect(bars[0].open).toBe(4700);
    expect(bars[1].close).toBe(4704);
  });

  it("returns [] for an empty input", () => {
    expect(parseDatabaseRowsToBars([], "SPX", { date: "date" })).toEqual([]);
  });

  it("filters rows with unparseable date but keeps the rest", () => {
    const rows = [
      { d: "not-a-date", t: "09:30", o: "1", h: "1", l: "1", c: "1" },
      { d: "2025-01-02", t: "09:30", o: "100", h: "100", l: "100", c: "100" },
    ];
    const bars = parseDatabaseRowsToBars(rows, "AAPL", {
      d: "date",
      t: "time",
      o: "open",
      h: "high",
      l: "low",
      c: "close",
    });
    expect(bars).toHaveLength(1);
    expect(bars[0].date).toBe("2025-01-02");
    expect(bars[0].ticker).toBe("AAPL");
  });
});
