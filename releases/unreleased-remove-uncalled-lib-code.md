# Unreleased — uncalled library code removed

**Breaking change for 4.0: library exports removed.** Nothing in the web app, the MCP server or the library called these. Several of them turned local-midnight calendar dates into days with `toISOString()`, which names the previous day east of UTC. They are deleted rather than fixed, together with the dead code around them.

Removed from `@tradeblocks/lib` and its `/calculations` subpath:

- `PerformanceCalculator`, with its static methods `calculatePerformanceMetrics`, `calculateMonthlyReturns`, `calculateRollingSharpe`, `calculateStreaks` and `calculatePLDistribution`. For portfolio statistics and streaks use `PortfolioStatsCalculator`; for chart series use `buildPerformanceSnapshot`.
- `CalculationOrchestrator`, the `calculationOrchestrator` instance, `CalculationCache` and `generateDataHash`. Its cache was filled only by `calculateAll`, so clearing it did nothing.
- `PortfolioStatsCalculator.calculatePortfolioValueAtDate`.

Removed from `@tradeblocks/lib` and its `/processing` subpath:

- `DailyLogProcessor.validateDataConsistency`.

Removed from library source modules that the package does not export:

- `buildPortfolioTimeline`, `getPortfolioValueFromDailyLog`, `interpolatePortfolioValues`, `calculatePortfolioValueAtDate` and the two-argument `calculateInitialCapital` in `processing/capital-calculator.ts`. `calculateInitialCapitalFromTrades` and `calculateInitialCapitalFromDailyLog` stay exported. The closest live equivalent of the two-argument function is `PortfolioStatsCalculator.calculateInitialCapital(trades, dailyLogs)`. It differs: it returns 0 when there are no trades even if a daily log is present, and without a daily log it uses the first trade by close date and its metric-basis P/L.
- `exportTradesToCSV` in `db/trades-store.ts` and `exportDailyLogsToCSV` in `db/daily-logs-store.ts`.

No calculation, MCP tool output or web chart changes.

This note does not bump a version or publish a release.
