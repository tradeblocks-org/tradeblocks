/**
 * importCsv write-failure cleanup: a failure after the block directory is
 * created removes only that new directory; an existing block is never touched.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as actualFs from "fs/promises";
import * as os from "os";
import * as path from "path";

let failDailyCopy = false;

jest.unstable_mockModule("fs/promises", () => ({
  ...actualFs,
  copyFile: async (src: string, dest: string) => {
    if (failDailyCopy && path.basename(dest) === "dailylog.csv") {
      throw new Error("injected dailylog.csv write failure");
    }
    return actualFs.copyFile(src, dest);
  },
}));

// Dynamic import: the loader must be evaluated after the fs/promises mock is registered.
const { importCsv } = await import("../../src/utils/block-loader.ts");

const TRADES = "Date Opened,Date Closed,P/L,Strategy,Legs\n2024-01-02,2024-01-02,100,Alpha,SPY\n";
const DAILY = "Date,Net Liquidity,P/L,Drawdown %\n2024-01-02,100000,0,0\n";

describe("importCsv write failure after block creation", () => {
  let root: string;
  let csvPath: string;
  let dailyLogPath: string;

  beforeEach(async () => {
    failDailyCopy = false;
    root = await actualFs.mkdtemp(path.join(os.tmpdir(), "tb-import-write-failure-"));
    await actualFs.mkdir(path.join(root, "blocks"));
    csvPath = path.join(root, "trades.csv");
    dailyLogPath = path.join(root, "daily.csv");
    await actualFs.writeFile(csvPath, TRADES);
    await actualFs.writeFile(dailyLogPath, DAILY);
  });

  afterEach(async () => {
    await actualFs.rm(root, { recursive: true, force: true });
  });

  it("removes the block it created when the daily-log copy fails", async () => {
    failDailyCopy = true;
    await expect(importCsv(root, { csvPath, dailyLogPath, blockName: "Broken" })).rejects.toThrow(
      "injected dailylog.csv write failure",
    );
    expect(await actualFs.readdir(path.join(root, "blocks"))).toEqual([]);
  });

  it("leaves an existing block with the same name untouched", async () => {
    const existing = path.join(root, "blocks", "broken");
    await actualFs.mkdir(existing);
    await actualFs.writeFile(path.join(existing, "tradelog.csv"), "keep");
    failDailyCopy = true;
    await expect(importCsv(root, { csvPath, dailyLogPath, blockName: "Broken" })).rejects.toThrow(
      'Block "broken" already exists',
    );
    expect(await actualFs.readdir(existing)).toEqual(["tradelog.csv"]);
    expect(await actualFs.readFile(path.join(existing, "tradelog.csv"), "utf-8")).toBe("keep");
  });
});
