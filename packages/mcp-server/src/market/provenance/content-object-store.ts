import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  addressBytes,
  canonicalJsonBytes,
  parseCanonicalJsonAddress,
  type CanonicalJsonAddress,
} from "./canonical-json.ts";

export interface PutContentObjectResult<T> {
  address: CanonicalJsonAddress;
  value: T;
  path: string;
  bytes: number;
  created: boolean;
}

export class ContentObjectCollisionError extends Error {
  readonly address: CanonicalJsonAddress;
  readonly objectPath: string;

  constructor(address: CanonicalJsonAddress, objectPath: string) {
    super(`Content object collision or corruption at ${address} (${objectPath})`);
    this.name = "ContentObjectCollisionError";
    this.address = address;
    this.objectPath = objectPath;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Immutable canonical-JSON object store.
 *
 * Temp objects are created with `wx` and installed by a no-replace hard link;
 * an existing address is never replaced. Repeating an identical put is
 * idempotent, while different bytes at the same address are treated as
 * collision/corruption and fail closed.
 */
export class ContentObjectStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  objectPath(address: CanonicalJsonAddress): string {
    const digest = parseCanonicalJsonAddress(address);
    return path.join(this.rootDir, "objects", "sha256", digest.slice(0, 2), `${digest}.json`);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureDurableDirectory(directory: string): Promise<void> {
    const parent = path.dirname(directory);
    if (parent !== directory) await this.ensureDurableDirectory(parent);
    try {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (parent !== directory) await this.syncDirectory(parent);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (parent === directory)
      throw new Error(`Cannot create content-object directory ${directory}`);
    let created = false;
    try {
      await fs.mkdir(directory);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      // A directory entry is durable only after its parent is synced. Sync the
      // new directory too before publishing any children into it.
      await this.syncDirectory(directory);
      await this.syncDirectory(parent);
    }
  }

  private async syncExistingObject(objectPath: string): Promise<void> {
    const handle = await fs.open(objectPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(path.dirname(objectPath));
  }

  async put<T>(value: T): Promise<PutContentObjectResult<T>> {
    // Encode once. Accessors and mutable input objects must not be able to make
    // an address computed by a second traversal disagree with published bytes.
    const bytes = canonicalJsonBytes(value);
    const address = addressBytes(bytes);
    const materialized = deepFreeze(JSON.parse(bytes.toString("utf8")) as T);
    const objectPath = this.objectPath(address);
    const objectDir = path.dirname(objectPath);
    await this.ensureDurableDirectory(objectDir);
    const tempPath = path.join(objectDir, `.${path.basename(objectPath)}.tmp-${randomUUID()}`);

    let handle: fs.FileHandle | undefined;
    try {
      // Publish only after the full object is durable. link(2) is an atomic
      // no-replace operation: unlike rename(), it fails with EEXIST and can
      // never overwrite an immutable object installed by another writer.
      handle = await fs.open(tempPath, "wx", 0o444);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(tempPath, objectPath);
      await this.syncDirectory(objectDir);
      await fs.unlink(tempPath);
      await this.syncDirectory(objectDir);
      return {
        address,
        value: materialized,
        path: objectPath,
        bytes: bytes.byteLength,
        created: true,
      };
    } catch (error) {
      await handle?.close();
      handle = undefined;
      await fs.unlink(tempPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readFile(objectPath);
      if (!existing.equals(bytes)) throw new ContentObjectCollisionError(address, objectPath);
      // The EEXIST winner may have linked the inode but not yet completed its
      // durability barrier. An idempotent caller supplies that barrier before
      // reporting success.
      await this.syncExistingObject(objectPath);
      return {
        address,
        value: materialized,
        path: objectPath,
        bytes: bytes.byteLength,
        created: false,
      };
    } finally {
      await handle?.close();
    }
  }

  async get<T>(address: CanonicalJsonAddress): Promise<T> {
    const objectPath = this.objectPath(address);
    const bytes = await fs.readFile(objectPath);
    // Identity is established from the exact stored bytes before parsing. A
    // parse/reserialize cycle must never be allowed to bless changed bytes.
    const digestAddress = addressBytes(bytes);
    if (digestAddress !== address) throw new ContentObjectCollisionError(address, objectPath);
    const value = JSON.parse(bytes.toString("utf8")) as T;
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new ContentObjectCollisionError(address, objectPath);
    }
    return deepFreeze(value);
  }
}
