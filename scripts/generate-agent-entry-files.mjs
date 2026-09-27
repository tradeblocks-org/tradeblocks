// Run with: node scripts/generate-agent-entry-files.mjs
//
// AGENTS.md carries the repository guide. CLAUDE.md only imports it, which is the
// form Claude Code reads on every version.

import { readFile, rename, rm, writeFile } from "node:fs/promises";

const source = new URL("../docs/ai-assistant-entry.md", import.meta.url);
const outputs = [
  [new URL("../AGENTS.md", import.meta.url), await readFile(source, "utf8")],
  [new URL("../CLAUDE.md", import.meta.url), "@AGENTS.md\n"],
];

await Promise.all(
  outputs.map(async ([target, contents]) => {
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
