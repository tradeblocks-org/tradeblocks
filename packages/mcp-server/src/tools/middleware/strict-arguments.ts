/**
 * Unknown-argument refusal (enterprise#4197)
 *
 * A plain Zod object strips keys it does not declare, so a client sending an option
 * this server does not support (a newer plugin's `dailyLogPath` sent to an older
 * server, say) got a successful call with the option silently ignored. Every tool's
 * input object is made strict here, where all tools register, so an undeclared
 * top-level argument fails the SDK's own input validation before the handler runs:
 * `Input validation error: Invalid arguments for tool <name>: Unrecognized key: "<key>"`.
 * Nested objects keep their own rules.
 *
 * The supported registration is `registerTool(name, { inputSchema: z.object(...) }, handler)`.
 * Any other input schema (a raw shape, a union, none at all) cannot be made strict,
 * so its registration is refused, naming the tool, rather than accepted with the
 * silent drop this exists to remove. The SDK's legacy `tool()` registration is refused
 * for the same reason. A schema replaced later through the returned handle's
 * `update({ paramsSchema })` is not made strict.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wrap an McpServer so every tool registered on it refuses undeclared arguments.
 *
 * Returns a proxy. Only `registerTool` and the legacy `tool` are intercepted; every
 * other property and method passes through to the real server untouched.
 */
export function refuseUnknownArguments(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return function refuseLegacyTool(name: unknown): never {
          throw new Error(
            `Tool "${String(name)}" cannot be registered with server.tool(): use registerTool ` +
              `with a Zod object inputSchema so undeclared arguments are refused rather than ignored.`,
          );
        };
      }
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver);
      }
      return function registerToolWithStrictArguments(...args: unknown[]): unknown {
        const [name, config] = args;
        // A Zod object, in either major version, is the only schema with `strict()`.
        const inputSchema =
          config && typeof config === "object" && "inputSchema" in config
            ? config.inputSchema
            : undefined;
        if (
          !config ||
          typeof config !== "object" ||
          !inputSchema ||
          typeof inputSchema !== "object" ||
          !("strict" in inputSchema) ||
          typeof inputSchema.strict !== "function"
        ) {
          throw new Error(
            `Tool "${String(name)}" cannot be registered: its inputSchema must be a Zod object ` +
              `(z.object) so undeclared arguments are refused rather than ignored.`,
          );
        }
        args[1] = { ...config, inputSchema: inputSchema.strict() };
        return Reflect.apply(target.registerTool, target, args);
      };
    },
  });
}
