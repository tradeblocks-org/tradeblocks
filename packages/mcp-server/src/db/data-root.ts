/**
 * Data Root Directory Override
 *
 * When --data-root is set, shared data (market/, market-meta/, strategies/, blocks/)
 * lives under this path instead of alongside DuckDB files.
 *
 * Set via --data-root CLI flag or TRADEBLOCKS_DATA_ROOT env var.
 * When not set, getDataRoot() falls back to its argument (backward compat).
 *
 * Stored on globalThis so all bundle instances in the same process share state.
 * tsup duplicates this module across separate bundles; a module-scoped variable
 * would give each bundle its own _dataRoot, leaving one path correct (set by
 * the CLI parser) and the other null (a consumer reads its own copy and falls
 * back to the default → wrong path).
 *
 * Note: globalThis is per-realm. Consumers running this across Workers, VM
 * contexts, or sandboxed iframes will see the same divergence across realm
 * boundaries and must coordinate state another way.
 */
import path from "node:path";

const KEY = "__tradeblocks_data_root__";
type GlobalSlot = { [KEY]?: string | null };

/**
 * The DuckDB files that live under a data root's `database/` subdirectory.
 *   - `analytics` — the base DB hosting the `trades` schema (CSV-imported blocks)
 *   - `market`    — attached market data (`market.duckdb`)
 *   - `backtests` — the backtest run-persistence index (`backtests.duckdb`)
 */
export type DbKind = "analytics" | "market" | "backtests";

/**
 * Single source of truth for where a DuckDB file lives under a data root:
 * `<dataRoot>/database/<kind>.duckdb`. Every writer and reader across the fleet
 * (the engine's backtests-db resolver, the console reader, the calibration
 * probe) MUST resolve through this so the `database/` segment can never drift —
 * a missing segment silently splits reads from writes (runs succeed, the console
 * shows an empty history forever). See tradeblocks-org/enterprise#983.
 */
export function resolveDbPath(dataRoot: string, kind: DbKind): string {
  return path.join(dataRoot, "database", `${kind}.duckdb`);
}

export function setDataRoot(dir: string): void {
  (globalThis as GlobalSlot)[KEY] = dir;
}

export function getDataRoot(fallback: string): string {
  return (globalThis as GlobalSlot)[KEY] ?? fallback;
}

/** Reset for testing. Not used in production. */
export function resetDataRoot(): void {
  (globalThis as GlobalSlot)[KEY] = null;
}
