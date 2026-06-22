/**
 * Unit tests for TickerRegistry — construction, CRUD, source-tagging, and
 * defense-in-depth regex validation (T-1-02 layer 2).
 *
 * Tests will run once Plan 01-06 wires test-exports for the tickers module.
 * Until then `npm run build` must succeed and imports must compile cleanly.
 */
import { describe, it, expect } from "@jest/globals";
import { TickerRegistry } from "../../../../src/test-exports.ts";

const defaults = [
  { underlying: "SPX", roots: ["SPX", "SPXW", "SPXQ"] },
  { underlying: "QQQ", roots: ["QQQ", "QQQX"] },
];

describe("TickerRegistry — construction from defaults", () => {
  it("resolves bundled roots", () => {
    const r = new TickerRegistry(defaults);
    expect(r.resolve("SPXW")).toBe("SPX");
    expect(r.resolve("QQQX")).toBe("QQQ");
  });
  it("identity-returns unknown root", () => {
    const r = new TickerRegistry(defaults);
    expect(r.resolve("SPXL")).toBe("SPXL");
  });
  it("tags bundled entries source='default'", () => {
    const r = new TickerRegistry(defaults);
    const spx = r.list().find((e) => e.underlying === "SPX");
    expect(spx?.source).toBe("default");
  });
});

describe("TickerRegistry — register", () => {
  it("adds a new user entry with source='user'", () => {
    const r = new TickerRegistry(defaults);
    const entry = r.register({ underlying: "XSP", roots: ["XSP", "XSPW"] });
    expect(entry.source).toBe("user");
    expect(r.resolve("XSPW")).toBe("XSP");
  });
  it("overriding a default yields source='user-override'", () => {
    const r = new TickerRegistry(defaults);
    const entry = r.register({
      underlying: "SPX",
      roots: ["SPX", "SPXW", "SPXQ", "SPXNEW"],
    });
    expect(entry.source).toBe("user-override");
    expect(r.resolve("SPXNEW")).toBe("SPX");
  });
  it("clears stale root mappings when roots are removed in update", () => {
    const r = new TickerRegistry(defaults);
    // Override SPX to drop SPXQ from its roots.
    r.register({ underlying: "SPX", roots: ["SPX", "SPXW"] });
    expect(r.resolve("SPXQ")).toBe("SPXQ"); // identity — no longer mapped
    expect(r.resolve("SPXW")).toBe("SPX");
  });
});

describe("TickerRegistry — unregister semantics", () => {
  it("throws on bundled default", () => {
    const r = new TickerRegistry(defaults);
    expect(() => r.unregister("SPX")).toThrow(/cannot unregister bundled default/);
  });
  it("removes pure user entry", () => {
    const r = new TickerRegistry(defaults);
    r.register({ underlying: "XSP", roots: ["XSP"] });
    r.unregister("XSP");
    expect(r.list().some((e) => e.underlying === "XSP")).toBe(false);
    expect(r.resolve("XSP")).toBe("XSP"); // identity fallback
  });
  it("reverts user-override to bundled default", () => {
    const r = new TickerRegistry(defaults);
    r.register({ underlying: "SPX", roots: ["SPX", "SPXNEW"] });
    r.unregister("SPX");
    const spx = r.list().find((e) => e.underlying === "SPX");
    expect(spx?.source).toBe("default");
    expect(spx?.roots).toEqual(["SPX", "SPXW", "SPXQ"]);
    expect(r.resolve("SPXNEW")).toBe("SPXNEW"); // identity — no longer mapped
    expect(r.resolve("SPXW")).toBe("SPX"); // bundled root restored
  });
  it("throws on unknown underlying", () => {
    const r = new TickerRegistry(defaults);
    expect(() => r.unregister("NONEXISTENT")).toThrow(/unknown underlying/);
  });
});

describe("TickerRegistry — toJSON", () => {
  it("emits only user + user-override, never bundled defaults", () => {
    const r = new TickerRegistry(defaults);
    r.register({ underlying: "XSP", roots: ["XSP"] });
    r.register({ underlying: "QQQ", roots: ["QQQ", "QQQX", "QQQZ"] });
    const json = r.toJSON();
    expect(json.version).toBe(1);
    const undKeys = json.underlyings.map((u) => u.underlying).sort();
    expect(undKeys).toEqual(["QQQ", "XSP"]); // SPX remains bundled default; excluded
  });
  it("emits empty underlyings when no user entries exist", () => {
    const r = new TickerRegistry(defaults);
    expect(r.toJSON().underlyings).toEqual([]);
  });
});

describe("TickerRegistry — regex validation (T-1-02 defense layer 2)", () => {
  it("rejects path-traversal in underlying", () => {
    const r = new TickerRegistry(defaults);
    expect(() => r.register({ underlying: "SPX/../etc", roots: ["SPX"] })).toThrow(
      /invalid underlying/,
    );
    expect(() => r.register({ underlying: "..", roots: ["X"] })).toThrow(/invalid underlying/);
  });
  it("rejects control chars / whitespace in roots", () => {
    const r = new TickerRegistry(defaults);
    expect(() => r.register({ underlying: "XSP", roots: ["XSP\n"] })).toThrow(/invalid root/);
    expect(() => r.register({ underlying: "XSP", roots: ["XS P"] })).toThrow(/invalid root/);
  });
  it("rejects malformed defaults at construction time", () => {
    expect(() => new TickerRegistry([{ underlying: "SPX/../etc", roots: ["SPX"] }])).toThrow(
      /invalid underlying/,
    );
  });
});
