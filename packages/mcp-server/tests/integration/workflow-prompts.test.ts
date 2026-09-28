import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const packageDir = resolve(import.meta.dirname, "../..");
const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const expectedVersion =
  manifest &&
  typeof manifest === "object" &&
  "version" in manifest &&
  typeof manifest.version === "string"
    ? manifest.version
    : null;

it("exposes version, instructions, three runnable OO prompts and all existing tools through MCP", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "tb-prompts-"));
  const client = new Client({ name: "workflow-prompts-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", join(packageDir, "src/index.ts"), dataDir],
    cwd: resolve(packageDir, "../.."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    expect(expectedVersion).toBeTruthy();
    expect(info?.version).toBe(expectedVersion);
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions!.length).toBeLessThanOrEqual(2048);
    expect(instructions).toContain("Option Omega");
    expect(instructions).toContain("list_blocks");
    expect(instructions).toContain("describe_database");
    expect(instructions).toContain("block_id");
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual([
      "bring-in-oo-backtest",
      "is-this-optimum-real",
      "stress-oo-portfolio",
    ]);
    for (const name of prompts.prompts.map((p) => p.name)) {
      const result = await client.getPrompt({ name });
      expect(result.messages).toHaveLength(1);
      const text = result.messages[0].content;
      expect(text.type).toBe("text");
      if (text.type !== "text") throw new Error("Expected text prompt");
      expect(text.text).toContain("isIgnored");
      expect(text.text).toContain("never subtract fees twice");
      expect(text.text).toContain("server name");
      if (name === "bring-in-oo-backtest") {
        expect(text.text).toContain("get_trade_log");
        expect(text.text).toContain("server-readable CSV");
        expect(text.text).toContain("get_statistics");
      } else if (name === "is-this-optimum-real") {
        expect(text.text).toContain("get_optimization_results");
        expect(text.text).toContain("paired_bootstrap_comparison");
        expect(text.text).toMatch(/no\s+verdict from optimizer cells alone/);
      } else {
        expect(text.text).toContain("get_portfolio_results");
        expect(text.text).toContain("stress_test");
        expect(text.text).toContain("get_saved_portfolio");
      }
    }

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(EXISTING_TOOL_NAMES);
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

// Tool names in origin/master's configured server, before MCP prompts were introduced.
const EXISTING_TOOL_NAMES = [
  "analyze_discrepancies", "analyze_edge_decay", "analyze_exit_triggers",
  "analyze_live_alignment", "analyze_period_metrics", "analyze_regime_comparison",
  "analyze_regime_performance", "analyze_rolling_metrics", "analyze_slippage_trends",
  "analyze_structure_fit", "analyze_walk_forward_degradation", "batch_exit_analysis",
  "block_diff", "calculate_orb", "compare_backtest_to_actual", "compare_blocks",
  "compute_vix_context", "decompose_greeks", "delete_profile", "describe_database",
  "drawdown_attribution", "enrich_market_data", "enrich_trades", "fetch_bars",
  "fetch_chain", "fetch_quotes", "filter_curve", "find_predictive_fields",
  "get_backtest_help", "get_block_info", "get_correlation_matrix", "get_field_statistics",
  "get_greeks_attribution", "get_option_snapshot", "get_performance_charts",
  "get_period_returns", "get_position_sizing", "get_reporting_log_stats",
  "get_statistics", "get_strategy_comparison", "get_strategy_profile", "get_tail_risk",
  "import_csv", "import_flat_file", "import_from_database", "import_market_csv",
  "list_blocks", "list_profiles", "list_underlyings", "marginal_contribution",
  "paired_bootstrap_comparison", "portfolio_health_check", "portfolio_structure_map",
  "profile_strategy", "purge_market_table", "refresh_market_data",
  "regime_allocation_advisor", "register_underlying", "replay_trade", "resolve_root",
  "run_monte_carlo", "run_sql", "run_walk_forward", "strategy_similarity",
  "stress_test", "suggest_filters", "suggest_strategy_matches", "unregister_underlying",
  "validate_entry_filters", "what_if_scaling",
];
