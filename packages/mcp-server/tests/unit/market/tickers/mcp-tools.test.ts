/**
 * Unit tests for the four ticker-registry MCP tools (Plan 01-05).
 *
 * Covers:
 *   - handleRegisterUnderlying: round-trip persists to {dataRoot}/market/underlyings.json
 *     and re-loadable via loadRegistry; output entry tagged source="user" or "user-override".
 *   - handleUnregisterUnderlying: throws on bundled defaults; succeeds on user entries.
 *   - handleListUnderlyings: returns entries with source annotation.
 *   - handleResolveRoot: returns {root, underlying, source} for OCC tickers, bare roots,
 *     and identity-fallback (leveraged ETFs not in registry).
 *   - Zod schemas (T-1-02 layer 1): reject path-traversal, control chars, empty arrays.
 *
 * The handlers are exported from src/tools/tickers.ts and re-exported via test-exports.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadRegistry,
  handleRegisterUnderlying,
  handleUnregisterUnderlying,
  handleListUnderlyings,
  handleResolveRoot,
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
} from "../../../../src/test-exports.ts";

interface ResourceContent {
  type: "resource";
  resource: { uri: string; mimeType: string; text: string };
}

function getJsonPayload(out: { content: Array<{ type: string }> }): unknown {
  const chunk = out.content.find((c) => c.type === "resource") as
    | ResourceContent
    | undefined;
  if (!chunk) throw new Error("No resource chunk in tool output");
  return JSON.parse(chunk.resource.text);
}

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = join(
    tmpdir(),
    `ticker-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpDataDir, "market"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("handleRegisterUnderlying — round-trip", () => {
  it("persists a new user entry to {dataRoot}/market/underlyings.json and reloads it", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    const out = await handleRegisterUnderlying(
      { underlying: "XSP", roots: ["XSP", "XSPW"] },
      r,
      tmpDataDir,
    );

    // File written to expected location
    const jsonPath = join(tmpDataDir, "market", "underlyings.json");
    expect(existsSync(jsonPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      version: 1;
      underlyings: Array<{ underlying: string; roots: string[] }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.underlyings.some((u) => u.underlying === "XSP")).toBe(true);

    // Handler output contains the merged entry with source="user"
    const payload = getJsonPayload(out) as {
      entry: { underlying: string; roots: string[]; source: string };
    };
    expect(payload.entry.underlying).toBe("XSP");
    expect(payload.entry.roots).toEqual(["XSP", "XSPW"]);
    expect(payload.entry.source).toBe("user");

    // Re-load registry from disk and confirm resolution
    const r2 = await loadRegistry({ dataDir: tmpDataDir });
    expect(r2.resolve("XSPW")).toBe("XSP");
    expect(r2.resolve("XSP")).toBe("XSP");
  });

  it("tags overrides of bundled defaults as source='user-override'", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    const out = await handleRegisterUnderlying(
      { underlying: "SPX", roots: ["SPX", "SPXW", "SPXQ", "SPXCUSTOM"] },
      r,
      tmpDataDir,
    );
    const payload = getJsonPayload(out) as {
      entry: { underlying: string; source: string };
    };
    expect(payload.entry.source).toBe("user-override");
  });
});

describe("handleUnregisterUnderlying — bundled-default protection", () => {
  it("throws when called with a bundled default (SPX)", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    await expect(
      handleUnregisterUnderlying({ underlying: "SPX" }, r, tmpDataDir),
    ).rejects.toThrow(/cannot unregister bundled default/);
  });

  it("succeeds for a user-added entry and persists removal", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    r.register({ underlying: "XSP", roots: ["XSP"] });
    await handleUnregisterUnderlying({ underlying: "XSP" }, r, tmpDataDir);
    expect(r.list().some((e) => e.underlying === "XSP")).toBe(false);
    // After save the file should not contain XSP
    const r2 = await loadRegistry({ dataDir: tmpDataDir });
    expect(r2.list().some((e) => e.underlying === "XSP")).toBe(false);
  });
});

describe("handleListUnderlyings — source annotation", () => {
  it("includes bundled defaults tagged source='default'", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    const out = await handleListUnderlyings({}, r);
    const payload = getJsonPayload(out) as {
      entries: Array<{ underlying: string; source: string }>;
    };
    const spx = payload.entries.find((e) => e.underlying === "SPX");
    expect(spx).toBeDefined();
    expect(spx?.source).toBe("default");
  });

  it("returns user-added entries tagged source='user' alongside defaults", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    r.register({ underlying: "XSP", roots: ["XSP"] });
    const out = await handleListUnderlyings({}, r);
    const payload = getJsonPayload(out) as {
      entries: Array<{ underlying: string; source: string }>;
    };
    expect(payload.entries.find((e) => e.underlying === "SPX")?.source).toBe(
      "default",
    );
    expect(payload.entries.find((e) => e.underlying === "XSP")?.source).toBe(
      "user",
    );
  });
});

describe("handleResolveRoot — debug helper", () => {
  it("returns root, underlying, source for a bundled OCC ticker", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    const out = await handleResolveRoot(
      { input: "SPXW251219C05000000" },
      r,
    );
    const payload = getJsonPayload(out);
    expect(payload).toEqual({
      root: "SPXW",
      underlying: "SPX",
      source: "default",
    });
  });

  it("returns source='identity' for unknown leveraged ETF (SPXL)", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    const out = await handleResolveRoot({ input: "SPXL" }, r);
    const payload = getJsonPayload(out);
    expect(payload).toEqual({
      root: "SPXL",
      underlying: "SPXL",
      source: "identity",
    });
  });

  it("returns source='user' for a user-registered entry", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    r.register({ underlying: "XSP", roots: ["XSP", "XSPW"] });
    const out = await handleResolveRoot({ input: "XSPW" }, r);
    const payload = getJsonPayload(out);
    expect(payload).toEqual({
      root: "XSPW",
      underlying: "XSP",
      source: "user",
    });
  });

  it("returns source='user-override' for an overridden bundled entry", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    r.register({ underlying: "SPX", roots: ["SPX", "SPXW", "SPXQ"] });
    const out = await handleResolveRoot({ input: "SPX" }, r);
    const payload = getJsonPayload(out);
    expect(payload).toEqual({
      root: "SPX",
      underlying: "SPX",
      source: "user-override",
    });
  });
});

describe("Zod schemas — T-1-02 defense layer 1", () => {
  it("rejects path-traversal in underlying", () => {
    expect(
      registerUnderlyingSchema.safeParse({
        underlying: "SPX/../etc",
        roots: ["SPX"],
      }).success,
    ).toBe(false);
  });

  it("rejects control chars (newline) in roots", () => {
    expect(
      registerUnderlyingSchema.safeParse({
        underlying: "XSP",
        roots: ["XSP\n"],
      }).success,
    ).toBe(false);
  });

  it("rejects empty roots array", () => {
    expect(
      registerUnderlyingSchema.safeParse({
        underlying: "XSP",
        roots: [],
      }).success,
    ).toBe(false);
  });

  it("rejects unregister with empty underlying", () => {
    expect(
      unregisterUnderlyingSchema.safeParse({ underlying: "" }).success,
    ).toBe(false);
  });

  it("rejects unregister with path-traversal", () => {
    expect(
      unregisterUnderlyingSchema.safeParse({ underlying: "SPX/../etc" })
        .success,
    ).toBe(false);
  });
});
