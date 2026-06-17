#!/usr/bin/env node
// Verifies the tradeblocks-mcp package exports map against drift.
//
// Two checks run against packages/mcp-server/package.json:
//
//   Check 1 — Resolution. Every target path referenced by the exports map
//             (across all conditional shapes: string, or object with
//             types/import/require/default) must exist on disk relative to
//             packages/mcp-server/. Catches deleted/renamed source files
//             that would silently break downstream consumers at install
//             time.
//
//   Check 2 — Exclusion. A small set of subpaths is deliberately scoped
//             out of the public surface. Any future addition of these
//             subpaths to the exports map is a deliberate widening and
//             should be a discrete decision, not a drive-by add.
//
// A third check — a coverage manifest declaring "consumer expects subpath
// X to exist" — was considered and deferred. Such a manifest just shifts
// the discipline elsewhere without a clear ownership story, and the
// YAGNI risk is real. If consumer breakage from a missing-but-expected
// subpath becomes a real problem, revisit by either (a) seeding the
// manifest from observed downstream imports or (b) running downstream
// consumer test suites as a CI matrix.
//
// Run from anywhere — paths resolve relative to this script's location.
// Exits 0 on pass, 1 on fail.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const packageJsonPath = resolve(packageRoot, "package.json");

// Subpaths deliberately scoped out of the public surface. Each exclusion
// is a maintenance-contract decision — adding any of these to the exports
// map should be a discrete PR, not an incidental change.
//
//   ./plugins                — plugin loader internals; not part of the
//                              consumer-facing surface.
//   ./index                  — package root entry; reserved (the package
//                              ships via dist/server/bin, not src/index).
//   ./utils/output-formatter — MCP-response formatting helper, coupled to
//                              MCP server response shape; not for reuse.
//
// The prefix ./server/ is excluded wholesale: the server/ directory is a
// build output and any subpath under it would expose build internals.
const EXCLUDED_SUBPATHS = new Set([
  "./plugins",
  "./index",
  "./utils/output-formatter",
]);
const EXCLUDED_PREFIXES = ["./server/"];

// Conditional exports may use any of the Node-defined conditions (types,
// import, require, default) plus user-defined ones. The walker recurses
// across every key it finds rather than gating on a known list, so a
// future condition (e.g. node, browser) does not silently hide a target.

function collectTargets(entry, subpath) {
  if (typeof entry === "string") {
    return [{ condition: null, target: entry }];
  }
  if (entry && typeof entry === "object") {
    const targets = [];
    for (const key of Object.keys(entry)) {
      const value = entry[key];
      if (typeof value !== "string") {
        // Nested conditional shape (e.g. { import: { types: ..., default: ... } })
        // is legal in Node's exports spec. Recurse.
        targets.push(
          ...collectTargets(value, subpath).map((t) => ({
            condition: t.condition ? `${key}.${t.condition}` : key,
            target: t.target,
          }))
        );
        continue;
      }
      targets.push({ condition: key, target: value });
    }
    return targets;
  }
  throw new Error(
    `Unexpected exports entry shape for "${subpath}": ${JSON.stringify(entry)}`
  );
}

function main() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const exportsMap = pkg.exports;

  if (!exportsMap || typeof exportsMap !== "object") {
    console.error(
      `verify-exports-surface: no exports map found in ${packageJsonPath}`
    );
    process.exit(1);
  }

  const resolutionFailures = [];
  const exclusionFailures = [];

  for (const subpath of Object.keys(exportsMap)) {
    // Check 2: exclusion
    if (EXCLUDED_SUBPATHS.has(subpath)) {
      exclusionFailures.push({
        subpath,
        reason: `listed in EXCLUDED_SUBPATHS`,
      });
    } else {
      for (const prefix of EXCLUDED_PREFIXES) {
        if (subpath.startsWith(prefix)) {
          exclusionFailures.push({
            subpath,
            reason: `matches excluded prefix "${prefix}"`,
          });
          break;
        }
      }
    }

    // Check 1: resolution
    const targets = collectTargets(exportsMap[subpath], subpath);
    for (const { condition, target } of targets) {
      if (typeof target !== "string" || !target.startsWith("./")) {
        resolutionFailures.push({
          subpath,
          condition,
          target,
          reason: `target is not a relative path starting with "./"`,
        });
        continue;
      }
      const absolute = resolve(packageRoot, target);
      if (!existsSync(absolute)) {
        resolutionFailures.push({
          subpath,
          condition,
          target,
          reason: `target file does not exist at ${absolute}`,
        });
      }
    }
  }

  let failed = false;

  if (resolutionFailures.length > 0) {
    failed = true;
    console.error("");
    console.error("Check 1 (Resolution) FAILED:");
    for (const f of resolutionFailures) {
      const cond = f.condition ? ` [${f.condition}]` : "";
      console.error(`  ${f.subpath}${cond} -> ${f.target}`);
      console.error(`    ${f.reason}`);
    }
  }

  if (exclusionFailures.length > 0) {
    failed = true;
    console.error("");
    console.error("Check 2 (Exclusion) FAILED:");
    for (const f of exclusionFailures) {
      console.error(`  ${f.subpath}`);
      console.error(`    ${f.reason}`);
    }
    console.error("");
    console.error(
      "  Adding an excluded subpath to the exports map is a deliberate"
    );
    console.error(
      "  widening of the public surface. If intentional, update the"
    );
    console.error(
      "  EXCLUDED_SUBPATHS / EXCLUDED_PREFIXES list in this script with"
    );
    console.error("  a comment explaining the new policy.");
  }

  if (failed) {
    console.error("");
    console.error("verify-exports-surface: FAIL");
    process.exit(1);
  }

  const entryCount = Object.keys(exportsMap).length;
  console.log(
    `verify-exports-surface: OK (${entryCount} entries, all targets resolve, no excluded subpaths present)`
  );
}

main();
