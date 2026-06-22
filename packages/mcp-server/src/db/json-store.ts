/**
 * JSON Store Utility
 *
 * Provides atomic JSON file operations for metadata storage.
 * Used by json-adapters.ts (and consumer-side adapters) to persist
 * strategy profiles, sync metadata, market import metadata,
 * flat import logs, and strategy definitions as JSON files.
 *
 * Write atomicity: all writes use write-then-rename pattern.
 * Write to {path}.tmp, then rename() to final path. This prevents
 * partial writes from being picked up by Syncthing or concurrent readers.
 *
 * Exports:
 *   - readJsonFile<T>()   - Read and parse a JSON file (null if ENOENT)
 *   - writeJsonFile<T>()  - Atomic write with 2-space indent + trailing newline
 *   - deleteJsonFile()    - Delete a JSON file (false if ENOENT)
 *   - listJsonFiles()     - List .json files in a directory (empty array if ENOENT)
 *   - toFileSlug()        - Convert a human name to a filesystem-safe slug
 */

import * as fs from "fs/promises";
import * as path from "path";

/** Check for Node.js ENOENT errors */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as Record<string, unknown>).code === "ENOENT"
  );
}

/**
 * Atomically write a JSON file using write-then-rename.
 * Creates parent directories if they don't exist.
 *
 * @param filePath - Final file path
 * @param data - Object to serialize (2-space indent, trailing newline)
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Read and parse a JSON file.
 * Returns null if file doesn't exist (ENOENT).
 * Throws on parse errors or permission errors.
 *
 * @param filePath - Path to JSON file
 * @returns Parsed object or null if file not found
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Delete a JSON file.
 * Returns true if file existed and was deleted.
 * Returns false if file did not exist (ENOENT, no throw).
 *
 * @param filePath - Path to JSON file
 * @returns true if deleted, false if not found
 */
export async function deleteJsonFile(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * List JSON files in a directory.
 * Returns array of full file paths for files ending in the given suffix.
 * Returns empty array if directory does not exist (ENOENT, no throw).
 * Filters to only files (ignores subdirectories and non-matching files).
 *
 * @param dirPath - Directory to scan
 * @param suffix - File extension to filter by (default: ".json")
 * @returns Sorted array of full file paths
 */
export async function listJsonFiles(dirPath: string, suffix = ".json"): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => path.join(dirPath, e.name))
      .sort();
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Convert a human-readable name to a filesystem-safe slug.
 * Lowercases, replaces non-alphanumeric sequences with hyphens,
 * and strips leading/trailing hyphens.
 *
 * @param name - Human-readable name (e.g., "Pickle RIC v2")
 * @returns Slug string (e.g., "pickle-ric-v2")
 */
export function toFileSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
