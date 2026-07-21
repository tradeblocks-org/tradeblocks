#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = mkdtempSync(join(tmpdir(), "tradeblocks-packed-provenance-"));
const packDir = join(fixtureRoot, "pack");
const consumerDir = join(fixtureRoot, "consumer");
mkdirSync(packDir);
mkdirSync(consumerDir);

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  );
  const tarball = join(packDir, packed[0].filename);
  const packedPaths = new Set((packed[0].files ?? []).map((file) => file.path));
  for (const required of ["dist/market/provenance/index.js", "dist/market/provenance/index.d.ts"]) {
    if (!packedPaths.has(required)) throw new Error(`Packed artifact is missing ${required}`);
  }
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "packed-provenance-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--save-exact",
      tarball,
    ],
    { cwd: consumerDir, stdio: "pipe" },
  );

  const runtimeProbe = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ContentObjectStore, canonicalJson } from "tradeblocks-mcp/market/provenance";
    const resolved = import.meta.resolve("tradeblocks-mcp/market/provenance");
    if (!resolved.includes("/dist/market/provenance/index.js")) throw new Error("not built dist: " + resolved);
    const root = mkdtempSync(join(tmpdir(), "packed-provenance-api-"));
    try {
      const store = new ContentObjectStore(root);
      const stored = await store.put({ b: 1, a: 2 });
      if (canonicalJson(await store.get(stored.address)) !== '{"a":2,"b":1}') throw new Error("API round trip failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", runtimeProbe], {
    cwd: consumerDir,
    stdio: "pipe",
  });
  if (Number(process.versions.node.split(".")[0]) !== 18) {
    const node18 = process.env.PROVENANCE_NODE18_BIN;
    if (node18) {
      execFileSync(node18, ["--input-type=module", "--eval", runtimeProbe], {
        cwd: consumerDir,
        stdio: "pipe",
      });
    } else {
      execFileSync("npx", ["--yes", "node@18", "--input-type=module", "--eval", runtimeProbe], {
        cwd: consumerDir,
        stdio: "pipe",
      });
    }
  }

  writeFileSync(
    join(consumerDir, "consumer.ts"),
    `import { ContentObjectStore, type CanonicalJsonAddress } from "tradeblocks-mcp/market/provenance";\n` +
      `const store = new ContentObjectStore("/tmp/provenance-types");\n` +
      `const address: CanonicalJsonAddress = "sha256:${"0".repeat(64)}";\n` +
      `void store.get(address);\n`,
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    }),
  );
  const tsc = resolve(packageRoot, "..", "..", "node_modules", "typescript", "bin", "tsc");
  if (!readFileSync(tsc, "utf8").includes("tsc"))
    throw new Error(`TypeScript compiler missing: ${tsc}`);
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: consumerDir,
    stdio: "pipe",
  });

  const processGate = join(consumerDir, "verify-provenance-process-lock.mjs");
  copyFileSync(resolve(packageRoot, "scripts", "verify-provenance-process-lock.mjs"), processGate);
  execFileSync(process.execPath, [processGate], {
    cwd: consumerDir,
    env: { ...process.env, PROVENANCE_PACKAGE_IMPORT: "tradeblocks-mcp/market/provenance" },
    stdio: "pipe",
  });

  console.log(
    `verify-packed-provenance-runtime: OK (${process.version} + Node18, exact tgz install, dist runtime, API, NodeNext declarations, cross-process locking)`,
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
