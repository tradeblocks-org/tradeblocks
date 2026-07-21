import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  addressBytes,
  addressCanonicalJson,
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

/**
 * Immutable canonical-JSON object store.
 *
 * Objects are created with `wx`; an existing path is never replaced. Repeating
 * an identical put is idempotent, while different bytes at the same address are
 * treated as collision/corruption and fail closed.
 */
export class ContentObjectStore {
  constructor(readonly rootDir: string) {}

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

  async put<T>(value: T): Promise<PutContentObjectResult<T>> {
    const bytes = canonicalJsonBytes(value);
    const address = addressCanonicalJson(value);
    const objectPath = this.objectPath(address);
    const objectDir = path.dirname(objectPath);
    await fs.mkdir(objectDir, { recursive: true });
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
      return { address, value, path: objectPath, bytes: bytes.byteLength, created: true };
    } catch (error) {
      await handle?.close();
      handle = undefined;
      await fs.unlink(tempPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readFile(objectPath);
      if (!existing.equals(bytes)) throw new ContentObjectCollisionError(address, objectPath);
      return { address, value, path: objectPath, bytes: bytes.byteLength, created: false };
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
    return value;
  }
}
