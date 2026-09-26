import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let COVERAGE_CLASSES;
let assessCoverage;
let assessSpotSessionLengths;
let coverageExitCode;
let isSessionDate;
let deriveHorizon;
let CoverageWindowError;
let lookbackSessions;
let makeFilesystemProbe;
let makeLastSpotBarProbe;
let mergeSpotSessionLengths;
let knownSpotSessionClose;
let spotSessionExpectation;
let isEarlyCloseSession;
let readRootFailure;
let resolveCoverageMembers;
let selfCheck;
let selectMissingDates;
let unknownReport;
let validateCoverageReport;
let resolveExpectedMembers;
let sessionsInWindow;

beforeAll(async () => {
  const scriptUrl = pathToFileURL(resolve(__dirname, "../market-data-coverage.mjs")).href;
  ({ selectMissingDates } = await import(
    pathToFileURL(resolve(__dirname, "../refresh-market-data.mjs")).href
  ));
  ({
    COVERAGE_CLASSES,
    assessCoverage,
    assessSpotSessionLengths,
    CoverageWindowError,
    coverageExitCode,
    deriveHorizon,
    isSessionDate,
    lookbackSessions,
    makeFilesystemProbe,
    makeLastSpotBarProbe,
    mergeSpotSessionLengths,
    knownSpotSessionClose,
    spotSessionExpectation,
    isEarlyCloseSession,
    readRootFailure,
    resolveCoverageMembers,
    resolveExpectedMembers,
    selfCheck,
    sessionsInWindow,
    unknownReport,
    validateCoverageReport,
  } = await import(scriptUrl));
});

// A tiny stand-in calendar: weekdays are sessions, weekends are not, and
// 2026-07-03 stands in for an observed holiday.
const HOLIDAYS = new Set(["2026-05-25", "2026-06-19", "2026-07-03"]);
function isSession(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6 && !HOLIDAYS.has(date);
}

// Parquet frames every file with `PAR1` at both ends. The probe checks that
// framing, so a fixture standing in for a real partition must carry it.
function parquetBytes(body = "metadata") {
  const footerLen = Buffer.alloc(4);
  footerLen.writeUInt32LE(body.length, 0);
  return Buffer.concat([
    Buffer.from("PAR1", "latin1"),
    Buffer.from(body, "latin1"),
    footerLen,
    Buffer.from("PAR1", "latin1"),
  ]);
}

// Both magics present, but the declared footer length is nonsense. DuckDB
// rejects this exact shape with "Footer length error" — so must the probe.
function framedButBrokenFooter(declaredLength) {
  const footerLen = Buffer.alloc(4);
  footerLen.writeUInt32LE(declaredLength, 0);
  return Buffer.concat([
    Buffer.from("PAR1", "latin1"),
    Buffer.from("metadata", "latin1"),
    footerLen,
    Buffer.from("PAR1", "latin1"),
  ]);
}

const SPOT = ["SPX", "QQQ", "VIX", "VIX3M", "VIX9D", "SPY", "IWM"];
const OPTIONS = ["SPX", "QQQ", "SPY", "IWM"];

// present: { "<class>|<member>|<date>": true }. Anything absent from the map
// reads as missing, which is what the real filesystem probe reports.
function probeFrom(present) {
  return (className, member, date) => present.has(`${className}|${member}|${date}`);
}

function allPresent(dates) {
  const present = new Set();
  for (const date of dates) {
    for (const klass of COVERAGE_CLASSES) {
      const members = klass.members === "spot" ? SPOT : OPTIONS;
      for (const member of members) present.add(`${klass.name}|${member}|${date}`);
    }
  }
  return present;
}

function assess(dates, present, overrides = {}) {
  return assessCoverage({
    sessions: dates,
    expected: { spot: SPOT, options: OPTIONS },
    probe: probeFrom(present),
    ...overrides,
  });
}

describe("market-data coverage assessment", () => {
  it("reports complete when every class has every configured member on every session", () => {
    const dates = ["2026-07-20", "2026-07-22"];
    const report = assess(dates, allPresent(dates));

    expect(report.status).toBe("complete");
    expect(report.incompleteSessions).toEqual([]);
    expect(selectMissingDates(report)).toEqual([]);
    expect(coverageExitCode(report)).toBe(0);
  });

  it("hostile regression (2026-07-21): a session with one spot ticker and nothing else is incomplete", () => {
    const dates = ["2026-07-20", "2026-07-21", "2026-07-22"];
    const present = allPresent(["2026-07-20", "2026-07-22"]);
    // The real 2026-07-21 shape: SPX spot landed, every other refresh-owned
    // partition never did, and the OI driver backfilled all four underlyings
    // a week later. A naive "does this date exist" check answers yes.
    present.add("spot|SPX|2026-07-21");

    const report = assess(dates, present);

    expect(report.status).toBe("incomplete");
    expect(selectMissingDates(report)).toEqual(["2026-07-21"]);
    const hole = report.incompleteSessions.find((entry) => entry.date === "2026-07-21");
    expect(hole.classes.spot).toEqual({
      present: 1,
      expected: 7,
      missing: ["QQQ", "VIX", "VIX3M", "VIX9D", "SPY", "IWM"],
    });
    expect(hole.classes.option_quote_minutes.present).toBe(0);
    expect(coverageExitCode(report)).toBe(1);
  });

  it("expects the configured members, not whichever members happen to exist on disk", () => {
    // IWM is configured but has never written a single partition. Deriving the
    // expectation from disk would enumerate zero IWM members and call every
    // session complete — presence-without-completeness one level up.
    const dates = ["2026-07-20", "2026-07-22"];
    const present = allPresent(dates);
    for (const date of dates) {
      for (const klass of COVERAGE_CLASSES) present.delete(`${klass.name}|IWM|${date}`);
    }

    const report = assess(dates, present);

    expect(report.status).toBe("incomplete");
    expect(report.incompleteSessions.map((entry) => entry.date)).toEqual(dates);
    for (const entry of report.incompleteSessions) {
      expect(entry.classes.spot.missing).toEqual(["IWM"]);
      expect(entry.classes.option_chain.missing).toEqual(["IWM"]);
    }
  });

  it("covers exactly the classes the refresh driver writes, and option_oi_daily is not one", () => {
    // OI is written by tradeblocks' oi-backfill from MARKET_OI_ROOTS, which
    // canonicalizes roots into underlyings (SPXW and SPX both land under
    // underlying=SPX). Nothing here can derive that membership, so judging the
    // class would produce a confident wrong verdict on the first box whose OI
    // roots differ from its option underlyings.
    expect(COVERAGE_CLASSES.map((klass) => klass.name)).toEqual([
      "spot",
      "option_chain",
      "option_quote_minutes",
      "enriched",
    ]);
    // And the work list is every incomplete date, because every covered class
    // is one --missing can actually repair.
    const report = assess(["2026-07-20", "2026-07-21"], allPresent(["2026-07-20"]));
    expect(selectMissingDates(report)).toEqual(["2026-07-21"]);
  });

  it("fails closed: an unreadable partition is unknown, never complete", () => {
    const dates = ["2026-07-20"];
    const present = allPresent(dates);
    const report = assessCoverage({
      sessions: dates,
      expected: { spot: SPOT, options: OPTIONS },
      probe: (className, member, date) => {
        if (className === "option_quote_minutes" && member === "SPX") {
          throw new Error("EACCES: permission denied");
        }
        return probeFrom(present)(className, member, date);
      },
    });

    expect(report.status).toBe("unknown");
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]).toMatchObject({
      class: "option_quote_minutes",
      member: "SPX",
      date: "2026-07-20",
    });
    expect(coverageExitCode(report)).toBe(2);
    // An unknown verdict must not be laundered into a work list either way.
    expect(() => selectMissingDates(report)).toThrow(/refusing/);
  });

  it("reports complete over an empty session set as unknown, not as a clean bill of health", () => {
    const report = assess([], new Set());

    expect(report.status).toBe("unknown");
    expect(report.reason).toMatch(/no trading sessions/i);
    expect(coverageExitCode(report)).toBe(2);
  });
});

