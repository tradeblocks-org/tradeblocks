/**
 * Integration tests for Strategy Profile MCP Tools
 *
 * Tests the four profile tool handlers: profile_strategy, get_strategy_profile,
 * list_profiles, and delete_profile. Exercises handler logic, CRUD operations,
 * and output formatting.
 *
 * Requirements covered:
 *   PROF-01: profile_strategy creates/updates profiles
 *   PROF-02: get_strategy_profile retrieves profiles
 *   PROF-03: list_profiles returns summary rows with optional block filter
 */
import * as path from "path";
import * as fs from "fs/promises";
import { tmpdir } from "os";

// @ts-expect-error - importing from bundled output
import {
  getConnection,
  closeConnection,
  handleProfileStrategy,
  handleGetStrategyProfile,
  handleListProfiles,
  handleDeleteProfile,
  profileStrategySchema,
} from "../../src/test-exports.ts";

/**
 * Create a minimal valid profile input for testing.
 */
function makeProfileInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blockId: "test-block-1",
    strategyName: "Test Iron Condor",
    structureType: "iron_condor",
    greeksBias: "theta_positive",
    thesis: "Sell premium in low-vol environments",
    legs: [
      { type: "short_put", strike: "5-delta", expiry: "same-day", quantity: -1 },
      { type: "long_put", strike: "2-delta", expiry: "same-day", quantity: 1 },
      { type: "short_call", strike: "5-delta", expiry: "same-day", quantity: -1 },
      { type: "long_call", strike: "2-delta", expiry: "same-day", quantity: 1 },
    ],
    entryFilters: [{ field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" }],
    exitRules: [
      { type: "stop_loss", trigger: "200% of credit" },
      { type: "profit_target", trigger: "50% of max profit" },
    ],
    expectedRegimes: ["low_vol", "range_bound"],
    keyMetrics: { expectedWinRate: 0.85, targetPremium: 1.5 },
    positionSizing: {
      method: "pct_of_portfolio",
      allocationPct: 5,
      maxContracts: 10,
      maxOpenPositions: 3,
    },
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), "profile-tools-test-"));
  // Open connection to initialize DB schemas
  await getConnection(tempDir);
});

