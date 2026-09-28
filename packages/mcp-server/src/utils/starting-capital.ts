import { PortfolioStatsCalculator } from "@tradeblocks/lib";
import type { DailyLogEntry, Trade } from "@tradeblocks/lib";

export type CapitalSource = "observed_trade_funds" | "daily_log" | "assumed_default";

/** The two MCP views share this capital and its evidence; absent evidence is never observed. */
export function resolveStartingCapital(
  trades: Trade[],
  dailyLogs?: DailyLogEntry[],
): { amount: number; source: CapitalSource } {
  if (dailyLogs?.length) {
    const first = dailyLogs.reduce((earliest, row) =>
      row.date.getTime() < earliest.date.getTime() ? row : earliest,
    );
    const capital = first.netLiquidity - first.dailyPl;
    if (first.startingCapitalInputsProvided !== false && Number.isFinite(capital) && capital > 0) {
      return { amount: capital, source: "daily_log" };
    }
  }

  if (trades.length) {
    const first = [...trades].sort((a, b) => {
      const date =
        (a.dateClosed ?? a.dateOpened).getTime() - (b.dateClosed ?? b.dateOpened).getTime();
      if (date) return date;
      const closeTime = (a.timeClosed ?? a.timeOpened).localeCompare(b.timeClosed ?? b.timeOpened);
      if (closeTime) return closeTime;
      const openDate = a.dateOpened.getTime() - b.dateOpened.getTime();
      return openDate || a.timeOpened.localeCompare(b.timeOpened);
    })[0];
    const capital = PortfolioStatsCalculator.calculateInitialCapital([first]);
    if (first.fundsAtCloseProvided !== false && Number.isFinite(capital) && capital > 0) {
      return { amount: capital, source: "observed_trade_funds" };
    }
  }

  return { amount: 100000, source: "assumed_default" };
}
