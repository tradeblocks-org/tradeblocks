/**
 * Directory durability of the provenance stores: a directory a write creates is
 * synced, with its parent entry, before anything is published into it; the
 * store root and its ancestors are not re-synced on every write; a directory
 * removed and recreated at the same path is synced again.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as actualFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Op = { op: "sync" | "link"; path: string };
let ops: Op[] = [];

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
    return handle;
  },
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

  it("syncs a directory again after it is removed and recreated at the same path", async () => {
    const store = new ContentObjectStore(rootDir);
    const value = { recreated: true };
    const first = await store.put(value);
    const objectsDir = path.join(rootDir, "objects");
    await actualFs.rm(objectsDir, { recursive: true });
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
});