afterEach(async () => {
  await closeConnection();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("profile_strategy tool", () => {
  it("creates a new profile and returns the full stored profile", async () => {
    const input = makeProfileInput();
    const result = await handleProfileStrategy(input, tempDir);

    // Result should have content array with text summary and JSON resource
    expect(result.content).toBeDefined();
    expect(result.content.length).toBe(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Profile saved");
    expect(result.content[0].text).toContain("Test Iron Condor");

    // Parse the JSON resource
    const jsonContent = result.content[1];
    expect(jsonContent.type).toBe("resource");
    const data = JSON.parse(jsonContent.resource.text);
    expect(data.profile).toBeDefined();
    expect(data.profile.blockId).toBe("test-block-1");
    expect(data.profile.strategyName).toBe("Test Iron Condor");
    expect(data.profile.structureType).toBe("iron_condor");
    expect(data.profile.greeksBias).toBe("theta_positive");
    expect(data.profile.legs).toHaveLength(4);
    expect(data.profile.entryFilters).toHaveLength(1);
    expect(data.profile.exitRules).toHaveLength(2);
    expect(data.profile.expectedRegimes).toEqual(["low_vol", "range_bound"]);
    expect(data.profile.keyMetrics.expectedWinRate).toBe(0.85);
    expect(data.profile.positionSizing).toBeDefined();
    expect(data.profile.positionSizing.method).toBe("pct_of_portfolio");
    expect(data.profile.positionSizing.allocationPct).toBe(5);
    expect(data.profile.positionSizing.maxContracts).toBe(10);
    expect(data.profile.positionSizing.maxOpenPositions).toBe(3);
    expect(data.profile.createdAt).toBeDefined();
    expect(data.profile.updatedAt).toBeDefined();
  });

  it("upserts an existing profile and returns updated values", async () => {
    const input = makeProfileInput();
    await handleProfileStrategy(input, tempDir);

    // Update with new thesis and structure type
    const updated = makeProfileInput({
      thesis: "Updated thesis for high vol",
      structureType: "reverse_iron_condor",
      greeksBias: "vega_negative",
    });
    const result = await handleProfileStrategy(updated, tempDir);

    const data = JSON.parse(result.content[1].resource.text);
    expect(data.profile.thesis).toBe("Updated thesis for high vol");
    expect(data.profile.structureType).toBe("reverse_iron_condor");
    expect(data.profile.greeksBias).toBe("vega_negative");
    // Original fields should be overwritten
    expect(data.profile.blockId).toBe("test-block-1");
    expect(data.profile.strategyName).toBe("Test Iron Condor");
  });

  it("creates a profile without positionSizing (optional field)", async () => {
    const input = makeProfileInput();
    delete (input as Record<string, unknown>).positionSizing;
    const result = await handleProfileStrategy(input, tempDir);

    const data = JSON.parse(result.content[1].resource.text);
    expect(data.profile.blockId).toBe("test-block-1");
    expect(data.profile.positionSizing).toBeUndefined();
  });
});

describe("get_strategy_profile tool", () => {
  it("retrieves an existing profile with all fields intact (JSON round-trip)", async () => {
    // Create a profile first
    const input = makeProfileInput();
    await handleProfileStrategy(input, tempDir);

    // Retrieve it
    const result = await handleGetStrategyProfile(
      { blockId: "test-block-1", strategyName: "Test Iron Condor" },
      tempDir,
    );

    expect(result.content[0].text).toContain("Test Iron Condor");
    const data = JSON.parse(result.content[1].resource.text);
    expect(data.profile).not.toBeNull();
    expect(data.profile.blockId).toBe("test-block-1");
    expect(data.profile.strategyName).toBe("Test Iron Condor");
    expect(data.profile.thesis).toBe("Sell premium in low-vol environments");
    expect(data.profile.legs).toHaveLength(4);
    expect(data.profile.legs[0].type).toBe("short_put");
    expect(data.profile.entryFilters[0].field).toBe("VIX_Close");
    expect(data.profile.exitRules[0].type).toBe("stop_loss");
    expect(data.profile.keyMetrics.targetPremium).toBe(1.5);
  });

  it("returns not-found message for nonexistent profile", async () => {
    const result = await handleGetStrategyProfile(
      { blockId: "no-such-block", strategyName: "No Such Strategy" },
      tempDir,
    );

    expect(result.content[0].text).toContain("No profile found");
    expect(result.content[0].text).toContain("No Such Strategy");
    const data = JSON.parse(result.content[1].resource.text);
    expect(data.profile).toBeNull();
  });
});

describe("list_profiles tool", () => {
  it("returns only the specified block profiles with summary format", async () => {
    // Create profiles in two different blocks
    await handleProfileStrategy(makeProfileInput({ blockId: "block-A" }), tempDir);
    await handleProfileStrategy(
      makeProfileInput({ blockId: "block-B", strategyName: "Calendar Spread" }),
      tempDir,
    );

    const result = await handleListProfiles({ blockId: "block-A" }, tempDir);

    const data = JSON.parse(result.content[1].resource.text);
    expect(data.count).toBe(1);
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].blockId).toBe("block-A");
    expect(data.profiles[0].strategyName).toBe("Test Iron Condor");
    expect(data.profiles[0].structureType).toBe("iron_condor");
    expect(data.profiles[0].greeksBias).toBe("theta_positive");
    expect(data.profiles[0].positionSizing).toBe("pct_of_portfolio");
    expect(data.profiles[0].updatedAt).toBeDefined();
    // Summary rows should NOT include full profile details (no legs, entryFilters, etc.)
    expect(data.profiles[0].legs).toBeUndefined();
    expect(data.profiles[0].thesis).toBeUndefined();
  });

  it("returns all profiles across blocks when blockId is omitted", async () => {
    await handleProfileStrategy(makeProfileInput({ blockId: "block-A" }), tempDir);
    await handleProfileStrategy(
      makeProfileInput({ blockId: "block-B", strategyName: "Calendar Spread" }),
      tempDir,
    );
    await handleProfileStrategy(
      makeProfileInput({ blockId: "block-A", strategyName: "Butterfly" }),
      tempDir,
    );

    const result = await handleListProfiles({}, tempDir);

    expect(result.content[0].text).toContain("3 profile(s)");
    const data = JSON.parse(result.content[1].resource.text);
    expect(data.count).toBe(3);
    expect(data.profiles).toHaveLength(3);
    // Should be sorted by block_id, strategy_name
    const blockIds = data.profiles.map((p: Record<string, string>) => p.blockId);
    expect(blockIds).toContain("block-A");
    expect(blockIds).toContain("block-B");
  });
});

describe("delete_profile tool", () => {
  it("removes an existing profile and returns deleted: true", async () => {
    await handleProfileStrategy(makeProfileInput(), tempDir);

    const result = await handleDeleteProfile(
      { blockId: "test-block-1", strategyName: "Test Iron Condor" },
      tempDir,
    );

    expect(result.content[0].text).toContain("Deleted profile");
    const data = JSON.parse(result.content[1].resource.text);
    expect(data.deleted).toBe(true);

    // Verify profile is gone
    const getResult = await handleGetStrategyProfile(
      { blockId: "test-block-1", strategyName: "Test Iron Condor" },
      tempDir,
    );
    const getData = JSON.parse(getResult.content[1].resource.text);
    expect(getData.profile).toBeNull();
  });

  it("returns deleted: false for nonexistent profile (idempotent)", async () => {
    const result = await handleDeleteProfile(
      { blockId: "no-block", strategyName: "No Strategy" },
      tempDir,
    );

    expect(result.content[0].text).toContain("nothing to delete");
    const data = JSON.parse(result.content[1].resource.text);
    expect(data.deleted).toBe(false);
  });
});

describe("Zod schema validation", () => {
  it("validates and applies defaults for profile_strategy input", () => {
    // Minimal input with only required fields
    const minimal = {
      blockId: "block-1",
      strategyName: "Test",
      structureType: "iron_condor",
      greeksBias: "theta_positive",
    };
    const parsed = profileStrategySchema.parse(minimal);
    expect(parsed.thesis).toBe("");
    expect(parsed.legs).toEqual([]);
    expect(parsed.entryFilters).toEqual([]);
    expect(parsed.exitRules).toEqual([]);
    expect(parsed.expectedRegimes).toEqual([]);
    expect(parsed.keyMetrics).toEqual({});
  });
});
