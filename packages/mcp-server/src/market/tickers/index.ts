/**
 * Ticker registry — shared module. Ships to both public and private repos.
 *
 * Flat re-exports of:
 *   - Pure resolver helpers (resolver.ts)
 *   - TickerRegistry class + entry types (registry.ts)
 *   - JSON loader for {dataRoot}/market/underlyings.json (loader.ts)
 *   - Zod schemas for file + MCP-tool input validation (schemas.ts)
 */
export { extractRoot, rootToUnderlying } from "./resolver.js";
export { TickerRegistry } from "./registry.js";
export type { TickerEntry, EntrySource } from "./registry.js";
export {
  UnderlyingsFileSchema,
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
  listUnderlyingsSchema,
  resolveRootSchema,
  TICKER_RE,
} from "./schemas.js";
export { loadRegistry, saveUserOverride } from "./loader.js";
