// Run with: node scripts/generate-agent-entry-files.mjs

import { readFile, rename, rm, writeFile } from "node:fs/promises";

const source = new URL("../docs/ai-assistant-entry.md", import.meta.url);
const targets = ["../CLAUDE.md", "../AGENTS.md"].map((path) => new URL(path, import.meta.url));
const contents = await readFile(source, "utf8");

await Promise.all(
  targets.map(async (target) => {
    const temporary = new URL(`${target.pathname}.${process.pid}.tmp`, target);

    try {
      await writeFile(temporary, contents);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }),
);
