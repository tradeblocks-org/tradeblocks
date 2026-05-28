/**
 * Ticker registry — shared module. Ships to both public and private repos.
 *
 * Flat re-exports of:
 *   - Pure resolver helpers (resolver.ts)
 *   - TickerRegistry class + entry types (registry.ts)
 *   - JSON loader for {dataRoot}/market/underlyings.json (loader.ts)
 *   - Zod schemas for file + MCP-tool input validation (schemas.ts)
 */
export { extractRoot, rootToUnderlying } from "./resolver.ts";
export { TickerRegistry } from "./registry.ts";
export type { TickerEntry, EntrySource } from "./registry.ts";
export {
  UnderlyingsFileSchema,
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
  listUnderlyingsSchema,
  resolveRootSchema,
  TICKER_RE,
} from "./schemas.ts";
export { loadRegistry, saveUserOverride } from "./loader.ts";
