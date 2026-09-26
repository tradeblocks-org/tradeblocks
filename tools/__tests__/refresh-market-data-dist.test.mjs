import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let assertFreshDist;
const tempRoots = [];

beforeAll(async () => {
  ({ assertFreshDist } = await import(
    pathToFileURL(resolve(__dirname, "../refresh-market-data.mjs")).href
  ));
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "market-data-dist-"));
  tempRoots.push(root);
  const src = join(root, "src");
  const distEntrypoint = join(root, "dist", "test-exports.js");
  await mkdir(src);
  await mkdir(dirname(distEntrypoint));
  const sourceFile = join(src, "market-ingestor.ts");
  await writeFile(sourceFile, "source");
  return { src, sourceFile, distEntrypoint };
}

const earlier = new Date("2026-01-01T00:00:00Z");
const later = new Date("2026-01-02T00:00:00Z");

describe("market-data tool dist freshness", () => {
  it("refuses missing dist without building it", async () => {
    const f = await fixture();
    await expect(
      assertFreshDist({ sourcePaths: [f.src], distEntrypoint: f.distEntrypoint }),
    ).rejects.toThrow(/TradeBlocks MCP dist is missing:.*run npm run build:mcp/);
  });

  it("refuses stale dist without modifying it", async () => {
    const f = await fixture();
    await writeFile(f.distEntrypoint, "old dist");
    await utimes(f.distEntrypoint, earlier, earlier);
    await utimes(f.sourceFile, later, later);
    await expect(
      assertFreshDist({ sourcePaths: [f.src], distEntrypoint: f.distEntrypoint }),
    ).rejects.toThrow(/TradeBlocks MCP dist is stale:.*run npm run build:mcp/);
  });

  it("accepts dist built after all source inputs", async () => {
    const f = await fixture();
    await writeFile(f.distEntrypoint, "new dist");
    await utimes(f.sourceFile, earlier, earlier);
    await utimes(f.distEntrypoint, later, later);
    await expect(
      assertFreshDist({ sourcePaths: [f.src], distEntrypoint: f.distEntrypoint }),
    ).resolves.toBeUndefined();
  });
});
