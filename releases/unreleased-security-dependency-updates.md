# Unreleased — dependency security fixes

**Security fixes, no interface change.** The earlier dependency repair cleared the following advisories:

- **Critical — `next` 16.3.3 → 16.3.8.** Remote code execution in `next/og` `ImageResponse` ([GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)). The web app pins `next`, so the pin moves to `16.3.8`. `eslint-config-next` moves with it from `16.3.4` to `16.3.8`.
- **High — `@grpc/grpc-js` 1.14.4 → 1.14.5** (transitive): unauthorized certificates reported as authorized ([GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)) and handler error messages sent to clients ([GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)).
- **High — `brace-expansion` 5.0.9 → 5.0.12** (transitive): CPU and stack-exhaustion denial of service ([GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)).
- **Moderate — `fast-uri` 3.1.7 → 3.1.8** (transitive): inconsistent host case normalization ([GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)).
- **Low — `esbuild` under the MCP server's `tsup`, 0.27.7 → 0.27.2**: arbitrary file read from the esbuild development server on Windows ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), affects `>=0.27.3 <0.28.1`). `tsup` 8.5.1, the latest release, requires `esbuild ^0.27.0`, and no patched 0.27 release exists, so its copy resolves to 0.27.2, which predates the flaw. The MCP server's own `esbuild` stays at 0.28.2.

The web app, the MCP server's tools, inputs and outputs, and the library exports are unchanged. Installed MCP packages and Docker images stay on the vulnerable versions until the next release.

This note does not bump a version or publish a release.

## Required audit repair for the next release

The next release includes these additional changes; no package version is bumped here.

- **High — `probe-image-size` 7.2.3 → 7.4.0** (transitive through unchanged
  `plotly.js` 3.7.0): patched SVG-parser quadratic-time denial of service
  ([GHSA-gjj5-9665-rwrc](https://github.com/advisories/GHSA-gjj5-9665-rwrc)).
- **Temporary dev-only exception — `braces` 3.0.3,
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).**
  No patched version is available. Removing the Next lint plugin would remove
  existing recommended/core-web-vitals rules, and would still leave the separate
  `repomix` context-packing path. The exception covers only this advisory and its
  propagated audit rows, only when every affected locked node is dev-only.
  `npm run audit` still audits development dependencies and fails on every other
  high/critical advisory, any production `braces` node, or an unreadable audit
  report. The required **Dependency audit** context is unchanged.

The reason is bounded local development use: Next's glob settings come from
the repository's lint configuration, not application user input. The separate,
manually invoked `gpt:context` command also consumes developer-controlled
Repomix configuration and Git-local exclusions, which are not necessarily
repository files. Do not feed untrusted or remote glob patterns to these tools.
The exception does not claim that dev-only installation makes arbitrary
Repomix inputs safe.

**Expiry: remove when a patched `braces` is published.** The exact advisory,
reason and expiry are printed by the check. Update the locked dependency,
remove the exception from `scripts/audit.mjs`, and retain the high/critical
gate. Installed packages and images receive the production fix only at the
next release.

## Second audit repair for the next release

Advisories published after the repair above blocked the required **Dependency
audit** again. All fixes are non-major; no package version is bumped here, and
the `braces` exception and audit policy are unchanged.

- **High — `@modelcontextprotocol/sdk` 1.30.0 → 1.32.1** (the MCP server's
  protocol dependency, within its existing `^1.30.0` range): the SDK's OAuth
  client could send credentials to an authorization server chosen by the MCP
  server ([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)).
  The server's stdio and HTTP transports, its OAuth login, and its tools, inputs
  and outputs are unchanged.
- **High — `sharp` 0.35.4 → 0.35.5** (under `next`): librsvg CVE-2026-96889
  ([GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)).
  The root `overrides` pin moves from `0.35.4` to `0.35.5`.
- **Critical — `proxy-addr` 2.0.7 → 2.0.8** (transitive through `express`): IP
  spoofing through an IPv4-mapped IPv6 trust subnet
  ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)).
- **High — `source-map-js` 1.2.1 → 1.2.2** (transitive): event-loop denial of
  service through indexed source-map section offsets
  ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)).
- **Critical — `tinypool` 2.1.0 → 2.2.0** (development-only, through
  `repomix`): prototype-pollution gadgets in worker and `run()` options leading to
  code execution ([GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3),
  [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)).

Installed MCP packages and Docker images stay on the vulnerable versions until
the next release.
