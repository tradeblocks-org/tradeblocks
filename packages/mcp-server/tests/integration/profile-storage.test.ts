/**
 * Integration tests for Strategy Profile Storage Layer
 *
 * Tests DDL creation, CRUD operations, composite key semantics, upsert overwrite,
 * JSON round-trip, and support for diverse Option Omega strategy types.
 *
 * Requirements covered:
 *   STOR-01: Full schema creation with all required columns
 *   STOR-02: Composite key (block_id, strategy_name) coexistence and upsert semantics
 *   STOR-03: All Option Omega strategy types stored without schema changes
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';

// @ts-expect-error - importing from bundled output
import {
  getConnection,
  closeConnection,
  upgradeToReadWrite,
  upsertProfile,
  getProfile,
  listProfiles,
  deleteProfile,
} from '../../src/test-exports.ts';

// Import type for test fixture typing only
// @ts-expect-error - importing from bundled output
import type { StrategyProfile } from '../../src/test-exports.ts';

/**
 * Create a minimal valid StrategyProfile for testing.
 * All fields are populated; pass overrides to customize specific tests.
 */
function makeProfile(
  overrides: Partial<Omit<StrategyProfile, 'createdAt' | 'updatedAt'>> = {}
): Omit<StrategyProfile, 'createdAt' | 'updatedAt'> {
  return {
    blockId: 'test-block-1',
    strategyName: 'Test Iron Condor',
    structureType: 'iron_condor',
    greeksBias: 'theta_positive',
    thesis: 'Sell premium in low-vol environments',
    legs: [
      { type: 'short_put', strike: '10-delta', expiry: 'same-day', quantity: -1 },
      { type: 'long_put', strike: '5-delta', expiry: 'same-day', quantity: 1 },
      { type: 'short_call', strike: '10-delta', expiry: 'same-day', quantity: -1 },
      { type: 'long_call', strike: '5-delta', expiry: 'same-day', quantity: 1 },
    ],
    entryFilters: [
      { field: 'VIX_Close', operator: '<', value: 20, description: 'Low vol environment' },
    ],
    exitRules: [
      { type: 'profit_target', trigger: '50% of credit' },
      { type: 'stop_loss', trigger: '200% of credit' },
    ],
    expectedRegimes: ['low_vol', 'neutral_trend'],
    keyMetrics: { expectedWinRate: 0.75, targetPremium: 150, maxLoss: 350 },
    positionSizing: {
      method: 'pct_of_portfolio',
      allocationPct: 5,
      maxContracts: 10,
      maxOpenPositions: 3,
    },
    ...overrides,
  };
}

