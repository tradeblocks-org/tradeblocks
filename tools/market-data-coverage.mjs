#!/usr/bin/env node
// tools/market-data-coverage.mjs
//
// Answers "which trading sessions is the market corpus missing?" — a STATE
// check over the partition tree, not an event check over a run.
//
// Why this exists (enterprise#2497). The nightly pipeline reported its 2026-07-22
// and 2026-07-31 failures correctly: RESULT: DEGRADED, exit 1, refresh=errors in
// the status record. It then forgot them. The status record is overwritten every
// run, so the next clean night erased the evidence; systemd's StartLimitBurst
// gave up after two attempts minutes apart; and the next night's refresh only
// ever asks for its own yesterday. Two trading sessions — 2026-07-21 and
// 2026-07-30 — were left permanently empty while every "newest partition" read
// answered with a much later date.
//
// A run-outcome record cannot close that: it answers how last night went. This
// answers what is missing now, so a hole stays visible until it is filled and
// can be handed back to the refresh driver as a work list.
//
// Consumed by:
//   - operators / the nightly wrapper, as a report (--json, exit codes below)
//   - refresh-market-data.mjs --missing, which refreshes exactly these dates
//
// Exit codes:
//   0  complete   — every configured member present on every session in the window
//   1  incomplete — at least one session is missing at least one member
//   2  unknown    — the corpus could not be read, or the window held no sessions
//
// `unknown` is deliberately distinct from `incomplete`: an unreadable tree must
// never render as a clean bill of health, and must never be laundered into a
// work list either.

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { closeSync, openSync, readFileSync, readSync, statSync } from "fs";

import { ConfigError, assertFreshDist, parseList } from "./refresh-market-data.mjs";
export {
  isEarlyCloseSession,
  knownSpotSessionClose,
  spotSessionExpectation,
} from "./spot-session-close.mjs";
import { spotSessionExpectation } from "./spot-session-close.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DIST_ENTRYPOINT = resolve(REPO_ROOT, "packages/mcp-server/dist/test-exports.js");

// How many concrete repair commands the human-readable report prints. The full
// list is always printed above it, so this caps the suggestion block, never the
// finding.
const REPAIR_HINT_LIMIT = 10;

// Parquet's own framing: the 4-byte magic appears at the start and the end of
// every file, so the smallest conceivable valid file is both magics plus a
// 4-byte footer length.
const PARQUET_MAGIC = "PAR1";
const PARQUET_MIN_BYTES = PARQUET_MAGIC.length * 2 + 4;

