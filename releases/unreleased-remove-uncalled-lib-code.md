# Unreleased — uncalled library code removed

**Breaking change for 4.0: library exports removed.** Nothing in the web app, the MCP server or the library called these. Each one turned local-midnight calendar dates into days with `toISOString()`, which names the previous day east of UTC. They are deleted rather than fixed.

Removed from `@tradeblocks/lib` (and `@tradeblocks/lib/calculations`):

- `PerformanceCalculator`, with its static methods `calculatePerformanceMetrics`, `calculateMonthlyReturns`, `calculateRollingSharpe`, `calculateStreaks` and `calculatePLDistribution`. For portfolio statistics and streaks use `PortfolioStatsCalculator`; for chart series use `buildPerformanceSnapshot`.
- `CalculationOrchestrator`, the `calculationOrchestrator` instance, `CalculationCache` and `generateDataHash`. Its cache was filled only by `calculateAll`, so clearing it did nothing.
- `DailyLogProcessor.validateDataConsistency`.

Removed from library source modules that the package does not export:

- `buildPortfolioTimeline`, `getPortfolioValueFromDailyLog`, `interpolatePortfolioValues` and the two-argument `calculateInitialCapital` in `processing/capital-calculator.ts`. `calculateInitialCapitalFromTrades` and `calculateInitialCapitalFromDailyLog` stay exported. `PortfolioStatsCalculator.calculateInitialCapital(trades, dailyLogs)` is the two-argument fallback.
- `exportTradesToCSV` in `db/trades-store.ts` and `exportDailyLogsToCSV` in `db/daily-logs-store.ts`.

No calculation, MCP tool output or web chart changes.

This note does not bump a version or publish a release.
