#!/usr/bin/env node
/**
 * One-off validation driver for the daily option open-interest gRPC path.
 *
 * Confirms that the gRPC DataTable header names assumed by
 * normalizeThetaOpenInterestRow actually match what the live MDDS terminal
 * returns. The REST v3 OI response names the date column `timestamp` (header:
 * symbol,expiration,strike,right,timestamp,open_interest) — the gRPC stream may
 * differ from both REST and the proto, so this driver prints the RAW decoded
 * header keys alongside the normalized output and compares to known-good REST
 * values for a single contract.
 *
 * Ground truth (REST), SPXW 2024-01-19 4700C:
 *   2024-01-02 -> 1189
 *   2024-01-03 -> 1232
 *   2024-01-05 -> 1889
 *   2024-01-09 -> 2056
 *
 * Reads ONE small wildcard stream (SPXW, one expiration, a short range).
 * Writes NOTHING — pure read + print.
 *
 * Usage:
 *   THETADATA_CREDENTIALS_FILE=/path/to/creds.txt \
 *     node tools/oi-validate.mjs
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "../packages/mcp-server/dist/test-exports.js");

// Live-session config. The MDDS endpoint is the hosted gRPC service
// (mdds-01.thetadata.us:443); the "session" is the single authenticated
// session bound to the account, shared with the running terminal.
if (!process.env.THETADATA_CREDENTIALS_FILE) {
  console.error("ERROR THETADATA_CREDENTIALS_FILE env var is required (path to ThetaData creds file)");
  process.exit(1);
}
process.env.THETADATA_MDDS_HOST = process.env.THETADATA_MDDS_HOST || "mdds-01.thetadata.us";
process.env.THETADATA_MDDS_PORT = process.env.THETADATA_MDDS_PORT || "443";
process.env.THETADATA_MDDS_CLIENT_TYPE = process.env.THETADATA_MDDS_CLIENT_TYPE || "terminal";

const ROOT = "SPXW";
const EXPIRATION = "2024-01-19";
const START = "2024-01-02";
const END = "2024-01-09";
const TARGET_STRIKE = 4700;
const TARGET_RIGHT = "call";

const GROUND_TRUTH = {
  "2024-01-02": 1189,
  "2024-01-03": 1232,
  "2024-01-05": 1889,
  "2024-01-09": 2056,
};

function isSessionCollision(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /Invalid session ID|UNAUTHENTICATED/i.test(msg);
}

async function main() {
  const mod = await import(DIST);
  const { ThetaMddsClient, decodeThetaResponseData, optionHistoryOpenInterest } = mod;

  const client = new ThetaMddsClient();
  console.log("[config] MDDS target =",
    `${process.env.THETADATA_MDDS_HOST}:${process.env.THETADATA_MDDS_PORT}`,
    "clientType =", process.env.THETADATA_MDDS_CLIENT_TYPE,
    "creds =", process.env.THETADATA_CREDENTIALS_FILE);

  await client.connect();
  console.log("[connect] authenticated, session acquired");

  // ---- RAW path: call the RPC directly to inspect the decoded DataTable headers.
  const request = {
    queryInfo: client.queryInfo(),
    params: {
      contractSpec: { symbol: ROOT, expiration: EXPIRATION, strike: "*", right: "both" },
      expiration: EXPIRATION,
      startDate: START,
      endDate: END,
    },
  };

  const chunks = await client.callStream("GetOptionHistoryOpenInterest", request);
  console.log(`[raw] received ${chunks.length} response chunk(s)`);

  let rawHeaders = null;
  const rawRows = [];
  for (const chunk of chunks) {
    const decoded = decodeThetaResponseData(chunk);
    if (!rawHeaders) rawHeaders = decoded.headers;
    rawRows.push(...decoded.rows);
  }
  console.log("[raw] DataTable headers:", JSON.stringify(rawHeaders));
  console.log(`[raw] total decoded rows: ${rawRows.length}`);
  if (rawRows.length > 0) {
    console.log("[raw] first row keys:", JSON.stringify(Object.keys(rawRows[0])));
    console.log("[raw] first row:", JSON.stringify(rawRows[0]));
  }

  // Show the raw rows for the target contract (4700C) across the range.
  const rawTarget = rawRows.filter((r) => {
    const strike = Number(r.strike);
    const right = String(r.right ?? "").toLowerCase();
    return strike === TARGET_STRIKE && (right === "c" || right === "call");
  });
  console.log(`[raw] target 4700C rows: ${rawTarget.length}`);
  for (const r of rawTarget) console.log("[raw]   4700C:", JSON.stringify(r));

  // ---- NORMALIZED path: the real endpoint wrapper consumers use.
  const normalized = await optionHistoryOpenInterest(client, {
    symbol: ROOT,
    expiration: EXPIRATION,
    startDate: START,
    endDate: END,
  });
  console.log(`[normalized] total rows: ${normalized.length}`);

  const normTarget = normalized.filter(
    (r) => r.strike === TARGET_STRIKE && r.right === TARGET_RIGHT,
  );
  console.log(`[normalized] target 4700C rows: ${normTarget.length}`);
  for (const r of normTarget) console.log("[normalized]   4700C:", JSON.stringify(r));

  // ---- COMPARE to REST ground truth.
  const byDate = new Map();
  for (const r of normTarget) byDate.set(r.date, r.openInterest);

  let pass = true;
  console.log("\n[compare] date        expected   got      verdict");
  for (const [date, expected] of Object.entries(GROUND_TRUTH)) {
    const got = byDate.has(date) ? byDate.get(date) : "(missing)";
    const ok = got === expected;
    if (!ok) pass = false;
    console.log(
      `[compare] ${date}   ${String(expected).padEnd(8)}   ${String(got).padEnd(8)} ${ok ? "PASS" : "FAIL"}`,
    );
  }

  // Field-health checks on the normalized target rows: no null/garbled.
  for (const r of normTarget) {
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      console.log(`[health] FAIL: bad date on ${JSON.stringify(r)}`);
      pass = false;
    }
    if (r.openInterest == null || !Number.isFinite(r.openInterest)) {
      console.log(`[health] FAIL: bad open_interest on ${JSON.stringify(r)}`);
      pass = false;
    }
    if (!r.ticker || !r.symbol || !r.expiration) {
      console.log(`[health] FAIL: missing identity field on ${JSON.stringify(r)}`);
      pass = false;
    }
  }

  console.log(`\n[result] ${pass ? "PASS — gRPC OI mapping matches REST ground truth" : "FAIL — see above"}`);
  client.close();
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  if (isSessionCollision(error)) {
    console.error("[session-collision] Invalid session ID / UNAUTHENTICATED — the single account session collided with the running terminal. STOPPING (no retry).");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  console.error("[error]", error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
