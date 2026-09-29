/**
 * A tool whose input cannot be made strict is refused at registration (enterprise#4197),
 * naming the tool, rather than registered with undeclared arguments silently dropped.
 * The call-time refusal is proven over MCP in tests/integration/unknown-arguments.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// @ts-expect-error - importing from the source barrel used by the other suites
import { refuseUnknownArguments } from "../../src/test-exports.ts";

describe("refuseUnknownArguments", () => {
  it.each([
    ["a raw shape", { inputSchema: { topic: z.string() } }],
    [
      "a union",
      { inputSchema: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) },
    ],
    ["no input schema", {}],
  ])("refuses a tool registered with %s", (_label, config) => {
    const server = refuseUnknownArguments(new McpServer({ name: "t", version: "0" }));
    expect(() => server.registerTool("plugin_tool", config, async () => ({ content: [] }))).toThrow(
      /Tool "plugin_tool" cannot be registered: its inputSchema must be a Zod object/,
    );
  });
});
