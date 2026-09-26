/**
 * Unit tests for refresh-market-data.mjs CLI/env list resolution.
 *
 * Covers the `resolveLists(args, env) → { spot, options, sources }` helper
 * added for enterprise#204 (per-underlying CLI flag overrides) and the
 * process-level guards that exit before the dist import:
 *   - --skip-spot + --spot-tickers mutex
 *   - --skip-options + --option-underlyings mutex
 *   - --skip-spot --skip-options no-op (must exit 2 before dist import)
 */
import { describe, expect, it, beforeAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "../refresh-market-data.mjs");

let resolveLists;
let resolveRefreshProvenance;
let buildRefreshRequest;
let formatProvenanceReceipt;
let makeRefreshProvider;

beforeAll(async () => {
  const scriptUrl = pathToFileURL(scriptPath).href;
  const mod = await import(scriptUrl);
  resolveLists = mod.resolveLists;
  resolveRefreshProvenance = mod.resolveRefreshProvenance;
  buildRefreshRequest = mod.buildRefreshRequest;
  formatProvenanceReceipt = mod.formatProvenanceReceipt;
  makeRefreshProvider = mod.makeRefreshProvider;
});

// Helper for clean default args.
function args(overrides = {}) {
  return {
    spotTickersCli: null,
    optionUnderlyingsCli: null,
    skipSpot: false,
    skipOptions: false,
    ...overrides,
  };
}

describe("refresh-market-data resolveLists (pure helper)", () => {
  it("env-only: both lists resolve from env, sources = env/env", () => {
    const out = resolveLists(args(), {
      TRADEBLOCKS_SPOT_TICKERS: "SPX,VIX",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
    });
    expect(out.spot).toEqual(["SPX", "VIX"]);
    expect(out.options).toEqual(["SPX"]);
    expect(out.sources).toEqual({ spot: "env", options: "env" });
  });

  it("cli-only: CLI overrides env, sources = cli/cli", () => {
    const out = resolveLists(args({ spotTickersCli: "QQQ", optionUnderlyingsCli: "QQQ" }), {
      TRADEBLOCKS_SPOT_TICKERS: "SPX,VIX",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
    });
    expect(out.spot).toEqual(["QQQ"]);
    expect(out.options).toEqual(["QQQ"]);
    expect(out.sources).toEqual({ spot: "cli", options: "cli" });
  });

  it("cli supplies the value when env is unset (no throw)", () => {
    const out = resolveLists(
      args({ spotTickersCli: "QQQ", optionUnderlyingsCli: "QQQ" }),
      {}, // empty env
    );
    expect(out.spot).toEqual(["QQQ"]);
    expect(out.options).toEqual(["QQQ"]);
    expect(out.sources).toEqual({ spot: "cli", options: "cli" });
  });

  it("--skip-spot: spot=[]; missing TRADEBLOCKS_SPOT_TICKERS does not throw", () => {
    const out = resolveLists(args({ skipSpot: true }), {
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX,QQQ",
    });
    expect(out.spot).toEqual([]);
    expect(out.options).toEqual(["SPX", "QQQ"]);
    expect(out.sources).toEqual({ spot: "skip", options: "env" });
  });

  it("--skip-options: options=[]; missing TRADEBLOCKS_OPTION_UNDERLYINGS does not throw", () => {
    const out = resolveLists(args({ skipOptions: true }), {
      TRADEBLOCKS_SPOT_TICKERS: "SPX,VIX",
    });
    expect(out.spot).toEqual(["SPX", "VIX"]);
    expect(out.options).toEqual([]);
    expect(out.sources).toEqual({ spot: "env", options: "skip" });
  });

  it("--skip-spot --skip-options: both lists empty, sources = skip/skip", () => {
    const out = resolveLists(args({ skipSpot: true, skipOptions: true }), {});
    expect(out.spot).toEqual([]);
    expect(out.options).toEqual([]);
    expect(out.sources).toEqual({ spot: "skip", options: "skip" });
  });

  it("still throws when a non-skipped stage has neither CLI nor env", () => {
    expect(() => resolveLists(args(), {})).toThrow(/TRADEBLOCKS_SPOT_TICKERS is required/);
    expect(() => resolveLists(args({ skipSpot: true }), {})).toThrow(
      /TRADEBLOCKS_OPTION_UNDERLYINGS is required/,
    );
  });

  it("propagates parseList shape validation through CLI flag names", () => {
    // Spot CLI is shape-invalid; options come from env so the spot error
    // surfaces first with the CLI flag name in the message.
    expect(() =>
      resolveLists(args({ spotTickersCli: "SP X" }), {
        TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
      }),
    ).toThrow(/^--spot-tickers contains invalid token/);
    // Spot resolves from env so the options CLI shape error surfaces.
    expect(() =>
      resolveLists(args({ optionUnderlyingsCli: "BAD!" }), {
        TRADEBLOCKS_SPOT_TICKERS: "SPX",
      }),
    ).toThrow(/^--option-underlyings contains invalid token/);
  });
});

