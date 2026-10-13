import { PlBasis, PortfolioStatsCalculator, type Trade } from "@tradeblocks/lib";
import { mockTrades } from "../data/mock-trades";

/** The production class entrypoint exposes the same dated returns used by ratios. */
describe("PortfolioStatsCalculator.calculateDailyReturnsWithDates", () => {
  it("uses close dates, fills idle business days, retains weekend exits and compounds prior equity", () => {
    const trades: Trade[] = [
      {
        ...mockTrades[0],
        plBasis: PlBasis.NetIncludesFees,
        dateOpened: new Date(2024, 0, 1),
        dateClosed: new Date(2024, 0, 5),
        pl: -1000,
        fundsAtClose: 99000,
      },
      {
        ...mockTrades[0],
        plBasis: PlBasis.NetIncludesFees,
        dateOpened: new Date(2024, 0, 2),
        dateClosed: new Date(2024, 0, 7),
        pl: 2000,
        fundsAtClose: 101000,
      },
      {
        ...mockTrades[0],
        plBasis: PlBasis.NetIncludesFees,
        dateOpened: new Date(2024, 0, 3),
        dateClosed: new Date(2024, 0, 9),
        pl: -500,
        fundsAtClose: 100500,
      },
    ];
    const calculator = new PortfolioStatsCalculator();
    expect(calculator.calculateDailyReturnsWithDates(trades)).toEqual([
      { date: new Date(2024, 0, 5), return: -0.01 },
      { date: new Date(2024, 0, 7), return: 2000 / 99000 },
      { date: new Date(2024, 0, 8), return: 0 },
      { date: new Date(2024, 0, 9), return: -500 / 101000 },
    ]);
    expect(calculator.calculateDailyReturnsWithDates([])).toEqual([]);
  });

  it.each([
    { basis: PlBasis.GrossBeforeFees, reportedPl: -1000 },
    { basis: PlBasis.NetIncludesFees, reportedPl: -1500 },
  ])("normalizes $basis exactly once without mutating caller trades", ({ basis, reportedPl }) => {
    const trade: Trade = {
      ...mockTrades[0],
      dateOpened: new Date(2024, 0, 8),
      dateClosed: new Date(2024, 0, 8),
      plBasis: basis,
      pl: reportedPl,
      openingCommissionsFees: 500,
      closingCommissionsFees: 0,
      fundsAtClose: 99000,
    };
    expect(new PortfolioStatsCalculator().calculateDailyReturnsWithDates([trade])).toEqual([
      { date: new Date(2024, 0, 8), return: -1500 / 100500 },
    ]);
    expect(trade.pl).toBe(reportedPl);
    expect(trade.plBasis).toBe(basis);
  });
});
