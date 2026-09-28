# Unreleased — Published risk-free rates

TradeBlocks now publishes the full DTB3 and SOFR FRED histories every day as `rates.json` on a separate `rates-data` branch. This replaces the weekly workflow that tried to commit Treasury rates to `master`, which had stopped working, and it covers SOFR for the first time.

**Web app**

- Reads the published file by default and caches the last validated copy in IndexedDB.
- Shows the effective DTB3 date next to Sharpe and Sortino.
- The Fetch published risk-free rates switch turns this off.
- Offline users fall back to the cached file or the bundled rates.
- CSV import and the library's bundled rate lookups work without an API key or network access.

**MCP server and market-data refresh**

- Use the same validated rates, with a local disk cache.
- Newer canonical rate slices become available, and unchanged historical slices keep their content identities.
- `TRADEBLOCKS_PUBLISHED_RATES=off` keeps the MCP server on the bundled rates.

**Releases**

- The release gate checks that neither bundled history is more than ten calendar days behind the published file.
- The reviewed `node scripts/rates.mjs seed` command refreshes both tables before a release.

**Bundled rates in this release**

- The seed extends both bundles through September 24, 2026.
- It corrects two misdated January 2026 DTB3 observations: 2026-01-03 is now 2026-01-05, and 2026-01-10 is now 2026-01-12, with the same values. Weekend lookups for January 10 and 11, 2026 now use the January 9 rate (3.52%) instead of 3.56%, and the January 5 and January 12 rate slices change identity.

**CLI**

- `node scripts/rates.mjs check --json` reports `current`, `behind`, or `unknown`, independently of release gating.
