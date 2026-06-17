/**
 * Ticker Registry MCP Tools (Market Data 3.0)
 *
 * Four MCP tools for CRUD operations on the underlying→roots mapping registry:
 *   - register_underlying     Create or update a user entry; persists to
 *                             {dataRoot}/market/underlyings.json (atomic write).
 *   - unregister_underlying   Remove a user entry, or revert a user-override to
 *                             the bundled default. Bundled defaults cannot be removed.
 *   - list_underlyings        Return all entries with source annotation
 *                             ('default' | 'user' | 'user-override').
 *   - resolve_root            Debug helper: returns {root, underlying, source}
 *                             for any bare-root or full OCC ticker input.
 *
 * Shared code. Wired into createServer() in src/index.ts — the registry
 * itself is storage infrastructure shared between the public and consumer
 * (private) repos.
 *
 * Security (defense in depth):
 *   Zod schemas from ../market/tickers/schemas.ts enforce the TICKER_RE whitelist
 *   on `underlying` and each `root` BEFORE any handler runs. Layer 2 (registry
 *   constructor / register) and layer 3 (writer partition-value whitelist) apply
 *   the same regex at their own boundaries.
 *
 * Singleton contract:
 *   The `TickerRegistry` instance is constructed ONCE in src/index.ts via
 *   loadRegistry(), and the same reference is passed here AND into
 *   StoreContext.tickers. Two instances would diverge on register/unregister.
 */
import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  TickerRegistry,
  TickerEntry,
} from "../market/tickers/registry.ts";
import {
  registerUnderlyingSchema,
  unregisterUnderlyingSchema,
  listUnderlyingsSchema,
  resolveRootSchema,
} from "../market/tickers/schemas.ts";
import { saveUserOverride } from "../market/tickers/loader.ts";
import { extractRoot } from "../market/tickers/resolver.ts";
import { createToolOutput, type ToolOutput } from "../utils/output-formatter.ts";

// ---------------------------------------------------------------------------
// Handlers (exported for unit testing without spinning up an MCP server)
// ---------------------------------------------------------------------------

/**
 * Handle register_underlying: create or update an entry, then persist.
 * Returns the merged entry (with computed `source`) in the JSON payload.
 */
export async function handleRegisterUnderlying(
  input: z.infer<typeof registerUnderlyingSchema>,
  registry: TickerRegistry,
  dataDir: string,
): Promise<ToolOutput> {
  const merged = registry.register(input);
  await saveUserOverride(dataDir, registry);
  return createToolOutput(
    `Registered underlying "${merged.underlying}" with ${merged.roots.length} root(s) [source=${merged.source}]`,
    { entry: merged },
  );
}

/**
 * Handle unregister_underlying: remove a user entry, or revert a user-override
 * to its bundled default. Throws clear error on bundled defaults.
 */
export async function handleUnregisterUnderlying(
  input: z.infer<typeof unregisterUnderlyingSchema>,
  registry: TickerRegistry,
  dataDir: string,
): Promise<ToolOutput> {
  registry.unregister(input.underlying);
  await saveUserOverride(dataDir, registry);
  return createToolOutput(
    `Unregistered underlying "${input.underlying}" (or reverted to bundled default if it was a user-override)`,
    { removed: input.underlying },
  );
}

/**
 * Handle list_underlyings: return all merged entries with source annotation.
 */
export async function handleListUnderlyings(
  _input: z.infer<typeof listUnderlyingsSchema>,
  registry: TickerRegistry,
): Promise<ToolOutput> {
  const entries: TickerEntry[] = registry.list();
  return createToolOutput(
    `Registry has ${entries.length} entries (defaults + user + user-override)`,
    { entries },
  );
}

/**
 * Handle resolve_root: debug helper showing how an input symbol resolves.
 * Returns {root, underlying, source} where source is one of:
 *   - 'default' | 'user' | 'user-override'  → matched a registry entry
 *   - 'identity'                            → registry miss, fell back to root
 */
export async function handleResolveRoot(
  input: z.infer<typeof resolveRootSchema>,
  registry: TickerRegistry,
): Promise<ToolOutput> {
  const root = extractRoot(input.input);
  const underlying = registry.resolve(root);
  // Determine source by consulting the registry's list. If the resolved entry's
  // root list contains this root, report its source; otherwise the resolve()
  // returned identity fallback (root === underlying), so source='identity'.
  const match = registry.list().find((e) => e.underlying === underlying);
  const source: "default" | "user" | "user-override" | "identity" =
    match && match.roots.includes(root) ? match.source : "identity";
  return createToolOutput(
    `Input "${input.input}" resolves: root="${root}" → underlying="${underlying}" [source=${source}]`,
    { root, underlying, source },
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all four ticker registry tools on the MCP server.
 *
 * @param server   - McpServer instance.
 * @param registry - The SAME TickerRegistry singleton used by every other
 *                   consumer in the process.
 * @param dataDir  - Base data directory; user override persists at
 *                   {dataDir}/market/underlyings.json.
 */
export function registerTickerTools(
  server: McpServer,
  registry: TickerRegistry,
  dataDir: string,
): void {
  server.registerTool(
    "register_underlying",
    {
      description:
        "Add or update an underlying→roots mapping in the ticker registry. " +
        "Persists to {dataRoot}/market/underlyings.json (user override layer; " +
        "bundled defaults are never modified). `underlying` is the canonical symbol " +
        "(e.g. SPX); `roots` are OCC roots that resolve to it (e.g. ['SPX','SPXW','SPXQ']). " +
        "Re-registering a bundled-default underlying creates a 'user-override' that the " +
        "registry uses in place of the default.",
      inputSchema: registerUnderlyingSchema,
    },
    async (input) => handleRegisterUnderlying(input, registry, dataDir),
  );

  server.registerTool(
    "unregister_underlying",
    {
      description:
        "Remove a user or user-override ticker entry. Bundled defaults cannot be removed; " +
        "removing a user-override reverts the entry back to its bundled default. " +
        "Persists the change to {dataRoot}/market/underlyings.json.",
      inputSchema: unregisterUnderlyingSchema,
    },
    async (input) => handleUnregisterUnderlying(input, registry, dataDir),
  );

  server.registerTool(
    "list_underlyings",
    {
      description:
        "List all ticker registry entries (bundled defaults + user-added + user-overrides). " +
        "Each entry is annotated with its source ('default' | 'user' | 'user-override'). " +
        "Bundled defaults ship with the binary; user entries live in {dataRoot}/market/underlyings.json.",
      inputSchema: listUnderlyingsSchema,
    },
    async (input) => handleListUnderlyings(input, registry),
  );

  server.registerTool(
    "resolve_root",
    {
      description:
        "Debug helper: show how a symbol resolves through the ticker registry. " +
        "Accepts bare roots ('SPXW') or full OCC tickers ('SPXW251219C05000000'). " +
        "Returns { root, underlying, source } where source is " +
        "'default' | 'user' | 'user-override' | 'identity'. Identity means the root " +
        "had no registry entry and was returned unchanged (e.g. leveraged ETFs SPXL/SPXS).",
      inputSchema: resolveRootSchema,
    },
    async (input) => handleResolveRoot(input, registry),
  );
}
