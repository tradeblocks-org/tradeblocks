# TradeBlocks Repository Guide

`docs/ai-assistant-entry.md` is the source for the root `CLAUDE.md` and `AGENTS.md` files. After
editing the source, run `node scripts/generate-agent-entry-files.mjs` to update both copies.

## Project

TradeBlocks is a Next.js application for analyzing options trading performance. It processes CSV
exports from Option Omega backtests and live trade logs, calculates portfolio statistics, and
provides MCP tools for AI-assisted analysis, including strategy profiling and structure-aware
analytics. The web application stores user data in IndexedDB; the MCP server uses DuckDB and
Parquet for analytics and market data.

The core value is accurate, trustworthy portfolio analytics that help traders understand their
strategies and make better decisions.

## Repository Constraints

- Preserve backwards compatibility for existing tools and public interfaces.
- Keep optional market-data integrations opt-in. CSV import must continue to work without an API
  key.
- Keep documentation self-contained in this repository and do not refer readers to non-public
  material.
- Follow the existing MCP tool pattern: Zod input schemas, sync middleware, handlers, and
  `createToolOutput` responses.
- Keep browser data in IndexedDB and server analytics data in DuckDB or Parquet according to the
  existing storage boundary.
- Use the platform-native `fetch` API for core market-data requests; do not add an HTTP client or
  provider SDK without a demonstrated need.

## Start Here

- `docs/development.md` — setup, commands, testing, repository structure, UI conventions, and
  contribution requirements.
- `docs/architecture.md` — data flow, storage boundaries, calculation invariants, date handling,
  and the Trading Calendar model.
- `docs/mcp-tools.md` — MCP tool catalog, design principles, development workflow, and verification.
- `docs/market-data.md` — providers, imports, enrichment, and provider implementation rules.

## Common Commands

```bash
npm install
npm run dev
npm test
npm run verify
```

Use `npm run build -w packages/mcp-server` and `npm test -w packages/mcp-server` when changing the
MCP server.

## Critical Implementation Rules

- Treat trade dates as US Eastern calendar dates, not UTC timestamps. The two date representations
  used by the application have different conversion rules; read `docs/architecture.md` before
  changing date logic.
- Keep gross P&L and commissions separate. Strategy filtering uses trade-based calculations because
  daily logs represent whole-portfolio performance.
- Apply prior-day values to close-derived market fields so analysis remains free of lookahead bias.
- Load trades and daily logs through their IndexedDB stores when working from a `ProcessedBlock`;
  the block contains references rather than embedded datasets.
- Add unit tests for every new pure-logic utility and run `npm run typecheck` before committing.

Follow existing code patterns, keep changes scoped, and verify behavior in addition to running the
automated checks.
