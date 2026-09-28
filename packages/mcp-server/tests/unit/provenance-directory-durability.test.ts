/**
 * Directory durability of the provenance stores: a directory a write creates is
 * synced, with its parent entry, before anything is published into it; the
 * store root and its ancestors are not re-synced on every write; a directory
 * removed and recreated at the same path is synced again; a directory whose
 * generation cannot be identified is never treated as already durable.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as actualFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Op = { op: "sync" | "link"; path: string };
let ops: Op[] = [];
let noBirthTime = false;
let reuseInodes = false;

/**
 * Simulate filesystem identity edge cases: one that reports no birth time, and
 * one that hands a recreated directory its predecessor's inode number.
 */
function simulated<T extends object>(stat: T): T {
  if (noBirthTime) Object.defineProperty(stat, "birthtimeNs", { value: 0n });
  if (reuseInodes) Object.defineProperty(stat, "ino", { value: 1n });
  return stat;
}

jest.unstable_mockModule("node:fs/promises", () => ({
  ...actualFs,
  open: async (...args: Parameters<typeof actualFs.open>) => {
    const handle = await actualFs.open(...args);
    const target = path.resolve(String(args[0]));
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      ops.push({ op: "sync", path: target });
      return sync();
    };
    const stat = handle.stat.bind(handle) as typeof handle.stat;
    handle.stat = (async (options?: { bigint?: boolean }) =>
      simulated(await stat(options as never))) as typeof handle.stat;
    return handle;
  },
  stat: (async (target: string, options?: { bigint?: boolean }) =>
    simulated(await actualFs.stat(target, options as never))) as typeof actualFs.stat,
  link: async (existing: string, created: string) => {
    ops.push({ op: "link", path: path.resolve(created) });
    return actualFs.link(existing, created);
  },
}));

// Dynamic import: the store must load after the node:fs/promises mock is registered.
const { ContentObjectStore } = await import("../../src/market/provenance/content-object-store.ts");

describe("provenance store directory durability", () => {
  let tmp: string;
  let rootDir: string;

  beforeEach(async () => {
    tmp = await actualFs.realpath(
      await actualFs.mkdtemp(path.join(os.tmpdir(), "tb-dir-durability-")),
    );
    rootDir = path.join(tmp, "store");
    ops = [];
    noBirthTime = false;
    reuseInodes = false;
  });

  afterEach(async () => {
    await actualFs.rm(tmp, { recursive: true, force: true });
  });

  const indexOf = (op: Op["op"], target: string, after = -1) =>
    ops.findIndex((entry, index) => index > after && entry.op === op && entry.path === target);

  /** The directory and the parent holding its entry are both synced before `published`. */
  const expectSyncedBefore = (directory: string, published: number) => {
    const ownSync = indexOf("sync", directory);
    expect(ownSync).toBeGreaterThan(-1);
    expect(ownSync).toBeLessThan(published);
    const parentSync = indexOf("sync", path.dirname(directory), ownSync);
    expect(parentSync).toBeGreaterThan(-1);
    expect(parentSync).toBeLessThan(published);
  };

  it("syncs every directory a write creates, and its parent entry, before publishing into it", async () => {
    const store = new ContentObjectStore(rootDir);
    const { path: objectPath } = await store.put({ first: 1 });

    const published = indexOf("link", objectPath);
    expect(published).toBeGreaterThan(-1);
    for (const directory of [
      rootDir,
      path.join(rootDir, "objects"),
      path.join(rootDir, "objects", "sha256"),
      path.dirname(objectPath),
    ]) {
      expectSyncedBefore(directory, published);
    }
  });

  it("does not re-sync the store root or anything above it on later writes", async () => {
    const store = new ContentObjectStore(rootDir);
    await store.put({ first: 1 });
    ops = [];
    const second = await store.put({ second: 2 });

    // Each put still flushes the directory it linked into.
    expect(ops).toContainEqual({ op: "sync", path: path.dirname(second.path) });
    for (let directory = rootDir; ; directory = path.dirname(directory)) {
      expect(ops).not.toContainEqual({ op: "sync", path: directory });
      if (path.dirname(directory) === directory) break;
    }
  });

  it("syncs a directory another writer removed and recreated, even on a reused inode", async () => {
    reuseInodes = true;
    const store = new ContentObjectStore(rootDir);
    const value = { recreated: true };
    const first = await store.put(value);
    const objectsDir = path.join(rootDir, "objects");
    // Another writer removes `objects` and recreates it without syncing.
    await actualFs.rm(objectsDir, { recursive: true });
    await actualFs.mkdir(objectsDir);
    ops = [];

    const second = await store.put(value);

    expect(second).toMatchObject({ created: true, path: first.path });
    expect(await actualFs.readFile(second.path, "utf8")).toBe('{"recreated":true}');
    const published = indexOf("link", second.path);
    expect(published).toBeGreaterThan(-1);
    // `objects` is synced together with the surviving store root's entry for it.
    for (const directory of [
      objectsDir,
      path.join(objectsDir, "sha256"),
      path.dirname(second.path),
    ]) {
      expectSyncedBefore(directory, published);
    }
  });

  it("keeps syncing every ancestor when the filesystem reports no birth time", async () => {
    noBirthTime = true;
    const store = new ContentObjectStore(rootDir);
    await store.put({ first: 1 });
    ops = [];
    const second = await store.put({ second: 2 });

    // A reused inode would be indistinguishable, so nothing is remembered.
    const published = indexOf("link", second.path);
    for (let directory = path.dirname(second.path); ; directory = path.dirname(directory)) {
      if (path.dirname(directory) === directory) break;
      expectSyncedBefore(directory, published);
    }
  });
});
