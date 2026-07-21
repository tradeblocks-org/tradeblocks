import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePartitionCommitStore,
  ManifestVerificationError,
  addressBytes,
  canonicalJson,
  createInputClosureDescriptor,
  dependencyKeyAddress,
  proveCutoffManifestPrefix,
  publishCutoffManifest,
  publishInputClosure,
  publishInputResolverRegistry,
  publishMissingProbeEvidence,
  publishSemanticInputLeaf,
  restrictInputClosureDescriptor,
  verifyCutoffManifest,
  verifyInputClosure,
  type InputClosureObservationV1,
  type ManifestInputResolver,
  type ManifestLeafReferenceV1,
} from "../../src/test-exports.ts";

describe("market-data content manifests", () => {
  let rootDir: string;
  let partitions: FilePartitionCommitStore;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `content-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(rootDir, { recursive: true });
    partitions = new FilePartitionCommitStore(rootDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const registryInput = {
    revision: "registry-2026-07-21",
    classes: [
      {
        kind: "partitioned" as const,
        dataClass: "spot",
        dataset: "spot",
        selectorKeys: ["ticker", "date"],
        sessionKey: "date",
        pathPrefix: "spot",
        filename: "data.parquet",
        supportedSchemaRevisions: [1],
        resolverRevision: "spot-resolver-v1",
        calendarRevision: "xnys-2026a",
      },
      {
        kind: "static" as const,
        dataClass: "rates",
        role: "risk-free-rates",
        relativePath: "control/rates.json",
        supportedSchemaRevisions: [1],
        resolverRevision: "rates-resolver-v1",
      },
    ],
  };

  const range = (throughSession: string): InputClosureObservationV1 => ({
    kind: "range",
    dataClass: "spot",
    selectorPrefix: { ticker: "IWM" },
    fromSession: "2026-07-20",
    throughSession,
  });

  const control: InputClosureObservationV1 = {
    kind: "control-file",
    dataClass: "rates",
    role: "risk-free-rates",
  };

  async function publishSpotPartition(session: string, payload: unknown) {
    const bytes = Buffer.from(canonicalJson(payload));
    const partition = { ticker: "IWM", date: session };
    const relativePath = `spot/ticker=IWM/date=${session}/data.parquet`;
    const targetPath = join(rootDir, ...relativePath.split("/"));
    const preparedPath = `${targetPath}.prepared-${Math.random().toString(36).slice(2)}`;
    mkdirSync(join(rootDir, "spot", "ticker=IWM", `date=${session}`), { recursive: true });
    writeFileSync(preparedPath, bytes);
    const receipt = await partitions.publishFileCommit({
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
    return {
      bytes,
      partition,
      receipt,
    };
  }

  async function publishSpotLeaf(
    registry: `sha256:${string}`,
    observation: InputClosureObservationV1,
    session: string,
    payload: unknown,
  ) {
    const published = await publishSpotPartition(session, payload);
    return publishSpotLeafFromPartition(registry, observation, published);
  }

  async function publishSpotLeafFromPartition(
    registry: `sha256:${string}`,
    observation: InputClosureObservationV1,
    published: Awaited<ReturnType<typeof publishSpotPartition>>,
  ) {
    const { partition, receipt } = published;
    const session = partition.date;
    const leaf = await publishSemanticInputLeaf(partitions.objects, {
      registry,
      observation,
      source: {
        kind: "partition-projection",
        dataset: "spot",
        partition,
        relativePath: receipt.receipt.relativePath,
        session,
        schemaRevision: 1,
        coverage: { kind: "date-range", from: session, through: session },
        quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
        file: receipt.receipt.file,
      },
    });
    return {
      leaf,
      published,
      reference: {
        leaf: leaf.address,
        evidence: { kind: "partition-receipt" as const, receipt: receipt.address },
      },
    };
  }

  function resolverFrom(
    resolutions: ReadonlyMap<
      string,
      { completeThrough: string; entries: readonly ManifestLeafReferenceV1[] }
    >,
  ): ManifestInputResolver {
    return {
      resolve: async ({ dependency }) => {
        const resolved = resolutions.get(dependency);
        return resolved
          ? { kind: "resolved", ...resolved }
          : { kind: "unresolved", reasonCode: "not-resolved" };
      },
    };
  }

  it("normalizes registry-bound observations and restricts only cutoff-scoped reads", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const futureExact: InputClosureObservationV1 = {
      kind: "exact",
      dataClass: "spot",
      selector: { date: "2026-07-21", ticker: "IWM" },
      session: "2026-07-21",
    };
    const futureMissing: InputClosureObservationV1 = {
      kind: "missing-probe",
      dataClass: "spot",
      selector: { ticker: "IWM", date: "2026-07-21" },
      session: "2026-07-21",
    };
    const descriptor = createInputClosureDescriptor(registry.address, [
      futureMissing,
      control,
      range("2026-07-21"),
      futureExact,
      control,
    ]);
    const restricted = restrictInputClosureDescriptor(descriptor, "2026-07-20");
    const ancestor = createInputClosureDescriptor(registry.address, [range("2026-07-20"), control]);

    expect(canonicalJson(restricted)).toBe(canonicalJson(ancestor));
    expect(descriptor.observations).toHaveLength(4);
    expect(dependencyKeyAddress(registry.address, range("2026-07-20"))).toBe(
      dependencyKeyAddress(registry.address, range("2026-07-21")),
    );
    expect(canonicalJson(ancestor)).toBe(
      '{"kind":"tradeblocks.market-data.input-closure","observations":[{"dataClass":"spot","fromSession":"2026-07-20","kind":"range","selectorPrefix":{"ticker":"IWM"},"throughSession":"2026-07-20"},{"dataClass":"rates","kind":"control-file","role":"risk-free-rates"}],"registry":"sha256:__REGISTRY__","version":1}'.replace(
        "sha256:__REGISTRY__",
        registry.address,
      ),
    );
  });

  it("binds materialized slices to their registry selector, schema, and content object", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, {
      revision: "materialized-registry-2026-07-21",
      classes: [
        {
          kind: "materialized",
          dataClass: "sofr_rates",
          selectorKeys: ["date"],
          sessionKey: "date",
          supportedSchemaRevisions: [1],
          resolverRevision: "sofr-resolver-v1",
          calendarRevision: "xnys-2026a",
        },
      ],
    });
    const session = "2026-04-30";
    const observation: InputClosureObservationV1 = {
      kind: "exact",
      dataClass: "sofr_rates",
      selector: { date: session },
      session,
    };
    const object = await partitions.objects.put({
      kind: "tradeblocks.market-data.rate-slice",
      version: 1,
      series: "sofr",
      requestedDate: session,
      effectiveDate: session,
      annualRateBasisPoints: 366,
      resolution: "exact",
    });
    const source = {
      kind: "materialized-slice" as const,
      selector: { date: session },
      session,
      schemaRevision: 1,
      object: { address: object.address, bytes: object.bytes },
    };
    const leaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation,
      source,
    });
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [observation],
    });
    const resolver = resolverFrom(
      new Map([
        [
          dependencyKeyAddress(registry.address, observation),
          {
            completeThrough: session,
            entries: [
              {
                leaf: leaf.address,
                evidence: { kind: "content-object" as const, object: object.address },
              },
            ],
          },
        ],
      ]),
    );
    const manifest = await publishCutoffManifest(partitions, {
      closure: closure.address,
      completeThrough: session,
      resolver,
    });
    await expect(
      verifyCutoffManifest(partitions, manifest.address, resolver),
    ).resolves.toBeDefined();

    await expect(
      publishSemanticInputLeaf(partitions.objects, {
        registry: registry.address,
        observation,
        source: { ...source, selector: { date: "2026-04-29" }, session: "2026-04-29" },
      }),
    ).rejects.toThrow(/exact source partition is incorrect/);
    await expect(
      publishSemanticInputLeaf(partitions.objects, {
        registry: registry.address,
        observation,
        source: { ...source, schemaRevision: 2 },
      }),
    ).rejects.toThrow(/schemaRevision is unsupported/);

    const otherObject = await partitions.objects.put({ unrelated: true });
    const wrongEvidenceResolver = resolverFrom(
      new Map([
        [
          dependencyKeyAddress(registry.address, observation),
          {
            completeThrough: session,
            entries: [
              {
                leaf: leaf.address,
                evidence: { kind: "content-object" as const, object: otherObject.address },
              },
            ],
          },
        ],
      ]),
    );
    await expect(
      publishCutoffManifest(partitions, {
        closure: closure.address,
        completeThrough: session,
        resolver: wrongEvidenceResolver,
      }),
    ).rejects.toThrow(/address disagrees with the semantic leaf/);
  });

  it("publishes, raw-verifies, and recomputes deterministic class and aggregate roots", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-20"), control],
    });
    const spot = await publishSpotLeaf(registry.address, range("2026-07-20"), "2026-07-20", {
      closeCents: 22_550,
      session: "2026-07-20",
    });
    const ratesObject = await partitions.objects.put({ rateBps: 433, role: "risk-free-rates" });
    const ratesLeaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation: control,
      source: {
        kind: "control-file",
        role: "risk-free-rates",
        relativePath: "control/rates.json",
        schemaRevision: 1,
        object: { address: ratesObject.address, bytes: ratesObject.bytes },
      },
    });
    const resolutions = new Map([
      [
        dependencyKeyAddress(registry.address, range("2026-07-20")),
        { completeThrough: "2026-07-20", entries: [spot.reference] },
      ],
      [
        dependencyKeyAddress(registry.address, control),
        {
          completeThrough: "2026-07-20",
          entries: [
            {
              leaf: ratesLeaf.address,
              evidence: { kind: "content-object" as const, object: ratesObject.address },
            },
          ],
        },
      ],
    ]);
    const resolver = resolverFrom(resolutions);

    const manifest = await publishCutoffManifest(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-20",
      resolver,
    });
    const verified = await verifyCutoffManifest(partitions, manifest.address, resolver);

    expect(verified.manifest.aggregateRoot).toBe(manifest.value.aggregateRoot);
    expect(verified.manifest.classes.map((entry) => entry.dataClass)).toEqual(["rates", "spot"]);
    expect(manifest.value.classes.map((entry) => entry.leafCount)).toEqual([1, 1]);
    expect(manifest.value.aggregateRoot).toBe(
      "sha256:2e26892f01effb301ed9221336447ce289574d51a1a65d8171e30b36932f4bd2",
    );
    expect(manifest.address).toBe(
      "sha256:b1262343a4e814d7b4c07dcc315151c540faf77889b460644aca9f9f7d48a20e",
    );

    const omittedClass = await partitions.objects.put({
      ...manifest.value,
      classes: manifest.value.classes.slice(1),
    });
    await expect(verifyCutoffManifest(partitions, omittedClass.address, resolver)).rejects.toThrow(
      /resolver-owned complete input set/,
    );
  });

  it("fails closed on unresolved, unmanifestable, incomplete, and omitted inputs", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const unresolvedClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-20")],
    });
    await expect(
      publishCutoffManifest(partitions, {
        closure: unresolvedClosure.address,
        completeThrough: "2026-07-20",
        resolver: resolverFrom(new Map()),
      }),
    ).rejects.toBeInstanceOf(ManifestVerificationError);

    const unmanifestable = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        { kind: "unmanifestable", readClass: "dynamic-socket", reasonCode: "no-byte-authority" },
      ],
    });
    await expect(
      publishCutoffManifest(partitions, {
        closure: unmanifestable.address,
        completeThrough: "2026-07-20",
        resolver: resolverFrom(new Map()),
      }),
    ).rejects.toThrow(/unmanifestable/);

    const spot = await publishSpotLeaf(registry.address, range("2026-07-20"), "2026-07-20", {
      session: "2026-07-20",
    });
    const lagging = resolverFrom(
      new Map([
        [
          dependencyKeyAddress(registry.address, range("2026-07-20")),
          { completeThrough: "2026-07-17", entries: [spot.reference] },
        ],
      ]),
    );
    await expect(
      publishCutoffManifest(partitions, {
        closure: unresolvedClosure.address,
        completeThrough: "2026-07-20",
        resolver: lagging,
      }),
    ).rejects.toThrow(/complete horizon/);
  });

  it("requires immutable evidence for missing probes and detects missing becoming present", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const missing: InputClosureObservationV1 = {
      kind: "missing-probe",
      dataClass: "spot",
      selector: { ticker: "IWM", date: "2026-07-20" },
      session: "2026-07-20",
    };
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [missing],
    });
    const absence = await publishMissingProbeEvidence(partitions.objects, {
      registry: registry.address,
      observation: missing,
      completeThrough: "2026-07-20",
    });
    const leaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation: missing,
      source: { kind: "missing-probe", session: "2026-07-20" },
    });
    const dependency = dependencyKeyAddress(registry.address, missing);
    const resolver = resolverFrom(
      new Map([
        [
          dependency,
          {
            completeThrough: "2026-07-20",
            entries: [
              {
                leaf: leaf.address,
                evidence: { kind: "absence-object" as const, object: absence.address },
              },
            ],
          },
        ],
      ]),
    );
    const manifest = await publishCutoffManifest(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-20",
      resolver,
    });
    await expect(
      verifyCutoffManifest(partitions, manifest.address, resolver),
    ).resolves.toBeDefined();

    await publishSpotPartition("2026-07-20", {
      materialized: true,
      session: "2026-07-20",
    });
    await expect(
      verifyCutoffManifest(partitions, manifest.address, resolver),
    ).rejects.toBeInstanceOf(ManifestVerificationError);
    await expect(
      publishCutoffManifest(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-20",
        resolver,
      }),
    ).rejects.toThrow(/no longer absent/);

    const otherMissing: InputClosureObservationV1 = {
      kind: "missing-probe",
      dataClass: "spot",
      selector: { ticker: "SPY", date: "2026-07-20" },
      session: "2026-07-20",
    };
    const otherEvidence = await publishMissingProbeEvidence(partitions.objects, {
      registry: registry.address,
      observation: otherMissing,
      completeThrough: "2026-07-20",
    });
    const wrongEvidenceResolver = resolverFrom(
      new Map([
        [
          dependency,
          {
            completeThrough: "2026-07-20",
            entries: [
              {
                leaf: leaf.address,
                evidence: { kind: "absence-object" as const, object: otherEvidence.address },
              },
            ],
          },
        ],
      ]),
    );
    await expect(
      publishCutoffManifest(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-20",
        resolver: wrongEvidenceResolver,
      }),
    ).rejects.toThrow(/requested dependency horizon/);
  });

  it.each(["repair", "delete", "tamper"] as const)(
    "rejects %s of an evidenced partition after manifest publication",
    async (mutation) => {
      const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
      const observation = range("2026-07-20");
      const closure = await publishInputClosure(partitions.objects, {
        registry: registry.address,
        observations: [observation],
      });
      const spot = await publishSpotLeaf(registry.address, observation, "2026-07-20", {
        closeCents: 22_500,
        session: "2026-07-20",
      });
      const resolver = resolverFrom(
        new Map([
          [
            dependencyKeyAddress(registry.address, observation),
            { completeThrough: "2026-07-20", entries: [spot.reference] },
          ],
        ]),
      );
      const manifest = await publishCutoffManifest(partitions, {
        closure: closure.address,
        completeThrough: "2026-07-20",
        resolver,
      });
      await expect(
        verifyCutoffManifest(partitions, manifest.address, resolver),
      ).resolves.toBeDefined();

      const targetPath = join(rootDir, "spot", "ticker=IWM", "date=2026-07-20", "data.parquet");
      if (mutation === "repair") {
        await publishSpotPartition("2026-07-20", {
          closeCents: 22_501,
          session: "2026-07-20",
        });
      } else if (mutation === "delete") {
        rmSync(targetPath);
      } else {
        writeFileSync(targetPath, canonicalJson({ tampered: true }));
      }

      await expect(verifyCutoffManifest(partitions, manifest.address, resolver)).rejects.toThrow(
        /current exact-byte authority tip/,
      );
    },
  );

  it("proves only sanctioned cutoff growth and refuses repairs or hidden history", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const ancestorClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-20"), control],
    });
    const futureExact: InputClosureObservationV1 = {
      kind: "exact",
      dataClass: "spot",
      selector: { ticker: "IWM", date: "2026-07-21" },
      session: "2026-07-21",
    };
    const descendantClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-21"), futureExact, control],
    });
    const dayOne = await publishSpotLeaf(registry.address, range("2026-07-20"), "2026-07-20", {
      close: 225,
      session: "2026-07-20",
    });
    const dayTwo = await publishSpotLeaf(registry.address, range("2026-07-21"), "2026-07-21", {
      close: 226,
      session: "2026-07-21",
    });
    const exactTwo = await publishSpotLeafFromPartition(
      registry.address,
      futureExact,
      dayTwo.published,
    );
    const ratesObject = await partitions.objects.put({ rateBps: 433 });
    const ratesLeaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation: control,
      source: {
        kind: "control-file",
        role: "risk-free-rates",
        relativePath: "control/rates.json",
        schemaRevision: 1,
        object: { address: ratesObject.address, bytes: ratesObject.bytes },
      },
    });
    const ratesReference = {
      leaf: ratesLeaf.address,
      evidence: { kind: "content-object" as const, object: ratesObject.address },
    };
    const resolutions = new Map([
      [
        dependencyKeyAddress(registry.address, range("2026-07-21")),
        {
          completeThrough: "2026-07-21",
          entries: [dayOne.reference, dayTwo.reference],
        },
      ],
      [
        dependencyKeyAddress(registry.address, futureExact),
        { completeThrough: "2026-07-21", entries: [exactTwo.reference] },
      ],
      [
        dependencyKeyAddress(registry.address, control),
        { completeThrough: "2026-07-21", entries: [ratesReference] },
      ],
    ]);
    const resolver = resolverFrom(resolutions);
    const ancestor = await publishCutoffManifest(partitions, {
      closure: ancestorClosure.address,
      completeThrough: "2026-07-20",
      resolver,
    });
    const descendant = await publishCutoffManifest(partitions, {
      closure: descendantClosure.address,
      completeThrough: "2026-07-21",
      resolver,
      predecessor: { manifest: ancestor.address, aggregateRoot: ancestor.value.aggregateRoot },
    });

    await expect(
      proveCutoffManifestPrefix(partitions, ancestor.address, descendant.address, resolver),
    ).resolves.toMatchObject({ valid: true });

    const rangeDependency = dependencyKeyAddress(registry.address, range("2026-07-21"));
    resolutions.set(rangeDependency, {
      completeThrough: "2026-07-21",
      entries: [dayOne.reference],
    });
    await expect(verifyCutoffManifest(partitions, descendant.address, resolver)).rejects.toThrow(
      /resolver-owned complete input set/,
    );
    resolutions.set(rangeDependency, {
      completeThrough: "2026-07-21",
      entries: [dayOne.reference, dayTwo.reference],
    });

    const hiddenHistorical: InputClosureObservationV1 = {
      kind: "exact",
      dataClass: "spot",
      selector: { ticker: "IWM", date: "2026-07-20" },
      session: "2026-07-20",
    };
    const hiddenClosure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-21"), futureExact, hiddenHistorical, control],
    });
    const hiddenLeaf = await publishSpotLeafFromPartition(
      registry.address,
      hiddenHistorical,
      dayOne.published,
    );
    resolutions.set(dependencyKeyAddress(registry.address, hiddenHistorical), {
      completeThrough: "2026-07-21",
      entries: [hiddenLeaf.reference],
    });
    const hidden = await publishCutoffManifest(partitions, {
      closure: hiddenClosure.address,
      completeThrough: "2026-07-21",
      resolver,
      predecessor: { manifest: ancestor.address, aggregateRoot: ancestor.value.aggregateRoot },
    });
    await expect(
      proveCutoffManifestPrefix(partitions, ancestor.address, hidden.address, resolver),
    ).resolves.toMatchObject({ valid: false, reason: "closure-restriction-mismatch" });
  });

  it("does not treat a cutoff-sensitive static replacement as descendant history", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [control],
    });
    const olderObject = await partitions.objects.put({ rateBps: 433 });
    const newerObject = await partitions.objects.put({ rateBps: 434 });
    const olderLeaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation: control,
      source: {
        kind: "control-file",
        role: "risk-free-rates",
        relativePath: "control/rates.json",
        schemaRevision: 1,
        object: { address: olderObject.address, bytes: olderObject.bytes },
      },
    });
    const newerLeaf = await publishSemanticInputLeaf(partitions.objects, {
      registry: registry.address,
      observation: control,
      source: {
        kind: "control-file",
        role: "risk-free-rates",
        relativePath: "control/rates.json",
        schemaRevision: 1,
        object: { address: newerObject.address, bytes: newerObject.bytes },
      },
    });
    const resolver: ManifestInputResolver = {
      resolve: async ({ completeThrough }) => ({
        kind: "resolved",
        completeThrough,
        entries: [
          completeThrough === "2026-07-20"
            ? {
                leaf: olderLeaf.address,
                evidence: { kind: "content-object", object: olderObject.address },
              }
            : {
                leaf: newerLeaf.address,
                evidence: { kind: "content-object", object: newerObject.address },
              },
        ],
      }),
    };
    const ancestor = await publishCutoffManifest(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-20",
      resolver,
    });
    const descendant = await publishCutoffManifest(partitions, {
      closure: closure.address,
      completeThrough: "2026-07-21",
      resolver,
      predecessor: { manifest: ancestor.address, aggregateRoot: ancestor.value.aggregateRoot },
    });

    await expect(
      proveCutoffManifestPrefix(partitions, ancestor.address, descendant.address, resolver),
    ).resolves.toMatchObject({ valid: false, reason: "historical-leaf-mismatch" });
  });

  it("rejects raw object tampering even when parsed content remains plausible", async () => {
    const registry = await publishInputResolverRegistry(partitions.objects, registryInput);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [range("2026-07-20")],
    });
    const stored = await verifyInputClosure(partitions.objects, closure.address);
    const closurePath = partitions.objects.objectPath(closure.address);
    chmodSync(closurePath, 0o644);
    writeFileSync(closurePath, `${readFileSync(closurePath, "utf8")}\n`);

    expect(stored.address).toBe(closure.address);
    await expect(verifyInputClosure(partitions.objects, closure.address)).rejects.toThrow(
      /collision|corruption/i,
    );
    expect(addressBytes(Buffer.from("abc"))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
