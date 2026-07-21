import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ContentObjectCollisionError,
  ContentObjectStore,
  FilePartitionCommitStore,
  addressBytes,
  addressCanonicalJson,
  canonicalJson,
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
  });

  describe("partition receipt store", () => {
    const identity = { dataset: "spot", partition: { ticker: "IWM", date: "2026-07-20" } };
    const relativePath = "spot/ticker=IWM/date=2026-07-20/data.parquet";
    const metadata = (rows: number) => ({
      schemaRevision: 1,
      coverage: { kind: "date-range" as const, from: "2026-07-20", through: "2026-07-20" },
      quality: { inputRows: rows, writtenRows: rows, droppedRows: 0 },
    });

    it("classifies first content as append, changed content as repair, and retries idempotently", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const first = await store.recordCommit({
        ...identity,
        relativePath,
        ...metadata(10),
        file: { address: addressBytes(Buffer.from("v1")), bytes: 2, rows: 10 },
      });
      const retry = await store.recordCommit({
        ...identity,
        relativePath,
        ...metadata(10),
        file: { address: addressBytes(Buffer.from("v1")), bytes: 2, rows: 10 },
      });
      const repair = await store.recordCommit({
        ...identity,
        relativePath,
        ...metadata(12),
        file: { address: addressBytes(Buffer.from("version-two")), bytes: 11, rows: 12 },
      });

      expect(first.receipt.classification).toBe("append");
      expect(retry.address).toBe(first.address);
      expect(retry.created).toBe(false);
      expect(repair.receipt.classification).toBe("repair");
      expect(repair.receipt.parent).toBe(first.address);
      expect(repair.address).not.toBe(first.address);
    });

    it("detects matching, missing, modified, and untracked files", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const targetPath = join(rootDir, "data.parquet");
      const bytes = Buffer.from("exact parquet stand-in");
      writeFileSync(targetPath, bytes);
      await store.recordCommit({
        ...identity,
        relativePath,
        ...metadata(3),
        file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 3 },
      });

      await expect(store.inspectPartition({ ...identity, targetPath })).resolves.toMatchObject({
        status: "match",
      });

      writeFileSync(targetPath, "modified");
      await expect(store.inspectPartition({ ...identity, targetPath })).resolves.toMatchObject({
        status: "mismatch",
      });

      unlinkSync(targetPath);
      await expect(store.inspectPartition({ ...identity, targetPath })).resolves.toMatchObject({
        status: "missing",
      });

      const orphanPath = join(rootDir, "untracked.parquet");
      writeFileSync(orphanPath, "orphan");
      await expect(
        store.inspectPartition({
          dataset: "spot",
          partition: { ticker: "IWM", date: "2026-07-21" },
          targetPath: orphanPath,
        }),
      ).resolves.toMatchObject({ status: "orphan" });
    });

    it("serializes concurrent writers into one append followed by one repair", async () => {
      const store = new FilePartitionCommitStore(rootDir);
      const commits = await Promise.all(
        ["first", "second"].map((value) => {
          const bytes = Buffer.from(value);
          return store.recordCommit({
            ...identity,
            relativePath,
            ...metadata(1),
            file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
          });
        }),
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
      await firstStore.recordCommit({
        ...identity,
        relativePath,
        ...metadata(1),
        file: { address: addressBytes(firstBytes), bytes: firstBytes.byteLength, rows: 1 },
      });

      const headsRoot = join(rootDir, "heads");
      const shard = readdirSync(headsRoot)[0];
      const headName = readdirSync(join(headsRoot, shard)).find((name) => name.endsWith(".json"));
      expect(headName).toBeDefined();
      const lockPath = join(headsRoot, shard, `${headName}.lock`);
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner.json"),
        canonicalJson({
          kind: "tradeblocks.market-data.partition-head-lock",
          version: 1,
          token: "00000000-0000-4000-8000-000000000000",
          pid: 2_147_483_647,
          createdAtMs: 0,
        }),
      );

      const recoveringStore = new FilePartitionCommitStore(rootDir, {
        staleLockMs: 0,
        lockWaitMs: 1_000,
      });
      const repairBytes = Buffer.from("repair");
      const repair = await recoveringStore.recordCommit({
        ...identity,
        relativePath,
        ...metadata(1),
        file: { address: addressBytes(repairBytes), bytes: repairBytes.byteLength, rows: 1 },
      });

      expect(repair.receipt.classification).toBe("repair");
      expect(readdirSync(join(headsRoot, shard)).some((name) => name.includes(".stale-"))).toBe(
        true,
      );
      expect(readdirSync(join(headsRoot, shard)).some((name) => name.endsWith(".lock"))).toBe(
        false,
      );
    });

    it("addresses exact bytes with a stable SHA-256 vector", () => {
      const bytes = Buffer.from("abc", "utf8");
      expect(addressBytes(bytes)).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    });
  });
});
