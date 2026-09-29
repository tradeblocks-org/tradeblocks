import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataLoader, TradeProcessor, enrichTrades, type Trade } from "@tradeblocks/lib";

// Real Option Omega export: first row has P/L 332.88 on 2 × $170 premium, and OO's
// P/L % 97.90588235294118 equals the recomputation. Tests overwrite that cell with a value
// the recomputation cannot produce, so a silent recompute fails them.
const csv = readFileSync(join(__dirname, "../data/ORB Test Data/orb-tradelog.csv"), "utf8");
const [header, firstRow] = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
const PL_PCT = header.split(",").indexOf("P/L %");
const COMPUTED = (332.88 / 340) * 100;

function withPlPct(cell: string): string {
  const cells = firstRow.split(",");
  cells[PL_PCT] = cell;
  return `${header}\n${cells.join(",")}\n`;
}

const parsers: Array<[string, (content: string) => Promise<Trade[]>]> = [
  [
    "TradeProcessor",
    async (content) => {
      const file = new File([content], "orb-tradelog.csv", { type: "text/csv" });
      const result = await new TradeProcessor().processFile(file);
      expect(result.invalidTrades).toBe(0);
      return result.trades;
    },
  ],
  [
    "DataLoader",
    async (content) => {
      const result = await DataLoader.createForTesting().loadTrades(content);
      expect(result.errors).toHaveLength(0);
      return result.data;
    },
  ],
];

describe.each(parsers)("%s trade-log P/L %%", (_name, parse) => {
  it("uses Option Omega's P/L % over the recomputation", async () => {
    const [trade] = await parse(withPlPct("12.5"));
    expect(trade.plPct).toBe(12.5);
    expect(trade.customFields?.["P/L %"]).toBeUndefined();

    const [enriched] = enrichTrades([trade]);
    expect(enriched.plPct).toBe(12.5);
    expect(enriched.premiumEfficiency).toBe(12.5);
    expect(enriched.netPlPct).toBeCloseTo(COMPUTED, 10);
  });

  it("accepts a trailing percent sign and thousands separators", async () => {
    expect((await parse(withPlPct("12.5%")))[0].plPct).toBe(12.5);
    expect((await parse(withPlPct('"1,234.5"')))[0].plPct).toBe(1234.5);
  });

  it("computes P/L % when the column is absent", async () => {
    const withoutColumn = [header, firstRow]
      .map((line) =>
        line
          .split(",")
          .filter((_, index) => index !== PL_PCT)
          .join(","),
      )
      .join("\n");
    const [trade] = await parse(`${withoutColumn}\n`);
    expect(trade.plPct).toBeUndefined();
    expect(enrichTrades([trade])[0].plPct).toBeCloseTo(COMPUTED, 10);
  });

  it("computes P/L % when the cell is blank", async () => {
    const [trade] = await parse(withPlPct(""));
    expect(trade.plPct).toBeUndefined();
    expect(enrichTrades([trade])[0].plPct).toBeCloseTo(COMPUTED, 10);
  });

  it("loads the trade and computes P/L % when the cell is not a number", async () => {
    const [trade] = await parse(withPlPct("abc"));
    expect(trade.pl).toBe(332.88);
    expect(trade.plPct).toBeUndefined();
    expect(enrichTrades([trade])[0].plPct).toBeCloseTo(COMPUTED, 10);
  });
});
