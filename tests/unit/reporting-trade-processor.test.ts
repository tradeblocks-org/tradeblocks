import {
  analyzeLiveAlignment,
  matchTrades,
  ReportingTradeProcessor,
  type Trade,
} from "@tradeblocks/lib";

describe("ReportingTradeProcessor lossless Automation-log intake", () => {
  it("parses server-side text while preserving new and unknown source columns", async () => {
    const csv =
      '\ufeff"Strategy","Account","Date Opened","Time Opened","Opening Price","Legs","Initial Premium","No. of Contracts","P/L","Closing Price","Date Closed","Time Closed","Days in Trade","Avg. Closing Cost","Reason For Close","Automation Id"\n' +
      '"Wizzy Orb EOD","Big Money","2026-07-10","15:56:07.1960624",7577.03,"1 Jul 10 7575 C STO 3.73 | 1 Jul 10 7595 C BTO 0.03",3.7,1,327.56,7575.39,"2026-07-10","16:15:01.0393019",0,-0.39,"Expired","run-42"\n';

    const result = await new ReportingTradeProcessor().processText(csv);

    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(1);
    expect(result.validTrades).toBe(1);
    expect(result.trades[0]).toMatchObject({
      strategy: "Wizzy Orb EOD",
      account: "Big Money",
      timeOpened: "3:56 PM",
      rawTimeOpened: "15:56:07.1960624",
      timeClosed: "4:15 PM",
      rawTimeClosed: "16:15:01.0393019",
      daysInTrade: 0,
    });
    expect(result.trades[0].sourceFields).toMatchObject({
      Account: "Big Money",
      "Days in Trade": "0",
      "Automation Id": "run-42",
    });
  });

  it("keeps the original alias columns while exposing canonical values", async () => {
    const csv =
      '"Strategy","Date Opened","Time Opened","Opening Price","Legs","Initial Credit","Contracts Traded","PL","Vendor Note"\n' +
      '"Alias Strategy","2026-07-09","09:31:02.1234567",6200,"legs",1.25,2,42.5,"preserve me"';

    const result = await new ReportingTradeProcessor().processText(csv);

    expect(result.errors).toEqual([]);
    expect(result.trades[0]).toMatchObject({
      strategy: "Alias Strategy",
      initialPremium: 1.25,
      numContracts: 2,
      pl: 42.5,
      rawTimeOpened: "09:31:02.1234567",
    });
    expect(result.trades[0].sourceFields).toEqual({
      Strategy: "Alias Strategy",
      "Date Opened": "2026-07-09",
      "Time Opened": "09:31:02.1234567",
      "Opening Price": "6200",
      Legs: "legs",
      "Initial Credit": "1.25",
      "Contracts Traded": "2",
      PL: "42.5",
      "Vendor Note": "preserve me",
    });
  });

  it("remains compatible with logs that do not have the additive fields", async () => {
    const csv =
      '"Strategy","Date Opened","Opening Price","Legs","Initial Premium","No. of Contracts","P/L"\n' +
      '"Legacy Strategy","2026-07-08",6100,"legs",2.5,1,-10';

    const result = await new ReportingTradeProcessor().processText(csv);

    expect(result.errors).toEqual([]);
    expect(result.trades[0]).toMatchObject({
      strategy: "Legacy Strategy",
      initialPremium: 2.5,
      numContracts: 1,
      pl: -10,
    });
    expect(result.trades[0].account).toBeUndefined();
    expect(result.trades[0].daysInTrade).toBeUndefined();
    expect(result.trades[0].rawTimeOpened).toBeUndefined();
  });

  it("matches parsed AM display times using the lossless source timestamp", async () => {
    const csv =
      '"Strategy","Date Opened","Time Opened","Opening Price","Legs","Initial Premium","No. of Contracts","P/L"\n' +
      '"Morning Strategy","2026-07-07","09:32:16.1234567",6000,"legs",1,1,80';
    const parsed = await new ReportingTradeProcessor().processText(csv);
    const backtest: Trade[] = [
      {
        strategy: "Morning Strategy",
        dateOpened: new Date(2026, 6, 7),
        timeOpened: "09:32:00",
        openingPrice: 6000,
        legs: "legs",
        premium: 1,
        numContracts: 1,
        pl: 100,
        fundsAtClose: 100,
        marginReq: 100,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 1,
      },
    ];

    expect(parsed.trades[0]).toMatchObject({
      timeOpened: "9:32 AM",
      rawTimeOpened: "09:32:16.1234567",
    });
    const alignment = analyzeLiveAlignment(backtest, parsed.trades);
    expect(alignment.available).toBe(true);
    if (!alignment.available) throw new Error(alignment.reason);
    expect(alignment.dataQuality.matchedTradeCount).toBe(1);
    expect(matchTrades(backtest, parsed.trades, "perContract").matchedTrades).toHaveLength(1);
    expect(
      matchTrades(backtest, [{ ...parsed.trades[0], rawTimeOpened: undefined }], "perContract")
        .matchedTrades,
    ).toHaveLength(1);
  });
});