describe("session-window resolution", () => {
  it("enumerates only trading sessions between two dates", () => {
    // 2026-07-03 is an observed holiday, 07-04/07-05 a weekend.
    expect(sessionsInWindow("2026-07-02", "2026-07-07", isSession)).toEqual([
      "2026-07-02",
      "2026-07-06",
      "2026-07-07",
    ]);
  });

  it("walks back N sessions from an end date, skipping non-sessions", () => {
    expect(lookbackSessions(3, "2026-07-07", isSession)).toEqual([
      "2026-07-02",
      "2026-07-06",
      "2026-07-07",
    ]);
  });

  it("excludes the end date itself when it is not a session", () => {
    expect(lookbackSessions(2, "2026-07-05", isSession)).toEqual(["2026-07-01", "2026-07-02"]);
  });
});

describe("calendar-aware spot session length", () => {
  it("uses sourced regular and early closes and refuses an unknown ticker", () => {
    expect(knownSpotSessionClose("VIX", "2026-07-02", isSession)).toBe("16:15");
    expect(knownSpotSessionClose("SPY", "2026-07-02", isSession)).toBe("16:00");
    expect(knownSpotSessionClose("VIX", "2026-11-27", isSession)).toBe("13:15");
    expect(knownSpotSessionClose("SPY", "2026-11-27", isSession)).toBe("13:00");
    expect(spotSessionExpectation("VIX", "2026-07-02", isSession)).toEqual({
      sessionClose: "16:15",
      minimumLastBar: "16:01",
    });
    expect(spotSessionExpectation("SPY", "2026-07-02", isSession)).toEqual({
      sessionClose: "16:00",
      minimumLastBar: "15:59",
    });
    expect(spotSessionExpectation("VIX", "2026-11-27", isSession)).toEqual({
      sessionClose: "13:15",
      minimumLastBar: "13:01",
    });
    expect(spotSessionExpectation("SPX", "2026-11-27", isSession)).toEqual({
      sessionClose: "13:15",
      minimumLastBar: "13:00",
    });
    expect(spotSessionExpectation("SPY", "2026-11-27", isSession)).toEqual({
      sessionClose: "13:00",
      minimumLastBar: "12:59",
    });
    expect(isEarlyCloseSession("2028-07-03", isSession)).toBe(true);
    expect(knownSpotSessionClose("NOTKNOWN", "2026-07-02", isSession)).toBeNull();
  });

  it("does not judge full-closure placeholders as short sessions", async () => {
    const readLastBar = jest.fn(async () => "11:25");
    const result = await assessSpotSessionLengths({
      sessions: sessionsInWindow("2026-05-25", "2026-06-19", isSession),
      tickers: ["VIX"],
      isSession,
      present: () => true,
      readLastBar,
    });
    expect(result.shortByDate.has("2026-05-25")).toBe(false);
    expect(result.shortByDate.has("2026-06-19")).toBe(false);
    expect(readLastBar).not.toHaveBeenCalledWith("VIX", "2026-05-25");
    expect(readLastBar).not.toHaveBeenCalledWith("VIX", "2026-06-19");
  });

  it.each([
    ["SPX", "2026-07-02", "16:15", "16:01", "16:00"],
    ["VIX", "2026-07-02", "16:15", "16:01", "16:00"],
    ["SPX", "2026-11-27", "13:15", "13:00", "12:59"],
    ["VIX9D", "2026-11-27", "13:15", "13:01", "13:00"],
    ["SPY", "2026-07-02", "16:00", "15:59", "15:58"],
  ])(
    "detects any %s session that ends before its calendar close window",
    async (ticker, date, close, minimumLastBar, truncatedLastBar) => {
      const complete = await assessSpotSessionLengths({
        sessions: [date],
        tickers: [ticker],
        isSession,
        present: () => true,
        readLastBar: async () => minimumLastBar,
      });
      expect(complete.shortByDate.size).toBe(0);

      const truncated = await assessSpotSessionLengths({
        sessions: [date],
        tickers: [ticker],
        isSession,
        present: () => true,
        readLastBar: async () => truncatedLastBar,
      });
      expect(truncated.shortByDate.get(date)).toEqual([
        { ticker, lastBar: truncatedLastBar, sessionClose: close, minimumLastBar },
      ]);
    },
  );

  it("returns unknown when the close is unknown or a present partition is unreadable", async () => {
    const result = await assessSpotSessionLengths({
      sessions: ["2026-07-02"],
      tickers: ["NOTKNOWN", "VIX"],
      isSession,
      present: () => true,
      readLastBar: async () => {
        throw new Error("DuckDB could not read parquet");
      },
    });
    expect(result.unknown).toHaveLength(2);
    expect(result.unknown[0].error).toMatch(/no sourced session close/);
    expect(result.unknown[1].error).toMatch(/DuckDB/);
  });

  it("refuses forged short-session evidence outside expected membership or close authority", () => {
    const base = {
      schemaVersion: 1,
      status: "incomplete",
      sessions: 1,
      incompleteSessions: [
        {
          date: "2026-07-02",
          classes: {
            spot: {
              present: 1,
              expected: 1,
              missing: [],
              short: [
                {
                  ticker: "SPX",
                  lastBar: "16:00",
                  sessionClose: "16:15",
                  minimumLastBar: "16:01",
                },
              ],
            },
          },
        },
      ],
      unreadable: [],
      expected: { spot: ["VIX"], options: [] },
      marketRoot: "/tmp/market",
      generatedAt: "2026-08-12T12:00:00Z",
      window: { from: "2026-07-02", to: "2026-07-02" },
      horizon: {
        completeThrough: null,
        contiguousFrom: null,
        gapsBehind: ["2026-07-02"],
        perClass: Object.fromEntries(COVERAGE_CLASSES.map(({ name }) => [name, null])),
      },
    };
    expect(validateCoverageReport(base, { isSession }).ok).toBe(false);
    base.expected.spot = ["SPX"];
    base.incompleteSessions[0].classes.spot.short[0].lastBar = "99:99";
    expect(validateCoverageReport(base, { isSession }).ok).toBe(false);
    base.incompleteSessions[0].classes.spot.short[0].lastBar = "16:00";
    base.incompleteSessions[0].classes.spot.short[0].minimumLastBar = "16:14";
    expect(validateCoverageReport(base, { isSession }).ok).toBe(false);
  });

  it("carries short and unreadable evidence through the report and exit-code contract", () => {
    const date = "2026-07-02";
    const base = {
      ...assess([date], allPresent([date])),
      expected: { spot: SPOT, options: OPTIONS },
      window: { from: date, to: date },
    };
    const incomplete = mergeSpotSessionLengths(base, {
      sessions: [date],
      unknown: [],
      shortByDate: new Map([
        [
          date,
          [
            {
              ticker: "VIX",
              lastBar: "16:00",
              sessionClose: "16:15",
              minimumLastBar: "16:01",
            },
          ],
        ],
      ]),
    });
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.incompleteSessions[0].classes.spot.short[0].ticker).toBe("VIX");
    expect(selectMissingDates(incomplete)).toEqual([date]);
    expect(coverageExitCode(incomplete)).toBe(1);

    const unknown = mergeSpotSessionLengths(base, {
      sessions: [date],
      shortByDate: new Map(),
      unknown: [{ class: "spot", member: "VIX", date, error: "unreadable parquet" }],
    });
    expect(unknown.status).toBe("unknown");
    expect(unknown.horizon).toBeNull();
    expect(coverageExitCode(unknown)).toBe(2);
    expect(() => selectMissingDates(unknown)).toThrow(/refusing/);
  });

  it("mutation test: truncating a real scratch parquet partition turns the check red", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const root = mkdtempSync(resolve(tmpdir(), "coverage-session-mutation-"));
    const partition = resolve(root, "spot/ticker=VIX/date=2026-07-02");
    mkdirSync(partition, { recursive: true });
    const artifact = resolve(partition, "data.parquet");
    const truncated = resolve(partition, "truncated.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(`
        COPY (
          SELECT strftime(bar_time, '%H:%M') AS time
          FROM generate_series(
            TIMESTAMP '2026-07-02 09:30:00',
            TIMESTAMP '2026-07-02 16:15:00',
            INTERVAL 1 MINUTE
          ) AS bars(bar_time)
        ) TO '${artifact}' (FORMAT parquet)
      `);
      let probe = await makeLastSpotBarProbe(root);
      let verdict = await assessSpotSessionLengths({
        sessions: ["2026-07-02"],
        tickers: ["VIX"],
        isSession,
        present: () => true,
        readLastBar: probe.read,
      });
      await probe.close();
      expect(verdict.shortByDate.size).toBe(0);

      await connection.run(`
        COPY (
          SELECT * FROM read_parquet('${artifact}') WHERE time <= '16:00'
        ) TO '${truncated}' (FORMAT parquet)
      `);
      renameSync(truncated, artifact);
      probe = await makeLastSpotBarProbe(root);
      verdict = await assessSpotSessionLengths({
        sessions: ["2026-07-02"],
        tickers: ["VIX"],
        isSession,
        present: () => true,
        readLastBar: probe.read,
      });
      await probe.close();
      expect(verdict.shortByDate.get("2026-07-02")).toEqual([
        {
          ticker: "VIX",
          lastBar: "16:00",
          sessionClose: "16:15",
          minimumLastBar: "16:01",
        },
      ]);
    } finally {
      connection.closeSync?.();
      instance.closeSync?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("filesystem probe", () => {
  let root;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), "coverage-probe-"));
    // A written partition, an empty-directory partition (the residue a killed
    // write leaves behind), and a zero-byte file.
    mkdirSync(resolve(root, "spot/ticker=SPX/date=2026-07-20"), { recursive: true });
    writeFileSync(resolve(root, "spot/ticker=SPX/date=2026-07-20/data.parquet"), parquetBytes());
    mkdirSync(resolve(root, "spot/ticker=QQQ/date=2026-07-20"), { recursive: true });
    mkdirSync(resolve(root, "spot/ticker=SPY/date=2026-07-20"), { recursive: true });
    writeFileSync(resolve(root, "spot/ticker=SPY/date=2026-07-20/data.parquet"), "");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("names an unusable corpus root once, as one fact", () => {
    // A mistyped corpus root must produce one diagnostic, rather than
    // reporting every partition as unreadable.
    expect(readRootFailure(resolve(root, "not-a-real-corpus"))).toMatch(/ENOENT/);
    // A path that exists but is not a directory must fail too — every partition
    // under it would read ENOTDIR, which the probe classifies as *absent*.
    writeFileSync(resolve(root, "market-as-a-file"), "not a corpus");
    expect(readRootFailure(resolve(root, "market-as-a-file"))).toMatch(/not a directory/);
    expect(readRootFailure(root)).toBeNull();
  });

  it("counts a partition present only when its canonical data.parquet is readable", () => {
    const probe = makeFilesystemProbe(root);

    expect(probe("spot", "SPX", "2026-07-20")).toBe(true);
    expect(probe("spot", "QQQ", "2026-07-20")).toBe(false); // empty directory
    expect(probe("spot", "SPY", "2026-07-20")).toBe(false); // zero-byte data.parquet
    expect(probe("spot", "IWM", "2026-07-20")).toBe(false); // absent
  });

  it("hostile regression: a non-empty data.parquet that is not Parquet is not a partition", () => {
    // Size alone let a corrupt or truncated artifact make every member look
    // present and produce `complete` with an empty repair list — while the
    // reader would reject the very same file. Coverage must not promise
    // something the consumer refuses.
    mkdirSync(resolve(root, "spot/ticker=VIX9D/date=2026-07-20"), { recursive: true });
    const artifact = resolve(root, "spot/ticker=VIX9D/date=2026-07-20/data.parquet");
    writeFileSync(artifact, "not parquet, but definitely not empty");
    expect(makeFilesystemProbe(root)("spot", "VIX9D", "2026-07-20")).toBe(false);

    // Truncated: opening magic present, trailing magic lost.
    writeFileSync(artifact, Buffer.from("PAR1 half a write, cut off here", "latin1"));
    expect(makeFilesystemProbe(root)("spot", "VIX9D", "2026-07-20")).toBe(false);

    // Both magics, but a footer length that does not fit inside the file. This
    // is the shape DuckDB rejects with "Footer length error"; magic-alone
    // accepted it.
    writeFileSync(artifact, framedButBrokenFooter(0));
    expect(makeFilesystemProbe(root)("spot", "VIX9D", "2026-07-20")).toBe(false);
    writeFileSync(artifact, framedButBrokenFooter(9_999_999));
    expect(makeFilesystemProbe(root)("spot", "VIX9D", "2026-07-20")).toBe(false);

    writeFileSync(artifact, parquetBytes());
    expect(makeFilesystemProbe(root)("spot", "VIX9D", "2026-07-20")).toBe(true);
  });

  it("hostile regression: a stranded writer sidecar is not a partition", () => {
    // The writer stages every partition as `data.parquet.tmp-<pid>-<ts>-<rand>`
    // and renames it into place; readers glob `**/data.parquet` so sidecars
    // never match. A killed write leaves exactly this residue — the residue a
    // FAILED NIGHT leaves — and "any non-empty file" counted it as complete.
    mkdirSync(resolve(root, "spot/ticker=VIX/date=2026-07-20"), { recursive: true });
    writeFileSync(
      resolve(root, "spot/ticker=VIX/date=2026-07-20/data.parquet.tmp-123-456-abc"),
      parquetBytes(),
    );
    // An unrelated non-empty file is not a partition either.
    writeFileSync(resolve(root, "spot/ticker=VIX/date=2026-07-20/README"), "notes");

    expect(makeFilesystemProbe(root)("spot", "VIX", "2026-07-20")).toBe(false);
  });

  it("treats an unreadable data.parquet as unreadable, never as present or absent", () => {
    mkdirSync(resolve(root, "spot/ticker=VIX3M/date=2026-07-20"), { recursive: true });
    const artifact = resolve(root, "spot/ticker=VIX3M/date=2026-07-20/data.parquet");
    writeFileSync(artifact, parquetBytes());
    chmodSync(artifact, 0o000);

    // Throwing is the contract: assessCoverage turns it into `unknown`. Reading
    // it as present would be a false complete; reading it as absent would hand
    // the refresh driver a repair it cannot perform.
    const probe = makeFilesystemProbe(root);
    if (process.getuid?.() === 0) return; // root bypasses mode bits
    expect(() => probe("spot", "VIX3M", "2026-07-20")).toThrow();
    chmodSync(artifact, 0o644);
  });
});

describe("expected-member resolution", () => {
  it("reads the same env contract the refresh driver writes from", () => {
    const expected = resolveExpectedMembers({
      TRADEBLOCKS_SPOT_TICKERS: "SPX, QQQ ,spy",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX,QQQ",
    });

    expect(expected).toEqual({ spot: ["SPX", "QQQ", "SPY"], options: ["SPX", "QQQ"] });
  });

  it("judges the caller's resolved membership when it has one, not the environment", () => {
    // `--missing` passes the lists THIS invocation resolved. With SPX in the
    // environment and `--spot-tickers QQQ` on the command line, reading the env
    // would have coverage judging SPX while the driver writes QQQ: a requested
    // QQQ repair reads complete and is silently skipped.
    const env = { TRADEBLOCKS_SPOT_TICKERS: "SPX", TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX" };
    expect(resolveCoverageMembers({ spot: ["QQQ"], options: ["QQQ"] }, env)).toEqual({
      spot: ["QQQ"],
      options: ["QQQ"],
    });
    expect(resolveCoverageMembers(null, env)).toEqual({ spot: ["SPX"], options: ["SPX"] });
  });

  it("refuses to guess when the ticker contract is absent", () => {
    expect(() => resolveExpectedMembers({})).toThrow(/TRADEBLOCKS_SPOT_TICKERS/);
    expect(() => resolveExpectedMembers({ TRADEBLOCKS_SPOT_TICKERS: "SPX" })).toThrow(
      /TRADEBLOCKS_OPTION_UNDERLYINGS/,
    );
  });
});

describe("window resolution fails closed", () => {
  it("refuses a lookback it cannot satisfy instead of silently shortening it", () => {
    // The previous form stopped at a fixed 400-calendar-day walk and returned
    // whatever it had: --lookback 401 reported on 286 sessions, so a hole before
    // the truncated start read as clean. A silent cap on a completeness check is
    // the defect the check exists to find.
    expect(() => lookbackSessions(50, "2026-07-07", isSession, 10)).toThrow(CoverageWindowError);
    expect(() => lookbackSessions(50, "2026-07-07", isSession, 10)).toThrow(
      /silently shortened window/,
    );
  });

  it("scales its own walk to the requested count, so a large lookback still resolves", () => {
    // 400 sessions needs ~580 calendar days; the default bound must cover it.
    expect(lookbackSessions(400, "2026-07-07", isSession)).toHaveLength(400);
  });
});

describe("the producer owns its report contract", () => {
  // A consumer's hand-maintained field checklist can accept a contradictory
  // report or invalid field types. These cases exercise the producer's
  // conformance check instead of re-deriving its contract in the consumer.
  const conformant = {
    schemaVersion: 1,
    status: "complete",
    sessions: 30,
    incompleteSessions: [],
    unreadable: [],
    expected: { spot: ["SPX", "QQQ"], options: ["SPX"] },
    marketRoot: "/home/op/tradeblocks-data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-06-26", to: "2026-08-07" },
    horizon: {
      completeThrough: "2026-08-07",
      contiguousFrom: "2026-06-26",
      gapsBehind: [],
      perClass: {
        spot: "2026-08-07",
        option_chain: "2026-08-07",
        option_quote_minutes: "2026-08-07",
        enriched: "2026-08-07",
      },
    },
  };

  it("crashes rather than emitting a report that fails its own contract", () => {
    // Every collectCoverage branch returns through selfCheck, so producer and
    // validator cannot drift apart silently — the drift that produced both
    // round-6 findings, where the validator failed to enforce invariants
    // assessCoverage already guaranteed. A future edit that breaks one without
    // the other is a crash here, not a clean-looking verdict downstream.
    expect(selfCheck(conformant)).toBe(conformant);
    expect(() => selfCheck({ ...conformant, marketRoot: "" })).toThrow(
      /failed its own contract check/,
    );
    expect(() =>
      selfCheck({ ...conformant, unreadable: [{ class: "spot", member: "SPX" }] }),
    ).toThrow(/unreadable/);
  });

  it("permits unreadable evidence only on an unknown verdict", () => {
    const unreadable = [{ class: "spot", member: "SPX", date: "2026-07-21", error: "EACCES" }];
    expect(
      validateCoverageReport({ ...conformant, status: "unknown", unreadable, horizon: null }).ok,
    ).toBe(true);
    expect(validateCoverageReport({ ...conformant, unreadable }).ok).toBe(false);
  });

  it("permits a null window only on an unknown verdict", () => {
    expect(
      validateCoverageReport({ ...conformant, status: "unknown", window: null, horizon: null }).ok,
    ).toBe(true);
    expect(validateCoverageReport({ ...conformant, window: null }).ok).toBe(false);
  });

  it("accepts what this module actually emits", () => {
    expect(validateCoverageReport(conformant)).toEqual({
      ok: true,
      status: "complete",
      incompleteSessions: null,
    });
    expect(
      validateCoverageReport({
        ...conformant,
        status: "incomplete",
        incompleteSessions: [{ date: "2026-07-21", classes: {} }],
        // contiguousFrom must start AFTER the gap: an unbroken run cannot span
        // a session the same report calls incomplete.
        horizon: {
          ...conformant.horizon,
          contiguousFrom: "2026-07-22",
          gapsBehind: ["2026-07-21"],
        },
      }),
    ).toEqual({ ok: true, status: "incomplete", incompleteSessions: 1 });
  });

  it.each([
    ["a status-only payload", { status: "complete" }],
    ["a future schemaVersion", { ...conformant, schemaVersion: 2 }],
    ["a boolean schemaVersion", { ...conformant, schemaVersion: true }],
    ["a boolean session count", { ...conformant, sessions: true }],
    ["a verdict over zero sessions", { ...conformant, sessions: 0 }],
    [
      "a complete report naming missing sessions",
      { ...conformant, incompleteSessions: [{ date: "2026-07-21", classes: {} }] },
    ],
    ["an incomplete report naming none", { ...conformant, status: "incomplete" }],
    ["a non-canonical member token", { ...conformant, expected: { spot: ["SPX-W"], options: [] } }],
    ["an empty member token", { ...conformant, expected: { spot: [""], options: [] } }],
    ["a whitespace-padded token", { ...conformant, expected: { spot: [" SPX "], options: [] } }],
    ["a non-string member", { ...conformant, expected: { spot: [1], options: [] } }],
    ["an expected map missing a key", { ...conformant, expected: { spot: ["SPX"] } }],
    ["an expected map naming nothing", { ...conformant, expected: { spot: [], options: [] } }],
    ["a non-array session list", { ...conformant, incompleteSessions: {} }],
    ["a non-object report", "complete"],
    ["a null report", null],
    // A verdict over evidence it could not read. assessCoverage returns
    // `unknown` whenever anything was unreadable, so a `complete` report
    // carrying unreadable entries contradicts the producer's own rule and
    // hands an operator a clean verdict over evidence of a hole.
    [
      "a complete report carrying unreadable evidence",
      { ...conformant, unreadable: [{ class: "spot", member: "SPX", date: "2026-07-21" }] },
    ],
    // Provenance binds a verdict to what it actually checked and when.
    ["a report with no marketRoot", { ...conformant, marketRoot: undefined }],
    ["a report with an empty marketRoot", { ...conformant, marketRoot: "" }],
    ["a report with no generatedAt", { ...conformant, generatedAt: undefined }],
    ["a report with a numeric generatedAt", { ...conformant, generatedAt: 7 }],
    ["a report with an unparseable generatedAt", { ...conformant, generatedAt: "never" }],
    ["a verdict with no window", { ...conformant, window: null }],
    ["a report with a malformed window", { ...conformant, window: { from: "2026-06-26" } }],
    ["a report with an inverted window", { ...conformant, window: { from: "b", to: "a" } }],
  ])("refuses %s", (_label, report) => {
    expect(validateCoverageReport(report).ok).toBe(false);
  });
});

describe("the horizon carries its own holes", () => {
  const SESSIONS = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-30", "2026-07-31"];

  it("reports the reach AND the gaps behind it, which is the whole difference from a naive read", () => {
    // A naive newest-partition read answers 2026-07-31 and hides both holes.
    // The headline date is the same, but cannot be quoted without the two
    // sessions it steps over.
    const horizon = deriveHorizon(
      SESSIONS,
      [
        { date: "2026-07-21", classes: { spot: { missing: ["QQQ"] } } },
        { date: "2026-07-30", classes: { spot: { missing: ["QQQ"] } } },
      ],
      [{ name: "spot" }, { name: "option_chain" }],
    );

    expect(horizon.completeThrough).toBe("2026-07-31");
    expect(horizon.gapsBehind).toEqual(["2026-07-21", "2026-07-30"]);
    // Unbroken for one session, while the headline reaches eleven days further.
    expect(horizon.contiguousFrom).toBe("2026-07-31");
  });

  it("takes the MIN across classes, so one lagging class pulls the horizon back", () => {
    const horizon = deriveHorizon(
      SESSIONS,
      [
        { date: "2026-07-30", classes: { option_chain: { missing: ["SPX"] } } },
        { date: "2026-07-31", classes: { option_chain: { missing: ["SPX"] } } },
      ],
      [{ name: "spot" }, { name: "option_chain" }],
    );

    expect(horizon.perClass).toEqual({ spot: "2026-07-31", option_chain: "2026-07-22" });
    expect(horizon.completeThrough).toBe("2026-07-22");
    // The two lagging sessions are AHEAD of the horizon, not behind it, so they
    // are not gaps — they are simply not covered by the claim.
    expect(horizon.gapsBehind).toEqual([]);
    expect(horizon.contiguousFrom).toBe("2026-07-20");
  });

  it("claims nothing when a class never completed in the window", () => {
    const horizon = deriveHorizon(
      SESSIONS,
      SESSIONS.map((date) => ({ date, classes: { option_chain: { missing: ["SPX"] } } })),
      [{ name: "spot" }, { name: "option_chain" }],
    );

    expect(horizon.completeThrough).toBeNull();
    expect(horizon.contiguousFrom).toBeNull();
    expect(horizon.gapsBehind).toEqual(SESSIONS);
  });

  it("has no horizon over an empty window", () => {
    expect(deriveHorizon([], [])).toBeNull();
  });
});

describe("the contract requires the horizon to be honest", () => {
  const base = {
    schemaVersion: 1,
    status: "incomplete",
    sessions: 5,
    incompleteSessions: [{ date: "2026-07-21", classes: {} }],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-20", to: "2026-07-31" },
    horizon: {
      completeThrough: "2026-07-31",
      contiguousFrom: "2026-07-31",
      gapsBehind: ["2026-07-21"],
      perClass: {
        spot: "2026-07-31",
        option_chain: "2026-07-31",
        option_quote_minutes: "2026-07-31",
        enriched: "2026-07-31",
      },
    },
  };

  it("accepts a horizon that discloses every gap behind it", () => {
    expect(validateCoverageReport(base).ok).toBe(true);
  });

  it("hostile regression: refuses a horizon that hides a gap behind itself", () => {
    // This is the naive newest-partition read wearing the new field's name: the
    // report knows about 2026-07-21, the horizon reaches past it, and the gap
    // list is empty. Coverage must never hide a known gap behind the horizon.
    expect(
      validateCoverageReport({ ...base, horizon: { ...base.horizon, gapsBehind: [] } }).ok,
    ).toBe(false);
  });

  it("refuses a verdict with no horizon, and an unknown that claims one", () => {
    expect(validateCoverageReport({ ...base, horizon: null }).ok).toBe(false);
    expect(
      validateCoverageReport({
        ...base,
        status: "unknown",
        horizon: base.horizon,
      }).ok,
    ).toBe(false);
  });

  it("refuses a malformed horizon", () => {
    for (const horizon of [
      { ...base.horizon, completeThrough: "not-a-date" },
      { ...base.horizon, gapsBehind: "2026-07-21" },
      { ...base.horizon, perClass: null },
      { ...base.horizon, completeThrough: null, contiguousFrom: "2026-07-31" },
    ]) {
      expect(validateCoverageReport({ ...base, horizon }).ok).toBe(false);
    }
  });
});

describe("the gap list is a SET, and unknowns never claim a horizon", () => {
  const base = {
    schemaVersion: 1,
    status: "incomplete",
    sessions: 5,
    incompleteSessions: [
      { date: "2026-07-21", classes: {} },
      { date: "2026-07-30", classes: {} },
    ],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-20", to: "2026-07-31" },
    horizon: {
      completeThrough: "2026-07-31",
      contiguousFrom: "2026-07-31",
      gapsBehind: ["2026-07-21", "2026-07-30"],
      perClass: {
        spot: "2026-07-31",
        option_chain: "2026-07-31",
        option_quote_minutes: "2026-07-31",
        enriched: "2026-07-31",
      },
    },
  };

  it("accepts the honest gap list", () => {
    expect(validateCoverageReport(base).ok).toBe(true);
  });

  it.each([
    ["a substituted gap of the same cardinality", ["2026-07-21", "2026-07-22"]],
    ["a duplicated gap padding the count", ["2026-07-21", "2026-07-21"]],
    ["nulls standing in for dates", [null, null]],
    ["an empty list", []],
  ])("hostile regression: refuses %s", (_label, gapsBehind) => {
    // Counting alone passed all four of these: the hidden hole with its
    // cardinality preserved. A consumer would render an apparently exhaustive
    // gap list that omits a real missing session, even with the right count.
    expect(validateCoverageReport({ ...base, horizon: { ...base.horizon, gapsBehind } }).ok).toBe(
      false,
    );
  });

  it("hostile regression: refuses ONE real gap padded by repetition", () => {
    // The set comparison alone accepts this — {A} equals {A} — so the
    // duplicate guard is the only thing catching it. A consumer counting the
    // list would report two gaps where one exists, which is a different lie
    // from hiding one but a lie about the same evidence.
    const oneGap = {
      ...base,
      incompleteSessions: [{ date: "2026-07-21", classes: {} }],
      horizon: { ...base.horizon, gapsBehind: ["2026-07-21", "2026-07-21"] },
    };
    expect(validateCoverageReport(oneGap).ok).toBe(false);
    expect(
      validateCoverageReport({
        ...oneGap,
        horizon: { ...base.horizon, gapsBehind: ["2026-07-21"] },
      }).ok,
    ).toBe(true);
  });

  it("refuses a complete verdict that reaches nowhere", () => {
    expect(
      validateCoverageReport({
        ...base,
        status: "complete",
        incompleteSessions: [],
        horizon: { completeThrough: null, contiguousFrom: null, gapsBehind: [], perClass: {} },
      }).ok,
    ).toBe(false);
  });

  it("every unknown the producer builds satisfies its own contract", () => {
    // Both collectCoverage unknown routes hand-assembled their report and both
    // omitted `horizon` when the field landed, so selfCheck threw and the CLI
    // exited 2 without emitting the reason it could not answer. Exit 2 is ALSO
    // the correct code for a real unknown, which is why measuring the exit code
    // could not tell the two apart.
    const common = { marketRoot: "/data/market", expected: { spot: ["SPX"], options: ["SPX"] } };
    const windowFailure = unknownReport({ reason: "window too short", ...common });
    const rootFailure = unknownReport({
      reason: "root unreadable",
      ...common,
      sessions: ["2026-07-20", "2026-07-21"],
      unreadable: [{ class: null, member: null, date: null, error: "ENOENT" }],
    });

    for (const report of [windowFailure, rootFailure]) {
      expect(report.horizon).toBeNull();
      expect(validateCoverageReport(report).ok).toBe(true);
      expect(selfCheck(report)).toBe(report);
    }
    expect(rootFailure.window).toEqual({ from: "2026-07-20", to: "2026-07-21" });
    expect(windowFailure.window).toBeNull();
  });
});

describe("one repair list, and a horizon inside its window", () => {
  const base = {
    schemaVersion: 1,
    status: "incomplete",
    sessions: 5,
    incompleteSessions: [
      { date: "2026-07-21", classes: {} },
      { date: "2026-07-30", classes: {} },
    ],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-20", to: "2026-07-31" },
    horizon: {
      completeThrough: "2026-07-31",
      contiguousFrom: "2026-07-31",
      gapsBehind: ["2026-07-21", "2026-07-30"],
      perClass: {
        spot: "2026-07-31",
        option_chain: "2026-07-31",
        option_quote_minutes: "2026-07-31",
        enriched: "2026-07-31",
      },
    },
  };

  it("the repair list cannot disagree with the sessions, because there is only one", () => {
    // A second serialized `missingSessions` was validated as an unrelated
    // array, so a report naming two incomplete sessions and one missing session
    // passed — and the refresh driver silently skipped the real hole. The field
    // is gone; the work list is derived.
    expect(validateCoverageReport(base).ok).toBe(true);
    expect(selectMissingDates({ ...base, status: "incomplete" })).toEqual([
      "2026-07-21",
      "2026-07-30",
    ]);
    // A stale second list, if some producer still emitted one, is inert.
    expect(selectMissingDates({ ...base, missingSessions: ["2026-07-21"] })).toEqual([
      "2026-07-21",
      "2026-07-30",
    ]);
  });

  it.each([
    ["reaching past the checked window", { completeThrough: "2026-12-31" }],
    ["starting before the checked window", { contiguousFrom: "2020-01-01" }],
    ["a per-class reach outside the window", { perClass: { spot: "2026-12-31" } }],
    [
      "a contiguous run starting after it ends",
      { contiguousFrom: "2026-07-31", completeThrough: "2026-07-21" },
    ],
    ["a perClass array rather than an object", { perClass: [] }],
  ])("hostile regression: refuses a horizon %s", (_label, override) => {
    // The probe only walks the window it was given, so a horizon outside it is
    // a claim over sessions nothing looked at — every hole out there is
    // undisclosed by construction.
    const horizon = { ...base.horizon, ...override };
    const report = { ...base, horizon };
    if (override.completeThrough === "2026-07-21") {
      report.incompleteSessions = [{ date: "2026-07-21", classes: {} }];
      horizon.gapsBehind = ["2026-07-21"];
    }
    expect(validateCoverageReport(report).ok).toBe(false);
  });
});

describe("perClass is the evidence, not a decoration", () => {
  const base = {
    schemaVersion: 1,
    status: "complete",
    sessions: 5,
    incompleteSessions: [],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-20", to: "2026-07-31" },
    horizon: {
      completeThrough: "2026-07-31",
      contiguousFrom: "2026-07-20",
      gapsBehind: [],
      perClass: {
        spot: "2026-07-31",
        option_chain: "2026-07-31",
        option_quote_minutes: "2026-07-31",
        enriched: "2026-07-31",
      },
    },
  };

  it("accepts a horizon whose reach matches its class evidence", () => {
    expect(validateCoverageReport(base).ok).toBe(true);
  });

  it.each([
    ["a null reach under a complete verdict", { spot: null }],
    ["a missing class", undefined],
    ["a class the probe does not cover", { bogus: "2026-07-31" }],
  ])("hostile regression: refuses %s", (_label, override) => {
    // A complete verdict whose own class reach says no such reach exists is a
    // false clean: the headline outruns the evidence it was derived from.
    const perClass =
      override === undefined ? { spot: "2026-07-31" } : { ...base.horizon.perClass, ...override };
    expect(validateCoverageReport({ ...base, horizon: { ...base.horizon, perClass } }).ok).toBe(
      false,
    );
  });

  it("hostile regression: refuses a completeThrough that is not the minimum reach", () => {
    // completeThrough IS min(perClass). Publishing a later date claims coverage
    // the laggard class does not have.
    const perClass = { ...base.horizon.perClass, option_chain: "2026-07-22" };
    expect(validateCoverageReport({ ...base, horizon: { ...base.horizon, perClass } }).ok).toBe(
      false,
    );
    expect(
      validateCoverageReport({
        ...base,
        horizon: { ...base.horizon, perClass, completeThrough: "2026-07-22" },
      }).ok,
    ).toBe(true);
  });

  it("hostile regression: refuses an unbroken run that spans a gap it names", () => {
    expect(
      validateCoverageReport({
        ...base,
        status: "incomplete",
        incompleteSessions: [{ date: "2026-07-21", classes: {} }],
        horizon: { ...base.horizon, contiguousFrom: "2026-07-20", gapsBehind: ["2026-07-21"] },
      }).ok,
    ).toBe(false);
  });
});

describe("a date must be a date, and a session must be a session", () => {
  const base = {
    schemaVersion: 1,
    status: "incomplete",
    sessions: 5,
    incompleteSessions: [{ date: "2026-07-21", classes: {} }],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-20", to: "2026-07-31" },
    horizon: {
      completeThrough: "2026-07-31",
      contiguousFrom: "2026-07-22",
      gapsBehind: ["2026-07-21"],
      perClass: {
        spot: "2026-07-31",
        option_chain: "2026-07-31",
        option_quote_minutes: "2026-07-31",
        enriched: "2026-07-31",
      },
    },
  };

  it("rejects lexically-shaped dates that name no day", () => {
    expect(isSessionDate("2026-07-21")).toBe(true);
    for (const impossible of ["2026-07-32", "2026-02-30", "2026-13-01", "not-a-date", 7, null]) {
      expect(isSessionDate(impossible)).toBe(false);
    }
  });

  it.each([
    ["an impossible day", "2026-07-32"],
    ["an impossible month-day", "2026-02-30"],
  ])("hostile regression: refuses %s in incompleteSessions", (_label, date) => {
    // incompleteSessions is the SOLE source of the refresh work list, so an
    // impossible date here becomes a refresh target.
    expect(
      validateCoverageReport({
        ...base,
        incompleteSessions: [{ date, classes: {} }],
        horizon: { ...base.horizon, gapsBehind: [date] },
      }).ok,
    ).toBe(false);
  });

  it("hostile regression: refuses an incomplete session outside the checked window", () => {
    // Outside the window nothing was checked, so the report cannot have found
    // it — and it would still drive a refresh.
    expect(
      validateCoverageReport({
        ...base,
        incompleteSessions: [{ date: "2026-12-31", classes: {} }],
        horizon: { ...base.horizon, gapsBehind: [] },
      }).ok,
    ).toBe(false);
  });

  it("hostile regression: refuses the same session named twice", () => {
    expect(
      validateCoverageReport({
        ...base,
        incompleteSessions: [
          { date: "2026-07-21", classes: {} },
          { date: "2026-07-21", classes: {} },
        ],
      }).ok,
    ).toBe(false);
  });

  it("refuses a non-trading day when the caller can settle it", () => {
    // 2026-07-25 is a Saturday. Without a calendar the validator cannot know;
    // with one it must refuse, because the producer never enumerates it.
    const weekend = {
      ...base,
      incompleteSessions: [{ date: "2026-07-25", classes: {} }],
      horizon: { ...base.horizon, gapsBehind: ["2026-07-25"], contiguousFrom: "2026-07-26" },
    };
    expect(validateCoverageReport(weekend).ok).toBe(true); // no calendar supplied
    expect(validateCoverageReport(weekend, { isSession: (d) => d !== "2026-07-25" }).ok).toBe(
      false,
    );
  });

  it("refuses an impossible date in the horizon itself", () => {
    expect(
      validateCoverageReport({
        ...base,
        status: "complete",
        incompleteSessions: [],
        horizon: {
          completeThrough: "2026-07-32",
          contiguousFrom: "2026-07-20",
          gapsBehind: [],
          perClass: {
            spot: "2026-07-32",
            option_chain: "2026-07-32",
            option_quote_minutes: "2026-07-32",
            enriched: "2026-07-32",
          },
        },
      }).ok,
    ).toBe(false);
  });
});

describe("the calendar binds every claimed session", () => {
  const saturday = "2026-07-25";
  // Weekend-aware, because the validator now cross-checks the session COUNT
  // against the calendar: a stub that called Sunday a session would make the
  // fixtures' own counts fiction.
  const isSession = (date) => {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  };
  const weekendComplete = {
    schemaVersion: 1,
    status: "complete",
    sessions: 1,
    incompleteSessions: [],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: saturday, to: saturday },
    horizon: {
      completeThrough: saturday,
      contiguousFrom: saturday,
      gapsBehind: [],
      perClass: {
        spot: saturday,
        option_chain: saturday,
        option_quote_minutes: saturday,
        enriched: saturday,
      },
    },
  };

  it("hostile regression: refuses a complete verdict over a day that never traded", () => {
    // Binding the calendar to `incompleteSessions` alone left this open: a
    // clean verdict over a Saturday window, which the producer's own calendar
    // says was never a session. A false clean needs no repair list to be a lie.
    expect(validateCoverageReport(weekendComplete, { isSession }).ok).toBe(false);
    // Without a calendar the validator cannot settle it and says so by accepting
    // the structural shape — which is why the CLI refuses to run without one.
    expect(validateCoverageReport(weekendComplete).ok).toBe(true);
  });

  it("binds the horizon and its class reaches, not only the window", () => {
    const realWindow = { from: "2026-07-20", to: "2026-07-31" };
    const withReach = (date) => ({
      ...weekendComplete,
      sessions: 10, // ten weekdays in 2026-07-20..2026-07-31
      window: realWindow,
      horizon: {
        completeThrough: date,
        contiguousFrom: "2026-07-20",
        gapsBehind: [],
        perClass: {
          spot: date,
          option_chain: date,
          option_quote_minutes: date,
          enriched: date,
        },
      },
    });
    expect(validateCoverageReport(withReach(saturday), { isSession }).ok).toBe(false);
    expect(validateCoverageReport(withReach("2026-07-31"), { isSession }).ok).toBe(true);
  });
});

describe("each calendar guard is proven on its own", () => {
  // 2026-07-25 is a Saturday; 07-24 Fri, 07-27 Mon.
  const SAT = "2026-07-25";
  const isSession = (date) => {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  };
  const report = (over) => ({
    schemaVersion: 1,
    status: "complete",
    sessions: 2,
    incompleteSessions: [],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-24", to: "2026-07-27" },
    horizon: {
      completeThrough: "2026-07-24",
      contiguousFrom: "2026-07-24",
      gapsBehind: [],
      perClass: {
        spot: "2026-07-24",
        option_chain: "2026-07-27",
        option_quote_minutes: "2026-07-27",
        enriched: "2026-07-27",
      },
    },
    ...over,
  });

  // Each case puts the Saturday in exactly ONE place. The combined weekend
  // fixture above could not tell these apart: removing any single guard still
  // left the others catching it, so all three mutations survived until now.
  it("the window's own bounds", () => {
    const only = report({
      window: { from: SAT, to: "2026-07-27" },
      horizon: {
        completeThrough: "2026-07-27",
        contiguousFrom: "2026-07-27",
        gapsBehind: [],
        perClass: {
          spot: "2026-07-27",
          option_chain: "2026-07-27",
          option_quote_minutes: "2026-07-27",
          enriched: "2026-07-27",
        },
      },
    });
    expect(validateCoverageReport(only, { isSession }).ok).toBe(false);
  });

  it("contiguousFrom, with a real horizon and real class reaches", () => {
    const only = report({
      horizon: {
        completeThrough: "2026-07-27",
        contiguousFrom: SAT,
        gapsBehind: [],
        perClass: {
          spot: "2026-07-27",
          option_chain: "2026-07-27",
          option_quote_minutes: "2026-07-27",
          enriched: "2026-07-27",
        },
      },
    });
    expect(validateCoverageReport(only, { isSession }).ok).toBe(false);
  });

  it("a class reach that is not the minimum, so completeThrough stays a real session", () => {
    // The Saturday sits ABOVE the minimum, so `completeThrough === min(perClass)`
    // is satisfied by a real session and only the per-class guard can catch it.
    const only = report({
      horizon: {
        completeThrough: "2026-07-24",
        contiguousFrom: "2026-07-24",
        gapsBehind: [],
        perClass: {
          spot: "2026-07-24",
          option_chain: SAT,
          option_quote_minutes: "2026-07-27",
          enriched: "2026-07-27",
        },
      },
    });
    expect(validateCoverageReport(only, { isSession }).ok).toBe(false);
    expect(validateCoverageReport(report(), { isSession }).ok).toBe(true);
  });
});

describe("the session count is evidence too", () => {
  const isSession = (date) => {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  };
  // 2026-07-24 Fri .. 2026-07-27 Mon = two sessions.
  const report = (sessions) => ({
    schemaVersion: 1,
    status: "complete",
    sessions,
    incompleteSessions: [],
    unreadable: [],
    expected: { spot: ["SPX"], options: ["SPX"] },
    marketRoot: "/data/market",
    generatedAt: "2026-08-10T15:00:00.000Z",
    window: { from: "2026-07-24", to: "2026-07-27" },
    horizon: {
      completeThrough: "2026-07-27",
      contiguousFrom: "2026-07-24",
      gapsBehind: [],
      perClass: {
        spot: "2026-07-27",
        option_chain: "2026-07-27",
        option_quote_minutes: "2026-07-27",
        enriched: "2026-07-27",
      },
    },
  });

  it("hostile regression: refuses a count that disagrees with the window", () => {
    // Every endpoint and horizon date here is a real session, so no date guard
    // can catch this. The claim is that only one session was checked across a
    // window holding two — a clean verdict over a session it never looked at.
    expect(validateCoverageReport(report(1), { isSession }).ok).toBe(false);
    expect(validateCoverageReport(report(3), { isSession }).ok).toBe(false);
    expect(validateCoverageReport(report(2), { isSession }).ok).toBe(true);
  });

  it("says nothing about the count when it has no calendar to say it with", () => {
    expect(validateCoverageReport(report(1)).ok).toBe(true);
  });
});
