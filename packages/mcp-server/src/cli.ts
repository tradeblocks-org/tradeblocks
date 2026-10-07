import { readFileSync } from "node:fs";

let runtimeGuidance = "Use the Node version declared in this package's engines, with npm.";
try {
  if (process.argv[2] === "setup") {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    runtimeGuidance = `Use Node ${manifest.engines.node} with npm.`;
    const minimum = Number(manifest.engines.node.match(/^>=(\d+)$/)?.[1]);
    if (!minimum || Number(process.versions.node.split(".")[0]) < minimum) {
      const args = process.argv.slice(3);
      const result = {
        status: "prerequisite_missing",
        client: args.includes("--client") ? (args[args.indexOf("--client") + 1] ?? null) : null,
        folder: args.includes("--folder") ? (args[args.indexOf("--folder") + 1] ?? null) : null,
        plannedChange: null,
        appliedChange: null,
        verification: { initialized: false, skipped: true },
        clientActionNeeded: null,
        nextSteps: [
          `Node ${manifest.engines.node} is required. Install Node with npm from https://nodejs.org/en/download and reopen your terminal.`,
        ],
      };
      if (args.includes("--json")) console.log(JSON.stringify(result));
      else {
        console.log("Setup stopped: missing Node prerequisite.");
        for (const step of result.nextSteps) console.log(`Next: ${step}`);
      }
      process.exitCode = 1;
    } else {
      // Unsupported Node versions cannot even load readline/promises. Delay
      // loading setup until the engine check can return an actionable result.
      const { runSetup } = await import("./setup.ts");
      process.exitCode = await runSetup(process.argv.slice(3));
    }
  } else {
    // Loading the server only in server mode also keeps setup independent of
    // native/market-data initialization. The server's host interface is unchanged.
    const { startTradeBlocksMcp } = await import("./index.ts");
    await startTradeBlocksMcp();
  }
} catch (error) {
  if (process.argv[2] === "setup" && process.argv.includes("--json")) {
    console.log(
      JSON.stringify({
        status: "setup_error",
        client: null,
        folder: null,
        plannedChange: null,
        appliedChange: null,
        verification: { initialized: false, skipped: true },
        clientActionNeeded: null,
        nextSteps: [
          `Could not load setup. ${runtimeGuidance} Check the TradeBlocks installation and retry.`,
        ],
      }),
    );
  } else if (process.argv[2] === "setup")
    console.error(`Could not load setup. ${runtimeGuidance} Check the installation.`);
  else console.error("Error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
