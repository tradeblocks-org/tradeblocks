import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FilePartitionCommitStore,
  addressBytes,
  canonicalControlIdentity,
  canonicalJson,
  finalizeCanonicalMarketDataCutoff,
  proveCanonicalMarketDataPrefix,
  publishCanonicalMarketResolverRegistry,
  publishInputClosure,
  verifyCanonicalMarketDataCutoff,
} from "../../src/test-exports.ts";

describe("producer-owned canonical market resolver", () => {
  let dataRoot: string;
  let marketRoot: string;
  let partitions: FilePartitionCommitStore;

  beforeEach(() => {
    dataRoot = join(
      tmpdir(),
      `canonical-market-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    marketRoot = join(dataRoot, "market");
    mkdirSync(marketRoot, { recursive: true });
    partitions = new FilePartitionCommitStore(marketRoot);
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  async function adoptSpot(session: string, payload: unknown) {
    const partition = { ticker: "IWM", date: session };
    const relativePath = `spot/ticker=IWM/date=${session}/data.parquet`;
    const targetPath = join(marketRoot, ...relativePath.split("/"));
    const bytes = Buffer.from(canonicalJson(payload));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, bytes);
    return partitions.adoptExistingFileCommit({
      dataset: "spot",
      partition,
      schemaRevision: 1,
      relativePath,
      coverage: { kind: "date-range", from: session, through: session },
      quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
      file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
    });
  }

  it("enumerates expected XNYS sessions instead of trusting visible files", async () => {
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        {
          kind: "range",
          dataClass: "spot",
          selectorPrefix: { ticker: "IWM" },
          fromSession: "2026-07-02",
          throughSession: "2026-07-06",
        },
      ],
    });
    await adoptSpot("2026-07-02", { closeCents: 22_500 });

    await expect(
      finalizeCanonicalMarketDataCutoff(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-06",
      }),
    ).rejects.toThrow(/not complete\/current/);

    await adoptSpot("2026-07-06", { closeCents: 22_650 });
    const manifest = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-06",
    });
    const verified = await verifyCanonicalMarketDataCutoff(partitions, manifest.address);

    expect(verified.manifest.classes).toHaveLength(1);
    expect(verified.manifest.classes[0]).toMatchObject({ dataClass: "spot", leafCount: 2 });
  });

  it("slices blackout semantics by cutoff and detects a historical content change", async () => {
    const control = canonicalControlIdentity("blackouts/fomc.json");
    const controlPath = join(dataRoot, "blackouts", "fomc.json");
    mkdirSync(dirname(controlPath), { recursive: true });
    writeFileSync(
      controlPath,
      JSON.stringify({ dates: ["2026-07-06"], description: "first wording" }),
    );
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects, {
      controlFiles: [control.relativePath],
    });
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [{ kind: "control-file", dataClass: control.dataClass, role: control.role }],
    });
    const manifest = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-06",
    });

    writeFileSync(
      controlPath,
      JSON.stringify({ dates: ["2026-07-06"], description: "ignored wording changed" }),
    );
    await expect(
      verifyCanonicalMarketDataCutoff(partitions, manifest.address),
    ).resolves.toBeDefined();

    writeFileSync(controlPath, JSON.stringify({ dates: ["2026-07-06", "2026-07-07"] }));
    await expect(
      verifyCanonicalMarketDataCutoff(partitions, manifest.address),
    ).resolves.toBeDefined();
    const descendant = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-07",
      predecessor: { manifest: manifest.address, aggregateRoot: manifest.value.aggregateRoot },
    });
    await expect(
      proveCanonicalMarketDataPrefix(partitions, manifest.address, descendant.address),
    ).resolves.toMatchObject({ valid: true });

    writeFileSync(
      controlPath,
      JSON.stringify({ dates: ["2026-07-02", "2026-07-06", "2026-07-07"] }),
    );
    await expect(verifyCanonicalMarketDataCutoff(partitions, manifest.address)).rejects.toThrow(
      /resolver-owned complete input set/,
    );
  });

  it("refuses a symlinked control parent outside the store-owned data root", async () => {
    const outside = `${dataRoot}-outside`;
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "fomc.json"), JSON.stringify(["2026-07-06"]));
    symlinkSync(outside, join(dataRoot, "blackouts"), "dir");
    const control = canonicalControlIdentity("blackouts/fomc.json");
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects, {
      controlFiles: [control.relativePath],
    });
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [{ kind: "control-file", dataClass: control.dataClass, role: control.role }],
    });
    try {
      await expect(
        finalizeCanonicalMarketDataCutoff(partitions, {
          closure: closure.address,
          completeThrough: "2026-07-06",
        }),
      ).rejects.toThrow(/parents must be real directories/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("publishes absence evidence but invalidates it when the partition appears", async () => {
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const missing = {
      kind: "missing-probe" as const,
      dataClass: "spot",
      selector: { ticker: "IWM", date: "2026-07-06" },
      session: "2026-07-06",
    };
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [missing],
    });
    const manifest = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-06",
    });
    await expect(
      verifyCanonicalMarketDataCutoff(partitions, manifest.address),
    ).resolves.toBeDefined();

    await adoptSpot("2026-07-06", { appeared: true });
    await expect(verifyCanonicalMarketDataCutoff(partitions, manifest.address)).rejects.toThrow(
      /probe-match|no longer absent/,
    );
  });

  it("refuses unbounded enriched reads and unsupported cutoff dates", async () => {
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    await expect(
      publishInputClosure(partitions.objects, {
        registry: registry.address,
        observations: [
          {
            kind: "range",
            dataClass: "enriched",
            selectorPrefix: { ticker: "IWM" },
            fromSession: "2026-07-02",
            throughSession: "2026-07-06",
          },
        ],
      }),
    ).rejects.toThrow(/unknown data class/);

    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        {
          kind: "missing-probe",
          dataClass: "spot",
          selector: { ticker: "IWM", date: "2026-07-04" },
          session: "2026-07-04",
        },
      ],
    });
    await expect(
      finalizeCanonicalMarketDataCutoff(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-04",
      }),
    ).rejects.toThrow(/not a supported XNYS session/);
  });
});
