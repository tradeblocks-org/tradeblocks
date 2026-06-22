/**
 * Tests for time formatting utilities
 */

import {
  formatMinutesToTime,
  generateTimeAxisTicks,
  generateTimeAxisTicksFromData,
  generateTimeAxisTicksWithInterval,
} from "@tradeblocks/lib";

describe("formatMinutesToTime", () => {
  describe("normal values", () => {
    it("formats midnight (0 minutes)", () => {
      expect(formatMinutesToTime(0)).toBe("12:00 AM ET");
    });

    it("formats noon (720 minutes)", () => {
      expect(formatMinutesToTime(720)).toBe("12:00 PM ET");
    });

    it("formats morning time", () => {
      expect(formatMinutesToTime(570)).toBe("9:30 AM ET"); // 9:30 AM
    });

    it("formats afternoon time", () => {
      expect(formatMinutesToTime(900)).toBe("3:00 PM ET"); // 3:00 PM
    });

    it("formats with minutes", () => {
      expect(formatMinutesToTime(705)).toBe("11:45 AM ET");
    });

    it("formats end of day (1439 minutes)", () => {
      expect(formatMinutesToTime(1439)).toBe("11:59 PM ET");
    });
  });

  describe("timezone suffix", () => {
    it("includes ET suffix by default", () => {
      expect(formatMinutesToTime(600)).toBe("10:00 AM ET");
    });

    it("excludes ET suffix when requested", () => {
      expect(formatMinutesToTime(600, false)).toBe("10:00 AM");
    });
  });

  describe("edge cases", () => {
    it("handles 24:00 (1440 minutes) by wrapping to midnight", () => {
      expect(formatMinutesToTime(1440)).toBe("12:00 AM ET");
    });

    it("handles overflow beyond 24 hours", () => {
      expect(formatMinutesToTime(1500)).toBe("1:00 AM ET"); // 25 hours = 1 AM next day
    });

    it("handles negative values by wrapping", () => {
      expect(formatMinutesToTime(-60)).toBe("11:00 PM ET"); // -1 hour = 11 PM
    });

    it("handles large negative values", () => {
      expect(formatMinutesToTime(-1440)).toBe("12:00 AM ET"); // -24 hours = midnight
    });

    it("avoids 10:60 edge case (rounds correctly)", () => {
      // 659.6 minutes rounds to 660 = 11:00, not 10:60
      expect(formatMinutesToTime(659.6)).toBe("11:00 AM ET");
    });

    it("rounds fractional minutes correctly", () => {
      expect(formatMinutesToTime(600.4)).toBe("10:00 AM ET");
      expect(formatMinutesToTime(600.6)).toBe("10:01 AM ET");
    });
  });
});

describe("generateTimeAxisTicks", () => {
  describe("normal ranges", () => {
    it("generates hourly ticks for a trading day", () => {
      const result = generateTimeAxisTicks(570, 960); // 9:30 AM to 4:00 PM
      expect(result.tickvals).toEqual([600, 660, 720, 780, 840, 900, 960]);
      expect(result.ticktext).toEqual([
        "10:00 AM ET",
        "11:00 AM ET",
        "12:00 PM ET",
        "1:00 PM ET",
        "2:00 PM ET",
        "3:00 PM ET",
        "4:00 PM ET",
      ]);
    });

    it("generates ticks without timezone suffix when requested", () => {
      const result = generateTimeAxisTicks(540, 660, false);
      expect(result.ticktext).toEqual(["9:00 AM", "10:00 AM", "11:00 AM"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty range (min equals max on hour boundary)", () => {
      const result = generateTimeAxisTicks(600, 600);
      expect(result.tickvals).toEqual([600]);
      expect(result.ticktext).toEqual(["10:00 AM ET"]);
    });

    it("handles range with no full hours", () => {
      const result = generateTimeAxisTicks(610, 650); // 10:10 to 10:50
      expect(result.tickvals).toEqual([]);
      expect(result.ticktext).toEqual([]);
    });

    it("handles range spanning midnight", () => {
      const result = generateTimeAxisTicks(1380, 1440); // 11 PM to midnight
      expect(result.tickvals).toEqual([1380, 1440]);
    });
  });
});

describe("generateTimeAxisTicksFromData", () => {
  it("generates ticks from array of values", () => {
    const values = [570, 600, 650, 720, 800];
    const result = generateTimeAxisTicksFromData(values);
    expect(result).not.toBeNull();
    expect(result!.tickvals).toEqual([600, 660, 720, 780]);
  });

  it("returns null for empty array", () => {
    expect(generateTimeAxisTicksFromData([])).toBeNull();
  });

  it("handles single value", () => {
    const result = generateTimeAxisTicksFromData([600]);
    expect(result).not.toBeNull();
    expect(result!.tickvals).toEqual([600]);
  });

  it("handles unsorted values", () => {
    const values = [800, 600, 700, 650];
    const result = generateTimeAxisTicksFromData(values);
    expect(result).not.toBeNull();
    // Should still compute correct min/max
    expect(result!.tickvals).toEqual([600, 660, 720, 780]);
  });

  it("respects includeTimezone parameter", () => {
    const values = [600, 720];
    const result = generateTimeAxisTicksFromData(values, false);
    expect(result).not.toBeNull();
    expect(result!.ticktext[0]).not.toContain("ET");
  });
});

describe("generateTimeAxisTicksWithInterval", () => {
  describe("normal ranges", () => {
    it("generates ticks at 2-hour intervals by default", () => {
      const result = generateTimeAxisTicksWithInterval(480, 960); // 8 AM to 4 PM
      expect(result.tickvals).toEqual([480, 600, 720, 840, 960]);
      expect(result.ticktext).toEqual(["8:00 AM", "10:00 AM", "12:00 PM", "2:00 PM", "4:00 PM"]);
    });

    it("generates ticks at custom interval", () => {
      const result = generateTimeAxisTicksWithInterval(540, 780, 3); // 9 AM to 1 PM, 3-hour intervals
      expect(result.tickvals).toEqual([540, 720]);
    });

    it("excludes timezone by default for compact display", () => {
      const result = generateTimeAxisTicksWithInterval(600, 720);
      expect(result.ticktext.every((t) => !t.includes("ET"))).toBe(true);
    });

    it("includes timezone when requested", () => {
      const result = generateTimeAxisTicksWithInterval(600, 720, 2, true);
      expect(result.ticktext.every((t) => t.includes("ET"))).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles negative min by normalizing to 0", () => {
      const result = generateTimeAxisTicksWithInterval(-60, 240, 2);
      // Should start from 0 (midnight), not negative
      expect(result.tickvals[0]).toBeGreaterThanOrEqual(0);
    });

    it("handles range smaller than interval", () => {
      const result = generateTimeAxisTicksWithInterval(600, 650, 2);
      expect(result.tickvals).toEqual([600]);
    });

    it("handles empty range when no interval boundaries", () => {
      const result = generateTimeAxisTicksWithInterval(610, 650, 2);
      expect(result.tickvals).toEqual([]);
    });
  });
});
