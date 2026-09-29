/**
 * `computeDerivedFields().dayOfWeek` names a trade's calendar weekday in every timezone. Trade dates
 * are calendar days held at local midnight, so east of UTC their UTC day is the previous day.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("computeDerivedFields dayOfWeek", () => {
  it.each(["Asia/Tokyo", "Pacific/Kiritimati", "UTC", "America/Los_Angeles"])(
    "names Monday for a trade opened on Monday 2025-03-31 in %s",
    (zone) => {
      const source = pathToFileURL(
        join(__dirname, "../../packages/lib/calculations/regime-filter.ts"),
      ).href;
      // The process timezone must be set before any Date is built, which only a child process allows.
      const code = `
        const { computeDerivedFields } = await import(${JSON.stringify(source)});
        const trade = { dateOpened: new Date(2025, 2, 31), timeOpened: "10:15:00", pl: 0 };
        console.log(computeDerivedFields(trade).dayOfWeek);`;
      const dayOfWeek = execFileSync(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", code],
        { encoding: "utf8", env: { ...process.env, TZ: zone } },
      ).trim();
      expect(dayOfWeek).toBe("1");
    },
  );
});
