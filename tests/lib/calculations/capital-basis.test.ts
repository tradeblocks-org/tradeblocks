import {
  dailyNetPlByCloseDate,
  periodReturnPct,
  plWithoutBestDays,
  positiveYears,
  summarizeCapitalBasis,
  type DailyNetPl,
  type Trade,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

// Synthetic series: 20 days of +10, three planted big days and one big loss.
function series(): DailyNetPl[] {
  const out: DailyNetPl[] = [];
  for (let i = 0; i < 20; i++) {
    const date = `2023-03-${String(i + 1).padStart(2, "0")}`;
    out.push({ date, pl: 10 });
  }
  out[4].pl = 500; // 2023-03-05
  out[9].pl = 300; // 2023-03-10
  out[14].pl = 300; // 2023-03-15 (tie with 03-10)
  out[17].pl = -400; // 2023-03-18
  return out;
}

function trade(date: string, closeDate: string | undefined, pl: number, fees = 0): Trade {
  return {
    dateOpened: new Date(`${date}T00:00:00`),
    dateClosed: closeDate ? new Date(`${closeDate}T00:00:00`) : undefined,
    timeOpened: "09:30:00",
    openingPrice: 0,
    legs: "",
    premium: 0,
    pl,
    numContracts: 1,
    fundsAtClose: 0,
    marginReq: 0,
    strategy: "S",
    openingCommissionsFees: fees,
    closingCommissionsFees: 0,
    openingShortLongRatio: 0,
  } as Trade;
}

describe("dailyNetPlByCloseDate", () => {
  it("sums net P&L per close date and falls back to the open date", () => {
    const daily = dailyNetPlByCloseDate([
      trade("2023-01-02", "2023-01-04", 100),
      trade("2023-01-03", "2023-01-04", -30),
      trade("2023-01-05", undefined, 7),
    ]);
    expect(daily).toEqual([
      { date: "2023-01-04", pl: 70 },
      { date: "2023-01-05", pl: 7 },
    ]);
  });
});

describe("plWithoutBestDays", () => {
  it("removes the best days, ties to the earlier date", () => {
    const daily = series();
    // total = 16 x 10 + 500 + 300 + 300 - 400 = 860
    const [one, two, three] = plWithoutBestDays(daily, [3, 1, 2, 1]);
    expect(one).toEqual({
      n: 1,
      pl: 360,
      removedPl: 500,
      shareOfTotal: 500 / 860,
      days: ["2023-03-05"],
    });
    expect(two.days).toEqual(["2023-03-05", "2023-03-10"]);
    expect(two.pl).toBe(60);
    expect(three.pl).toBe(-240);
    expect(three.shareOfTotal).toBeCloseTo(1100 / 860, 12);
  });

  it("never removes losing days and reports null share for a non-positive total", () => {
    const daily: DailyNetPl[] = [
      { date: "2023-01-02", pl: 50 },
      { date: "2023-01-03", pl: -80 },
    ];
    const [r] = plWithoutBestDays(daily, [5]);
    expect(r.days).toEqual(["2023-01-02"]);
    expect(r.pl).toBe(-80);
    expect(r.shareOfTotal).toBeNull();
  });
});

describe("positiveYears", () => {
  it("counts calendar years with positive net P&L", () => {
    const result = positiveYears([
      { date: "2021-05-03", pl: 100 },
      { date: "2022-02-01", pl: -50 },
      { date: "2022-11-01", pl: 20 },
      { date: "2023-06-01", pl: 1 },
    ]);
    expect(result.perYear).toEqual([
      { year: 2021, netPl: 100 },
      { year: 2022, netPl: -30 },
      { year: 2023, netPl: 1 },
    ]);
    expect(result.share).toBeCloseTo(2 / 3, 12);
    expect(positiveYears([]).share).toBeNull();
  });
});

describe("capital basis", () => {
  it("computes total return and drawdown on amount + cumulative P&L", () => {
    const s = summarizeCapitalBasis(series(), { mode: "fixed", amount: 10_000 });
    expect(s.netPl).toBe(860);
    expect(s.totalReturnPct).toBeCloseTo(8.6, 12);
    // Peak 10,000 + 1,240 on 03-17, then -400 on 03-18.
    expect(s.maxDrawdownDollars).toBe(400);
    expect(s.maxDrawdownPct).toBeCloseTo((400 / 11_240) * 100, 12);
  });

  it("divides by the same amount (fixed) or by prior equity (compounding)", () => {
    const periods = [{ netPl: 1_000 }, { netPl: 1_100 }, { netPl: -2_100 }];
    expect(periodReturnPct(periods, { mode: "fixed", amount: 10_000 })).toEqual([10, 11, -21]);
    const compounding = periodReturnPct(periods, { mode: "compounding", amount: 10_000 });
    expect(compounding[0]).toBeCloseTo(10, 12);
    expect(compounding[1]).toBeCloseTo(10, 12);
    expect(compounding[2]).toBeCloseTo((-2_100 / 12_100) * 100, 12);
  });

  it("yields null for a non-positive compounding base and rejects a bad amount", () => {
    expect(
      periodReturnPct([{ netPl: -1_000 }, { netPl: 5 }], { mode: "compounding", amount: 1_000 }),
    ).toEqual([-100, null]);
    expect(() => periodReturnPct([], { mode: "fixed", amount: 0 })).toThrow(RangeError);
  });
});
