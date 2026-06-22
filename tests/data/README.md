# Test Data Directory

This directory contains test data for portfolio calculations validation.

## Mock Data (Default)

- `mock-trades.ts`: Predefined trade data with known expected results
- `mock-daily-logs.ts`: Corresponding daily portfolio values
- `csv-loader.ts`: Utility to load CSV files or fall back to mock data

## CSV Data (Optional)

Place your test CSV files here to test against real data:

### `tradelog.csv`

Should contain columns matching the Trade model:

- Date Opened, Time Opened, Opening Price, Legs, Premium
- Closing Price, Date Closed, Time Closed, Avg. Closing Cost
- Reason For Close, P/L, No. of Contracts, Funds at Close
- Margin Req., Strategy, Opening Commissions + Fees
- Closing Commissions + Fees, Opening Short/Long Ratio
- Closing Short/Long Ratio, Opening VIX, Closing VIX
- Gap, Movement, Max Profit, Max Loss

### `dailylog.csv`

Should contain columns matching the DailyLogEntry model:

- Date, Net Liquidity, Current Funds, Withdrawn
- Trading Funds, Daily P/L, Daily P/L%, Drawdown%

## Usage

### Running Tests

```bash
# Run all tests
npm test

# Run only portfolio stats tests
npm run test:portfolio

# Run tests with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

### Test Modes

Tests will automatically:

1. **Check for CSV files first** - If `tradelog.csv` and/or `dailylog.csv` exist
2. **Fall back to mock data** - If CSV files don't exist or fail to parse
3. **Report data source** - Console output shows which data source is being used

This allows for:

- **Automated testing** with predictable results (mock data)
- **Validation against real data** (CSV files)
- **Regression testing** when calculations change

### Expected Results

With mock data, tests validate:

- **Basic Stats**: Total P/L, win rate, average win/loss
- **Drawdown Metrics**: Max drawdown, time in drawdown
- **Strategy Filtering**: Proper isolation of strategy-specific performance
- **Edge Cases**: Empty data, missing daily logs, etc.

### Debugging Failed Tests

If tests fail:

1. **Check console output** for data source and loaded counts
2. **Run with verbose logging**: Tests include detailed result logging
3. **Compare against legacy**: Use same data with legacy Python calculator
4. **Validate CSV format**: Ensure column names match exactly

### Legacy Compatibility

Mock data is based on the legacy Python test framework (`legacy/tests/conftest.py`) to ensure calculation compatibility between implementations.
