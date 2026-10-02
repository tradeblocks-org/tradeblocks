# Unreleased — dependency security fixes

**Security fixes, no interface change.** `npm audit` reports no vulnerabilities on this tree. Before, it reported one critical, two high, one moderate and one low advisory:

- **Critical — `next` 16.3.3 → 16.3.8.** Remote code execution in `next/og` `ImageResponse` ([GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)). The web app pins `next`, so the pin moves to `16.3.8`. `eslint-config-next` moves with it from `16.3.4` to `16.3.8`.
- **High — `@grpc/grpc-js` 1.14.4 → 1.14.5** (transitive): unauthorized certificates reported as authorized ([GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)) and handler error messages sent to clients ([GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)).
- **High — `brace-expansion` 5.0.9 → 5.0.12** (transitive): CPU and stack-exhaustion denial of service ([GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)).
- **Moderate — `fast-uri` 3.1.7 → 3.1.8** (transitive): inconsistent host case normalization ([GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)).
- **Low — `esbuild` under the MCP server's `tsup`, 0.27.7 → 0.27.2**: arbitrary file read from the esbuild development server on Windows ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), affects `>=0.27.3 <0.28.1`). `tsup` 8.5.1, the latest release, requires `esbuild ^0.27.0`, and no patched 0.27 release exists, so its copy resolves to 0.27.2, which predates the flaw. The MCP server's own `esbuild` stays at 0.28.2.

The web app, the MCP server's tools, inputs and outputs, and the library exports are unchanged. Installed MCP packages and Docker images stay on the vulnerable versions until the next release.

This note does not bump a version or publish a release.
