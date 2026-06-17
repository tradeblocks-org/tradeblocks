#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src/utils/providers/thetadata/mdds.proto");
const targets = [
  resolve(root, "server/mdds.proto"),
  resolve(root, "dist/mdds.proto"),
];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
