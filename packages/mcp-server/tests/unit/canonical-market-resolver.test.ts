import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FilePartitionCommitStore,
  CANONICAL_REFRESH_COMPLETION_KIND,
  CANONICAL_REFRESH_COMPLETION_VERSION,
  addressBytes,
  canonicalControlIdentity,
  canonicalJson,
  finalizeCanonicalMarketDataCutoff,
  proveCanonicalMarketDataPrefix,
  publishCanonicalMarketResolverRegistry,
  publishRefreshCompletionAuthority,
  publishInputClosure,
  verifyCanonicalMarketDataCutoff,
  type CanonicalJsonAddress,
  type StoredPartitionCommit,
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

  async function adoptSpot(session: string, payload: unknown, ticker = "IWM") {
    const partition = { ticker, date: session };
    const relativePath = `spot/ticker=${ticker}/date=${session}/data.parquet`;
    const targetPath = join(marketRoot, ...relativePath.split("/"));
    const preparedPath = `${targetPath}.prepared-${Math.random().toString(36).slice(2)}`;
    const bytes = Buffer.from(canonicalJson(payload));
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(preparedPath, bytes);
    return partitions.publishFileCommit({
      dataset: "spot",
      partition,
      schemaRevision: 1,
      relativePath,
      coverage: { kind: "date-range", from: session, through: session },
      quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
      file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
      preparedPath,
      expectedTargetPath: targetPath,
    });
  }

  async function publishCompletion(
    closure: CanonicalJsonAddress,
    session: string,
    commits: readonly StoredPartitionCommit[],
  ) {
    const spotTickers = commits
      .filter((commit) => commit.receipt.dataset === "spot")
      .map((commit) => commit.receipt.partition.ticker)
      .sort();
    const completion = await partitions.objects.put({
      kind: CANONICAL_REFRESH_COMPLETION_KIND,
      version: CANONICAL_REFRESH_COMPLETION_VERSION,
      attemptId: `test-${session}`,
      closure,
      plan: {
        asOf: session,
        spotTickers,
        chainUnderlyings: [],
        quoteUnderlyings: [],
        openInterestUnderlyings: [],
      },
      operations: commits.map((commit) => ({
        kind: "spot" as const,
        target: commit.receipt.partition.ticker,
        status: "ok" as const,
        rowsWritten: commit.receipt.file.rows,
      })),
      quoteGroups: [],
      receipts: commits.map((commit) => ({
        dataset: commit.receipt.dataset,
        partition: commit.receipt.partition,
        receipt: commit.address,
      })),
    });
    await publishRefreshCompletionAuthority(partitions, completion.address);
    return completion;
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
    const first = await adoptSpot("2026-07-02", { closeCents: 22_500 });
    const incomplete = await publishCompletion(closure.address, "2026-07-06", [first]);

    await expect(
      finalizeCanonicalMarketDataCutoff(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-06",
        refreshCompletion: incomplete.address,
      }),
    ).rejects.toThrow(/complete zero-drop cutoff partition|producer inventory/);

    const latest = await adoptSpot("2026-07-06", { closeCents: 22_650 });
    const completion = await publishCompletion(closure.address, "2026-07-06", [latest]);
    const manifest = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-06",
      refreshCompletion: completion.address,
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
    const ancestorClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        { kind: "control-file", dataClass: control.dataClass, role: control.role },
        {
          kind: "range",
          dataClass: "spot",
          selectorPrefix: { ticker: "IWM" },
          fromSession: "2026-07-06",
          throughSession: "2026-07-06",
        },
      ],
    });
    const firstReceipt = await adoptSpot("2026-07-06", { closeCents: 22_650 });
    const firstCompletion = await publishCompletion(ancestorClosure.address, "2026-07-06", [
      firstReceipt,
    ]);
    const manifest = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: ancestorClosure.address,
      completeThrough: "2026-07-06",
      refreshCompletion: firstCompletion.address,
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
    const descendantClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        { kind: "control-file", dataClass: control.dataClass, role: control.role },
        {
          kind: "range",
          dataClass: "spot",
          selectorPrefix: { ticker: "IWM" },
          fromSession: "2026-07-06",
          throughSession: "2026-07-07",
        },
      ],
    });
    const descendantReceipt = await adoptSpot("2026-07-07", { closeCents: 22_700 });
    const descendantCompletion = await publishCompletion(descendantClosure.address, "2026-07-07", [
      descendantReceipt,
    ]);
    const descendant = await finalizeCanonicalMarketDataCutoff(partitions, {
      closure: descendantClosure.address,
      completeThrough: "2026-07-07",
      refreshCompletion: descendantCompletion.address,
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
      observations: [
        { kind: "control-file", dataClass: control.dataClass, role: control.role },
        {
          kind: "range",
          dataClass: "spot",
          selectorPrefix: { ticker: "IWM" },
          fromSession: "2026-07-06",
          throughSession: "2026-07-06",
        },
      ],
    });
    const receipt = await adoptSpot("2026-07-06", { closeCents: 22_650 });
    const completion = await publishCompletion(closure.address, "2026-07-06", [receipt]);
    try {
      await expect(
        finalizeCanonicalMarketDataCutoff(partitions, {
          closure: closure.address,
          completeThrough: "2026-07-06",
          refreshCompletion: completion.address,
        }),
      ).rejects.toThrow(/parents must be real directories/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a cutoff missing-probe as refresh completion authority", async () => {
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
    const receipt = await adoptSpot("2026-07-06", { closeCents: 53_000 }, "SPY");
    const completion = await publishCompletion(closure.address, "2026-07-06", [receipt]);
    await expect(
      finalizeCanonicalMarketDataCutoff(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-06",
        refreshCompletion: completion.address,
      }),
    ).rejects.toThrow(/missing-probe cannot satisfy refresh completion/);
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
        refreshCompletion: closure.address,
      }),
    ).rejects.toThrow(/not a supported XNYS session/);
  });
});
