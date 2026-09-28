import * as fs from "node:fs/promises";
import * as path from "node:path";

/** fsync a directory so entries created, linked, renamed or removed in it are durable. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type DirectoryIdentity = string;

function identityOf(stat: { dev: bigint; ino: bigint; birthtimeNs: bigint }): DirectoryIdentity {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

async function syncDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const handle = await fs.open(directory, "r");
  try {
    const identity = identityOf(await handle.stat({ bigint: true }));
    await handle.sync();
    return identity;
  } finally {
    await handle.close();
  }
}

async function currentIdentity(directory: string): Promise<DirectoryIdentity | undefined> {
  try {
    return identityOf(await fs.stat(directory, { bigint: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Directories one store instance has made durable, keyed by path and pinned to
 * the directory inode that was synced.
 *
 * Invariant: when `ensure(directory)` resolves, `directory` exists, and it and
 * every ancestor up to `/` were each fsynced, with its entry fsynced in its
 * parent, after that ancestor's current inode was created. This instance
 * performs those syncs the first time it meets each directory: on creation, or
 * on first sight of a directory someone else created. A later call skips a
 * directory whose path still resolves to the same device, inode and birth time,
 * because a durable entry stays durable until it is removed or renamed.
 * Removing or recreating a directory gives the path a new identity, so it is
 * synced again, together with its parent entry. The store never renames
 * directories it ensures; an external rename of an ancestor is outside this
 * invariant.
 */
export class DurableDirectories {
  private readonly known = new Map<string, DirectoryIdentity>();

  async ensure(directory: string): Promise<void> {
    const known = this.known.get(directory);
    if (known !== undefined) {
      if ((await currentIdentity(directory)) === known) return;
      this.known.delete(directory);
    }

    const parent = path.dirname(directory);
    if (parent !== directory) await this.ensure(parent);
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Sync the directory before anything is published into it, and its parent
    // so its own entry is durable. A directory another writer just created may
    // not have finished either sync, so an existing directory gets both too.
    const identity = await syncDirectoryIdentity(directory);
    if (parent !== directory) await syncDirectory(parent);
    this.known.set(directory, identity);
  }
}
