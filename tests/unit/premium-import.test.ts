import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TradeProcessor } from "../../packages/lib/processing/trade-processor";
import { DataLoader } from "../../packages/lib/processing/data-loader";
import { calculatePremiumEfficiencyPercent, computeTotalPremium } from "@tradeblocks/lib";

const csv = readFileSync(join(__dirname, "../data/EMA Test Data/ema-tradelog.csv"), "utf8");
const [header, firstRow] = csv.replace(/^\uFEFF/, "").split(/\r?\n/);

// This OO row has $420 per lot, three lots, $9 opening fees and $1,251 net P/L.
for (const premium of ["420", "420.00"]) {
  const row = firstRow.replace(/,420,/, `,${premium},`);
  const content = `${header}\n${row}\n`;

  it(`TradeProcessor keeps ${premium} as $1,260 total premium`, async () => {
    const file = new File([content], "ema-tradelog.csv", { type: "text/csv" });
    const result = await new TradeProcessor().processFile(file);
    expect(result.validTrades).toBe(1);
    const trade = result.trades[0];
    expect(trade.premium).toBe(420);
    expect(computeTotalPremium(trade)).toBe(1260);
    expect(calculatePremiumEfficiencyPercent(trade).percentage).toBeCloseTo(99.2857142857);
  });

  it(`DataLoader keeps ${premium} as $1,260 total premium`, async () => {
    const result = await DataLoader.createForTesting().loadTrades(content);
    expect(result.errors).toHaveLength(0);
    const trade = result.data[0];
    expect(trade.premium).toBe(420);
    expect(computeTotalPremium(trade)).toBe(1260);
    expect(calculatePremiumEfficiencyPercent(trade).percentage).toBeCloseTo(99.2857142857);
  });
}
