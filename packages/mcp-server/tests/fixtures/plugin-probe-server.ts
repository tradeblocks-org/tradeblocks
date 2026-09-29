// The production stdio server with one TradeBlocksPlugin tool, so tests reach plugin
// registration through startTradeBlocksMcp exactly as a plugin host does.
import { z } from "zod";
import { startTradeBlocksMcp } from "../../src/index.ts";

await startTradeBlocksMcp({
  plugins: [
    {
      name: "probe",
      registerTools(server) {
        server.registerTool(
          "plugin_probe",
          {
            description: "Test plugin tool",
            inputSchema: z.object({ value: z.string().optional() }),
          },
          async ({ value }) => ({ content: [{ type: "text", text: `ran ${value ?? ""}` }] }),
        );
      },
    },
  ],
});
