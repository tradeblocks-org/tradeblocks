/**
 * @tradeblocks/lib - Shared library for TradeBlocks
 *
 * This package contains all shared business logic, models, and utilities
 * used across the TradeBlocks monorepo.
 */

// Core calculations
export * from "./calculations/index.ts";

// Data models
export * from "./models/index.ts";

// CSV processing pipeline
export * from "./processing/index.ts";

// IndexedDB database layer
export * from "./db/index.ts";

// Utility functions
export * from "./utils/index.ts";

// Static data (treasury rates, etc.)
export * from "./data/index.ts";

// Services (calendar data, performance snapshots)
export * from "./services/index.ts";

// Metrics (trade efficiency, etc.)
export * from "./metrics/index.ts";

// Type definitions
export * from "./types/index.ts";

// NOTE: Zustand stores are NOT exported from main entry to avoid:
// 1. Browser dependency conflicts with Node.js MCP server
// 2. Export name conflicts (Block is defined in both models and stores)
// Import stores directly from '@tradeblocks/lib/stores' when needed in browser context
