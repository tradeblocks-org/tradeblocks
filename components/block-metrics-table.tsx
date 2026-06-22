interface MetricRow {
  category: string;
  metric: string;
  value: string;
  change: string;
  status: "positive" | "neutral" | "negative";
}

const metrics: MetricRow[] = [
  {
    category: "Return Metrics",
    metric: "Total P&L",
    value: "$2,802,985",
    change: "+4.8% vs. prior block",
    status: "positive",
  },
  {
    category: "Return Metrics",
    metric: "CAGR",
    value: "1359.40%",
    change: "+2.4 pts",
    status: "positive",
  },
  {
    category: "Risk & Drawdown",
    metric: "Max Drawdown",
    value: "5.55%",
    change: "-0.6 pts",
    status: "positive",
  },
  {
    category: "Risk & Drawdown",
    metric: "Sharpe Ratio",
    value: "7.65",
    change: "-0.12",
    status: "negative",
  },
  {
    category: "Consistency",
    metric: "Win Rate",
    value: "55.54%",
    change: "+1.8 pts",
    status: "positive",
  },
  {
    category: "Consistency",
    metric: "Loss Streak",
    value: "7",
    change: "Unchanged",
    status: "neutral",
  },
];

const statusClass: Record<MetricRow["status"], string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  neutral: "text-muted-foreground",
  negative: "text-rose-500 dark:text-rose-400",
};

export function BlockMetricsTable() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-6">
        <div>
          <h2 className="text-base font-semibold">Key Metrics</h2>
          <p className="text-sm text-muted-foreground">
            Snapshot of profitability, risk, and consistency for the active block.
          </p>
        </div>
        <span className="hidden rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 sm:inline-flex">
          Auto-updated
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border/60 text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left">
              <th scope="col" className="px-4 py-3 font-medium text-muted-foreground sm:px-6">
                Category
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-muted-foreground sm:px-6">
                Metric
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-muted-foreground sm:px-6">
                Value
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-muted-foreground sm:px-6">
                Change vs. prior block
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {metrics.map((row) => (
              <tr
                key={`${row.category}-${row.metric}`}
                className="transition-colors hover:bg-muted/30"
              >
                <td className="whitespace-nowrap px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:px-6">
                  {row.category}
                </td>
                <td className="px-4 py-3 font-medium text-foreground sm:px-6">{row.metric}</td>
                <td className="px-4 py-3 font-semibold tabular-nums text-foreground sm:px-6">
                  {row.value}
                </td>
                <td className={`px-4 py-3 text-sm sm:px-6 ${statusClass[row.status]}`}>
                  {row.change}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