// The partition classes under <dataRoot>/market that the REFRESH DRIVER writes,
// with the partition key each uses and which configured ticker list defines its
// membership. This set is deliberately exactly what `--missing` can repair.
//
// `option_oi_daily` is NOT here, and its absence is a decision (Worf gate,
// enterprise#2497). It is written by tradeblocks' `tools/oi-backfill.mjs` from
// its own root list (`MARKET_OI_ROOTS`), which canonicalizes roots into
// underlyings — SPXW and SPX both land under `underlying=SPX`. Nothing in this
// process can derive that membership without reimplementing the OI driver's
// canonicalization, and an expectation we cannot derive correctly is a false
// verdict waiting for the first box whose OI roots differ from its option
// underlyings. Reporting a class this probe cannot judge is worse than not
// reporting it: repair an OI hole with that driver.
// The canonical ticker-token grammar, shared with the refresh driver's parseList.
const TICKER_TOKEN_RE = /^[A-Z0-9]+$/;
const SESSION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shape is not a date. `2026-07-32` and `2026-02-30` match the regex and name no
// day that exists; a UTC roundtrip is the cheap total check (Worf gate,
// holodeck#278 round 4). This matters most on `incompleteSessions`, which is now
// the sole source of the refresh work list — an impossible date there becomes a
// refresh target.
export function isSessionDate(value) {
  if (typeof value !== "string" || !SESSION_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export const COVERAGE_CLASSES = [
  { name: "spot", dir: "spot", key: "ticker", members: "spot" },
  { name: "option_chain", dir: "option_chain", key: "underlying", members: "options" },
  {
    name: "option_quote_minutes",
    dir: "option_quote_minutes",
    key: "underlying",
    members: "options",
  },
  { name: "enriched", dir: "enriched", key: "ticker", members: "spot" },
];

// Membership comes from the SAME env contract the refresh driver writes from,
// never from what happens to be on disk. Enumerating members from the tree is
// the presence-without-completeness bug one level up: a ticker that has never
// written a single partition would contribute zero expected members and make
// every session read complete.
// Which membership a coverage run judges against: the caller's resolved lists
// when it has them, else the environment contract.
//
// A function rather than an inline `??` so the choice can be asserted. The
// override exists because the refresh driver honours CLI member overrides the
// environment does not carry — reading the env in `--missing` had coverage
// judging a DIFFERENT ticker set than the driver was about to write, so a
// requested repair could read complete and be silently skipped (Worf gate,
// enterprise#2497).
export function resolveCoverageMembers(expectedOverride, env) {
  if (expectedOverride) return expectedOverride;
  return resolveExpectedMembers(env);
}

export function resolveExpectedMembers(env) {
  return {
    spot: parseList(env.TRADEBLOCKS_SPOT_TICKERS, "TRADEBLOCKS_SPOT_TICKERS"),
    options: parseList(env.TRADEBLOCKS_OPTION_UNDERLYINGS, "TRADEBLOCKS_OPTION_UNDERLYINGS"),
  };
}

function shiftDate(date, days) {
  const cursor = new Date(`${date}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

export function sessionsInWindow(from, to, isSession) {
  const out = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    if (isSession(date)) out.push(date);
  }
  return out;
}

// The last `count` sessions on or before `endDate`, oldest first.
//
// FAILS CLOSED when the walk cannot satisfy the count (Worf gate,
// enterprise#2497). The previous form stopped at a fixed 400-calendar-day bound
// and returned whatever it had: `--lookback 401` silently reported on 286
// sessions, so a hole before the truncated start read as clean. A silent cap on
// a completeness check is the defect the check exists to find.
export class CoverageWindowError extends Error {}

export function lookbackSessions(count, endDate, isSession, maxCalendarDays = null) {
  const bound = maxCalendarDays ?? count * 3 + 30;
  const out = [];
  let date = endDate;
  for (let step = 0; step < bound && out.length < count; step += 1) {
    if (isSession(date)) out.unshift(date);
    date = shiftDate(date, -1);
  }
  if (out.length < count) {
    throw new CoverageWindowError(
      `could not resolve ${count} trading sessions ending ${endDate} within ${bound} calendar days ` +
        `(found ${out.length}) — refusing to report on a silently shortened window`,
    );
  }
  return out;
}

// The horizon: how far coverage actually reaches, WITH the holes behind it.
//
// ADR 0090 decision 2 asks the refresh rail for "a min-across-classes horizon
// and the gaps behind it", and is explicit that such a statement is more honest
// than either the frozen 2026-07-20 attestation or a naive newest-partition read
// (2026-08-07, holes hidden). The difference between this and the naive read is
// entirely `gapsBehind`: the same headline date, but it can no longer be quoted
// without the holes it steps over.
//
// `completeThrough` is the MIN across classes of each class's newest complete
// session — one class lagging pulls the whole horizon back, which is the point
// of min-across-classes. It is null when any class never completed in the window.
// `contiguousFrom` is where the unbroken all-classes run ending at the horizon
// begins; on this corpus in 2026-08 that was six sessions while the headline date
// was three weeks wider, which is exactly the gap enterprise#2497 was filed on.
export function deriveHorizon(sessions, incompleteSessions, classes = COVERAGE_CLASSES) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const holesByDate = new Map(incompleteSessions.map((entry) => [entry.date, entry.classes]));

  const perClass = {};
  for (const klass of classes) {
    let newest = null;
    for (const date of sessions) {
      const holes = holesByDate.get(date);
      if (!holes || !holes[klass.name]) newest = date;
    }
    perClass[klass.name] = newest;
  }

  const reaches = Object.values(perClass);
  const completeThrough = reaches.includes(null)
    ? null
    : reaches.reduce((lowest, date) => (date < lowest ? date : lowest));

  const gapsBehind =
    completeThrough === null
      ? incompleteSessions.map((entry) => entry.date)
      : incompleteSessions.map((entry) => entry.date).filter((date) => date <= completeThrough);

  // Walk back from the horizon while every class is complete. Null when the
  // horizon itself is not a fully complete session.
  let contiguousFrom = null;
  if (completeThrough !== null) {
    const upTo = sessions.filter((date) => date <= completeThrough);
    for (let i = upTo.length - 1; i >= 0; i -= 1) {
      if (holesByDate.has(upTo[i])) break;
      contiguousFrom = upTo[i];
    }
  }

  return { completeThrough, contiguousFrom, gapsBehind, perClass };
}

// Pure. `probe(className, member, date) -> boolean` is injected so the verdict
// logic is testable without a filesystem, and so a probe that throws can be
// exercised directly.
export function assessCoverage({ sessions, expected, probe, classes = COVERAGE_CLASSES }) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return {
      status: "unknown",
      reason: "window contained no trading sessions",
      sessions: 0,
      incompleteSessions: [],
      unreadable: [],
      horizon: null,
    };
  }

  const incompleteSessions = [];
  const unreadable = [];

  for (const date of sessions) {
    const perClass = {};

    for (const klass of classes) {
      const members = expected[klass.members];
      const missing = [];
      for (const member of members) {
        let present;
        try {
          present = probe(klass.name, member, date);
        } catch (error) {
          unreadable.push({
            class: klass.name,
            member,
            date,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!present) missing.push(member);
      }
      if (missing.length > 0) {
        perClass[klass.name] = {
          present: members.length - missing.length,
          expected: members.length,
          missing,
        };
      }
    }

    if (Object.keys(perClass).length > 0) incompleteSessions.push({ date, classes: perClass });
  }

  // Fail closed. A tree we could not fully read is neither clean nor a work
  // list — both readings would act on evidence we do not have.
  if (unreadable.length > 0) {
    return {
      status: "unknown",
      reason: `${unreadable.length} partition(s) could not be read`,
      sessions: sessions.length,
      incompleteSessions,
      unreadable,
      // An unreadable tree cannot support a horizon claim either.
      horizon: null,
    };
  }

  return {
    status: incompleteSessions.length === 0 ? "complete" : "incomplete",
    sessions: sessions.length,
    incompleteSessions,
    unreadable,
    horizon: deriveHorizon(sessions, incompleteSessions, classes),
  };
}

export function coverageExitCode(report) {
  if (report.status === "complete") return 0;
  if (report.status === "incomplete") return 1;
  return 2;
}

// A partition counts as present only when it holds a READABLE, non-empty
// `data.parquet` — the exact artifact the reader consumes.
//
// "any non-empty file in the directory" was wrong three ways at once (Worf gate,
// enterprise#2497). The writer stages every partition as a sidecar named
// `data.parquet.tmp-<pid>-<ts>-<rand>` and atomically renames it into place
// (tradeblocks `packages/mcp-server/src/db/parquet-writer.ts`), and every reader
// globs `**/data.parquet` precisely so those sidecars never match
// (`db/market-views.ts`). So a stranded sidecar from a killed write — the exact
// residue a failed night leaves — counted as a complete partition, as did any
// unrelated non-empty file. A file the reader cannot open counted too.
//
// Matching the reader's own rule is what makes this a completeness check rather
// than a directory-shape check. Unreadable is NOT absent: it throws, so the
// caller records `unknown`.
export function makeFilesystemProbe(marketRoot, classes = COVERAGE_CLASSES) {
  const dirs = new Map(classes.map((klass) => [klass.name, klass]));
  return (className, member, date) => {
    const klass = dirs.get(className);
    const artifact = resolve(
      marketRoot,
      klass.dir,
      `${klass.key}=${member}`,
      `date=${date}`,
      "data.parquet",
    );
    let stats;
    try {
      stats = statSync(artifact);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
      throw error; // EACCES and friends are unreadable, not absent.
    }
    if (!stats.isFile() || stats.size < PARQUET_MIN_BYTES) return false;
    // Opening and reading throws on an unreadable file, which reaches `unknown`.
    return hasParquetFraming(artifact, stats.size);
  };
}

// Parquet frames every file as: `PAR1` … metadata … <uint32 LE footer length>
// `PAR1`. This checks that framing — both magics, and a footer length that
// actually fits inside the file — using three small reads and no parser.
//
// WHAT THIS DOES AND DOES NOT ANSWER, because the question has no bottom.
// It answers "is a structurally framed artifact present at the path the reader
// globs". It does NOT answer "will every byte parse": a file can carry valid
// framing and still fail deep in its column metadata, and only a real
// `read_parquet` of all ~25k partitions would settle that — a different job
// (a corpus fsck), at a cost no nightly should pay to answer a presence
// question. A completeness probe that silently degraded into a slow integrity
// scan would stop running, which is worse than a bounded honest check.
//
// The framing checks are here because each one caught a REACHABLE wrong-green
// (Worf gate, enterprise#2497): size alone accepted any non-empty file, so a
// stranded writer sidecar counted; leading magic alone accepted a truncated
// write; both magics alone accepted a file DuckDB rejects with
// "Footer length error".
function hasParquetFraming(artifact, size) {
  const fd = openSync(artifact, "r");
  try {
    const head = Buffer.alloc(PARQUET_MAGIC.length);
    const tail = Buffer.alloc(PARQUET_MAGIC.length);
    const footerLen = Buffer.alloc(4);
    if (readSync(fd, head, 0, head.length, 0) !== head.length) return false;
    if (readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length) return false;
    if (readSync(fd, footerLen, 0, 4, size - tail.length - 4) !== 4) return false;
    if (head.toString("latin1") !== PARQUET_MAGIC) return false;
    if (tail.toString("latin1") !== PARQUET_MAGIC) return false;
    // The footer must be non-empty and fit between the two magics.
    const declared = footerLen.readUInt32LE(0);
    return declared > 0 && PARQUET_MIN_BYTES + declared <= size;
  } finally {
    closeSync(fd);
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Reads the evidence the short-session check actually needs. DuckDB is loaded
// lazily so structural report validation does not acquire a native dependency.
// The caller owns the connection lifetime and supplies only canonical paths.
export async function makeLastSpotBarProbe(marketRoot) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", {
    memory_limit: "512MB",
    threads: "2",
  });
  const connection = await instance.connect();
  return {
    async read(ticker, date) {
      const artifact = resolve(
        marketRoot,
        "spot",
        `ticker=${ticker}`,
        `date=${date}`,
        "data.parquet",
      );
      const result = await connection.runAndReadAll(
        `SELECT max(CAST(time AS VARCHAR)) AS last_bar FROM read_parquet(${sqlString(artifact)})`,
      );
      const value = result.getRowObjects()[0]?.last_bar;
      return value === null || value === undefined ? null : String(value).slice(0, 5);
    },
    async close() {
      connection.closeSync?.();
      instance.closeSync?.();
    },
  };
}

// Calendar-aware session-length verdict over existing spot partitions.
// `present` prevents a missing file (already an incomplete finding) from being
// mislabeled unreadable. A present file that cannot be parsed is UNKNOWN.
export async function assessSpotSessionLengths({
  sessions,
  tickers,
  isSession,
  present,
  readLastBar,
}) {
  const shortByDate = new Map();
  const unknown = [];

  for (const date of sessions) {
    for (const ticker of tickers) {
      const expectation = spotSessionExpectation(ticker, date, isSession);
      if (expectation === null) {
        unknown.push({
          class: "spot",
          member: ticker,
          date,
          error: `no sourced session close is defined for ${ticker}`,
        });
        continue;
      }
      let exists;
      try {
        exists = present("spot", ticker, date);
      } catch {
        // assessCoverage already records the more precise filesystem error.
        continue;
      }
      if (!exists) continue;

      let lastBar;
      try {
        lastBar = await readLastBar(ticker, date);
      } catch (error) {
        unknown.push({
          class: "spot",
          member: ticker,
          date,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (lastBar === null) {
        unknown.push({
          class: "spot",
          member: ticker,
          date,
          error: "partition contains no readable last-bar timestamp",
        });
      } else if (lastBar < expectation.minimumLastBar) {
        const findings = shortByDate.get(date) ?? [];
        findings.push({
          ticker,
          lastBar,
          sessionClose: expectation.sessionClose,
          minimumLastBar: expectation.minimumLastBar,
        });
        shortByDate.set(date, findings);
      }
    }
  }
  return { sessions, shortByDate, unknown };
}

export function mergeSpotSessionLengths(report, lengthAssessment, classes = COVERAGE_CLASSES) {
  if (report.status === "unknown" || lengthAssessment.unknown.length > 0) {
    const unreadable = [...report.unreadable, ...lengthAssessment.unknown];
    return {
      ...report,
      status: "unknown",
      reason: `${unreadable.length} partition or session-close judgment(s) could not be read`,
      unreadable,
      horizon: null,
    };
  }

  const byDate = new Map(report.incompleteSessions.map((entry) => [entry.date, entry]));
  for (const [date, short] of lengthAssessment.shortByDate) {
    let entry = byDate.get(date);
    if (!entry) {
      entry = { date, classes: {} };
      byDate.set(date, entry);
    }
    const existing = entry.classes.spot;
    entry.classes.spot = {
      present: existing?.present ?? report.expected.spot.length,
      expected: existing?.expected ?? report.expected.spot.length,
      missing: existing?.missing ?? [],
      short,
    };
  }
  const incompleteSessions = [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  return {
    ...report,
    status: incompleteSessions.length === 0 ? "complete" : "incomplete",
    incompleteSessions,
    horizon: deriveHorizon(lengthAssessment.sessions, incompleteSessions, classes),
  };
}

// The one place an `unknown` report is built.
//
// `collectCoverage` used to hand-assemble its two unknown branches, and both
// forgot `horizon` when the field was added — so `selfCheck` threw and the CLI
// exited 2 without ever emitting the reason it could not answer (Worf gate,
// holodeck#278 H1). Both routes are fail-closed paths, which is exactly where
// losing the explanation costs the most. One constructor means a field added to
// the contract cannot be added to some unknowns and not others.
export function unknownReport({
  reason,
  marketRoot,
  expected,
  now = new Date(),
  sessions = [],
  unreadable = [],
}) {
  return {
    status: "unknown",
    reason,
    sessions: sessions.length,
    incompleteSessions: [],
    unreadable,
    // An unknown verdict never claims a horizon; it did not get far enough to
    // have one, and the contract refuses a horizon on an unknown.
    horizon: null,
    schemaVersion: 1,
    generatedAt: new Date(now.getTime()).toISOString(),
    marketRoot,
    window: sessions.length > 0 ? { from: sessions[0], to: sessions[sessions.length - 1] } : null,
    expected,
  };
}

// Returns the failure message when the corpus root cannot be used, else null.
// A path that exists but is not a directory is a failure too — a file named
// `market` would otherwise make every partition read ENOTDIR, i.e. absent.
export function readRootFailure(marketRoot) {
  try {
    if (!statSync(marketRoot).isDirectory()) {
      return `not a directory: ${marketRoot}`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// The producer's own conformance check for a v1 report, exported so the consumer
// can call it INSTEAD OF keeping a hand-written copy of this contract.
//
// Why this exists (Worf gate round 5, enterprise#2497). The nightly wrapper
// validated reports with a hand-maintained field checklist in an embedded Python
// heredoc, and that predicate was wrong in four consecutive gate rounds — each
// fix correct, each leaving the neighbouring hole: a status-only payload, then a
// self-contradictory one, then `sessions: true`, then `schemaVersion: true`, then
// member tokens the producer would never emit. Every one of those was the
// consumer re-deriving a contract it does not own. A fifth field patch would buy
// the fifth hole; the contract needs ONE implementation, and this is it.
//
// `--validate <path>` runs this over a file, so the wrapper asks the producer
// whether a report is conformant rather than guessing.
export function validateCoverageReport(report, options = {}) {
  const { classes = COVERAGE_CLASSES, isSession = null } = options;
  const fail = (reason) => ({ ok: false, reason });
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return fail("report is not an object");
  }
  // `=== 1` alone accepts JSON true in some hosts and reads as a version check
  // in none. Be explicit about the type before the value.
  if (typeof report.schemaVersion !== "number" || report.schemaVersion !== 1) {
    return fail(`unsupported schemaVersion ${JSON.stringify(report.schemaVersion)}`);
  }
  if (!["complete", "incomplete", "unknown"].includes(report.status)) {
    return fail(`unknown status ${JSON.stringify(report.status)}`);
  }
  if (!Number.isInteger(report.sessions) || report.sessions < 0) {
    return fail("sessions is not a non-negative integer");
  }
  for (const key of ["incompleteSessions", "unreadable"]) {
    if (!Array.isArray(report[key])) return fail(`${key} is not an array`);
  }
  const expected = report.expected;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return fail("expected is not an object");
  }
  // Each entry must actually name a session. `incompleteSessions` is the ONLY
  // source of the repair work list now, so an entry without a canonical date
  // would map to `undefined` and hand the refresh driver a hole it cannot fill.
  const seenSessions = new Set();
  for (const entry of report.incompleteSessions) {
    if (entry === null || typeof entry !== "object" || !isSessionDate(entry.date)) {
      return fail(`incompleteSessions entry does not name a session: ${JSON.stringify(entry)}`);
    }
    if (seenSessions.has(entry.date)) {
      return fail(`incompleteSessions names ${entry.date} twice`);
    }
    seenSessions.add(entry.date);
    if (entry.classes && typeof entry.classes === "object" && !Array.isArray(entry.classes)) {
      for (const [className, cell] of Object.entries(entry.classes)) {
        if (cell?.short !== undefined) {
          if (className !== "spot" || !Array.isArray(cell.short) || cell.short.length === 0) {
            return fail(`${entry.date} ${className} has invalid short-session findings`);
          }
          const seenShort = new Set();
          for (const finding of cell.short) {
            const validMinute = (value) => {
              if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
              const [hour, minute] = value.split(":").map(Number);
              return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
            };
            if (
              finding === null ||
              typeof finding !== "object" ||
              !TICKER_TOKEN_RE.test(finding.ticker ?? "") ||
              !expected.spot?.includes(finding.ticker) ||
              !validMinute(finding.lastBar) ||
              !validMinute(finding.sessionClose) ||
              !validMinute(finding.minimumLastBar) ||
              finding.minimumLastBar > finding.sessionClose ||
              finding.lastBar >= finding.minimumLastBar ||
              seenShort.has(finding.ticker)
            ) {
              return fail(`${entry.date} spot has an invalid short-session finding`);
            }
            if (isSession) {
              const authority = spotSessionExpectation(finding.ticker, entry.date, isSession);
              if (
                authority === null ||
                finding.sessionClose !== authority.sessionClose ||
                finding.minimumLastBar !== authority.minimumLastBar
              ) {
                return fail(`${entry.date} spot short-session finding contradicts close authority`);
              }
            }
            seenShort.add(finding.ticker);
          }
        }
      }
    }
    // A session outside the window was never checked, so it cannot be something
    // this report found — and it would still become a refresh target.
    if (
      report.window !== null &&
      (entry.date < report.window.from || entry.date > report.window.to)
    ) {
      return fail(`incompleteSessions names ${entry.date}, outside the window that was checked`);
    }
    // When the caller can settle it, the date must be a real trading session.
    if (isSession && !isSession(entry.date)) {
      return fail(`incompleteSessions names ${entry.date}, which is not a trading session`);
    }
  }
  const keys = Object.keys(expected).sort();
  if (keys.length !== 2 || keys[0] !== "options" || keys[1] !== "spot") {
    return fail("expected must carry exactly spot and options");
  }
  for (const [name, members] of Object.entries(expected)) {
    if (!Array.isArray(members)) return fail(`expected.${name} is not an array`);
    // The SAME grammar parseList enforces on the way in. A member the producer
    // could never have emitted means the report did not come from this contract.
    for (const member of members) {
      if (typeof member !== "string" || !TICKER_TOKEN_RE.test(member)) {
        return fail(`expected.${name} contains a non-canonical member ${JSON.stringify(member)}`);
      }
    }
  }
  if (!expected.spot.length && !expected.options.length) {
    return fail("expected names no members, so no session can be missing");
  }
  // Semantics, not just shape: a verdict must agree with the evidence it carries.
  if (report.status === "complete" && report.incompleteSessions.length) {
    return fail("complete report names missing sessions");
  }
  if (report.status === "incomplete" && !report.incompleteSessions.length) {
    return fail("incomplete report names no sessions");
  }
  if (report.status !== "unknown" && report.sessions === 0) {
    return fail("a verdict over zero sessions is not a verdict");
  }
  // `unknown` is the ONLY status that may carry unreadable evidence, because
  // assessCoverage returns exactly that whenever anything was unreadable. A
  // `complete` report listing a partition it could not read contradicts the
  // producer's own rule, and shipping it hands an operator a clean verdict over
  // evidence of a hole (Worf gate round 6).
  if (report.status !== "unknown" && report.unreadable.length > 0) {
    return fail(
      `${report.status} report carries ${report.unreadable.length} unreadable partition(s)`,
    );
  }
  // Provenance is required, not decorative. A verdict without its window, its
  // generation time, and the root it read is an unbound claim: it cannot be
  // checked for staleness or for whether it describes the corpus in front of
  // you. Every collectCoverage branch emits all three.
  if (typeof report.marketRoot !== "string" || report.marketRoot.length === 0) {
    return fail("marketRoot is missing or not a non-empty string");
  }
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) {
    return fail(`generatedAt is not a parseable timestamp: ${JSON.stringify(report.generatedAt)}`);
  }
  if (report.window === null) {
    // A null window means no sessions were resolved, which is only ever an
    // `unknown`. A verdict with no window is not a verdict about anything.
    if (report.status !== "unknown") return fail(`${report.status} report has no window`);
  } else if (
    typeof report.window !== "object" ||
    Array.isArray(report.window) ||
    !isSessionDate(report.window.from) ||
    !isSessionDate(report.window.to) ||
    // The window's own bounds are sessions the producer enumerated, so when the
    // caller can settle it they must be real ones. Without this a `complete`
    // verdict over a Saturday window validated clean (Worf gate, holodeck#278
    // round 5) — a false clean over a day the calendar says never traded.
    (isSession !== null && (!isSession(report.window.from) || !isSession(report.window.to))) ||
    report.window.from > report.window.to
  ) {
    return fail(`window is not a bounded date range: ${JSON.stringify(report.window)}`);
  }

  // The session COUNT is evidence too, and it was the last date-bearing field
  // the calendar did not bind (Worf gate, holodeck#278 round 6). Every endpoint
  // and horizon date can be a real session while the count says the report
  // checked one session across a window holding two — a clean verdict over
  // sessions it never looked at, with no bad date anywhere to catch.
  if (isSession && report.window !== null) {
    const actual = sessionsInWindow(report.window.from, report.window.to, isSession).length;
    if (report.sessions !== actual) {
      return fail(
        `report claims ${report.sessions} session(s) but ${report.window.from}..${report.window.to} holds ${actual}`,
      );
    }
  }

  // The horizon is part of the statement, not a decoration: a verdict that
  // reaches a date without disclosing the holes behind it is the naive
  // newest-partition read ADR 0090 decision 2 rejects by name.
  if (report.status === "unknown") {
    if (report.horizon !== null) return fail("an unknown verdict cannot claim a horizon");
  } else {
    const horizon = report.horizon;
    if (horizon === null || typeof horizon !== "object" || Array.isArray(horizon)) {
      return fail(`${report.status} report has no horizon`);
    }
    // A horizon may only claim dates INSIDE the window that was actually
    // checked. Without this, a report whose window ran to July could headline
    // "complete through December" — and every hole after July is undisclosed by
    // construction, because the probe never looked there (Worf gate,
    // holodeck#278 R2-H2). The claim must not outrun the evidence.
    const inWindow = (date) =>
      report.window !== null && date >= report.window.from && date <= report.window.to;
    for (const key of ["completeThrough", "contiguousFrom"]) {
      if (horizon[key] === null) continue;
      if (!isSessionDate(horizon[key])) {
        return fail(`horizon.${key} is not a session date: ${JSON.stringify(horizon[key])}`);
      }
      if (!inWindow(horizon[key])) {
        return fail(`horizon.${key} (${horizon[key]}) is outside the window that was checked`);
      }
      if (isSession && !isSession(horizon[key])) {
        return fail(`horizon.${key} (${horizon[key]}) is not a trading session`);
      }
    }
    if (
      horizon.completeThrough !== null &&
      horizon.contiguousFrom !== null &&
      horizon.contiguousFrom > horizon.completeThrough
    ) {
      return fail("horizon.contiguousFrom is after the date it reaches");
    }
    if (!Array.isArray(horizon.gapsBehind)) return fail("horizon.gapsBehind is not an array");
    if (
      horizon.perClass === null ||
      typeof horizon.perClass !== "object" ||
      Array.isArray(horizon.perClass)
    ) {
      return fail("horizon.perClass is not an object");
    }
    // `perClass` is the evidence `completeThrough` is derived FROM, so the two
    // must agree — otherwise a report can publish a complete verdict while its
    // own class reach says no such reach exists (Worf gate, holodeck#278 B1).
    // `{"spot": null}`, `{}`, and a bogus class name all passed a shape-only
    // check.
    const classNames = classes.map((klass) => klass.name).sort();
    const reachNames = Object.keys(horizon.perClass).sort();
    if (reachNames.length !== classNames.length || reachNames.some((n, i) => n !== classNames[i])) {
      return fail(
        `horizon.perClass names ${reachNames.join(",") || "nothing"}; expected ${classNames.join(",")}`,
      );
    }
    for (const [name, reach] of Object.entries(horizon.perClass)) {
      if (reach === null) {
        if (report.status === "complete") {
          return fail(`complete report has no reach for ${name}`);
        }
        continue;
      }
      if (!isSessionDate(reach) || !inWindow(reach)) {
        return fail(`horizon.perClass.${name} (${JSON.stringify(reach)}) is outside the window`);
      }
      if (isSession && !isSession(reach)) {
        return fail(`horizon.perClass.${name} (${reach}) is not a trading session`);
      }
    }
    const reaches = Object.values(horizon.perClass);
    const derived = reaches.includes(null)
      ? null
      : reaches.reduce((lowest, date) => (date < lowest ? date : lowest));
    if (horizon.completeThrough !== derived) {
      return fail(
        `horizon.completeThrough (${JSON.stringify(horizon.completeThrough)}) is not the minimum class reach (${JSON.stringify(derived)})`,
      );
    }
    // A contiguous run must actually be contiguous. Claiming one that spans a
    // gap the report itself names is a self-contradicting operator claim, even
    // though `gapsBehind` still discloses the hole.
    if (horizon.contiguousFrom !== null) {
      const spanned = report.incompleteSessions
        .map((entry) => entry.date)
        .filter(
          (date) => date >= horizon.contiguousFrom && date <= (horizon.completeThrough ?? date),
        );
      if (spanned.length > 0) {
        return fail(
          `horizon claims an unbroken run from ${horizon.contiguousFrom} that spans ${spanned.join(",")}`,
        );
      }
    }
    // The holes behind the horizon are what make it honest. A report that names
    // incomplete sessions at or before the horizon and lists none of them is
    // the hidden-holes failure wearing the new field's name.
    const owed = report.incompleteSessions
      .map((entry) => entry.date)
      .filter((date) => horizon.completeThrough === null || date <= horizon.completeThrough);
    // Compare the SET, not the count. Counting let a report swap a real gap for
    // a fabricated one, or list the same gap twice, and still pass — the hidden
    // hole with its cardinality preserved (Worf gate, holodeck#278 H2). That is
    // the naive read this field exists to prevent, one substitution deeper.
    const owedSet = new Set(owed);
    const claimed = new Set(horizon.gapsBehind);
    if (claimed.size !== horizon.gapsBehind.length) {
      return fail("horizon.gapsBehind repeats a gap");
    }
    if (claimed.size !== owedSet.size || [...owedSet].some((date) => !claimed.has(date))) {
      return fail(
        `horizon.gapsBehind does not name the gaps behind the horizon ` +
          `(owed ${[...owedSet].sort().join(",") || "none"}; claimed ${[...claimed].sort().join(",") || "none"})`,
      );
    }
    // A verdict over real sessions that reaches nowhere is not a horizon.
    if (report.status === "complete" && horizon.completeThrough === null) {
      return fail("a complete report must reach a date");
    }
    if (horizon.contiguousFrom !== null && horizon.completeThrough === null) {
      return fail("horizon claims a contiguous run with no horizon to end it");
    }
  }

  const count = report.status === "incomplete" ? report.incompleteSessions.length : null;
  return { ok: true, status: report.status, incompleteSessions: count };
}

export function parseCoverageArgs(argv) {
  const args = { from: null, to: null, lookback: null, json: false, validate: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--from" || arg === "--to" || arg === "--lookback") {
      const next = argv[++i];
      if (next === undefined) throw new ConfigError(`${arg} requires a value`);
      if (arg === "--lookback") {
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new ConfigError(`--lookback must be a positive integer (got "${next}")`);
        }
        args.lookback = parsed;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
          throw new ConfigError(`${arg} must be YYYY-MM-DD (got "${next}")`);
        }
        args[arg.slice(2)] = next;
      }
    } else if (arg === "--validate") {
      const next = argv[++i];
      if (next === undefined) throw new ConfigError("--validate requires a path");
      args.validate = next;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  if (args.validate !== null) return args;
  if ((args.from === null) !== (args.to === null)) {
    throw new ConfigError("--from and --to are required together");
  }
  if (args.from !== null && args.lookback !== null) {
    throw new ConfigError("--lookback is mutually exclusive with --from/--to");
  }
  if (args.from !== null && args.from > args.to) {
    throw new ConfigError(`--to (${args.to}) must be >= --from (${args.from})`);
  }
  if (args.from === null && args.lookback === null) args.lookback = 30;
  return args;
}

// Yesterday in ET — the newest session the nightly could have written. Lifted
// from refresh-market-data.mjs's yesterdayET for the same reason it is local
// there: no coupling to a test-only sibling export.
export function yesterdayET(now = new Date()) {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return shiftDate(todayET, -1);
}

// Resolve the window, read the corpus, return the report. Shared by this CLI
// and by refresh-market-data.mjs --missing so the two can never disagree about
// what "missing" means.
export async function collectCoverage({
  args,
  env = process.env,
  now = new Date(),
  // The caller may supply the membership it actually resolved. `--missing` does,
  // because the refresh driver honours CLI overrides (`--spot-tickers`,
  // `--skip-options`, …) that the environment does not carry: reading the env
  // here made coverage judge a DIFFERENT ticker set than the one the driver was
  // about to write, so a requested repair could be reported complete and
  // silently skipped (Worf gate, enterprise#2497).
  expected: expectedOverride = null,
} = {}) {
  await assertFreshDist();
  const { isXnysSessionDate } = await import(pathToFileURL(DIST_ENTRYPOINT).href);
  if (typeof isXnysSessionDate !== "function") {
    throw new Error("TradeBlocks MCP dist is missing isXnysSessionDate — run npm run build:mcp.");
  }

  const expected = resolveCoverageMembers(expectedOverride, env);
  const dataRoot = env.TRADEBLOCKS_DATA_ROOT || `${env.HOME}/tradeblocks-data`;
  const marketRoot = resolve(dataRoot, "market");

  let sessions;
  try {
    sessions =
      args.lookback === null
        ? sessionsInWindow(args.from, args.to, isXnysSessionDate)
        : lookbackSessions(args.lookback, yesterdayET(now), isXnysSessionDate);
  } catch (error) {
    if (!(error instanceof CoverageWindowError)) throw error;
    return selfCheck(
      unknownReport({ reason: error.message, marketRoot, expected, now }),
      isXnysSessionDate,
    );
  }

  // An absent corpus root is ONE fact, and it is reported once. The probe still
  // throws per partition as defence in depth (a root can vanish mid-run), but
  // letting that be the only check turned a mistyped TRADEBLOCKS_DATA_ROOT into
  // 130 identical `unreadable` entries — a correct `unknown` verdict buried
  // under a wall that hides which fact it rests on.
  const rootFailure = readRootFailure(marketRoot);
  if (rootFailure) {
    return selfCheck(
      unknownReport({
        reason: `market-data root is not readable: ${rootFailure}`,
        marketRoot,
        expected,
        now,
        sessions,
        unreadable: [{ class: null, member: null, date: null, error: rootFailure }],
      }),
      isXnysSessionDate,
    );
  }

  const presenceProbe = makeFilesystemProbe(marketRoot);
  const presenceReport = assessCoverage({
    sessions,
    expected,
    probe: presenceProbe,
  });
  const reportWithProvenance = {
    ...presenceReport,
    schemaVersion: 1,
    generatedAt: new Date(now.getTime()).toISOString(),
    marketRoot,
    window: sessions.length > 0 ? { from: sessions[0], to: sessions[sessions.length - 1] } : null,
    expected,
  };
  if (presenceReport.status === "unknown") {
    return selfCheck(reportWithProvenance, isXnysSessionDate);
  }

  let lastBarProbe;
  try {
    lastBarProbe = await makeLastSpotBarProbe(marketRoot);
    const lengths = await assessSpotSessionLengths({
      sessions,
      tickers: expected.spot,
      isSession: isXnysSessionDate,
      present: presenceProbe,
      readLastBar: lastBarProbe.read,
    });
    return selfCheck(mergeSpotSessionLengths(reportWithProvenance, lengths), isXnysSessionDate);
  } finally {
    await lastBarProbe?.close();
  }
}

// The producer runs its own contract check over everything it emits, so producer
// and validator cannot drift apart silently — the drift class that produced both
// round-6 findings, where the validator failed to enforce invariants
// assessCoverage already guaranteed. A non-conformant report is now a crash
// here, not a clean-looking verdict downstream.
export function selfCheck(report, isSession = null) {
  const verdict = validateCoverageReport(report, { isSession });
  if (!verdict.ok) {
    throw new Error(`coverage report failed its own contract check: ${verdict.reason}`);
  }
  return report;
}

function printHelp() {
  console.log(`Usage: market-data-coverage.mjs [options]

Reports which XNYS trading sessions are missing market-data partitions.

Covers the four classes the refresh driver writes: spot, option_chain,
option_quote_minutes, enriched. option_oi_daily is OUT OF SCOPE — it is written
by tradeblocks' tools/oi-backfill.mjs from its own root list, whose membership
this probe cannot derive. Check and repair OI with that driver.

Options:
  --lookback N        Check the last N trading sessions ending yesterday ET
                      (default 30). Mutually exclusive with --from/--to.
  --from YYYY-MM-DD   Window start (requires --to).
  --to YYYY-MM-DD     Window end (requires --from).
  --json              Emit the machine-readable report instead of the table.
  --validate PATH     Check that PATH is a conformant v1 coverage report and
                      print "<status>\\t<incompleteCount>". Exit 0 conformant,
                      2 not. This is the producer's own contract check, so a
                      consumer never needs a hand-written copy of it.
  -h, --help          Show this help.

Environment (same contract refresh-market-data.mjs writes from):
  TRADEBLOCKS_SPOT_TICKERS        defines spot + enriched membership
  TRADEBLOCKS_OPTION_UNDERLYINGS  defines option_chain + option_quote_minutes membership
  TRADEBLOCKS_DATA_ROOT           corpus root (default ~/tradeblocks-data)

Exit: 0 complete · 1 incomplete · 2 unknown (unreadable, or no sessions).
`);
}

function renderReport(report) {
  const lines = [];
  lines.push(
    `[coverage] window=${report.window ? `${report.window.from}..${report.window.to}` : "(none)"} ` +
      `sessions=${report.sessions} status=${report.status}`,
  );
  if (report.reason) lines.push(`[coverage] reason: ${report.reason}`);
  for (const entry of report.unreadable) {
    lines.push(
      entry.date === null
        ? `[coverage]   unreadable: ${entry.error}`
        : `[coverage]   unreadable: ${entry.class}/${entry.member} ${entry.date} — ${entry.error}`,
    );
  }
  for (const entry of report.incompleteSessions) {
    const cells = Object.entries(entry.classes)
      .map(([name, cell]) => {
        const defects = [];
        if (cell.missing.length > 0) defects.push(`missing ${cell.missing.join(",")}`);
        if (cell.short?.length > 0) {
          defects.push(
            `short ${cell.short
              .map(
                ({ ticker, lastBar, minimumLastBar, sessionClose }) =>
                  `${ticker} ended ${lastBar}, expected at least ${minimumLastBar} ` +
                  `(session closes ${sessionClose})`,
              )
              .join("; ")}`,
          );
        }
        return `${name}=${cell.present}/${cell.expected} (${defects.join("; ")})`;
      })
      .join(" ");
    lines.push(`[coverage]   ${entry.date}  ${cells}`);
  }
  const repairable = report.incompleteSessions.map((entry) => entry.date);
  if (repairable.length > 0) {
    lines.push(`[coverage] refreshable sessions (${repairable.length}): ` + repairable.join(" "));
    // Name the dates, never a lookback. `--lookback` counts back from
    // yesterday, not from the reported window, so translating a window into a
    // session count produces a DIFFERENT window — and a large one would sweep
    // every session in between, re-fetching sessions the vendor may simply not
    // have and that therefore never become complete. `--asOf` is exact.
    for (const date of repairable.slice(0, REPAIR_HINT_LIMIT)) {
      lines.push(`[coverage] fill with: tools/refresh-market-data.mjs --asOf ${date}`);
    }
    if (repairable.length > REPAIR_HINT_LIMIT) {
      lines.push(`[coverage] ...and ${repairable.length - REPAIR_HINT_LIMIT} more, listed above`);
    }
  }
  return lines.join("\n");
}

async function main() {
  let args;
  try {
    args = parseCoverageArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  // Ask the producer whether a report on disk is conformant. Emits
  // "<status>\t<incompleteCount>" on success so a shell consumer can read the
  // verdict without parsing JSON itself; exit 0 conformant, 2 not.
  if (args.validate !== null) {
    let report;
    try {
      report = JSON.parse(readFileSync(args.validate, "utf8"));
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    // Load the same calendar the producer used, so `--validate` is exactly as
    // strict as `selfCheck` rather than a weaker outside opinion.
    //
    // FAIL CLOSED when it cannot be loaded. The first version caught every load
    // error and validated structurally instead, which silently swapped the
    // contract for a weaker one — and a weekend date accepted that way still
    // reaches the refresh work list (Worf gate, holodeck#278 round 5). A tool
    // whose whole job is refusing bad reports must not quietly become a tool
    // that refuses fewer of them.
    let isSession = null;
    try {
      await assertFreshDist();
      ({ isXnysSessionDate: isSession } = await import(pathToFileURL(DIST_ENTRYPOINT).href));
    } catch (error) {
      console.error(
        `Error: cannot validate without the trading calendar — ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }
    if (typeof isSession !== "function") {
      console.error(
        "Error: cannot validate without the trading calendar — TradeBlocks MCP dist is missing isXnysSessionDate",
      );
      process.exit(2);
    }
    const verdict = validateCoverageReport(report, { isSession });
    if (!verdict.ok) {
      console.error(`Error: not a conformant coverage report — ${verdict.reason}`);
      process.exit(2);
    }
    process.stdout.write(`${verdict.status}\t${verdict.incompleteSessions ?? ""}\n`);
    return;
  }

  let report;
  try {
    report = await collectCoverage({ args });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  console.log(args.json ? JSON.stringify(report) : renderReport(report));
  process.exit(coverageExitCode(report));
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(2);
  });
}
