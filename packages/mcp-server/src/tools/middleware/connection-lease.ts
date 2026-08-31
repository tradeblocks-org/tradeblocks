/**
 * Connection-lease middleware (#445)
 *
 * The analytics database allows many readers but no writer alongside them, so a
 * server that parks its read-only handle for its whole lifetime blocks every write
 * in every other server sharing the data directory — even while it is idle. The
 * handle is therefore leased: held while work is in flight, closed shortly after the
 * last lease drops. See the lock matrix in db/connection.ts.
 *
 * A lease has to cover a whole tool call, because tool handlers legitimately hold a
 * connection reference across awaits. Rather than ask 70 registration sites and
 * ~40 getConnection callers to bracket themselves — a contract that would be broken
 * by the first tool added without reading this file — the lease is taken in ONE
 * place: every handler passed to `server.registerTool` is wrapped here.
 *
 * `leaseToolHandlers` wraps the server object once, immediately after construction
 * and before anything registers, so core tools and plugin tools are both covered
 * with no per-tool opt-in.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withConnectionLease } from "../../db/connection.ts";

/** A tool handler as the SDK passes it: unknown args, possibly-async result. */
type ToolHandler = (...handlerArgs: unknown[]) => unknown;

/**
 * Wrap an McpServer so every tool registered on it runs inside a connection lease.
 *
 * Returns a proxy. Only `registerTool` is intercepted; every other property and
 * method passes through to the real server untouched.
 *
 * Apply this BEFORE any registration — a tool registered on the unwrapped server
 * gets no lease, and the failure mode is a released handle mid-call rather than
 * anything that shows up at registration time.
 */
export function leaseToolHandlers(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver);
      }
      return function registerToolWithLease(...args: unknown[]): unknown {
        // The SDK's shape is registerTool(name, config, handler) — the handler is
        // last across every overload. Anything else is passed through unchanged
        // rather than guessed at, so an SDK signature change degrades to "no
        // lease" instead of a corrupted registration.
        const handlerIndex = args.length - 1;
        const handler = args[handlerIndex];
        if (typeof handler === "function") {
          const original = handler as ToolHandler;
          args[handlerIndex] = (...handlerArgs: unknown[]) =>
            withConnectionLease(async () => await original(...handlerArgs));
        }
        // Reflect.apply keeps `this` bound to the real server; calling
        // target.registerTool(...) directly would lose it.
        return Reflect.apply(target.registerTool as ToolHandler, target, args);
      };
    },
  });
}
