/**
 * TickerRegistry — in-memory map keyed by underlying.
 *
 * Seeded from bundled defaults (defaults.json). User-added entries via register()
 * persist to {dataRoot}/market/underlyings.json via saveUserOverride (loader.ts).
 *
 * `src/market/stores/types.ts` imports `TickerRegistry`, `TickerEntry`, and
 * `EntrySource` as types — keep those exported names stable.
 *
 * Defense-in-depth: every stored value is validated against TICKER_RE at
 * construction and at register() time. The MCP-tool layer applies the same
 * regex at the Zod boundary; the writer applies its own whitelist at the
 * partition-value boundary. Each layer is independently sufficient; together
 * they prevent malformed/injected ticker strings from reaching DuckDB.
 */
import { TICKER_RE } from "./schemas.js";

export type EntrySource = "default" | "user" | "user-override";

export interface TickerEntry {
  underlying: string;
  roots: string[];
  source: EntrySource;
}

function validate(underlying: string, roots: string[]): void {
  if (!TICKER_RE.test(underlying)) {
    throw new Error(
      `TickerRegistry: invalid underlying "${underlying}" — must match ${TICKER_RE.source}`,
    );
  }
  for (const r of roots) {
    if (!TICKER_RE.test(r)) {
      throw new Error(
        `TickerRegistry: invalid root "${r}" — must match ${TICKER_RE.source}`,
      );
    }
  }
}

export class TickerRegistry {
  private rootMap: Map<string, { underlying: string; source: EntrySource }> =
    new Map();
  private entries: Map<string, TickerEntry> = new Map();
  // Preserved so unregister('user-override') can revert to the bundled default.
  private readonly bundledDefaults: ReadonlyMap<string, ReadonlyArray<string>>;

  constructor(
    defaults: Array<{ underlying: string; roots: string[] }>,
    userOverrides: Array<{ underlying: string; roots: string[] }> = [],
  ) {
    const bundled = new Map<string, ReadonlyArray<string>>();
    for (const e of defaults) {
      validate(e.underlying, e.roots);
      bundled.set(e.underlying, [...e.roots]);
      this.entries.set(e.underlying, {
        underlying: e.underlying,
        roots: [...e.roots],
        source: "default",
      });
      for (const r of e.roots) {
        this.rootMap.set(r, { underlying: e.underlying, source: "default" });
      }
    }
    this.bundledDefaults = bundled;
    for (const e of userOverrides) {
      validate(e.underlying, e.roots);
      const source: EntrySource = bundled.has(e.underlying)
        ? "user-override"
        : "user";
      // Clear stale root mappings that previously pointed at this underlying.
      for (const [r, v] of [...this.rootMap]) {
        if (v.underlying === e.underlying) this.rootMap.delete(r);
      }
      this.entries.set(e.underlying, {
        underlying: e.underlying,
        roots: [...e.roots],
        source,
      });
      for (const r of e.roots) {
        this.rootMap.set(r, { underlying: e.underlying, source });
      }
    }
  }

  /**
   * Resolve a root symbol to its underlying.
   * Identity fallback (returns the root unchanged) when unknown — unknown
   * roots are treated as their own underlying so single-symbol tickers
   * (e.g. leveraged ETFs) keep working without explicit registration.
   */
  resolve(root: string): string {
    return this.rootMap.get(root)?.underlying ?? root;
  }

  /**
   * Add or update an underlying entry.
   * - New underlying (not a bundled default): source = "user"
   * - Overriding a bundled default: source = "user-override"
   *
   * @throws on invalid characters in `underlying` or any `root` (defense-in-depth — see file header).
   */
  register(entry: { underlying: string; roots: string[] }): TickerEntry {
    validate(entry.underlying, entry.roots);
    const isDefault = this.bundledDefaults.has(entry.underlying);
    const source: EntrySource = isDefault ? "user-override" : "user";
    // Clear stale root mappings that previously pointed at this underlying.
    for (const [r, v] of [...this.rootMap]) {
      if (v.underlying === entry.underlying) this.rootMap.delete(r);
    }
    const merged: TickerEntry = {
      underlying: entry.underlying,
      roots: [...entry.roots],
      source,
    };
    this.entries.set(entry.underlying, merged);
    for (const r of entry.roots) {
      this.rootMap.set(r, { underlying: entry.underlying, source });
    }
    return merged;
  }

  /**
   * Remove a user entry, or revert a user-override to its bundled default.
   * Bundled defaults cannot be removed.
   *
   * @throws on unknown underlying or when attempting to remove a bundled default.
   */
  unregister(underlying: string): void {
    const entry = this.entries.get(underlying);
    if (!entry) {
      throw new Error(
        `TickerRegistry.unregister: unknown underlying "${underlying}"`,
      );
    }
    if (entry.source === "default") {
      throw new Error(
        `TickerRegistry.unregister: cannot unregister bundled default "${underlying}"`,
      );
    }
    // If it was a user-override of a default, revert to the bundled default.
    if (
      entry.source === "user-override" &&
      this.bundledDefaults.has(underlying)
    ) {
      const defaultRoots = [...(this.bundledDefaults.get(underlying) ?? [])];
      for (const [r, v] of [...this.rootMap]) {
        if (v.underlying === underlying) this.rootMap.delete(r);
      }
      this.entries.set(underlying, {
        underlying,
        roots: defaultRoots,
        source: "default",
      });
      for (const r of defaultRoots) {
        this.rootMap.set(r, { underlying, source: "default" });
      }
      return;
    }
    // Pure user entry — remove entirely.
    this.entries.delete(underlying);
    for (const [r, v] of [...this.rootMap]) {
      if (v.underlying === underlying) this.rootMap.delete(r);
    }
  }

  /** Return all entries (defaults + user + user-override) as defensive copies. */
  list(): TickerEntry[] {
    return Array.from(this.entries.values()).map((e) => ({
      ...e,
      roots: [...e.roots],
    }));
  }

  /**
   * Serialize ONLY user + user-override entries.
   * Bundled defaults are NEVER persisted — they live in defaults.json and ship with the binary.
   */
  toJSON(): {
    version: 1;
    underlyings: Array<{ underlying: string; roots: string[] }>;
  } {
    const persisted = this.list().filter(
      (e) => e.source === "user" || e.source === "user-override",
    );
    return {
      version: 1,
      underlyings: persisted.map((e) => ({
        underlying: e.underlying,
        roots: [...e.roots],
      })),
    };
  }
}
