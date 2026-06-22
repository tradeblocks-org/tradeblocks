/**
 * Unit tests for json-store.ts utility
 *
 * Tests atomic JSON file operations: read, write, delete, list, and slug generation.
 * Uses os.tmpdir() for isolated test directories.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

import {
  readJsonFile,
  writeJsonFile,
  deleteJsonFile,
  listJsonFiles,
  toFileSlug,
} from "../../src/test-exports.ts";

const TEST_DIR = path.join(os.tmpdir(), "json-store-test-" + Date.now());

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("writes JSON with 2-space indent and trailing newline to a .tmp file, then renames to final path", async () => {
    const filePath = path.join(TEST_DIR, "write-test", "data.json");
    const data = { name: "test", value: 42 };

    await writeJsonFile(filePath, data);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe(JSON.stringify(data, null, 2) + "\n");

    // Verify .tmp file was cleaned up (renamed away)
    await expect(fs.access(filePath + ".tmp")).rejects.toThrow();
  });

  it("creates parent directories recursively if they don't exist", async () => {
    const filePath = path.join(TEST_DIR, "deep", "nested", "dir", "data.json");
    await writeJsonFile(filePath, { nested: true });

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual({ nested: true });
  });
});

describe("readJsonFile", () => {
  it("returns parsed object when file exists", async () => {
    const filePath = path.join(TEST_DIR, "read-test.json");
    await fs.writeFile(filePath, JSON.stringify({ hello: "world" }), "utf-8");

    const result = await readJsonFile<{ hello: string }>(filePath);
    expect(result).toEqual({ hello: "world" });
  });

  it("returns null when file does not exist (ENOENT)", async () => {
    const filePath = path.join(TEST_DIR, "nonexistent.json");
    const result = await readJsonFile(filePath);
    expect(result).toBeNull();
  });

  it("throws on malformed JSON (parse error propagates)", async () => {
    const filePath = path.join(TEST_DIR, "malformed.json");
    await fs.writeFile(filePath, "{ bad json }", "utf-8");

    await expect(readJsonFile(filePath)).rejects.toThrow();
  });
});

describe("deleteJsonFile", () => {
  it("returns true when file existed and was deleted", async () => {
    const filePath = path.join(TEST_DIR, "delete-test.json");
    await fs.writeFile(filePath, "{}", "utf-8");

    const result = await deleteJsonFile(filePath);
    expect(result).toBe(true);

    // Verify file is gone
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns false when file did not exist (ENOENT, no throw)", async () => {
    const filePath = path.join(TEST_DIR, "does-not-exist.json");
    const result = await deleteJsonFile(filePath);
    expect(result).toBe(false);
  });
});

describe("listJsonFiles", () => {
  const listDir = path.join(TEST_DIR, "list-test");

  beforeAll(async () => {
    await fs.mkdir(listDir, { recursive: true });
    await fs.writeFile(path.join(listDir, "a.json"), "{}", "utf-8");
    await fs.writeFile(path.join(listDir, "b.json"), "{}", "utf-8");
    await fs.writeFile(path.join(listDir, "c.tmp"), "{}", "utf-8");
    await fs.writeFile(path.join(listDir, "d.txt"), "{}", "utf-8");
    await fs.mkdir(path.join(listDir, "subdir"), { recursive: true });
  });

  it("returns array of full file paths for .json files in a directory", async () => {
    const files = await listJsonFiles(listDir);
    expect(files).toEqual([path.join(listDir, "a.json"), path.join(listDir, "b.json")]);
  });

  it("returns empty array when directory does not exist (ENOENT, no throw)", async () => {
    const files = await listJsonFiles(path.join(TEST_DIR, "nonexistent-dir"));
    expect(files).toEqual([]);
  });

  it("filters to only files ending in .json (ignores subdirectories, .tmp files)", async () => {
    const files = await listJsonFiles(listDir);
    // Should NOT include c.tmp, d.txt, or the subdir
    for (const f of files) {
      expect(f).toMatch(/\.json$/);
    }
    expect(files).toHaveLength(2);
  });
});

describe("toFileSlug", () => {
  it('converts "Pickle RIC v2" to "pickle-ric-v2"', () => {
    expect(toFileSlug("Pickle RIC v2")).toBe("pickle-ric-v2");
  });

  it('converts "Iron Condor #1" to "iron-condor-1"', () => {
    expect(toFileSlug("Iron Condor #1")).toBe("iron-condor-1");
  });

  it("strips leading/trailing hyphens", () => {
    expect(toFileSlug("--test--")).toBe("test");
    expect(toFileSlug("#leading")).toBe("leading");
    expect(toFileSlug("trailing!")).toBe("trailing");
  });

  it("handles empty string gracefully (returns empty string)", () => {
    expect(toFileSlug("")).toBe("");
  });
});