describe("refresh-market-data canonical provenance wiring", () => {
  const closure = `sha256:${"a".repeat(64)}`;
  const manifest = `sha256:${"b".repeat(64)}`;
  const aggregateRoot = `sha256:${"c".repeat(64)}`;

  it("preserves the legacy refresh request when provenance is absent", () => {
    expect(resolveRefreshProvenance(args())).toBeUndefined();
    expect(buildRefreshRequest("2026-07-21", ["SPX"], ["SPX"], undefined)).toEqual({
      asOf: "2026-07-21",
      spotTickers: ["SPX"],
      chainUnderlyings: ["SPX"],
      quoteUnderlyings: ["SPX"],
      computeVixContext: true,
    });
  });

  it("passes closure and attemptId without inventing a predecessor", () => {
    const provenance = resolveRefreshProvenance({
      provenanceClosure: closure,
      provenanceAttemptId: "daily-2026-07-21",
      predecessorManifest: null,
      predecessorRoot: null,
    });
    expect(provenance).toEqual({ closure, attemptId: "daily-2026-07-21" });
    expect(buildRefreshRequest("2026-07-21", ["SPX"], ["SPX"], provenance)).toEqual(
      expect.objectContaining({ provenance }),
    );
    expect(buildRefreshRequest("2026-07-21", ["SPX"], ["SPX"], provenance)).not.toHaveProperty(
      "provider",
    );
  });

  it("constructs a Theta provider whose index endpoint requests the 16:15 close", async () => {
    let deps;
    let received;
    class FakeThetaProvider {
      constructor(value) {
        deps = value;
      }
    }
    const mod = {
      MassiveProvider: class {},
      ThetaDataProvider: FakeThetaProvider,
      indexHistoryOhlc: async (_client, params) => {
        received = params;
        return [];
      },
    };
    expect(makeRefreshProvider(mod, "thetadata")).toBeInstanceOf(FakeThetaProvider);
    await deps.indexHistoryOhlc({}, { symbol: "VIX", endTime: "16:00:00.000" });
    expect(received).toMatchObject({ symbol: "VIX", endTime: "16:15:00.000" });
  });

  it("preserves the ordinary provider choice for a spot-only provenance refresh", () => {
    const provenance = { closure, attemptId: "spot-2026-07-21" };
    const request = buildRefreshRequest("2026-07-21", ["SPX"], [], provenance);
    expect(request).toEqual(
      expect.objectContaining({
        spotTickers: ["SPX"],
        chainUnderlyings: [],
        quoteUnderlyings: [],
        provenance,
      }),
    );
    expect(request).not.toHaveProperty("provider");
  });

  it("maps the optional predecessor manifest/root pair to the ingestor contract", () => {
    expect(
      resolveRefreshProvenance({
        provenanceClosure: closure,
        provenanceAttemptId: "daily-2026-07-21",
        predecessorManifest: manifest,
        predecessorRoot: aggregateRoot,
      }),
    ).toEqual({
      closure,
      attemptId: "daily-2026-07-21",
      predecessor: { manifest, aggregateRoot },
    });
  });

  it("formats only a matching, address-valid cutoff receipt", () => {
    expect(
      formatProvenanceReceipt(
        "2026-07-21",
        {
          provenance: {
            attemptId: "daily-2026-07-21",
            cutoff: manifest,
            aggregateRoot,
          },
        },
        { attemptId: "daily-2026-07-21" },
      ),
    ).toBe(`[refresh] 2026-07-21 cutoff=${manifest} aggregateRoot=${aggregateRoot}`);
    expect(() =>
      formatProvenanceReceipt("2026-07-21", {}, { attemptId: "daily-2026-07-21" }),
    ).toThrow("returned no cutoff receipt");
    expect(() =>
      formatProvenanceReceipt(
        "2026-07-21",
        { provenance: { attemptId: "wrong", cutoff: manifest, aggregateRoot } },
        { attemptId: "daily-2026-07-21" },
      ),
    ).toThrow("attemptId does not match");
  });
});

