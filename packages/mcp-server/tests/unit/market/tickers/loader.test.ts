/**
 * Unit tests for the ticker-registry JSON loader.
 *
 * Covers the four behavioral paths:
 *   - Missing user file → defaults-only registry
 *   - Valid user override → merged registry with user-override / user source tags
 *   - Malformed JSON (syntactically invalid) → clear "Malformed {path}" error
 *   - Schema-invalid JSON (wrong shape / bad characters) → same error shape
 *   - Round-trip: saveUserOverride → loadRegistry re-reads user entries
 *
 * Tests will run once Plan 01-06 wires test-exports for the tickers module.
 * Until then `npm run build` must succeed and imports must compile cleanly.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadRegistry, saveUserOverride } from "../../../../src/test-exports.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../../fixtures");

let tmpDataDir: string;
beforeEach(() => {
  tmpDataDir = join(
    tmpdir(),
    `tickers-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpDataDir, "market"), { recursive: true });
});
afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("loadRegistry — missing user file", () => {
  it("returns defaults-only registry", async () => {
    const r = await loadRegistry({ dataDir: tmpDataDir });
    expect(r.resolve("SPXW")).toBe("SPX");
    expect(r.resolve("QQQX")).toBe("QQQ");
    expect(r.toJSON().underlyings).toEqual([]); // no user entries
  });
});

describe("loadRegistry — valid user override", () => {
  it("merges user entries with defaults (user-override and user tagged)", async () => {
    copyFileSync(
      join(fixturesDir, "underlyings.valid.json"),
      join(tmpDataDir, "market", "underlyings.json"),
    );
    const r = await loadRegistry({ dataDir: tmpDataDir });
    expect(r.resolve("XSPW")).toBe("XSP"); // new user entry
    expect(r.resolve("SPXCUSTOM")).toBe("SPX"); // user-override of bundled SPX
    const spx = r.list().find((e) => e.underlying === "SPX");
    expect(spx?.source).toBe("user-override");
    const xsp = r.list().find((e) => e.underlying === "XSP");
    expect(xsp?.source).toBe("user");
  });
});

describe("loadRegistry — malformed JSON (T-1-03 mitigation)", () => {
  it("throws a clear error referencing the file path; no silent fallback", async () => {
    copyFileSync(
      join(fixturesDir, "underlyings.malformed.json"),
      join(tmpDataDir, "market", "underlyings.json"),
    );
    await expect(loadRegistry({ dataDir: tmpDataDir })).rejects.toThrow(
      /Malformed .*underlyings\.json/,
    );
  });
});

describe("loadRegistry — schema-invalid JSON (Zod rejection)", () => {
  it("throws when version is missing", async () => {
    writeFileSync(
      join(tmpDataDir, "market", "underlyings.json"),
      JSON.stringify({
        underlyings: [{ underlying: "SPX", roots: ["SPX"] }],
      }),
    );
    await expect(loadRegistry({ dataDir: tmpDataDir })).rejects.toThrow(
      /Malformed .*underlyings\.json/,
    );
  });
  it("throws on bad characters in underlying (T-1-02 belt-and-braces)", async () => {
    writeFileSync(
      join(tmpDataDir, "market", "underlyings.json"),
      JSON.stringify({
        version: 1,
        underlyings: [{ underlying: "SPX/../etc", roots: ["SPX"] }],
      }),
    );
    await expect(loadRegistry({ dataDir: tmpDataDir })).rejects.toThrow(
      /Malformed .*underlyings\.json/,
    );
  });
  it("throws when entries array is missing", async () => {
    writeFileSync(join(tmpDataDir, "market", "underlyings.json"), JSON.stringify({ version: 1 }));
    await expect(loadRegistry({ dataDir: tmpDataDir })).rejects.toThrow(
      /Malformed .*underlyings\.json/,
    );
  });
});

describe("saveUserOverride — round-trip", () => {
  it("persists user entries and re-reads them via loadRegistry", async () => {
    const r1 = await loadRegistry({ dataDir: tmpDataDir });
    r1.register({ underlying: "XSP", roots: ["XSP", "XSPW"] });
    await saveUserOverride(tmpDataDir, r1);
    const r2 = await loadRegistry({ dataDir: tmpDataDir });
    expect(r2.resolve("XSPW")).toBe("XSP");
    expect(r2.list().find((e) => e.underlying === "XSP")?.source).toBe("user");
  });
  it("does not persist bundled defaults", async () => {
    const r1 = await loadRegistry({ dataDir: tmpDataDir });
    await saveUserOverride(tmpDataDir, r1);
    const r2 = await loadRegistry({ dataDir: tmpDataDir });
    // Every default entry still tagged 'default' — nothing promoted to user via persistence.
    const spx = r2.list().find((e) => e.underlying === "SPX");
    expect(spx?.source).toBe("default");
  });
});
