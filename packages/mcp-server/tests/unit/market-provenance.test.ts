import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  ContentObjectCollisionError,
  ContentObjectStore,
  FilePartitionCommitStore,
  addressBytes,
  addressCanonicalJson,
  canonicalJson,
  parseCanonicalJsonAddress,
  setPartitionCommitTestFault,
} from "../../src/test-exports.ts";

describe("market-data provenance foundation", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `market-provenance-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe("canonical JSON v1", () => {
    it("matches fixed canonical bytes and address vectors", () => {
      const first = { b: 1, a: 2 };
      expect(canonicalJson(first)).toBe('{"a":2,"b":1}');
      expect(addressCanonicalJson(first)).toBe(
        "sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
      );

      const nested = { s: "é", n: -0, a: [3, { z: null, y: true }] };
      expect(canonicalJson(nested)).toBe('{"a":[3,{"y":true,"z":null}],"n":0,"s":"é"}');
      expect(addressCanonicalJson(nested)).toBe(
        "sha256:3778d8370e3e572201c083f38f5408689045ee43bb06894c44c14aca1219e4e6",
      );
    });

    it("normalizes keys and values to NFC and sorts keys by Unicode code point", () => {
      expect(canonicalJson({ value: "e\u0301" })).toBe('{"value":"é"}');
      expect(canonicalJson({ "😀": 2, "": 1 })).toBe('{"":1,"😀":2}');
      expect(() => canonicalJson({ é: 1, "e\u0301": 2 })).toThrow(/key collision/);
    });

    it("rejects values JSON cannot identify portably", () => {
      expect(() => canonicalJson({ value: undefined })).toThrow(/does not support undefined/);
      expect(() => canonicalJson({ value: Number.NaN })).toThrow(/safe integers/);
      expect(() => canonicalJson({ value: 1.5 })).toThrow(/safe integers/);
      expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
      expect(() => canonicalJson(new Date())).toThrow(/plain objects/);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
    });
  });

  describe("immutable content objects", () => {
    it("is idempotent for identical canonical content", async () => {
      const store = new ContentObjectStore(rootDir);
      const first = await store.put({ b: 1, a: 2 });
      const second = await store.put({ a: 2, b: 1 });

      expect(first.address).toBe(second.address);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(readFileSync(first.path, "utf8")).toBe('{"a":2,"b":1}');
      expect(await store.get(first.address)).toEqual({ a: 2, b: 1 });
      expect(readdirSync(dirname(first.path))).toEqual([first.path.split("/").at(-1)]);
    });

    it("converges concurrent first-shard creators on one durable immutable object", async () => {
      const stores = Array.from({ length: 8 }, () => new ContentObjectStore(rootDir));
      const results = await Promise.all(stores.map((store) => store.put({ shared: "object" })));

      expect(new Set(results.map((result) => result.address)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      await expect(stores[0].get(results[0].address)).resolves.toEqual({ shared: "object" });
    });

    it("never replaces conflicting bytes at an existing object address", async () => {
      const store = new ContentObjectStore(rootDir);
      const value = { dataset: "spot", partition: { date: "2026-07-20" } };
      const address = addressCanonicalJson(value);
      const objectPath = store.objectPath(address);
      mkdirSync(dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, "corrupt-existing-bytes", "utf8");

      await expect(store.put(value)).rejects.toBeInstanceOf(ContentObjectCollisionError);
      expect(readFileSync(objectPath, "utf8")).toBe("corrupt-existing-bytes");
    });

    it("verifies raw stored bytes before parsing or canonical re-encoding", async () => {
      const store = new ContentObjectStore(rootDir);
      const stored = await store.put({ a: 1, b: 2 });
      chmodSync(stored.path, 0o644);
      writeFileSync(stored.path, '{"b":2,"a":1}', "utf8");

      await expect(store.get(stored.address)).rejects.toBeInstanceOf(ContentObjectCollisionError);
    });

    it("encodes accessor-backed input once and returns the frozen captured value", async () => {
      const store = new ContentObjectStore(rootDir);
      let reads = 0;
      const input = {
        get value() {
          reads += 1;
          return reads;
        },
      };

      const stored = await store.put(input);

      expect(reads).toBe(1);
      expect(stored.address).toBe(addressBytes(Buffer.from('{"value":1}')));
      expect(stored.value).toEqual({ value: 1 });
      expect(Object.isFrozen(stored.value)).toBe(true);
      expect(await store.get(stored.address)).toEqual({ value: 1 });
    });
  });

  describe("partition receipt store", () => {
    const identity = { dataset: "spot", partition: { ticker: "IWM", date: "2026-07-20" } };
    const relativePath = "spot/ticker=IWM/date=2026-07-20/data.parquet";
    const metadata = (rows: number) => ({
      schemaRevision: 1,
      coverage: { kind: "date-range" as const, from: "2026-07-20", through: "2026-07-20" },
      quality: { inputRows: rows, writtenRows: rows, droppedRows: 0 },
    });

    const targetFor = (partition: Record<string, string>) =>
      join(rootDir, "spot", `ticker=${partition.ticker}`, `date=${partition.date}`, "data.parquet");

    const publish = async (
      store: FilePartitionCommitStore,
      args: {
        partition?: Record<string, string>;
        bytes: Buffer;
        rows: number;
        metadataRows?: number;
      },
    ) => {
      const partition = args.partition ?? identity.partition;
      const targetPath = targetFor(partition);
      mkdirSync(dirname(targetPath), { recursive: true });
      const preparedPath = `${targetPath}.prepared-${Math.random().toString(36).slice(2)}`;
      writeFileSync(preparedPath, args.bytes);
      return store.publishFileCommit({
        dataset: "spot",
        partition,
        relativePath: `spot/ticker=${partition.ticker}/date=${partition.date}/data.parquet`,
        ...metadata(args.metadataRows ?? args.rows),
        file: {
          address: addressBytes(args.bytes),
          bytes: args.bytes.byteLength,
          rows: args.rows,
        },
        preparedPath,
        expectedTargetPath: targetPath,
      });
    };

    it("classifies first content as append, changed content as repair, and retries idempotently", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const first = await publish(store, { bytes: Buffer.from("v1"), rows: 10 });
      const retry = await publish(store, { bytes: Buffer.from("v1"), rows: 10 });
      const repair = await publish(store, { bytes: Buffer.from("version-two"), rows: 12 });

      expect(first.receipt.classification).toBe("append");
      expect(retry.address).toBe(first.address);
      expect(retry.created).toBe(false);
      expect(repair.receipt.classification).toBe("repair");
      expect(repair.receipt.parent).toBe(first.address);
      expect(repair.address).not.toBe(first.address);
    });

    it("detects matching, missing, modified, and untracked files", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const bytes = Buffer.from("exact parquet stand-in");
      const targetPath = targetFor(identity.partition);
      await publish(store, { bytes, rows: 3 });

      await expect(store.inspectPartition(identity)).resolves.toMatchObject({
        status: "match",
      });

      writeFileSync(targetPath, "modified");
      await expect(store.inspectPartition(identity)).resolves.toMatchObject({
        status: "mismatch",
      });

      unlinkSync(targetPath);
      await expect(store.inspectPartition(identity)).resolves.toMatchObject({
        status: "missing",
      });

      const orphanIdentity = {
        dataset: "spot",
        partition: { ticker: "IWM", date: "2026-07-21" },
      };
      const orphanPath = targetFor(orphanIdentity.partition);
      mkdirSync(dirname(orphanPath), { recursive: true });
      writeFileSync(orphanPath, "orphan");
      await expect(store.inspectPartition(orphanIdentity)).resolves.toMatchObject({
        status: "orphan",
      });
    });

    it("serializes concurrent writers into one append followed by one repair", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const commits = await Promise.all(
        ["first", "second"].map((value) => publish(store, { bytes: Buffer.from(value), rows: 1 })),
      );

      expect(commits.map((commit) => commit.receipt.classification).sort()).toEqual([
        "append",
        "repair",
      ]);
      const repair = commits.find((commit) => commit.receipt.classification === "repair");
      const append = commits.find((commit) => commit.receipt.classification === "append");
      expect(repair?.receipt.parent).toBe(append?.address);
    });

    it("recovers a dead stale owner without removing a replacement writer's lock", async () => {
      const firstStore = new FilePartitionCommitStore(rootDir);
      const firstBytes = Buffer.from("first");
      await publish(firstStore, { bytes: firstBytes, rows: 1 });

      const identityDigest = parseCanonicalJsonAddress(
        addressCanonicalJson({
          kind: "tradeblocks.market-data.partition-identity",
          version: 1,
          ...identity,
        }),
      );
      const lockRoot = join(
        rootDir,
        ".provenance",
        "locks",
        identityDigest.slice(0, 2),
        identityDigest,
      );
      const claimsDir = join(lockRoot, "claims");
      const staleToken = "00000000-0000-4000-8000-000000000000";
      const staleClaim = join(claimsDir, staleToken);
      mkdirSync(staleClaim, { recursive: true });
      writeFileSync(
        join(staleClaim, "owner.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-lock-owner",
          version: 1,
          token: staleToken,
          pid: 2_147_483_647,
          hostname: hostname(),
          bootId: "different-boot-generation",
          createdAtMs: 0,
        }),
      );
      writeFileSync(
        join(staleClaim, "ticket.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-lock-ticket",
          version: 1,
          token: staleToken,
          number: 1,
        }),
      );

      const recoveringStore = new FilePartitionCommitStore(rootDir, {
        staleLockMs: 0,
        lockWaitMs: 1_000,
      });
      const repairBytes = Buffer.from("repair");
      const repair = await publish(recoveringStore, { bytes: repairBytes, rows: 1 });

      expect(repair.receipt.classification).toBe("repair");
      expect(readdirSync(join(lockRoot, "quarantine"))).toHaveLength(1);
      expect(readdirSync(claimsDir)).toEqual([]);
    });

    it("rebuilds a missing or rolled-back head from the immutable event authority", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const first = await publish(store, { bytes: Buffer.from("first"), rows: 1 });
      const digest = parseCanonicalJsonAddress(
        addressCanonicalJson({
          kind: "tradeblocks.market-data.partition-identity",
          version: 1,
          ...identity,
        }),
      );
      const headPath = join(rootDir, ".provenance", "heads", digest.slice(0, 2), `${digest}.json`);
      const firstHead = readFileSync(headPath);

      unlinkSync(headPath);
      await expect(store.inspectPartition(identity)).resolves.toMatchObject({ status: "match" });
      expect(existsSync(headPath)).toBe(true);

      const second = await publish(store, { bytes: Buffer.from("second"), rows: 1 });
      expect(second.receipt.parent).toBe(first.address);
      writeFileSync(headPath, firstHead);
      await expect(store.inspectPartition(identity)).resolves.toMatchObject({
        status: "match",
        receipt: { address: second.address },
      });
      expect(JSON.parse(readFileSync(headPath, "utf8")).receipt).toBe(second.address);
    });

    it("rebuilds a parseable head with unsupported canonical values", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const committed = await publish(store, { bytes: Buffer.from("first"), rows: 1 });
      const digest = parseCanonicalJsonAddress(
        addressCanonicalJson({
          kind: "tradeblocks.market-data.partition-identity",
          version: 1,
          ...identity,
        }),
      );
      const headPath = join(rootDir, ".provenance", "heads", digest.slice(0, 2), `${digest}.json`);
      writeFileSync(
        headPath,
        JSON.stringify({
          kind: "tradeblocks.market-data.partition-head",
          version: 1.5,
          ...identity,
          receipt: committed.address,
          event: `sha256:${"0".repeat(64)}`,
        }),
      );

      await expect(store.inspectPartition(identity)).resolves.toMatchObject({
        status: "match",
        receipt: { address: committed.address },
      });
      expect(JSON.parse(readFileSync(headPath, "utf8"))).toMatchObject({
        version: 1,
        receipt: committed.address,
      });
    });

    it("rebuilds the head after a deterministic event-before-head crash", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const first = await publish(store, { bytes: Buffer.from("first"), rows: 1 });
      setPartitionCommitTestFault(store, (point) => {
        if (point === "after-event-before-head") throw new Error("injected crash boundary");
      });

      await expect(publish(store, { bytes: Buffer.from("second"), rows: 1 })).rejects.toThrow(
        /installed without a complete projected commit/,
      );
      setPartitionCommitTestFault(store);

      const inspection = await store.inspectPartition(identity);
      expect(inspection).toMatchObject({ status: "match" });
      if (inspection.status !== "match") throw new Error("expected rebuilt matching receipt");
      expect(inspection.receipt.receipt.parent).toBe(first.address);
      expect(inspection.receipt.receipt.file.address).toBe(addressBytes(Buffer.from("second")));
    });

    it("fails closed when immutable event authority has a fork", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const first = await publish(store, { bytes: Buffer.from("first"), rows: 1 });
      const digest = parseCanonicalJsonAddress(
        addressCanonicalJson({
          kind: "tradeblocks.market-data.partition-identity",
          version: 1,
          ...identity,
        }),
      );
      const head = JSON.parse(
        readFileSync(
          join(rootDir, ".provenance", "heads", digest.slice(0, 2), `${digest}.json`),
          "utf8",
        ),
      );
      const indexDir = join(rootDir, ".provenance", "events", digest.slice(0, 2), digest);
      for (const child of ["left", "right"]) {
        const bytes = Buffer.from(child);
        const storedReceipt = await store.objects.put({
          ...first.receipt,
          file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
          classification: "repair",
          parent: first.address,
        });
        const storedEvent = await store.objects.put({
          kind: "tradeblocks.market-data.partition-commit-event",
          version: 1,
          ...identity,
          receipt: storedReceipt.address,
          previous: head.event,
        });
        linkSync(
          storedEvent.path,
          join(indexDir, `${parseCanonicalJsonAddress(storedEvent.address)}.json`),
        );
      }

      await expect(store.inspectPartition(identity)).rejects.toThrow(/ambiguous tips/);
    });

    it("snapshots mutable publication input before the first await", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const bytes = Buffer.from("captured");
      const targetPath = targetFor(identity.partition);
      mkdirSync(dirname(targetPath), { recursive: true });
      const preparedPath = `${targetPath}.prepared`;
      writeFileSync(preparedPath, bytes);
      const input = {
        ...identity,
        partition: { ...identity.partition },
        relativePath,
        ...metadata(1),
        file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
        preparedPath,
        expectedTargetPath: targetPath,
      };

      const pending = store.publishFileCommit(input);
      input.partition.ticker = "MUTATED";
      input.coverage.from = "2026-07-19";
      input.quality.inputRows = 999;
      input.file.address = addressBytes(Buffer.from("mutated"));
      const stored = await pending;

      expect(stored.receipt.partition).toEqual(identity.partition);
      expect(stored.receipt.coverage).toEqual(metadata(1).coverage);
      expect(stored.receipt.file.address).toBe(addressBytes(bytes));
      expect(Object.isFrozen(stored.receipt)).toBe(true);
      expect(Object.isFrozen(stored.receipt.partition)).toBe(true);
      await expect(store.inspectPartition(identity)).resolves.toMatchObject({ status: "match" });
    });

    it("refuses malformed and remote lock claims without moving their unique paths", async () => {
      const digest = parseCanonicalJsonAddress(
        addressCanonicalJson({
          kind: "tradeblocks.market-data.partition-identity",
          version: 1,
          ...identity,
        }),
      );
      const claimsDir = join(rootDir, ".provenance", "locks", digest.slice(0, 2), digest, "claims");
      mkdirSync(claimsDir, { recursive: true });
      const malformedToken = "10000000-0000-4000-8000-000000000000";
      const malformedPath = join(claimsDir, malformedToken);
      mkdirSync(malformedPath);
      writeFileSync(join(malformedPath, "owner.json"), "not-canonical-owner");
      writeFileSync(
        join(malformedPath, "ticket.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-lock-ticket",
          version: 1,
          token: malformedToken,
          number: 1,
        }),
      );
      const store = new FilePartitionCommitStore(rootDir, { staleLockMs: 0, lockWaitMs: 30 });

      await expect(publish(store, { bytes: Buffer.from("blocked"), rows: 1 })).rejects.toThrow(
        /Timed out acquiring partition lock/,
      );
      expect(existsSync(malformedPath)).toBe(true);
      expect(existsSync(join(dirname(claimsDir), "quarantine"))).toBe(false);

      rmSync(malformedPath, { recursive: true });
      const remoteToken = "20000000-0000-4000-8000-000000000000";
      const remotePath = join(claimsDir, remoteToken);
      mkdirSync(remotePath);
      writeFileSync(
        join(remotePath, "owner.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-lock-owner",
          version: 1,
          token: remoteToken,
          pid: 2_147_483_647,
          hostname: "remote-host.example",
          bootId: "remote-boot",
          createdAtMs: 0,
        }),
      );
      writeFileSync(
        join(remotePath, "ticket.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-lock-ticket",
          version: 1,
          token: remoteToken,
          number: 1,
        }),
      );

      await expect(
        publish(store, { bytes: Buffer.from("remote-blocked"), rows: 1 }),
      ).rejects.toThrow(/Timed out acquiring partition lock/);
      expect(existsSync(remotePath)).toBe(true);
    });

    it("rejects non-POSIX paths, unregistered identities, and false coverage before install", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const bytes = Buffer.from("invalid");
      const targetPath = targetFor(identity.partition);
      mkdirSync(dirname(targetPath), { recursive: true });
      const preparedPath = `${targetPath}.prepared`;
      writeFileSync(preparedPath, bytes);
      const base = {
        ...identity,
        relativePath,
        ...metadata(1),
        file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
        preparedPath,
        expectedTargetPath: targetPath,
      };

      await expect(
        store.publishFileCommit({ ...base, relativePath: relativePath.replaceAll("/", "\\") }),
      ).rejects.toThrow(/relative path/);
      await expect(store.publishFileCommit({ ...base, dataset: "unregistered" })).rejects.toThrow(
        /Unregistered/,
      );
      await expect(
        store.publishFileCommit({ ...base, coverage: { kind: "empty" } }),
      ).rejects.toThrow(/Non-empty partition/);
      expect(existsSync(targetPath)).toBe(false);
    });

    it("addresses exact bytes with a stable SHA-256 vector", () => {
      const bytes = Buffer.from("abc", "utf8");
      expect(addressBytes(bytes)).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    });
  });
});
