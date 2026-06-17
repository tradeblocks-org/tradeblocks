/**
 * Zod schemas for the ticker registry.
 *
 * Applied at three trust boundaries (defense in depth per RESEARCH.md Pitfall 3):
 *   1. MCP tool input boundary (schemas exported here, consumed by src/tools/tickers.ts in Plan 05)
 *   2. Registry constructor / register (registry.ts applies the same regex)
 *   3. Writer partition-value whitelist (src/db/parquet-writer.ts — Plan 03)
 */
import { z } from "zod";

/**
 * Whitelist for ticker-like strings. Must START with an uppercase letter
 * (forbids ".." and other digit/punctuation-only inputs from validating).
 *
 * Accepts after the leading letter: uppercase A-Z, digits 0-9, and `^ _ -`
 * which appear in a handful of real-world option roots and continuous-futures
 * symbols. Forbids `.` (and therefore `..`), `/`, `\`, whitespace, null bytes,
 * newlines, and any other non-filesystem-safe characters.
 */
export const TICKER_RE = /^[A-Z][A-Z0-9^_-]*$/;

export const UnderlyingsFileSchema = z.object({
  version: z.literal(1),
  underlyings: z.array(
    z.object({
      underlying: z.string().min(1).max(16).regex(TICKER_RE),
      roots: z.array(z.string().min(1).max(16).regex(TICKER_RE)).min(1).max(32),
    }),
  ),
});

// MCP tool input schemas (consumed by src/tools/tickers.ts in Plan 05).
export const registerUnderlyingSchema = z.object({
  underlying: z
    .string()
    .min(1)
    .max(16)
    .regex(TICKER_RE)
    .describe("Canonical underlying symbol, e.g. SPX"),
  roots: z
    .array(z.string().min(1).max(16).regex(TICKER_RE))
    .min(1)
    .max(32)
    .describe(
      "OCC roots that resolve to this underlying, e.g. ['SPX','SPXW','SPXQ']",
    ),
});

export const unregisterUnderlyingSchema = z.object({
  underlying: z
    .string()
    .min(1)
    .max(16)
    .regex(TICKER_RE)
    .describe("Underlying to remove. Bundled defaults cannot be removed."),
});

export const listUnderlyingsSchema = z.object({});

export const resolveRootSchema = z.object({
  input: z
    .string()
    .min(1)
    .max(32)
    .describe(
      "Bare root ('SPXW') or full OCC ticker ('SPXW251219C05000000')",
    ),
});