describe('Profile Storage Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create isolated temp directory for each test
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'profile-test-'));
    // Pre-open connection in RW mode — getConnection() downgrades to RO after init,
    // but profile tests need write access for INSERT operations
    await getConnection(testDir);
    await upgradeToReadWrite(testDir);
  });

  afterEach(async () => {
    // Close DuckDB connection to release file lock
    await closeConnection();
    // Clean up temp directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Test 1: DDL — table creation
  it('creates profiles.strategy_profiles table on connection open', async () => {
    const conn = await getConnection(testDir);

    const result = await conn.runAndReadAll(
      `SELECT table_name FROM duckdb_tables()
       WHERE schema_name = 'profiles' AND table_name = 'strategy_profiles'`
    );

    expect(result.getRows().length).toBe(1);
  });

  // Test 2: Insert and retrieve — full field round-trip including JSON columns
  it('inserts and retrieves a profile with all fields intact', async () => {
    const conn = await getConnection(testDir);
    const input = makeProfile();

    const stored = await upsertProfile(conn, input);

    expect(stored.blockId).toBe(input.blockId);
    expect(stored.strategyName).toBe(input.strategyName);
    expect(stored.structureType).toBe(input.structureType);
    expect(stored.greeksBias).toBe(input.greeksBias);
    expect(stored.thesis).toBe(input.thesis);
    expect(stored.legs).toEqual(input.legs);
    expect(stored.entryFilters).toEqual(input.entryFilters);
    expect(stored.exitRules).toEqual(input.exitRules);
    expect(stored.expectedRegimes).toEqual(input.expectedRegimes);
    expect(stored.keyMetrics).toEqual(input.keyMetrics);
    expect(stored.positionSizing).toEqual(input.positionSizing);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toBeInstanceOf(Date);

    // Verify via getProfile as well
    const fetched = await getProfile(conn, input.blockId, input.strategyName);
    expect(fetched).not.toBeNull();
    expect(fetched!.strategyName).toBe(input.strategyName);
    expect(fetched!.legs).toEqual(input.legs);
    expect(fetched!.entryFilters).toEqual(input.entryFilters);
    expect(fetched!.keyMetrics).toEqual(input.keyMetrics);
    expect(fetched!.positionSizing).toEqual(input.positionSizing);
  });

  // Test 3: Composite key — two strategies, same block (STOR-02)
  it('stores two profiles with same blockId but different strategyName without collision', async () => {
    const conn = await getConnection(testDir);

    const profile1 = makeProfile({ strategyName: 'Iron Condor' });
    const profile2 = makeProfile({
      strategyName: 'Calendar Spread',
      structureType: 'calendar_spread',
      greeksBias: 'vega_positive',
    });

    await upsertProfile(conn, profile1);
    await upsertProfile(conn, profile2);

    const profiles = await listProfiles(conn, 'test-block-1');
    expect(profiles.length).toBe(2);

    const names = profiles.map((p: { strategyName: string }) => p.strategyName).sort();
    expect(names).toEqual(['Calendar Spread', 'Iron Condor']);

    // Each getProfile returns the correct one
    const fetched1 = await getProfile(conn, 'test-block-1', 'Iron Condor');
    expect(fetched1!.structureType).toBe('iron_condor');

    const fetched2 = await getProfile(conn, 'test-block-1', 'Calendar Spread');
    expect(fetched2!.structureType).toBe('calendar_spread');
  });

  // Test 4: Upsert overwrites existing record (STOR-02 upsert semantics)
  it('overwrites existing profile on upsert with same composite key', async () => {
    const conn = await getConnection(testDir);

    const original = makeProfile({ thesis: 'Original thesis' });
    const stored1 = await upsertProfile(conn, original);

    // Small delay to ensure updated_at differs from created_at
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = makeProfile({
      thesis: 'Updated thesis',
      structureType: 'reverse_iron_condor',
    });
    const stored2 = await upsertProfile(conn, updated);

    expect(stored2.thesis).toBe('Updated thesis');
    expect(stored2.structureType).toBe('reverse_iron_condor');

    // Only one row should exist (upsert, not insert)
    const all = await listProfiles(conn, 'test-block-1');
    expect(all.length).toBe(1);

    // updated_at should be >= created_at
    expect(stored2.updatedAt.getTime()).toBeGreaterThanOrEqual(stored1.createdAt.getTime());
  });

  // Test 5: Delete returns true on success, false on second call
  it('deletes a profile and returns accurate boolean', async () => {
    const conn = await getConnection(testDir);

    const profile = makeProfile();
    await upsertProfile(conn, profile);

    // First delete — should succeed
    const deleted = await deleteProfile(conn, profile.blockId, profile.strategyName);
    expect(deleted).toBe(true);

    // Profile should be gone
    const fetched = await getProfile(conn, profile.blockId, profile.strategyName);
    expect(fetched).toBeNull();

    // Second delete — should return false
    const deletedAgain = await deleteProfile(conn, profile.blockId, profile.strategyName);
    expect(deletedAgain).toBe(false);
  });

  // Test 6: listProfiles without blockId returns all profiles across blocks
  it('listProfiles without blockId returns all profiles across all blocks', async () => {
    const conn = await getConnection(testDir);

    const p1 = makeProfile({ blockId: 'block-A', strategyName: 'Strategy 1' });
    const p2 = makeProfile({ blockId: 'block-B', strategyName: 'Strategy 2' });
    const p3 = makeProfile({ blockId: 'block-B', strategyName: 'Strategy 3' });

    await upsertProfile(conn, p1);
    await upsertProfile(conn, p2);
    await upsertProfile(conn, p3);

    const all = await listProfiles(conn);
    expect(all.length).toBe(3);

    const blockAProfiles = await listProfiles(conn, 'block-A');
    expect(blockAProfiles.length).toBe(1);

    const blockBProfiles = await listProfiles(conn, 'block-B');
    expect(blockBProfiles.length).toBe(2);
  });

  // Test 7: Backward compat — profile without positionSizing
  it('stores and retrieves a profile without positionSizing (backward compat)', async () => {
    const conn = await getConnection(testDir);
    // Explicitly omit positionSizing by overriding with undefined
    const input = makeProfile({ positionSizing: undefined });
    delete (input as Record<string, unknown>).positionSizing;

    const stored = await upsertProfile(conn, input);
    expect(stored.positionSizing).toBeUndefined();

    const fetched = await getProfile(conn, input.blockId, input.strategyName);
    expect(fetched).not.toBeNull();
    expect(fetched!.positionSizing).toBeUndefined();
  });

  // Test 8: Schema supports diverse Option Omega strategy types (STOR-03)
  it('stores all Option Omega strategy types without schema changes', async () => {
    const conn = await getConnection(testDir);

    const strategyTypes = [
      { structureType: 'vertical_spread', greeksBias: 'delta_positive', strategyName: 'Bull Put Spread' },
      { structureType: 'calendar_spread', greeksBias: 'vega_positive', strategyName: 'Calendar Spread' },
      { structureType: 'iron_condor', greeksBias: 'theta_positive', strategyName: 'Iron Condor' },
      {
        structureType: 'reverse_iron_condor',
        greeksBias: 'vega_positive',
        strategyName: 'Reverse Iron Condor',
      },
      { structureType: 'butterfly', greeksBias: 'theta_positive', strategyName: 'Butterfly Spread' },
    ];

    for (const strategy of strategyTypes) {
      const profile = makeProfile({
        blockId: 'strategy-types-block',
        strategyName: strategy.strategyName,
        structureType: strategy.structureType,
        greeksBias: strategy.greeksBias,
      });
      await upsertProfile(conn, profile);
    }

    const allProfiles = await listProfiles(conn, 'strategy-types-block');
    expect(allProfiles.length).toBe(strategyTypes.length);

    for (const strategy of strategyTypes) {
      const fetched = await getProfile(conn, 'strategy-types-block', strategy.strategyName);
      expect(fetched).not.toBeNull();
      expect(fetched!.structureType).toBe(strategy.structureType);
      expect(fetched!.greeksBias).toBe(strategy.greeksBias);
      // Verify JSON columns round-trip correctly
      expect(fetched!.legs).toEqual(makeProfile().legs);
      expect(fetched!.entryFilters).toEqual(makeProfile().entryFilters);
      expect(fetched!.keyMetrics).toEqual(makeProfile().keyMetrics);
    }
  });
});
