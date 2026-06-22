/**
 * Tests for Static Dataset Matcher
 */

import {
  combineDateAndTime,
  matchTradeToDataset,
  matchTradeToDatasetWithDetails,
  calculateMatchStats,
  getMatchedValuesForTrade,
  getMatchedFieldValue,
  formatTimeDifference,
  Trade,
  StaticDataset,
  StaticDatasetRow,
  MatchStrategy,
} from "@tradeblocks/lib";

/**
 * Get Eastern Time offset in minutes for a given date
 * Returns the offset from UTC in minutes (e.g., -300 for EST, -240 for EDT)
 */
function getEasternTimeOffset(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName");

  if (tzPart) {
    const match = tzPart.value.match(/GMT([+-]\d+)/);
    if (match) {
      return parseInt(match[1], 10) * 60;
    }
  }
  return -300; // Fallback to EST
}

// Helper to create a minimal trade
// Creates date as UTC midnight (matching how app parses 'YYYY-MM-DD' from CSV)
function createTrade(dateOpened: string, timeOpened: string): Trade {
  // Parse date as UTC midnight (same as new Date('YYYY-MM-DD') in the app)
  const date = new Date(dateOpened);

  return {
    dateOpened: date,
    timeOpened,
    openingPrice: 4500,
    legs: "SPX TEST",
    premium: 100,
    pl: 50,
    numContracts: 1,
    fundsAtClose: 10050,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 0,
    closingCommissionsFees: 0,
    openingShortLongRatio: 1,
  };
}

// Helper to create a timestamp for dataset rows
// Creates timestamp in Eastern Time (like TradingView exports)
function createTimestamp(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes, seconds = 0] = timeStr.split(":").map(Number);

  // Create as UTC with the given time components
  const utcDate = Date.UTC(year, month - 1, day, hours, minutes, seconds, 0);
  const testDate = new Date(utcDate);
  const etOffset = getEasternTimeOffset(testDate);

  // Convert Eastern Time to UTC by subtracting the offset
  return new Date(utcDate - etOffset * 60 * 1000);
}

// Helper to create dataset rows
function createRows(timestamps: Date[], values: Record<string, number>[]): StaticDatasetRow[] {
  return timestamps.map((timestamp, index) => ({
    datasetId: "test-dataset",
    timestamp,
    values: values[index] || values[0],
  }));
}

// Helper to create a dataset
function createDataset(
  matchStrategy: MatchStrategy = "nearest-before",
  dateRange?: { start: Date; end: Date },
): StaticDataset {
  return {
    id: "test-dataset",
    name: "vix",
    fileName: "vix.csv",
    uploadedAt: new Date(),
    rowCount: 10,
    dateRange: dateRange || {
      start: createTimestamp("2024-01-15", "09:00:00"),
      end: createTimestamp("2024-01-15", "16:00:00"),
    },
    columns: ["close", "open", "high", "low"],
    matchStrategy,
  };
}

/**
 * Helper to format date in Eastern Time for verification
 */