// Subprocess-level guards (mutex + no-op short-circuit). These exit BEFORE
// the dist import — verified by running with an empty PATH-of-sorts: we
// simply check that the exit code is 2 and the dist module never logs.
//
// Two exit-code families on the config surface:
//   exit 2 → config INCOHERENT (mutex / both-skip no-op)
//   exit 1 → config MISSING or SHAPE-INVALID (env var unset/empty/whitespace,
//            or CLI flag value fails the /^[A-Z0-9]+$/ shape check)
// Both print a one-line `Error: <msg>` to stderr — no stack trace.
describe("refresh-market-data CLI guards (subprocess)", () => {
  function run(argv, env = {}) {
    // Strip any inherited TRADEBLOCKS_* env vars so tests are deterministic
    // regardless of the operator's shell (CI, homelab, local dev). The env
    // param then becomes the full authoritative env for the script.
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("TRADEBLOCKS_")) baseEnv[k] = v;
    }
    return spawnSync(process.execPath, [scriptPath, ...argv], {
      env: { ...baseEnv, ...env },
      encoding: "utf8",
    });
  }

  it("--skip-spot --spot-tickers QQQ exits 2 with mutex error", () => {
    const r = run(["--skip-spot", "--spot-tickers", "QQQ"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--skip-spot is mutually exclusive with --spot-tickers/);
  });

  it("--skip-options --option-underlyings QQQ exits 2 with mutex error", () => {
    const r = run(["--skip-options", "--option-underlyings", "QQQ"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--skip-options is mutually exclusive with --option-underlyings/);
  });

  it.each([
    [["--provenance-closure", `sha256:${"a".repeat(64)}`], /required together/],
    [["--provenance-attempt-id", "daily-1"], /required together/],
    [
      [
        "--provenance-closure",
        `sha256:${"a".repeat(64)}`,
        "--provenance-attempt-id",
        "daily-1",
        "--predecessor-manifest",
        `sha256:${"b".repeat(64)}`,
      ],
      /predecessor-manifest and --predecessor-root are required together/,
    ],
    [
      ["--provenance-closure", "sha256:ABC", "--provenance-attempt-id", "daily-1"],
      /provenance-closure must be a lowercase sha256 address/,
    ],
    [
      [
        "--provenance-closure",
        `sha256:${"a".repeat(64)}`,
        "--provenance-attempt-id",
        "not canonical",
      ],
      /provenance-attempt-id must be 1-128 canonical/,
    ],
  ])("provenance flag pairing and address syntax fail before dist import", (argv, message) => {
    const r = run(argv);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).not.toMatch(/\[refresh\] spot_tickers/);
  });

  it("dry-run accepts and surfaces a complete provenance request without importing dist", () => {
    const closure = `sha256:${"a".repeat(64)}`;
    const r = run(
      [
        "--dry-run",
        "--asOf",
        "2026-07-21",
        "--provenance-closure",
        closure,
        "--provenance-attempt-id",
        "daily-2026-07-21",
      ],
      {
        TRADEBLOCKS_SPOT_TICKERS: "SPX",
        TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`closure=${closure} attemptId=daily-2026-07-21`);
    expect(r.stdout).toContain("dry-run complete; no ingestor calls made");
  });

  it("canonical provenance refuses a multi-date range", () => {
    const r = run([
      "--from",
      "2026-07-20",
      "--to",
      "2026-07-21",
      "--provenance-closure",
      `sha256:${"a".repeat(64)}`,
      "--provenance-attempt-id",
      "range-1",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/accepts one date at a time/);
    expect(r.stdout).not.toMatch(/\[refresh\] spot_tickers/);
  });

  it("--skip-spot --skip-options exits 2 BEFORE any dist import", () => {
    // Pass empty env so a non-guarded code path would throw "TRADEBLOCKS_…
    // is required". Hitting the no-op guard short-circuits before that.
    const r = run(["--skip-spot", "--skip-options"], {
      TRADEBLOCKS_SPOT_TICKERS: "",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/both --skip-spot and --skip-options/);
    // No dist import side-effects: the script only logs via [refresh] prefix
    // AFTER resolveLists returns. The no-op guard exits before that.
    expect(r.stdout).not.toMatch(/\[refresh\] spot_tickers/);
  });

  // ── Exit-1 family: config missing or shape-invalid ──
  // All cases must print a clean `Error: …` one-liner to stderr, with NO
  // stack trace and NO trailing newline before/after Error: noise. The
  // resolver throws ConfigError; the top-level catch flattens it.

  it("env-var missing (both unset): exit 1, one-liner naming SPOT_TICKERS, no stack", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^Error: TRADEBLOCKS_SPOT_TICKERS is required; see docs\/operations\/market-data-deployment\.md/,
    );
    // Negative: no stack trace artefacts.
    expect(r.stderr).not.toMatch(/at \w+ \(/); // "at funcName ("
    expect(r.stderr).not.toMatch(/ConfigError:/); // raw class name
  });

  it("env-var empty: exit 1, one-liner", () => {
    const r = run([], {
      TRADEBLOCKS_SPOT_TICKERS: "",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^Error: TRADEBLOCKS_SPOT_TICKERS is required; see docs\/operations\/market-data-deployment\.md/,
    );
    expect(r.stderr).not.toMatch(/at \w+ \(/);
  });

  it("env-var whitespace-only: exit 1, one-liner", () => {
    const r = run([], {
      TRADEBLOCKS_SPOT_TICKERS: "   ",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^Error: TRADEBLOCKS_SPOT_TICKERS is required; see docs\/operations\/market-data-deployment\.md/,
    );
    expect(r.stderr).not.toMatch(/at \w+ \(/);
  });

  it("env-var shape-invalid (whitespace inside token): exit 1, one-liner", () => {
    const r = run([], {
      TRADEBLOCKS_SPOT_TICKERS: "SP X",
      TRADEBLOCKS_OPTION_UNDERLYINGS: "SPX",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Error: TRADEBLOCKS_SPOT_TICKERS contains invalid token "SP X"/);
    expect(r.stderr).not.toMatch(/at \w+ \(/);
  });

  it("CLI flag shape-invalid: exit 1, one-liner naming the flag", () => {
    const r = run(["--spot-tickers", "BAD!", "--option-underlyings", "SPX"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Error: --spot-tickers contains invalid token "BAD!"/);
    expect(r.stderr).not.toMatch(/at \w+ \(/);
  });
});
