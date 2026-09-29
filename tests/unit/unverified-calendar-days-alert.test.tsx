import { render, screen } from "@testing-library/react";
import { UnverifiedCalendarDaysAlert } from "@/components/unverified-calendar-days-alert";
import type { Block } from "@tradeblocks/lib/stores";

function block(unverifiedCalendarDays?: Block["unverifiedCalendarDays"]): Block {
  return {
    id: "b1",
    name: "Iron Condor",
    isActive: true,
    created: new Date(),
    lastModified: new Date(),
    tradeLog: { fileName: "ic-trades.csv", rowCount: 10, fileSize: 1 },
    dailyLog: { fileName: "ic-daily.csv", rowCount: 10, fileSize: 1 },
    reportingLog: { fileName: "ic-strategy.csv", rowCount: 10, fileSize: 1 },
    unverifiedCalendarDays,
    stats: { totalPnL: 0, winRate: 0, totalTrades: 10, avgWin: 0, avgLoss: 0 },
  };
}

describe("UnverifiedCalendarDaysAlert", () => {
  it("names each file to re-import with its count of unconfirmed dates", () => {
    render(<UnverifiedCalendarDaysAlert block={block({ trades: 12, reportingLogs: 1 })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/may be off by one day/);
    expect(screen.getByText("Trade log (ic-trades.csv): 12 dates")).toBeInTheDocument();
    expect(screen.getByText("Reporting log (ic-strategy.csv): 1 date")).toBeInTheDocument();
    expect(screen.queryByText(/ic-daily\.csv/)).not.toBeInTheDocument();
  });

  it("shows nothing for a block whose dates are all confirmed", () => {
    const { container } = render(<UnverifiedCalendarDaysAlert block={block()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
