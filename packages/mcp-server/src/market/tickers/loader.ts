/**
 * Registry loader — bundled defaults merged with optional user override at
 * {dataRoot}/market/underlyings.json.
 *
 * Reuses writeJsonFile / readJsonFile from src/db/json-store.ts (already atomic)
 * and resolveMarketDir from src/db/market-datasets.ts (single source of truth for
 * {dataDir}/market).
 *
 * Bundled defaults loading (Plan 01-05 deviation Rule 3):
 *   The previous `fs.readFileSync(new URL("./defaults.json", import.meta.url))`
 *   approach broke under tsup bundling — the JSON file did not get copied next
 *   to the bundled `server/index.js`, causing ENOENT at server boot. The path
 *   only worked under Jest because Jest reads from src/ directly.
 *
 *   Using a JSON import with the `with { type: 'json' }` attribute lets esbuild
 *   (via tsup) inline the JSON data into the bundle at build time — no runtime
 *   filesystem dependency. Node 22+ supports import attributes natively (we run
 *   on Node 23), and ts-jest passes the import attribute through unchanged.
 *
 * The parsed object is module-scope and cached for the process lifetime.
 */
import * as path from "path";
import { readJsonFile, writeJsonFile } from "../../db/json-store.ts";
import { resolveMarketDir } from "../../db/market-datasets.ts";
import { UnderlyingsFileSchema } from "./schemas.ts";
import { TickerRegistry } from "./registry.ts";
import defaultsData from "./defaults.json" with { type: "json" };

function userOverridePath(dataDir: string): string {
  return path.join(resolveMarketDir(dataDir), "underlyings.json");
}

/**
 * Load the ticker registry.
 *   - Missing user-override file is OK (returns defaults-only registry).
 *   - Malformed user JSON throws a clear "Malformed {path}: ..." error — NO silent
 *     fallback (D-08, T-1-03 mitigation).
 */
export async function loadRegistry(args: {
  dataDir: string;
}): Promise<TickerRegistry> {
  const overridePath = userOverridePath(args.dataDir);
  // readJsonFile returns null on ENOENT (json-store.ts:51-61) and throws on JSON
  // parse errors. We treat both Zod rejections AND parse errors as "Malformed"
  // so the user sees a single, consistent error shape referencing the file path.
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(overridePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed ${overridePath}: ${detail}`);
  }
  let userEntries: Array<{ underlying: string; roots: string[] }> = [];
  if (raw !== null) {
    const parsed = UnderlyingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Malformed ${overridePath}: ${parsed.error.message}`);
    }
    userEntries = parsed.data.underlyings;
  }
  return new TickerRegistry(defaultsData.underlyings, userEntries);
}

/**
 * Persist user + user-override entries to {dataRoot}/market/underlyings.json.
 * Atomic tmp-then-rename via writeJsonFile (json-store.ts:36-41).
 */
export async function saveUserOverride(
  dataDir: string,
  registry: TickerRegistry,
): Promise<void> {
  const overridePath = userOverridePath(dataDir);
  await writeJsonFile(overridePath, registry.toJSON());
}