function formatInEastern(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

describe("combineDateAndTime", () => {
  it("combines date and time correctly - treating time as Eastern Time", () => {
    // Use UTC midnight date (same as new Date('2024-01-15') from CSV parsing)
    const date = new Date("2024-01-15"); // UTC midnight
    const time = "10:37:00";

    const result = combineDateAndTime(date, time);

    // Verify the result represents 10:37 AM Eastern Time on Jan 15
    const etFormatted = formatInEastern(result);
    expect(etFormatted).toMatch(/01\/15\/2024/);
    expect(etFormatted).toMatch(/10:37:00/);
  });

  it("handles single-digit hours", () => {
    const date = new Date("2024-01-15");
    const time = "9:30:00";

    const result = combineDateAndTime(date, time);

    const etFormatted = formatInEastern(result);
    expect(etFormatted).toMatch(/09:30:00/);
  });

  it("handles time without seconds", () => {
    const date = new Date("2024-01-15");
    const time = "10:30";

    const result = combineDateAndTime(date, time);

    const etFormatted = formatInEastern(result);
    expect(etFormatted).toMatch(/10:30:00/);
  });
});

describe("matchTradeToDataset", () => {
  const hourlyTimestamps = [
    createTimestamp("2024-01-15", "09:00:00"),
    createTimestamp("2024-01-15", "10:00:00"),
    createTimestamp("2024-01-15", "11:00:00"),
    createTimestamp("2024-01-15", "12:00:00"),
    createTimestamp("2024-01-15", "13:00:00"),
  ];

  const hourlyValues = hourlyTimestamps.map((_, i) => ({
    close: 14 + i * 0.5,
    open: 14 + i * 0.4,
    high: 14.5 + i * 0.5,
    low: 13.5 + i * 0.5,
  }));

  describe("exact matching", () => {
    it("finds exact match when timestamp matches", () => {
      const trade = createTrade("2024-01-15", "10:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "exact");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(14.5);
    });

    it("matches trade to dataset with exact timestamp - issue reproduction", () => {
      // This test reproduces the issue from the bug report where
      // "2025-12-16 15:19:00" in the tradelog should match
      // "2025-12-16 15:19:00" in the static dataset
      const trade = createTrade("2025-12-16", "15:19:00");
      const rows = createRows([createTimestamp("2025-12-16", "15:19:00")], [{ close: 42 }]);

      const result = matchTradeToDataset(trade, rows, "exact");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(42);
    });

    it("returns null when no exact match exists", () => {
      const trade = createTrade("2024-01-15", "10:37:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "exact");

      expect(result).toBeNull();
    });

    it("returns null for empty rows", () => {
      const trade = createTrade("2024-01-15", "10:00:00");

      const result = matchTradeToDataset(trade, [], "exact");

      expect(result).toBeNull();
    });
  });

  describe("nearest-before matching", () => {
    it("finds the most recent row at or before trade time", () => {
      const trade = createTrade("2024-01-15", "10:37:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-before");

      // Should match 10:00, not 11:00
      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(14.5); // 10:00 row
    });

    it("matches exact timestamp when available", () => {
      const trade = createTrade("2024-01-15", "10:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-before");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(14.5); // 10:00 row
    });

    it("returns null when trade is before all rows", () => {
      const trade = createTrade("2024-01-15", "08:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-before");

      expect(result).toBeNull();
    });
  });

  describe("nearest-after matching", () => {
    it("finds the earliest row at or after trade time", () => {
      const trade = createTrade("2024-01-15", "10:37:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-after");

      // Should match 11:00, not 10:00
      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(15.0); // 11:00 row
    });

    it("matches exact timestamp when available", () => {
      const trade = createTrade("2024-01-15", "10:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-after");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(14.5); // 10:00 row
    });

    it("returns null when trade is after all rows", () => {
      const trade = createTrade("2024-01-15", "17:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest-after");

      expect(result).toBeNull();
    });
  });

  describe("same-day matching", () => {
    // Daily data - only dates, no specific times (timestamps at midnight)
    const dailyTimestamps = [
      createTimestamp("2024-01-14", "00:00:00"),
      createTimestamp("2024-01-15", "00:00:00"),
      createTimestamp("2024-01-16", "00:00:00"),
      createTimestamp("2024-01-17", "00:00:00"),
    ];

    const dailyValues = dailyTimestamps.map((_, i) => ({
      close: 5900 + i * 50,
      open: 5890 + i * 50,
    }));

    it("matches trade to same calendar day regardless of time", () => {
      // Trade at 10:37 AM should match the 00:00:00 row for the same day
      const trade = createTrade("2024-01-15", "10:37:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(5950); // Jan 15 row
    });

    it("matches trade at market close to same day", () => {
      // Trade at 4:00 PM (16:00) should still match the same day
      const trade = createTrade("2024-01-15", "16:00:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(5950); // Jan 15 row
    });

    it("matches trade at midnight to that day", () => {
      // Trade at exactly midnight should match
      const trade = createTrade("2024-01-15", "00:00:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(5950); // Jan 15 row
    });

    it("returns null when no row exists for that day", () => {
      // Trade on a day not in the dataset
      const trade = createTrade("2024-01-20", "10:00:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).toBeNull();
    });

    it("handles first day in dataset", () => {
      const trade = createTrade("2024-01-14", "09:31:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(5900); // Jan 14 row
    });

    it("handles last day in dataset", () => {
      const trade = createTrade("2024-01-17", "15:45:00");
      const rows = createRows(dailyTimestamps, dailyValues);

      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(6050); // Jan 17 row
    });

    it("returns null for empty rows", () => {
      const trade = createTrade("2024-01-15", "10:00:00");

      const result = matchTradeToDataset(trade, [], "same-day");

      expect(result).toBeNull();
    });
  });

  describe("nearest matching", () => {
    it("finds the closest row by absolute time on the same day", () => {
      // 10:50 is closer to 11:00 (10 min) than to 10:00 (50 min)
      const trade = createTrade("2024-01-15", "10:50:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(15.0); // 11:00 row (closer)
    });

    it("prefers before when equidistant", () => {
      // 10:30 is equidistant from 10:00 and 11:00
      const trade = createTrade("2024-01-15", "10:30:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(14.5); // 10:00 row (before, ties go to before)
    });

    it("finds row before when no after exists on same day", () => {
      const trade = createTrade("2024-01-15", "17:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest");

      expect(result).not.toBeNull();
      // Should match last row on same day (13:00)
      expect(result?.values.close).toBe(16.0);
    });

    it("finds row after when no before exists on same day", () => {
      const trade = createTrade("2024-01-15", "08:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues);

      const result = matchTradeToDataset(trade, rows, "nearest");

      expect(result).not.toBeNull();
      // Should match first row on same day (09:00)
      expect(result?.values.close).toBe(14.0);
    });

    it("returns null when trade is on a different day from all dataset rows", () => {
      // Trade on Jan 16, but all rows are on Jan 15
      const trade = createTrade("2024-01-16", "10:00:00");
      const rows = createRows(hourlyTimestamps, hourlyValues); // All Jan 15

      const result = matchTradeToDataset(trade, rows, "nearest");

      // Should NOT match across days - this is the same-day constraint
      expect(result).toBeNull();
    });

    it("does not match to rows from previous day even if closer in absolute time", () => {
      // Dataset has rows at end of Jan 14 and start of Jan 15
      const crossDayTimestamps = [
        createTimestamp("2024-01-14", "15:00:00"),
        createTimestamp("2024-01-14", "16:00:00"), // 4 PM Jan 14
        createTimestamp("2024-01-15", "09:00:00"), // 9 AM Jan 15
        createTimestamp("2024-01-15", "10:00:00"),
      ];
      const crossDayValues = [{ close: 100 }, { close: 101 }, { close: 102 }, { close: 103 }];
      const rows = createRows(crossDayTimestamps, crossDayValues);

      // Trade at 8:00 AM Jan 15 - closer to 4 PM Jan 14 (16h) than 9 AM Jan 15 (1h)
      // but should match to 9 AM Jan 15 because of same-day constraint
      const trade = createTrade("2024-01-15", "08:00:00");

      const result = matchTradeToDataset(trade, rows, "nearest");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(102); // 9 AM Jan 15, not 4 PM Jan 14
    });
  });

  describe("DST edge cases", () => {
    it("correctly matches trades during DST spring-forward (March)", () => {
      // 2024 DST starts March 10 at 2 AM
      const dstTimestamps = [
        createTimestamp("2024-03-08", "10:00:00"),
        createTimestamp("2024-03-11", "10:00:00"), // After DST change
      ];
      const dstValues = [{ close: 100 }, { close: 101 }];
      const rows = createRows(dstTimestamps, dstValues);

      const trade = createTrade("2024-03-11", "10:00:00");
      const result = matchTradeToDataset(trade, rows, "exact");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(101);
    });

    it("correctly matches trades during DST fall-back (November)", () => {
      // 2024 DST ends November 3 at 2 AM
      const dstTimestamps = [
        createTimestamp("2024-11-01", "10:00:00"),
        createTimestamp("2024-11-04", "10:00:00"), // After DST change
      ];
      const dstValues = [{ close: 100 }, { close: 101 }];
      const rows = createRows(dstTimestamps, dstValues);

      const trade = createTrade("2024-11-04", "10:00:00");
      const result = matchTradeToDataset(trade, rows, "exact");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(101);
    });

    it("same-day matching works correctly around DST transition", () => {
      // Daily data around DST spring-forward
      const dailyTimestamps = [
        createTimestamp("2024-03-08", "00:00:00"),
        createTimestamp("2024-03-11", "00:00:00"), // Skips weekend + DST
      ];
      const dailyValues = [{ close: 100 }, { close: 101 }];
      const rows = createRows(dailyTimestamps, dailyValues);

      // Trade on March 11 should match March 11 data
      const trade = createTrade("2024-03-11", "10:30:00");
      const result = matchTradeToDataset(trade, rows, "same-day");

      expect(result).not.toBeNull();
      expect(result?.values.close).toBe(101);
    });
  });
});

describe("matchTradeToDatasetWithDetails", () => {
  it("returns match details including time difference", () => {
    const trade = createTrade("2024-01-15", "10:37:00");
    const dataset = createDataset("nearest-before");
    const rows = createRows(
      [createTimestamp("2024-01-15", "10:00:00"), createTimestamp("2024-01-15", "11:00:00")],
      [{ close: 14.5 }, { close: 15.0 }],
    );

    const result = matchTradeToDatasetWithDetails(trade, dataset, rows);

    expect(result.datasetId).toBe("test-dataset");
    expect(result.datasetName).toBe("vix");
    expect(result.matchedRow).not.toBeNull();
    expect(result.matchedTimestamp).not.toBeNull();
    // Trade at 10:37, matched to 10:00 = 37 minutes difference
    expect(result.timeDifferenceMs).toBe(-37 * 60 * 1000);
  });

  it("returns null values when no match found", () => {
    const trade = createTrade("2024-01-15", "08:00:00");
    const dataset = createDataset("nearest-before");
    const rows = createRows([createTimestamp("2024-01-15", "10:00:00")], [{ close: 14.5 }]);

    const result = matchTradeToDatasetWithDetails(trade, dataset, rows);

    expect(result.matchedRow).toBeNull();
    expect(result.matchedTimestamp).toBeNull();
    expect(result.timeDifferenceMs).toBeNull();
  });
});

describe("calculateMatchStats", () => {
  it("calculates correct match statistics", () => {
    const trades = [
      createTrade("2024-01-15", "10:00:00"),
      createTrade("2024-01-15", "11:00:00"),
      createTrade("2024-01-15", "12:00:00"),
    ];
    const dataset = createDataset("exact", {
      start: createTimestamp("2024-01-15", "10:00:00"),
      end: createTimestamp("2024-01-15", "11:00:00"),
    });
    const rows = createRows(
      [createTimestamp("2024-01-15", "10:00:00"), createTimestamp("2024-01-15", "11:00:00")],
      [{ close: 14.5 }, { close: 15.0 }],
    );

    const stats = calculateMatchStats(trades, dataset, rows);

    expect(stats.totalTrades).toBe(3);
    expect(stats.matchedTrades).toBe(2); // 10:00 and 11:00 match
    // 12:00 is within the same calendar day (date range extended to end-of-day)
    // but won't find a match with 'exact' strategy
    expect(stats.outsideDateRange).toBe(0);
    expect(stats.matchPercentage).toBeCloseTo(66.7, 0);
  });

  it("marks trades before dataset start as outside range", () => {
    const trades = [
      createTrade("2024-01-14", "23:00:00"), // Day before
      createTrade("2024-01-15", "10:00:00"),
    ];
    const dataset = createDataset("exact", {
      start: createTimestamp("2024-01-15", "10:00:00"),
      end: createTimestamp("2024-01-15", "11:00:00"),
    });
    const rows = createRows([createTimestamp("2024-01-15", "10:00:00")], [{ close: 14.5 }]);

    const stats = calculateMatchStats(trades, dataset, rows);

    expect(stats.totalTrades).toBe(2);
    expect(stats.matchedTrades).toBe(1);
    expect(stats.outsideDateRange).toBe(1); // 23:00 on Jan 14 is before start
  });

  it("includes trades on final day of dataset even after last timestamp", () => {
    // This tests the fix for daily datasets where trades during the day
    // should still be considered "in range" even if the dataset timestamp is midnight
    const trades = [
      createTrade("2024-01-15", "14:30:00"), // Afternoon trade on last day
    ];
    const dataset = createDataset("same-day", {
      start: createTimestamp("2024-01-15", "00:00:00"), // Midnight timestamp
      end: createTimestamp("2024-01-15", "00:00:00"), // Same midnight
    });
    const rows = createRows([createTimestamp("2024-01-15", "00:00:00")], [{ close: 14.5 }]);

    const stats = calculateMatchStats(trades, dataset, rows);

    expect(stats.totalTrades).toBe(1);
    expect(stats.matchedTrades).toBe(1); // Should match with same-day strategy
    expect(stats.outsideDateRange).toBe(0); // Should NOT be outside range
  });

  it("handles empty trades", () => {
    const dataset = createDataset();
    const rows = createRows([createTimestamp("2024-01-15", "10:00:00")], [{ close: 14.5 }]);

    const stats = calculateMatchStats([], dataset, rows);

    expect(stats.totalTrades).toBe(0);
    expect(stats.matchedTrades).toBe(0);
    expect(stats.matchPercentage).toBe(0);
  });

  it("handles empty rows", () => {
    const trades = [createTrade("2024-01-15", "10:00:00")];
    const dataset = createDataset();

    const stats = calculateMatchStats(trades, dataset, []);

    expect(stats.totalTrades).toBe(1);
    expect(stats.matchedTrades).toBe(0);
    expect(stats.matchPercentage).toBe(0);
  });
});

describe("getMatchedValuesForTrade", () => {
  it("returns matched values from multiple datasets", () => {
    const trade = createTrade("2024-01-15", "10:00:00");

    const datasets = [
      {
        dataset: { ...createDataset(), name: "vix" },
        rows: createRows(
          [createTimestamp("2024-01-15", "10:00:00")],
          [{ close: 14.5, open: 14.2 }],
        ),
      },
      {
        dataset: { ...createDataset(), name: "spx" },
        rows: createRows(
          [createTimestamp("2024-01-15", "10:00:00")],
          [{ close: 4500, open: 4490 }],
        ),
      },
    ];

    const result = getMatchedValuesForTrade(trade, datasets);

    expect(result.vix).toBeDefined();
    expect(result.vix.close).toBe(14.5);
    expect(result.spx).toBeDefined();
    expect(result.spx.close).toBe(4500);
  });

  it("excludes datasets with no match", () => {
    const trade = createTrade("2024-01-15", "08:00:00");

    const datasets = [
      {
        dataset: createDataset("nearest-before"),
        rows: createRows([createTimestamp("2024-01-15", "10:00:00")], [{ close: 14.5 }]),
      },
    ];

    const result = getMatchedValuesForTrade(trade, datasets);

    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("getMatchedFieldValue", () => {
  it("returns value for a specific field", () => {
    const trade = createTrade("2024-01-15", "10:00:00");

    const datasets = [
      {
        dataset: { ...createDataset(), name: "vix" },
        rows: createRows(
          [createTimestamp("2024-01-15", "10:00:00")],
          [{ close: 14.5, open: 14.2 }],
        ),
      },
    ];

    const value = getMatchedFieldValue(trade, "vix.close", datasets);

    expect(value).toBe(14.5);
  });

  it("returns null for non-existent dataset", () => {
    const trade = createTrade("2024-01-15", "10:00:00");
    const datasets: Array<{ dataset: StaticDataset; rows: StaticDatasetRow[] }> = [];

    const value = getMatchedFieldValue(trade, "vix.close", datasets);

    expect(value).toBeNull();
  });

  it("returns null for non-existent column", () => {
    const trade = createTrade("2024-01-15", "10:00:00");

    const datasets = [
      {
        dataset: { ...createDataset(), name: "vix" },
        rows: createRows([createTimestamp("2024-01-15", "10:00:00")], [{ close: 14.5 }]),
      },
    ];

    const value = getMatchedFieldValue(trade, "vix.nonexistent", datasets);

    expect(value).toBeNull();
  });

  it("returns null for invalid field format", () => {
    const trade = createTrade("2024-01-15", "10:00:00");
    const datasets: Array<{ dataset: StaticDataset; rows: StaticDatasetRow[] }> = [];

    const value = getMatchedFieldValue(trade, "invalidfield", datasets);

    expect(value).toBeNull();
  });
});

describe("formatTimeDifference", () => {
  it('returns "No match" for null', () => {
    expect(formatTimeDifference(null)).toBe("No match");
  });

  it('returns "Exact match" for small differences', () => {
    expect(formatTimeDifference(500)).toBe("Exact match");
    expect(formatTimeDifference(-500)).toBe("Exact match");
  });

  it("formats seconds correctly", () => {
    expect(formatTimeDifference(30000)).toBe("+30s");
    expect(formatTimeDifference(-30000)).toBe("-30s");
  });

  it("formats minutes correctly", () => {
    expect(formatTimeDifference(5 * 60 * 1000)).toBe("+5m");
    expect(formatTimeDifference(-37 * 60 * 1000)).toBe("-37m");
  });

  it("formats hours correctly", () => {
    expect(formatTimeDifference(2 * 60 * 60 * 1000)).toBe("+2h");
    expect(formatTimeDifference(-3 * 60 * 60 * 1000)).toBe("-3h");
  });

  it("formats days correctly", () => {
    expect(formatTimeDifference(2 * 24 * 60 * 60 * 1000)).toBe("+2d");
    expect(formatTimeDifference(-5 * 24 * 60 * 60 * 1000)).toBe("-5d");
  });
});
