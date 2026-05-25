/**
 * Unit tests for the Tool Dependency Registry.
 *
 * Mirrors the contract-style unit test pattern used elsewhere in this tree.
 * Covers the registry shape, unionTickerDeps composition, and a handful of
 * edge cases (targetTicker substitution, deterministic sorting, unknown
 * tool errors).
 */
import { describe, it, expect } from '@jest/globals';
import {
  TOOL_TICKER_DEPS,
  unionTickerDeps,
} from '../../src/test-exports.js';

describe('TOOL_TICKER_DEPS registry shape', () => {
  it('declares backtester as [SPX, VIX, VIX9D]', () => {
    expect(TOOL_TICKER_DEPS.backtester).toEqual(['SPX', 'VIX', 'VIX9D']);
  });

  it('declares market_enricher_t2 as [VIX, VIX9D, VIX3M] (cross-ticker context)', () => {
    expect(TOOL_TICKER_DEPS.market_enricher_t2).toEqual(['VIX', 'VIX9D', 'VIX3M']);
  });

  it('uses [] for target-ticker-dependent tools (market_enricher_t1/t3, orb_calculator)', () => {
    expect(TOOL_TICKER_DEPS.market_enricher_t1).toEqual([]);
    expect(TOOL_TICKER_DEPS.market_enricher_t3).toEqual([]);
    expect(TOOL_TICKER_DEPS.orb_calculator).toEqual([]);
  });
});

describe('unionTickerDeps', () => {
  it('returns the registered set for backtester + SPX target (sorted, deduped)', () => {
    expect(unionTickerDeps(['backtester'], 'SPX')).toEqual(['SPX', 'VIX', 'VIX9D']);
  });

  it('substitutes targetTicker for [] entries (market_enricher_t1, QQQ)', () => {
    expect(unionTickerDeps(['market_enricher_t1'], 'QQQ')).toEqual(['QQQ']);
  });

  it('dedupes across multiple tools with the same SPX target', () => {
    // backtester -> [SPX, VIX, VIX9D]; opening_drive -> [VIX]
    // Union: {SPX, VIX, VIX9D} sorted.
    const result = unionTickerDeps(['backtester', 'opening_drive'], 'SPX');
    expect(result).toEqual(['SPX', 'VIX', 'VIX9D']);
  });

  it('returns a lexicographically sorted deterministic list', () => {
    // market_enricher_t2 -> [VIX, VIX9D, VIX3M]; opening_drive -> [VIX]
    // Sorted ASCII: VIX < VIX3M < VIX9D.
    const result = unionTickerDeps(['market_enricher_t2', 'opening_drive'], 'SPX');
    expect(result).toEqual(['VIX', 'VIX3M', 'VIX9D']);
  });

  it('throws a descriptive error on unknown tool name', () => {
    expect(() => unionTickerDeps(['no_such_tool'], 'SPX')).toThrow(
      /Unknown tool in TOOL_TICKER_DEPS/,
    );
  });

  it('does NOT substitute when targetTicker is undefined and entry is []', () => {
    // market_enricher_t1 -> []; no targetTicker -> no substitution
    expect(unionTickerDeps(['market_enricher_t1'])).toEqual([]);
  });
});
