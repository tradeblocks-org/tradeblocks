#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
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
    import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { dirname, join } from "node:path";
    import {
      ContentObjectStore,
      FilePartitionCommitStore,
      PartitionFileIntegrityError,
      addressBytes,
      canonicalJson,
      createInputClosureDescriptor,
      dependencyKeyAddress,
      publishInputResolverRegistry,
    } from "tradeblocks-mcp/market/provenance";
    const resolved = import.meta.resolve("tradeblocks-mcp/market/provenance");
    if (!resolved.includes("/dist/market/provenance/index.js")) throw new Error("not built dist: " + resolved);
    const root = mkdtempSync(join(tmpdir(), "packed-provenance-api-"));
    try {
      const store = new ContentObjectStore(root);
      const stored = await store.put({ b: 1, a: 2 });
      if (canonicalJson(await store.get(stored.address)) !== '{"a":2,"b":1}') throw new Error("API round trip failed");
      const registry = await publishInputResolverRegistry(store, {
        revision: "packed-runtime-v1",
        classes: [{
          kind: "partitioned",
          dataClass: "spot",
          dataset: "spot",
          selectorKeys: ["ticker", "date"],
          sessionKey: "date",
          pathPrefix: "spot",
          filename: "data.parquet",
          supportedSchemaRevisions: [1],
          resolverRevision: "spot-resolver-v1",
          calendarRevision: "xnys-packed-v1",
        }],
      });
      const closure = createInputClosureDescriptor(registry.address, [{
        kind: "range",
        dataClass: "spot",
        selectorPrefix: { ticker: "IWM" },
        fromSession: "2026-07-20",
        throughSession: "2026-07-21",
      }]);
      if (!dependencyKeyAddress(registry.address, closure.observations[0]).startsWith("sha256:")) {
        throw new Error("content-manifest API round trip failed");
      }

      const marketRoot = join(root, "market");
      const externalRoot = join(root, "external");
      mkdirSync(marketRoot);
      mkdirSync(externalRoot);
      const commits = new FilePartitionCommitStore(marketRoot);
      const input = (ticker, date, preparedPath, targetPath, bytes) => ({
        dataset: "spot",
        partition: { ticker, date },
        schemaRevision: 1,
        relativePath: "spot/ticker=" + ticker + "/date=" + date + "/data.parquet",
        coverage: { kind: "date-range", from: date, through: date },
        quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
        file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
        preparedPath,
        expectedTargetPath: targetPath,
      });
      const expectIntegrity = async (operation, label) => {
        try {
          await operation;
        } catch (error) {
          if (error instanceof PartitionFileIntegrityError) return;
          throw error;
        }
        throw new Error(label + " was accepted");
      };

      const symlinkBytes = Buffer.from("external-symlink");
      const symlinkTarget = join(marketRoot, "spot", "ticker=IWM", "date=2026-07-20", "data.parquet");
      const symlinkPrepared = symlinkTarget + ".prepared";
      const symlinkExternal = join(externalRoot, "symlink.parquet");
      mkdirSync(dirname(symlinkTarget), { recursive: true });
      writeFileSync(symlinkExternal, symlinkBytes);
      symlinkSync(symlinkExternal, symlinkPrepared);
      await expectIntegrity(
        commits.publishFileCommit(input("IWM", "2026-07-20", symlinkPrepared, symlinkTarget, symlinkBytes)),
        "prepared symlink",
      );

      const hardLinkBytes = Buffer.from("external-hard-link");
      const hardLinkTarget = join(marketRoot, "spot", "ticker=IWM", "date=2026-07-21", "data.parquet");
      const hardLinkPrepared = hardLinkTarget + ".prepared";
      const hardLinkExternal = join(externalRoot, "hard-link.parquet");
      mkdirSync(dirname(hardLinkTarget), { recursive: true });
      writeFileSync(hardLinkExternal, hardLinkBytes);
      linkSync(hardLinkExternal, hardLinkPrepared);
      await expectIntegrity(
        commits.publishFileCommit(input("IWM", "2026-07-21", hardLinkPrepared, hardLinkTarget, hardLinkBytes)),
        "prepared hard link",
      );

      const externalTicker = join(externalRoot, "ticker=SPY");
      const parentLink = join(marketRoot, "spot", "ticker=SPY");
      const escapedTarget = join(parentLink, "date=2026-07-22", "data.parquet");
      const escapedPrepared = escapedTarget + ".prepared";
      const escapedBytes = Buffer.from("escaped-parent");
      mkdirSync(dirname(join(externalTicker, "date=2026-07-22", "data.parquet")), { recursive: true });
      symlinkSync(externalTicker, parentLink, "dir");
      writeFileSync(escapedPrepared, escapedBytes);
      await expectIntegrity(
        commits.publishFileCommit(input("SPY", "2026-07-22", escapedPrepared, escapedTarget, escapedBytes)),
        "symlinked target parent",
      );

      const regularBytes = Buffer.from("regular-then-replaced");
      const regularTarget = join(marketRoot, "spot", "ticker=IWM", "date=2026-07-23", "data.parquet");
      const regularPrepared = regularTarget + ".prepared";
      const movedRegular = join(externalRoot, "moved-regular.parquet");
      mkdirSync(dirname(regularTarget), { recursive: true });
      writeFileSync(regularPrepared, regularBytes);
      await commits.publishFileCommit(input("IWM", "2026-07-23", regularPrepared, regularTarget, regularBytes));
      renameSync(regularTarget, movedRegular);
      symlinkSync(movedRegular, regularTarget);
      await expectIntegrity(
        commits.inspectPartition({ dataset: "spot", partition: { ticker: "IWM", date: "2026-07-23" } }),
        "symlinked canonical target",
      );
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
    `import { ContentObjectStore, PartitionFileIntegrityError, publishCutoffManifest, type CanonicalJsonAddress, type CutoffManifestV1 } from "tradeblocks-mcp/market/provenance";\n` +
      `const store = new ContentObjectStore("/tmp/provenance-types");\n` +
      `const address: CanonicalJsonAddress = "sha256:${"0".repeat(64)}";\n` +
      `const manifest: CutoffManifestV1 | undefined = undefined;\n` +
      `void PartitionFileIntegrityError;\n` +
      `void publishCutoffManifest;\n` +
      `void manifest;\n` +
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
  const tsc = resolve(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
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
