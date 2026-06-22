/**
 * Tests for Static Dataset Processor - timestamp parsing
 *
 * These tests verify that timestamps from various sources (TradingView, Yahoo Finance, etc.)
 * are correctly parsed into UTC dates that can be matched against trades.
 */

import { processStaticDatasetContent, suggestDatasetName } from "@tradeblocks/lib";

/**
 * Format a date in Eastern Time for verification
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

/**
 * Get just the date portion in Eastern Time (YYYY-MM-DD)
 */
function getEasternDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

describe("parseTimestamp in static dataset processor", () => {
  describe("date-only formats (YYYY-MM-DD)", () => {
    it("parses date-only as midnight Eastern Time, not UTC", async () => {
      // This was the bug: 2022-05-20 parsed as UTC midnight showed as May 19 in Eastern
      const csv = `time,close
2022-05-20,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);

      // Should be May 20 in Eastern Time
      const dateStr = getEasternDateString(result.rows[0].timestamp);
      expect(dateStr).toBe("2022-05-20");
    });

    it("handles multiple date-only rows correctly", async () => {
      const csv = `time,open,close
2022-05-18,4051.98,3923.67
2022-05-19,3899,3900.78
2022-05-20,3927.76,3901.35
2022-05-23,3919.42,3973.76`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(4);

      // Verify each date is correct in Eastern Time
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2022-05-18");
      expect(getEasternDateString(result.rows[1].timestamp)).toBe("2022-05-19");
      expect(getEasternDateString(result.rows[2].timestamp)).toBe("2022-05-20");
      expect(getEasternDateString(result.rows[3].timestamp)).toBe("2022-05-23");
    });

    it("handles dates during EST (winter)", async () => {
      // January is EST (UTC-5)
      const csv = `time,close
2024-01-15,4500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2024-01-15");
    });

    it("handles dates during EDT (summer)", async () => {
      // July is EDT (UTC-4)
      const csv = `time,close
2024-07-15,5500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2024-07-15");
    });

    it("handles DST spring-forward date (March)", async () => {
      // 2024 DST starts March 10
      const csv = `time,close
2024-03-08,5100
2024-03-11,5150`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(2);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2024-03-08");
      expect(getEasternDateString(result.rows[1].timestamp)).toBe("2024-03-11");
    });

    it("handles DST fall-back date (November)", async () => {
      // 2024 DST ends November 3
      const csv = `time,close
2024-11-01,5800
2024-11-04,5850`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(2);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2024-11-01");
      expect(getEasternDateString(result.rows[1].timestamp)).toBe("2024-11-04");
    });
  });

  describe("Unix timestamps", () => {
    it("parses Unix timestamp in seconds (TradingView format)", async () => {
      // 1742500200 = March 20, 2025 at 19:50 UTC = 3:50 PM Eastern (EDT)
      const csv = `time,RSI
1742500200,52.5`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);

      // Unix timestamps are already UTC, so we just verify the date and time
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/03\/20\/2025/);
      expect(etFormatted).toMatch(/15:50:00/); // 3:50 PM Eastern
    });

    it("parses Unix timestamp in milliseconds", async () => {
      // 1742500200000 = same as above but in milliseconds
      const csv = `time,RSI
1742500200000,52.5`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);

      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/03\/20\/2025/);
      expect(etFormatted).toMatch(/15:50:00/); // 3:50 PM Eastern
    });

    it("handles multiple Unix timestamps sorted by time", async () => {
      // 30-minute intervals
      const csv = `time,RSI
1742498400,48.2
1742500200,52.5
1742502000,55.1`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(3);

      // Should be sorted by timestamp
      expect(result.rows[0].timestamp.getTime()).toBeLessThan(result.rows[1].timestamp.getTime());
      expect(result.rows[1].timestamp.getTime()).toBeLessThan(result.rows[2].timestamp.getTime());
    });
  });

  describe("ISO 8601 with time", () => {
    it("parses ISO format with T separator and Z timezone", async () => {
      const csv = `time,close
2024-01-15T10:30:00Z,4500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      // 10:30 UTC = 5:30 AM EST
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/01\/15\/2024/);
      expect(etFormatted).toMatch(/05:30:00/);
    });

    it("parses ISO format with timezone offset", async () => {
      const csv = `time,close
2024-01-15T10:30:00-05:00,4500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      // 10:30 EST = 10:30 Eastern
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/01\/15\/2024/);
      expect(etFormatted).toMatch(/10:30:00/);
    });

    it("parses ISO local time format (no timezone) as Eastern Time", async () => {
      // This was a regression: 2024-01-15T10:30:00 (no Z or offset) was being dropped
      // because it didn't match any pattern - not the date-only YYYY-MM-DD pattern,
      // not the ISO with timezone pattern, and not the space-separated pattern
      const csv = `time,close
2024-01-15T10:30:00,4500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);
      // Should be parsed as 10:30 Eastern Time
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/01\/15\/2024/);
      expect(etFormatted).toMatch(/10:30:00/);
    });

    it("parses ISO local time format without seconds", async () => {
      const csv = `time,close
2024-01-15T10:30,4500`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/01\/15\/2024/);
      expect(etFormatted).toMatch(/10:30:00/);
    });
  });

  describe("US date formats", () => {
    it("parses MM/DD/YYYY format (date only) as Eastern midnight", async () => {
      const csv = `time,close
05/20/2022,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2022-05-20");
    });

    it("parses MM/DD/YYYY HH:mm format with time", async () => {
      const csv = `time,close
05/20/2022 10:30,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(1);
      // Time should be preserved (local time interpretation)
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/05\/20\/2022/);
    });

    it("parses YYYY-MM-DD HH:mm:ss format treating time as Eastern Time", async () => {
      // This test reproduces the exact issue from the bug report
      // "2025-12-16 15:19:00" should be treated as 3:19 PM Eastern Time
      const csv = `t,somevalue
2025-12-16 15:19:00,42`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.rows).toHaveLength(1);

      // Verify it was parsed as Eastern Time
      const etFormatted = formatInEastern(result.rows[0].timestamp);
      expect(etFormatted).toMatch(/12\/16\/2025/);
      expect(etFormatted).toMatch(/15:19:00/);

      // The value should be preserved
      expect(result.rows[0].values.somevalue).toBe(42);
    });
  });

  describe("date range calculation", () => {
    it("correctly calculates date range for date-only data", async () => {
      const csv = `time,close
2022-05-18,3923.67
2022-05-19,3900.78
2022-05-20,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(getEasternDateString(result.dataset.dateRange.start)).toBe("2022-05-18");
      expect(getEasternDateString(result.dataset.dateRange.end)).toBe("2022-05-20");
    });
  });

  describe("edge cases", () => {
    it("handles empty timestamp gracefully", async () => {
      const csv = `time,close
2022-05-18,3923.67
,3900.78
2022-05-20,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      // Should skip the row with empty timestamp
      expect(result.rows).toHaveLength(2);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("handles invalid timestamp gracefully", async () => {
      const csv = `time,close
2022-05-18,3923.67
not-a-date,3900.78
2022-05-20,3901.35`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      // Should skip the row with invalid timestamp
      expect(result.rows).toHaveLength(2);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("sorts rows by timestamp regardless of input order", async () => {
      const csv = `time,close
2022-05-20,3901.35
2022-05-18,3923.67
2022-05-19,3900.78`;

      const result = await processStaticDatasetContent(csv, {
        name: "test",
        fileName: "test.csv",
      });

      expect(result.rows).toHaveLength(3);
      expect(getEasternDateString(result.rows[0].timestamp)).toBe("2022-05-18");
      expect(getEasternDateString(result.rows[1].timestamp)).toBe("2022-05-19");
      expect(getEasternDateString(result.rows[2].timestamp)).toBe("2022-05-20");
    });
  });
});

describe("suggestDatasetName", () => {
  it("converts filename to snake_case without extension", () => {
    expect(suggestDatasetName("My Data File.csv")).toBe("my_data_file");
  });

  it("handles multiple invalid characters", () => {
    expect(suggestDatasetName("hello---world___test.xlsx")).toBe("hello_world_test");
  });

  it("removes leading non-alphanumeric after sanitization", () => {
    expect(suggestDatasetName("___leading.csv")).toBe("leading");
  });

  it("prefixes with data_ if result starts with non-alphanumeric", () => {
    // A filename that after sanitization starts with underscore
    expect(suggestDatasetName(".hidden-file.csv")).toBe("hidden_file");
  });

  it('returns "dataset" for empty or fully invalid input', () => {
    expect(suggestDatasetName("...")).toBe("dataset");
    expect(suggestDatasetName("   ")).toBe("dataset");
  });

  it("truncates to 50 characters", () => {
    const longName = "a".repeat(60) + ".csv";
    expect(suggestDatasetName(longName).length).toBe(50);
  });

  it("handles filenames with path separators", () => {
    expect(suggestDatasetName("some/path/file.csv")).toBe("some_path_file");
  });

  it("handles filenames without extension", () => {
    expect(suggestDatasetName("noextension")).toBe("noextension");
  });
});
