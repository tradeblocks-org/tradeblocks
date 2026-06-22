import { TradeProcessor } from "../../packages/lib/processing/trade-processor";

describe("TradeProcessor validateRawTradeData", () => {
  it("normalizes blank strategy values to Unknown", () => {
    const processor = new TradeProcessor();

    const row: Record<string, string> = {
      "Date Opened": "2025-09-23",
      "Time Opened": "09:32:00",
      "Opening Price": "6694.8",
      Legs: "Test Legs",
      Premium: "55",
      "Closing Price": "",
      "Date Closed": "",
      "Time Closed": "",
      "Avg. Closing Cost": "",
      "Reason For Close": "",
      "P/L": "4930.2",
      "No. of Contracts": "99",
      "Funds at Close": "945113.8",
      "Margin Req.": "93555",
      Strategy: "",
      "Opening Commissions + Fees": "514.8",
      "Opening Short/Long Ratio": "1.48",
      Gap: "-1.31",
      Movement: "2.36",
      "Max Profit": "100",
      "Max Loss": "-400",
    };

    const normalized = processor["validateRawTradeData"](row, 1);

    expect(normalized).not.toBeNull();
    expect(normalized?.["Strategy"]).toBe("Unknown");
  });

  it("defaults missing opening short/long ratio to 0", () => {
    const processor = new TradeProcessor();

    const row: Record<string, string> = {
      "Date Opened": "2025-08-08",
      "Time Opened": "13:52:00",
      "Opening Price": "6390.11",
      Legs: "1 Aug 8 6380 P STO 1.95",
      Premium: "185",
      "Closing Price": "6389.45",
      "Date Closed": "2025-08-08",
      "Time Closed": "16:00:00",
      "Avg. Closing Cost": "0",
      "Reason For Close": "Expired",
      "P/L": "184.35",
      "No. of Contracts": "1",
      "Funds at Close": "244773.65",
      "Margin Req.": "5695",
      Strategy: "Credit Iron Condor",
      "Opening Commissions + Fees": "0.65",
      "Closing Commissions + Fees": "0",
      Gap: "15.22",
      Movement: "34.89",
      "Max Profit": "100",
      "Max Loss": "-48.65",
    };

    const normalized = processor["validateRawTradeData"](row, 1);

    expect(normalized).not.toBeNull();
    expect(normalized?.["Opening Short/Long Ratio"]).toBe("0");
  });

  it("defaults missing VIX and movement fields to 0", () => {
    const processor = new TradeProcessor();

    const row: Record<string, string> = {
      "Date Opened": "2025-08-08",
      "Time Opened": "13:52:00",
      "Opening Price": "6390.11",
      Legs: "1 Aug 8 6380 P STO 1.95",
      Premium: "185",
      "P/L": "184.35",
      "No. of Contracts": "1",
      "Funds at Close": "244773.65",
      "Margin Req.": "5695",
      Strategy: "Credit Iron Condor",
      "Opening Commissions + Fees": "0.65",
      "Closing Commissions + Fees": "0",
      "Opening Short/Long Ratio": "1.23",
    };

    const normalized = processor["validateRawTradeData"](row, 1);

    expect(normalized).not.toBeNull();
    expect(normalized?.["Opening VIX"]).toBe("0");
    expect(normalized?.["Closing VIX"]).toBe("0");
    expect(normalized?.["Gap"]).toBe("0");
    expect(normalized?.["Movement"]).toBe("0");
  });
});
