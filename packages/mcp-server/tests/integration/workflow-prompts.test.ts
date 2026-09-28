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

it("exposes version, instructions, five runnable OO prompts and all existing tools through MCP", async () => {
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
      "live-vs-oo",
      "allocate-oo-portfolio",
    ]);
    expect(
      Object.fromEntries(
        prompts.prompts.map((p) => [
          p.name,
          p.arguments?.map((arg) => `${arg.name}${arg.required ? "" : "?"}`),
        ]),
      ),
    ).toEqual({
      "bring-in-oo-backtest": ["ooId?", "block?"],
      "is-this-optimum-real": ["optimizationId?"],
      "stress-oo-portfolio": ["ooId?", "block?"],
      "live-vs-oo": ["block?"],
      "allocate-oo-portfolio": ["ooId?", "block?"],
    });
    for (const { name, arguments: args = [] } of prompts.prompts) {
      // MCP lets prompts/get omit arguments entirely; that must equal an empty set.
      const result = await client.getPrompt({ name });
      const withEmpty = await client.getPrompt({ name, arguments: {} });
      expect(withEmpty).toEqual(result);
      const given = Object.fromEntries(args.map((arg) => [arg.name, `given-${arg.name}`]));
      const withArgs = await client.getPrompt({ name, arguments: given });
      const withArgsText = withArgs.messages[0].content;
      if (withArgsText.type !== "text") throw new Error("Expected text prompt");
      for (const [argName, value] of Object.entries(given)) {
        expect(withArgsText.text).toContain(`${argName} = "${value}"`);
      }
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");
    }
    const allocation = prompts.prompts.find((p) => p.name === "allocate-oo-portfolio");
    expect(allocation?.arguments?.map((arg) => [arg.name, arg.required])).toEqual([
      ["ooId", false],
      ["block", false],
    ]);
    const guided = await client.getPrompt({
      name: "allocate-oo-portfolio",
      arguments: { ooId: "saved-portfolio-1", block: "book-block" },
    });
    const content = guided.messages[0].content;
    if (content.type !== "text") throw new Error("Expected text prompt");
    expect(content.text).toContain('ooId = "saved-portfolio-1"');
    expect(content.text).toContain('block = "book-block"');
    expect(content.text).toMatch(
      /run_portfolio[\s\S]*get_portfolio_status[\s\S]*get_portfolio_results/,
    );
    expect(content.text).toMatch(/complete[\s\S]*get_portfolio_results[\s\S]*OO-tested/);
    expect(content.text).toMatch(/never save|do not save/i);
    expect(content.text).toMatch(/explicitly asks[\s\S]*new portfolio/i);
    expect(content.text).toMatch(/trade-derived counterfactual/i);
    expect(content.text).toMatch(/whole-book[\s\S]*no per-member marks/i);
    expect(content.text).toContain("dailyLogPath");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(EXISTING_TOOL_NAMES);
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

// Tool names in origin/master's configured server, before MCP prompts were introduced.
const EXISTING_TOOL_NAMES = [
  "analyze_discrepancies",
  "analyze_edge_decay",
  "analyze_exit_triggers",
  "analyze_live_alignment",
  "analyze_period_metrics",
  "analyze_regime_comparison",
  "analyze_regime_performance",
  "analyze_rolling_metrics",
  "analyze_slippage_trends",
  "analyze_structure_fit",
  "analyze_walk_forward_degradation",
  "batch_exit_analysis",
  "block_diff",
  "calculate_orb",
  "compare_backtest_to_actual",
  "compare_blocks",
  "compute_vix_context",
  "decompose_greeks",
  "delete_profile",
  "describe_database",
  "drawdown_attribution",
  "enrich_market_data",
  "enrich_trades",
  "fetch_bars",
  "fetch_chain",
  "fetch_quotes",
  "filter_curve",
  "find_predictive_fields",
  "get_backtest_help",
  "get_block_info",
  "get_correlation_matrix",
  "get_field_statistics",
  "get_greeks_attribution",
  "get_option_snapshot",
  "get_performance_charts",
  "get_period_returns",
  "get_position_sizing",
  "get_reporting_log_stats",
  "get_statistics",
  "get_strategy_comparison",
  "get_strategy_profile",
  "get_tail_risk",
  "import_csv",
  "import_flat_file",
  "import_from_database",
  "import_market_csv",
  "list_blocks",
  "list_profiles",
  "list_underlyings",
  "marginal_contribution",
  "paired_bootstrap_comparison",
  "portfolio_health_check",
  "portfolio_structure_map",
  "profile_strategy",
  "purge_market_table",
  "refresh_market_data",
  "regime_allocation_advisor",
  "register_underlying",
  "replay_trade",
  "resolve_root",
  "run_monte_carlo",
  "run_sql",
  "run_walk_forward",
  "strategy_similarity",
  "stress_test",
  "suggest_filters",
  "suggest_strategy_matches",
  "unregister_underlying",
  "validate_entry_filters",
  "what_if_scaling",
];
