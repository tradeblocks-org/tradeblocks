import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Temporary exception: remove when a patched braces is published.
// Only local development tooling is covered: Next lint configuration and
// manually invoked repomix context packing. Their patterns must be trusted
// developer inputs, not remote/user-supplied glob patterns. Repomix can also
// read developer-owned global configuration and Git-local exclusions.
const allowedUrl = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const isBlocking = (severity) => severity === "high" || severity === "critical";

try {
  // Always audit the complete graph, including development dependencies.
  const result = spawnSync("npm", ["audit", "--json", "--include=dev"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit failed: ${result.error?.message ?? result.status}`);
  }
  const report = JSON.parse(result.stdout);
  if (
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error("Missing or unsupported npm audit report");
  }
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error("Expected the committed npm v3 lockfile");
  }

  // npm's dev flag is true only when a node is exclusively development-only;
  // shared production/dev nodes and production optional nodes are not exempt.
  for (const [path, node] of Object.entries(lock.packages)) {
    if (path.endsWith("node_modules/braces") && node.dev !== true) {
      throw new Error(`braces reaches a production dependency path: ${path}`);
    }
  }

  function advisories(name, visiting = new Set()) {
    const vulnerability = report.vulnerabilities[name];
    if (!vulnerability || visiting.has(name) || !vulnerability.via?.length) {
      throw new Error(`Unresolved audit advisory chain: ${name}`);
    }
    const next = new Set(visiting).add(name);
    return vulnerability.via.flatMap((via) =>
      typeof via === "string" ? advisories(via, next) : [via],
    );
  }

  let allowed = false;
  let failed = false;
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!isBlocking(vulnerability.severity)) continue;
    const causes = advisories(name).filter((via) => isBlocking(via.severity));
    const devOnly =
      vulnerability.nodes?.length > 0 &&
      vulnerability.nodes.every((path) => lock.packages[path]?.dev === true);
    if (
      devOnly &&
      causes.length > 0 &&
      causes.every((via) => via.url === allowedUrl && via.name === "braces")
    ) {
      allowed = true;
      console.log(`ALLOWED GHSA-vfj7-8cjw-p6xm (dev-only): ${name}`);
    } else {
      failed = true;
      console.error(`BLOCKED ${vulnerability.severity}: ${name}`);
      for (const via of causes) console.error(`  ${via.title}: ${via.url}`);
      if (!devOnly) console.error("  Not exclusively development-only");
    }
  }
  if (allowed) {
    console.log(
      "Exception reason: trusted local Next lint configuration and developer-invoked repomix context packing; never untrusted glob patterns.",
    );
    console.log("Exception expiry: remove when a patched braces is published.");
  }
  console.log(failed ? "Dependency audit FAILED" : "Dependency audit PASSED");
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(`Dependency audit FAILED: ${error.message}`);
  process.exitCode = 1;
}
