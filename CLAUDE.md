<!-- GSD:project-start source:PROJECT.md -->
## Project

**TradeBlocks**

A Next.js 15 application for analyzing options trading performance. Processes CSV exports from Option Omega backtests and live trade logs, calculates comprehensive portfolio statistics, and provides 50+ MCP tools for AI-assisted analysis including strategy profiling and structure-aware analytics. Uses IndexedDB for client-side storage and DuckDB for server-side analytics.

**Core Value:** Accurate, trustworthy portfolio analytics that help traders understand their strategies and make better decisions.

### Constraints

- **Backwards compatibility**: Existing tools must not change behavior
- **Optional adoption**: Massive.com integration is opt-in — users without API key use CSV import as before
- **MCP server**: New tools follow existing registration patterns (Zod schemas, sync middleware, createToolOutput)
- **Storage**: All data in DuckDB for consistency across the analytics layer
- **No new dependencies for core**: Massive API calls use native fetch — no SDK required
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Context
- Node.js 22.22.0 (confirmed via runtime check)
- TypeScript 5.8.0 with ESM modules
- Jest 30.2.0 with ts-jest 29.4.6 and ESM preset
- Zod 4.3.6 for schema validation
- @duckdb/node-api 1.4.4 for storage
- Project constraint: "No new dependencies for core: Massive API calls use native fetch"
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `fetch` (native) | Node.js built-in (22.x) | HTTP client for Massive.com REST API | Stable and unflagged since Node.js 18. Node.js 22 ships Undici-backed fetch with full AbortController, timeout signal, and streaming support. Zero additional dependency. Project constraint mandates it. Confidence: HIGH (confirmed via `node -e "console.log(typeof fetch)"` → `function`). |
| `AbortSignal.timeout()` | Node.js built-in (22.x) | Per-request timeout on fetch calls | Ships with Node.js 22. `AbortSignal.timeout(ms)` creates a self-managing timeout signal — no manual `setTimeout`/`clearTimeout` needed. Pass directly to `fetch(url, { signal: AbortSignal.timeout(30_000) })`. Confidence: HIGH. |
| Zod 4.3.6 | Already installed | Validate Massive API response shapes | Already in `package.json`. Define a `MassiveBarSchema` and `MassiveResponseSchema`, parse every API response before mapping to DuckDB rows. Fails loudly on schema drift rather than silently inserting garbage. Confidence: HIGH. |
| `process.env.MASSIVE_API_KEY` | N/A | API key injection | Established pattern in codebase — `TRADEBLOCKS_DATA_DIR`, `MARKET_DB_PATH`, `DUCKDB_THREADS` all follow the same pattern. Read at call site, not stored in module scope, so tests can override with `process.env.MASSIVE_API_KEY = 'test-key'` before each test. Confidence: HIGH. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `p-limit` | 6.x | Concurrency control for paginated requests | When fetching multiple date-range chunks in parallel. Limits concurrent requests to 2-3 to avoid hitting Massive rate limits. Install only if parallel chunk fetching is implemented. If fetching sequentially (simpler), this is not needed — defer to the phase where parallelism is actually warranted. |
| `p-retry` | 6.x | Exponential backoff retry for transient HTTP errors | When Massive returns 429 or 5xx. Wraps individual `fetch` calls with configurable retry count + backoff. Install only if retry logic is needed — it can also be hand-rolled (~20 lines) with `AbortSignal.timeout` since the use case is simple. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| Jest 30 `jest.spyOn(globalThis, 'fetch')` | Mock native fetch in unit tests | Preferred pattern over `jest.mock`. Spy directly on `globalThis.fetch`, restore with `jest.restoreAllMocks()` in `afterEach`. Works cleanly with ESM and ts-jest 29. See Testing section below. |
| `Response` / `Request` (built-in) | Construct mock fetch responses | Use `new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })` to build mock return values — no library needed. |
## Architecture of the New Module
## Installation
# No new core dependencies required — native fetch covers the HTTP client.
# Optional: only if sequential fetch + simple retry proves insufficient
# Dev: no changes needed (Jest 30 + ts-jest already installed)
## Detailed Recommendations by Question
### HTTP Client: Native Fetch
- Adds ~15KB dependency
- CommonJS-first; ESM support requires `import axios from 'axios'` with interop shims
- The project is `"type": "module"` — axios ESM interop has historically caused bundler friction
- ESM-only (good), but still an external dependency
- Its main value prop (retries, pagination helpers) can be accomplished with ~30 lines of hand-rolled code for a structured import pipeline
- Over-engineered for one-off REST calls against a single API
- Node.js 22 fetch is Undici-backed — production quality, not experimental
- `AbortSignal.timeout(30_000)` handles timeouts cleanly
- Response streaming is available if Massive ever returns large payloads
- Zero dependency delta; honored by the project constraint
### Rate Limiting Strategy
### Pagination Handling
### API Response Parsing and Column Mapping
### Environment Variable Configuration
- Read `process.env.MASSIVE_API_KEY` at the **tool handler call site**, not at module load time. This makes tests simple: set `process.env.MASSIVE_API_KEY = 'test'` before the call, clear after.
- Return a clean error message (not a thrown exception) when the key is missing — matches existing tool error patterns.
- Do NOT accept the API key as a tool input parameter. PROJECT.md Decision: "MASSIVE_API_KEY env var (not tool parameter) — avoids key in conversation history."
### Testing Approach
- `ts-jest` with `isolatedModules: true` and ESM preset
- Integration tests that stand up real DuckDB instances in `tmpdir()`
- Pure function unit tests with no mocking (market-enricher, filter-predicates, etc.)
- Handler exports via `src/test-exports.ts` for direct testing without MCP transport
- Node.js 22 native fetch lives on `globalThis.fetch`, not in a module
- `jest.mock()` works against module specifiers; you cannot `jest.mock('fetch')`
- `jest.spyOn(globalThis, 'fetch')` is the idiomatic Jest approach for globals — confirmed pattern for Jest 30 with ESM
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Native `fetch` | `axios` | If the project were CommonJS-first or needed interceptors across many services. Not applicable here. |
| Native `fetch` | `got` | If the API client needed rich retry/pagination primitives out of the box. Here the pagination contract is simple enough that a hand-rolled generator is clearer. |
| Sequential page fetching | Parallel fetching with `p-limit` | If importing multiple tickers simultaneously (e.g., SPX + VIX + QQQ in one call). Defer until that use case is confirmed. |
| Hard-coded Massive field mapping | User-provided `column_mapping` | If Massive ever changes their API schema and a mapping escape hatch is needed. Start without it — the tool description is simpler and the failure mode (Zod parse error) is clearer than a silent wrong-column mapping. |
| `jest.spyOn(globalThis, 'fetch')` | `msw` (Mock Service Worker) | `msw` is excellent for integration test suites with many endpoints. One API client with ~5 endpoints does not justify the setup cost and extra dependency. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `axios` | CommonJS-first; ESM interop friction in `"type":"module"` project; adds dependency for no functional gain over native fetch on Node.js 22 | Native `fetch` |
| `got` | External dependency; pagination helpers are over-engineered for this use case; ESM-only is fine but the payoff isn't there | Native `fetch` + hand-rolled generator |
| `node-fetch` | Polyfill for pre-18 Node.js. Completely unnecessary on Node.js 22 where `fetch` is a stable global. Installing it introduces a CommonJS/ESM conflict | Native `fetch` |
| `msw` (Mock Service Worker) | Heavyweight test infrastructure for one API client. Adds 10+ transitive deps. | `jest.spyOn(globalThis, 'fetch')` |
| Reading `MASSIVE_API_KEY` at module load | Module-level `const API_KEY = process.env.MASSIVE_API_KEY` bakes the key (or undefined) at import time, breaking test isolation | Read at call site inside the tool handler |
## Stack Patterns by Variant
- Use sequential `AsyncGenerator` pagination — simplest, no concurrency complexity
- Use `Promise.all([fetchTicker('VIX'), fetchTicker('VIX9D'), fetchTicker('VIX3M')])` with at most 3 concurrent requests — simple enough without `p-limit`
- Read `Retry-After` header, sleep, retry once — hand-rolled, no library needed
- If repeated 429s become a problem, add `p-limit` with concurrency=1 and a `MIN_REQUEST_INTERVAL_MS` constant
- The Zod parse error surfaces immediately on the first row, before any DuckDB writes. The error message includes the field path. No data corruption.
## Version Compatibility
| Package | Compatible With | Notes |
|---------|-----------------|-------|
| Node.js 22.x native fetch | Jest 30 + ts-jest 29 | `jest.spyOn(globalThis, 'fetch')` works correctly; ESM module interop is not involved since fetch is a global |
| Zod 4.3.6 | TypeScript 5.8 | `.parse()` throws `ZodError`; `.safeParse()` returns `{ success, data, error }` — prefer `safeParse` in the client to return structured errors without try/catch |
| @duckdb/node-api 1.4.4 | Node.js 22 | Already validated by existing test suite |
## Sources
- Runtime verification: `node --version` → v22.22.0; `node -e "console.log(typeof fetch)"` → `function` (HIGH confidence)
- `packages/mcp-server/package.json` — confirmed installed deps and versions (HIGH confidence)
- Project dependency constraint — "no new dependencies for core; native fetch for API calls" (HIGH confidence)
- `packages/mcp-server/src/db/connection.ts` — `process.env.*` pattern (HIGH confidence)
- `packages/mcp-server/jest.config.js` — ESM + ts-jest preset confirmed (HIGH confidence)
- Node.js 22 fetch stabilization: https://nodejs.org/en/blog/release/v22.0.0 (HIGH confidence — fetch stable, not experimental, since Node.js 21)
- Jest 30 global spy pattern: jest.spyOn(globalThis, 'fetch') — standard pattern for mocking native fetch globals in Jest; confirmed consistent with Jest 30 release notes approach to ESM globals (MEDIUM confidence — verified via Jest docs cross-reference, not live Context7 query)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

### Communicating effort

Never estimate effort in time units (hours, days, weeks, sprints). Time estimates are uncalibrated to David's actual workflow and create false precision.

Frame effort as **complexity weighted to value/outcome**:
- **Scope**: how many files / call sites / systems are affected
- **Complexity**: mechanical edit vs. design change vs. cross-cutting rewrite
- **Blast radius**: what breaks if it goes wrong (tests, public repo users, live trading)
- **Value delivered**: what problem this actually solves and how big that problem is

**Bad:** "multi-day rewrite", "an afternoon's work", "~2 hours"
**Good:** "large rewrite — every Theta call site remaps + new auth model + native binary in distribution — for marginal value over the 30-line transpose fix already in place"
**Good:** "small mechanical change in one file, no consumer impact, fixes the immediate breakage Amy reported"
**Good:** "medium refactor across 3 files, blast radius limited to <feature> scoring path, unblocks the autonomous-iteration agent work"

When recommending between options, lead with the value delta and the blast radius — those are what David is actually weighing.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
