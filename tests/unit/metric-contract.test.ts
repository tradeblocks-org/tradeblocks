import {
  combineAllLegGroups,
  combineLegGroup,
  getNetPl,
  PlBasis,
  PerformanceCalculator,
  PortfolioStatsCalculator,
  tradeSchema,
  type DailyLogEntry,
  type Trade,
} from "@tradeblocks/lib";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date("2026-01-02"),
    timeOpened: "09:32:00",
    openingPrice: 0,
    legs: "SPX test spread",
    premium: 0,
    dateClosed: new Date("2026-01-02"),
    timeClosed: "15:55:00",
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100100,
    marginReq: 1000,
    strategy: "OO parity",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
    ...overrides,
  };
}

describe("P/L and Sharpe calculation contract", () => {
  it("preserves the serialized P/L basis values", () => {
    expect(PlBasis.NetIncludesFees).toBe("net_includes_fees");
    expect(PlBasis.GrossBeforeFees).toBe("gross_before_fees");
  });

  it("validates only supported P/L basis values", () => {
    const plBasisSchema = tradeSchema.shape.plBasis;

    expect(plBasisSchema.safeParse(PlBasis.NetIncludesFees).success).toBe(true);
    expect(plBasisSchema.safeParse(PlBasis.GrossBeforeFees).success).toBe(true);
    expect(plBasisSchema.safeParse("net_includes_fee").success).toBe(false);
    expect(plBasisSchema.safeParse("TOTALLY_BOGUS").success).toBe(false);
    expect(plBasisSchema.safeParse(undefined).success).toBe(true);
  });

  it("does not deduct Option Omega fees a second time", () => {
    const trades = [
      trade({
        pl: 231.44,
        plBasis: PlBasis.NetIncludesFees,
        openingCommissionsFees: 1.78,
        closingCommissionsFees: 1.78,
      }),
      trade({
        dateOpened: new Date("2026-01-05"),
        dateClosed: new Date("2026-01-05"),
        pl: -305.12,
        plBasis: PlBasis.NetIncludesFees,
        openingCommissionsFees: 2.56,
        closingCommissionsFees: 2.56,
        fundsAtClose: 99726.32,
      }),
    ];

    const stats = new PortfolioStatsCalculator().calculatePortfolioStats(trades);

    expect(stats.totalPl).toBeCloseTo(-73.68, 8);
    expect(stats.netPl).toBeCloseTo(-73.68, 8);
    expect(stats.totalCommissions).toBeCloseTo(8.68, 8);
    expect(getNetPl(trades[0])).toBe(231.44);
  });

  it("keeps the legacy undeclared gross contract and deducts fees once", () => {
    const grossTrade = trade({
      pl: 235,
      openingCommissionsFees: 1.78,
      closingCommissionsFees: 1.78,
    });

    const stats = new PortfolioStatsCalculator().calculatePortfolioStats([grossTrade]);

    expect(stats.totalPl).toBe(235);
    expect(stats.netPl).toBeCloseTo(231.44, 8);
    expect(getNetPl(grossTrade)).toBeCloseTo(231.44, 8);
  });

  it("uses the same net derived metrics for undeclared and explicit gross P/L", () => {
    const trades = [
      trade({ pl: 110, openingCommissionsFees: 5, closingCommissionsFees: 5 }),
      trade({
        dateOpened: new Date("2026-01-05"),
        dateClosed: new Date("2026-01-05"),
        pl: -40,
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
      }),
      trade({
        dateOpened: new Date("2026-01-06"),
        dateClosed: new Date("2026-01-06"),
        pl: 60,
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
      }),
    ];
    const explicit = trades.map((item) => ({
      ...item,
      plBasis: PlBasis.GrossBeforeFees,
    }));
    const calculator = new PortfolioStatsCalculator({ riskFreeRateAnnualPct: 0 });
    const undeclaredStats = calculator.calculatePortfolioStats(trades);
    const explicitStats = calculator.calculatePortfolioStats(explicit);

    expect(undeclaredStats.netPl).toBe(explicitStats.netPl);
    expect(undeclaredStats.profitFactor).toBe(explicitStats.profitFactor);
    expect(undeclaredStats.sharpeRatio).toBe(explicitStats.sharpeRatio);
    expect(undeclaredStats.sortinoRatio).toBe(explicitStats.sortinoRatio);
  });

  it("normalizes mixed-basis leg groups to one net basis", () => {
    const combined = combineLegGroup([
      trade({
        pl: 100,
        plBasis: PlBasis.NetIncludesFees,
        legs: "call spread",
        openingCommissionsFees: 2,
        closingCommissionsFees: 2,
      }),
      trade({
        pl: 100,
        plBasis: PlBasis.GrossBeforeFees,
        legs: "put spread",
        openingCommissionsFees: 3,
        closingCommissionsFees: 3,
      }),
    ]);

    expect(combined.plBasis).toBe("net_includes_fees");
    expect(combined.pl).toBe(194);
    expect(getNetPl(combined)).toBe(194);
  });

  it("preserves OO metrics when paired entry legs are grouped", () => {
    let runningFunds = 100000;
    const rawTrades = [100, -40, 80, -20].flatMap((groupPl, index) => {
      const date = new Date(2026, 0, 5 + index);
      const legs = [
        trade({
          dateOpened: date,
          dateClosed: date,
          timeOpened: "09:40:00",
          timeClosed: "15:54:00",
          strategy: "Grouped OO",
          legs: "call spread",
          pl: groupPl * 0.6,
          plBasis: PlBasis.NetIncludesFees,
          openingCommissionsFees: 1.78,
          closingCommissionsFees: 0.78,
        }),
        trade({
          dateOpened: date,
          dateClosed: date,
          timeOpened: "09:40:00",
          timeClosed: "15:55:00",
          strategy: "Grouped OO",
          legs: "put spread",
          pl: groupPl * 0.4,
          plBasis: PlBasis.NetIncludesFees,
          openingCommissionsFees: 1.78,
          closingCommissionsFees: 0.78,
        }),
      ];
      return legs.map((item) => {
        runningFunds += item.pl;
        return { ...item, fundsAtClose: runningFunds };
      });
    });
    const grouped = combineAllLegGroups(rawTrades);
    const calculator = new PortfolioStatsCalculator({ riskFreeRateAnnualPct: 2.5 });
    const rawStats = calculator.calculatePortfolioStats(rawTrades);
    const groupedStats = calculator.calculatePortfolioStats(grouped);

    expect(grouped).toHaveLength(4);
    expect(grouped.every((item) => item.plBasis === "net_includes_fees")).toBe(true);
    expect(groupedStats.netPl).toBeCloseTo(rawStats.netPl, 10);
    expect(groupedStats.totalCommissions).toBeCloseTo(rawStats.totalCommissions, 10);
    expect(groupedStats.sharpeRatio).toBeCloseTo(rawStats.sharpeRatio!, 10);
    expect(groupedStats.sortinoRatio).toBeCloseTo(rawStats.sortinoRatio!, 10);
  });

  it("uses sample N-1 volatility and echoes a fixed annual RFR", () => {
    const trades = [
      trade({ pl: 1000, plBasis: PlBasis.NetIncludesFees }),
      trade({
        dateOpened: new Date("2026-01-05"),
        dateClosed: new Date("2026-01-05"),
        pl: -505,
        plBasis: PlBasis.NetIncludesFees,
      }),
      trade({
        dateOpened: new Date("2026-01-06"),
        dateClosed: new Date("2026-01-06"),
        pl: 1004.95,
        plBasis: PlBasis.NetIncludesFees,
      }),
    ];
    const dailyLogs: DailyLogEntry[] = [
      {
        date: new Date("2026-01-02"),
        netLiquidity: 101000,
        currentFunds: 101000,
        withdrawn: 0,
        tradingFunds: 101000,
        dailyPl: 1000,
        dailyPlPct: 1,
        drawdownPct: 0,
      },
      {
        date: new Date("2026-01-05"),
        netLiquidity: 100495,
        currentFunds: 100495,
        withdrawn: 0,
        tradingFunds: 100495,
        dailyPl: -505,
        dailyPlPct: -0.5,
        drawdownPct: -0.5,
      },
      {
        date: new Date("2026-01-06"),
        netLiquidity: 101499.95,
        currentFunds: 101499.95,
        withdrawn: 0,
        tradingFunds: 101499.95,
        dailyPl: 1004.95,
        dailyPlPct: 1,
        drawdownPct: 0,
      },
    ];
    const calculator = new PortfolioStatsCalculator({ riskFreeRateAnnualPct: 0 });
    const stats = calculator.calculatePortfolioStats(trades, dailyLogs);
    const expectedSampleStd = Math.sqrt(
      ((0.01 - 0.005) ** 2 + (-0.005 - 0.005) ** 2 + (0.01 - 0.005) ** 2) / 2,
    );
    const expectedSharpe = (0.005 / expectedSampleStd) * Math.sqrt(252);

    expect(stats.sharpeRatio).toBeCloseTo(expectedSharpe, 10);

    const methodology = calculator.getCalculationMethodology(trades, dailyLogs);
    expect(methodology.sharpe.volatilityEstimator).toBe("sample_standard_deviation_n_minus_1");
    expect(methodology.sharpe.riskFreeRate).toEqual({
      mode: "fixed",
      annualRatePct: 0,
    });
    expect(methodology.sortino).toEqual({
      annualizationFactor: 252,
      downsideTarget: "zero_excess_return",
      observationSet: "all_return_observations_positive_values_contribute_zero",
      denominator: "total_observations_n",
      riskFreeRate: "same_daily_rate_as_sharpe",
    });
    expect(methodology.returns).toMatchObject({
      source: "daily_log",
      observations: 3,
      idleDays: "included_as_provided",
    });
  });

  it("matches the reduced OO display benchmark at a fixed 2.5% RFR", () => {
    // Synthetic excess-return shape reduced from the supplied OO parity case.
    // It locks the two independently displayed rounded risk metrics without
    // committing the user's trade or portfolio logs.
    const excessReturns = [
      -0.01, -0.01, 0.021984978900273847, 0.0006599291968471125, 0.0006599291968471125,
      0.0006599291968471125, 0.0006599291968471125, 0.0006599291968471125, 0.0006599291968471125,
      0.0006599291968471125,
    ];
    const dailyRiskFreeRate = 0.025 / 252;
    let previousValue = 100000;
    const dates = [
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
    ];
    const dailyLogs: DailyLogEntry[] = excessReturns.map((excessReturn, index) => {
      const dailyPl = previousValue * (excessReturn + dailyRiskFreeRate);
      previousValue += dailyPl;
      return {
        date: new Date(dates[index]),
        netLiquidity: previousValue,
        currentFunds: previousValue,
        withdrawn: 0,
        tradingFunds: previousValue,
        dailyPl,
        dailyPlPct: 0,
        drawdownPct: 0,
      };
    });
    const trades = dates.map((date, index) =>
      trade({
        dateOpened: new Date(date),
        dateClosed: new Date(date),
        pl: dailyLogs[index].dailyPl,
        fundsAtClose: dailyLogs[index].netLiquidity,
        plBasis: PlBasis.NetIncludesFees,
      }),
    );

    const stats = new PortfolioStatsCalculator({
      riskFreeRateAnnualPct: 2.5,
    }).calculatePortfolioStats(trades, dailyLogs);

    expect(stats.sharpeRatio).toBeCloseTo(1.20437, 5);
    expect(stats.sortinoRatio).toBeCloseTo(2.344359, 5);
    expect(stats.sharpeRatio?.toFixed(1)).toBe("1.2");
    expect(stats.sortinoRatio?.toFixed(2)).toBe("2.34");
  });

  it("inserts zero-P/L weekdays for trade-only annualization", () => {
    const trades = [
      trade({ dateClosed: new Date("2026-01-05"), plBasis: PlBasis.NetIncludesFees }),
      trade({
        dateOpened: new Date("2026-01-16"),
        dateClosed: new Date("2026-01-16"),
        pl: -50,
        plBasis: PlBasis.NetIncludesFees,
      }),
    ];

    const methodology = new PortfolioStatsCalculator({
      riskFreeRateAnnualPct: 0,
    }).getCalculationMethodology(trades);

    expect(methodology.returns).toMatchObject({
      source: "realized_trade_pl",
      observations: 10,
      idleDays: "included_business_days",
    });
  });

  it("discloses rolling windows as realized-trade dates rather than days", () => {
    const trades = [
      trade({ dateClosed: new Date("2026-01-05"), plBasis: PlBasis.NetIncludesFees }),
      trade({
        dateOpened: new Date("2026-01-16"),
        dateClosed: new Date("2026-01-16"),
        pl: -50,
        plBasis: PlBasis.NetIncludesFees,
      }),
    ];

    const [point] = PerformanceCalculator.calculateRollingSharpe(trades, 2, 0);

    expect(point.windowDefinition).toBe("distinct_realized_trade_dates");
    expect(point.requestedWindowSize).toBe(2);
    expect(point.calculationMethodology.returns.observations).toBe(10);
    expect(point.calculationMethodology.warnings.join(" ")).toContain(
      "2 distinct realized-trade dates",
    );
  });

  it("discloses stale historical DTB3 observations", () => {
    const trades = [
      trade({ dateClosed: new Date("2099-01-05"), plBasis: PlBasis.NetIncludesFees }),
      trade({
        dateOpened: new Date("2099-01-06"),
        dateClosed: new Date("2099-01-06"),
        plBasis: PlBasis.NetIncludesFees,
      }),
    ];

    const methodology = new PortfolioStatsCalculator().getCalculationMethodology(trades);

    expect(methodology.returns.attribution).toBe("date_closed_fallback_date_opened");
    expect(methodology.returns.idleDays).toBe("included_business_days");
    expect(methodology.sharpe.riskFreeRate).toMatchObject({
      mode: "historical",
      series: "FRED_DTB3",
      resolutionCounts: { staleAfterLatest: 2 },
    });
    expect(methodology.warnings.join(" ")).toContain("latest available DTB3 rate");
  });
});
