#!/usr/bin/env node
/**
 * MCPB Packer Script
 * Creates a proper .mcpb zip bundle following the MCPB v0.3 specification.
 *
 * Bundle structure:
 * - manifest.json (required)
 * - server/index.js (MCP server entry point)
 * - agent-skills/ (optional: bundled skills)
 */

import { createWriteStream, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

// Read version from package.json (single source of truth)
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf-8"));

// Sync version from package.json to manifest.json
if (manifest.version !== packageJson.version) {
  console.log(`Syncing version: ${manifest.version} -> ${packageJson.version}`);
  manifest.version = packageJson.version;
  writeFileSync(
    join(packageRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

const outputName = `${manifest.name}-${manifest.version}.mcpb`;
const outputPath = join(packageRoot, outputName);

console.log(`\nPacking MCPB bundle: ${outputName}`);
console.log(`Manifest version: ${manifest.manifest_version}`);
console.log(`Server type: ${manifest.server.type}`);
console.log(`Entry point: ${manifest.server.entry_point}`);

// Verify required files exist
const requiredFiles = ["manifest.json", "server/index.js"];

for (const file of requiredFiles) {
  const filePath = join(packageRoot, file);
  if (!existsSync(filePath)) {
    console.error(`\nError: Required file missing: ${file}`);
    console.error('Run "npm run build" first.');
    process.exit(1);
  }
}

// Create zip archive
const output = createWriteStream(outputPath);
const archive = archiver("zip", {
  zlib: { level: 9 }, // Maximum compression
});

archive.on("warning", (err) => {
  if (err.code === "ENOENT") {
    console.warn("Warning:", err.message);
  } else {
    throw err;
  }
});

archive.on("error", (err) => {
  throw err;
});

output.on("close", () => {
  const sizeKB = (archive.pointer() / 1024).toFixed(1);
  console.log(`\n✓ Created ${outputName} (${sizeKB} KB)`);
  console.log(`  Location: ${outputPath}`);
  console.log("\nTo install in Claude Desktop:");
  console.log("  Double-click the .mcpb file, or");
  console.log("  Run: mcpb install " + outputName);
});

archive.pipe(output);

// Add manifest.json at root
archive.file(join(packageRoot, "manifest.json"), { name: "manifest.json" });

// Add server directory
archive.directory(join(packageRoot, "server"), "server");

// Add agent-skills if present (optional)
const skillsPath = join(packageRoot, "agent-skills");
if (existsSync(skillsPath)) {
  archive.directory(skillsPath, "agent-skills");
  console.log("Including agent-skills/");
}

// Finalize
archive.finalize();
