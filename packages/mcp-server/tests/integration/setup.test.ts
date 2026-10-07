import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const packageDir = resolve(import.meta.dirname, "../..");
const binary = join(
  packageDir,
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin["tradeblocks-mcp"],
);
let home: string;
let env: NodeJS.ProcessEnv;
let file: string;

async function writeExecutable(name: string, script: string) {
  if (process.platform === "win32") {
    await writeFile(join(home, "bin", `${name}.cjs`), script);
    await writeFile(
      join(home, "bin", `${name}.cmd`),
      `@"${process.execPath}" "%dp0%\\${name}.cjs" %*\r\n`,
    );
  } else
    await writeFile(join(home, "bin", name), `#!${process.execPath}\n${script}`, { mode: 0o755 });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tb-setup-"));
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    GEMINI_CLI_HOME: home,
    APPDATA: join(home, "appdata"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: join(home, "bin"),
  };
  file =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Claude/claude_desktop_config.json")
      : process.platform === "win32"
        ? join(home, "appdata/Claude/claude_desktop_config.json")
        : join(home, ".config/Claude/claude_desktop_config.json");
  await mkdir(resolve(file, ".."), { recursive: true });
  await mkdir(join(home, "bin"));
  await mkdir(env.CODEX_HOME!, { recursive: true });
  for (const client of ["claude", "codex", "gemini"]) {
    // The fixture's first argument identifies the external command, not a
    // shipping setup flag or injected production dependency.
    await writeExecutable(
      client,
      `process.argv.splice(2,0,${JSON.stringify(client)}); import(require('node:url').pathToFileURL(${JSON.stringify(join(packageDir, "tests/fixtures/setup-client.mjs"))}).href);`,
    );
  }
  // A local npx command adapter executes the real built server, never npm/network.
  await writeExecutable(
    "npx",
    `const {spawn}=require('node:child_process'); const args=process.argv.slice(2); if(args[0]!=='-y'||args[1]!=='tradeblocks-mcp') process.exit(2); const p=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(binary)},...args.slice(2)],{stdio:'inherit'}); p.on('exit',c=>process.exit(c??1));`,
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup(extra: string[] = [], client = "claude-desktop", nodeArgs: string[] = []) {
  const child = spawnSync(
    process.execPath,
    [
      ...nodeArgs,
      binary,
      "setup",
      "--client",
      client,
      "--folder",
      join(home, "data with spaces"),
      "--json",
      ...extra,
    ],
    { env, encoding: "utf8", timeout: 45_000 },
  );
  expect(child.error).toBeUndefined();
  return {
    code: child.status,
    result: JSON.parse(child.stdout),
    output: child.stdout + child.stderr,
    stderr: child.stderr,
  };
}

it("configures Desktop and proves real MCP initialization and tool discovery, then reruns without writing", async () => {
  const first = setup(["--yes"]);
  expect(first.code).toBe(0);
  expect(first.result.status).toBe("configured");
  expect(first.result.verification).toMatchObject({
    initialized: true,
    serverName: "tradeblocks-mcp",
  });
  expect(first.result.verification.toolCount).toBeGreaterThan(50);
  const written = await readFile(file, "utf8");
  expect(JSON.parse(written).mcpServers.tradeblocks.args).toEqual([
    "-y",
    "tradeblocks-mcp",
    join(home, "data with spaces"),
  ]);
  const second = setup();
  expect(second.code).toBe(0);
  expect(second.result.status).toBe("already_configured");
  expect(second.result.appliedChange).toBeNull();
  expect(second.result.verification.initialized).toBe(true);
  expect(await readFile(file, "utf8")).toBe(written);
}, 90_000);

it("requires explicit consent in JSON and piped human modes before creating either config or data", async () => {
  const no = setup();
  expect(no.code).toBe(1);
  expect(no.result.status).toBe("consent_required");
  expect(no.result.plannedChange.createFolder).toBe(true);
  const preview = JSON.parse(no.stderr.slice(no.stderr.indexOf("{")));
  expect(preview.file).toBe(file);
  expect(preview.entry).toMatchObject({
    name: "tradeblocks",
    type: "stdio",
    args: ["-y", "tradeblocks-mcp", join(home, "data with spaces")],
  });
  expect(no.result.appliedChange).toBeNull();
  await expect(access(file)).rejects.toThrow();
  await expect(access(join(home, "data with spaces"))).rejects.toThrow();
  const piped = spawnSync(
    process.execPath,
    [binary, "setup", "--client", "claude-desktop", "--folder", join(home, "piped data")],
    { env, input: "y\n", encoding: "utf8", timeout: 5_000 },
  );
  expect(piped.status).toBe(1);
  expect(() => JSON.parse(piped.stdout)).toThrow();
  expect(piped.stdout).toContain("consent required");
  expect(piped.stderr).toContain(file);
  expect(piped.stderr).toContain(`'${join(home, "piped data")}'`);
  await expect(access(file)).rejects.toThrow();
});

it("requires distinct replacement consent, preserves secrets and unrelated settings, and retains a backup", async () => {
  const other = {
    command: "other",
    env: { OTHER_SECRET: "do-not-expose-other" },
    args: ["unchanged"],
  };
  const original = JSON.stringify(
    {
      theme: "dark",
      nested: { retained: [1, 2] },
      mcpServers: {
        other,
        tradeblocks: {
          command: "old-command",
          args: ["do-not-expose-arg"],
          env: { DEMO_SECRET: "do-not-expose-value" },
        },
      },
    },
    null,
    4,
  );
  await writeFile(file, original);
  for (const flags of [[], ["--yes"], ["--replace"]]) {
    const denied = setup(flags);
    expect(denied.code).toBe(1);
    expect(["conflict", "consent_required"]).toContain(denied.result.status);
    expect(denied.output).not.toContain("do-not-expose");
    expect(await readFile(file, "utf8")).toBe(original);
  }
  const replaced = setup(["--yes", "--replace"]);
  expect(replaced.code).toBe(0);
  expect(replaced.output).not.toContain("do-not-expose");
  const updated = JSON.parse(await readFile(file, "utf8"));
  expect(updated.theme).toBe("dark");
  expect(updated.nested).toEqual({ retained: [1, 2] });
  expect(updated.mcpServers.other).toEqual(other);
  expect(updated.mcpServers.tradeblocks.env.DEMO_SECRET).toBe("do-not-expose-value");
  expect(await readFile(replaced.result.appliedChange.backup, "utf8")).toBe(original);
});

it.each(["claude-desktop", "claude-code", "codex", "gemini"])(
  "refuses malformed %s config without changing any bytes",
  async (client) => {
    const target =
      client === "claude-desktop"
        ? file
        : client === "claude-code"
          ? join(env.CLAUDE_CONFIG_DIR!, ".claude.json")
          : client === "codex"
            ? join(env.CODEX_HOME!, "config.toml")
            : join(home, ".gemini/settings.json");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, '{ invalid: "do-not-expose-secret"');
    const denied = setup(["--yes", "--replace"], client);
    expect(denied.code).toBe(1);
    expect(denied.result.status).toBe("config_error");
    expect(denied.output).toContain(target);
    expect(denied.output).not.toContain("do-not-expose-secret");
    expect(await readFile(target, "utf8")).toBe('{ invalid: "do-not-expose-secret"');
    await expect(access(join(home, "data with spaces"))).rejects.toThrow();
  },
);

it.each(["claude-code", "codex", "gemini"])(
  "registers %s through its user command and verifies persisted argv, then protects and replaces conflicts",
  async (client) => {
    const target =
      client === "claude-code"
        ? join(env.CLAUDE_CONFIG_DIR!, ".claude.json")
        : client === "codex"
          ? join(env.CODEX_HOME!, "config.toml")
          : join(home, ".gemini/settings.json");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial =
      client === "codex"
        ? 'model = "keep-model"\n[mcp_servers.other]\ncommand = "keep-command"\n'
        : JSON.stringify({
            theme: "keep-theme",
            mcpServers: { other: { command: "keep-command" } },
          });
    await writeFile(target, initial);
    const first = setup(["--yes"], client);
    expect(first.code).toBe(0);
    expect(first.result.verification.initialized).toBe(true);
    expect(first.result.verification.toolCount).toBeGreaterThan(50);
    const registered = await readFile(target, "utf8");
    expect(registered).toContain("keep-command");
    expect(registered).toContain(client === "codex" ? "keep-model" : "keep-theme");
    const again = setup([], client);
    expect(again.code).toBe(0);
    expect(again.result.status).toBe("already_configured");
    expect(await readFile(target, "utf8")).toBe(registered);
    // Real persistence, not a fixture receipt, controls rerun and replacement.
    let conflicting = registered.replace("data with spaces", "old folder");
    if (client === "codex")
      conflicting +=
        '\n[mcp_servers.tradeblocks.env]\nZ_SECRET = "do-not-expose-z"\nA_SECRET = "do-not-expose-a"\n';
    else {
      const config = JSON.parse(conflicting);
      config.mcpServers.tradeblocks.env = {
        Z_SECRET: "do-not-expose-z",
        A_SECRET: "do-not-expose-a",
      };
      conflicting = JSON.stringify(config);
    }
    await writeFile(target, conflicting);
    const conflict = await readFile(target, "utf8");
    expect(setup(["--yes"], client).result.status).toBe("conflict");
    expect(await readFile(target, "utf8")).toBe(conflict);
    const replaced = setup(["--yes", "--replace"], client);
    expect(replaced.code).toBe(0);
    expect(replaced.result.verification.initialized).toBe(true);
    expect(await readFile(target, "utf8")).toContain("keep-command");
    expect(replaced.output).not.toContain("do-not-expose");
    const final = await readFile(target, "utf8");
    expect(final).toContain("do-not-expose-z");
    expect(final).toContain("do-not-expose-a");
  },
  90_000,
);

it("reports absent prerequisites without writes", async () => {
  await rm(join(home, "bin", process.platform === "win32" ? "npx.cmd" : "npx"));
  const missingNpx = setup(["--yes"]);
  expect(missingNpx.result.status).toBe("prerequisite_missing");
  expect(missingNpx.result.nextSteps.join(" ")).toContain("nodejs.org");
  expect(missingNpx.code).toBe(1);
  await expect(access(file)).rejects.toThrow();
});

it.each(["claude-code", "codex", "gemini"])(
  "reports missing %s without installing it or writing configuration",
  async (client) => {
    const command = client === "claude-code" ? "claude" : client;
    await rm(join(home, "bin", command + (process.platform === "win32" ? ".cmd" : "")));
    const missing = setup(["--yes"], client);
    expect(missing.code).toBe(1);
    expect(missing.result.status).toBe("prerequisite_missing");
    expect(missing.result.appliedChange).toBeNull();
  },
);

it("refuses an absent Desktop directory and unreadable configuration", async () => {
  await rm(resolve(file, ".."), { recursive: true });
  expect(setup(["--yes"]).result.status).toBe("prerequisite_missing");
  await mkdir(file, { recursive: true });
  const unreadable = setup(["--yes"]);
  expect(unreadable.code).toBe(1);
  expect(unreadable.result.status).toBe("config_error");
});

it("never calls registration alone a successful MCP verification", async () => {
  await writeExecutable("npx", "process.stderr.write('do-not-expose-diagnostic');process.exit(1);");
  const failed = setup(["--yes"]);
  expect(failed.code).toBe(1);
  expect(failed.result.status).toBe("verification_failed");
  expect(failed.result.appliedChange.registered).toBe(true);
  expect(failed.result.verification.initialized).toBe(false);
  expect(failed.output).not.toContain("do-not-expose-diagnostic");
});

it("keeps help and all retained skill instruction commands compatible", () => {
  for (const command of ["--help", "install-skills", "uninstall-skills", "check-skills"]) {
    const child = spawnSync(process.execPath, [binary, command], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(
      command === "--help" ? "setup" : "/plugin install tradeblocks@tradeblocks-skills",
    );
  }
});

it.each(["positional", "environment"])(
  "retains built stdio %s invocation and folder/options configuration",
  async (mode) => {
    const data = join(home, "existing data");
    const blocks = join(home, "csv blocks");
    const shared = join(home, "shared data");
    await mkdir(data);
    await mkdir(blocks);
    await mkdir(shared);
    const serverEnv = Object.fromEntries(
      Object.entries({
        ...env,
        BLOCKS_DIRECTORY: data,
        TRADEBLOCKS_BLOCKS_DIR: blocks,
        TRADEBLOCKS_DATA_ROOT: shared,
        MARKET_DB_PATH: join(home, "market.duckdb"),
      }).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    );
    const client = new Client({ name: "setup-compatibility", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        binary,
        ...(mode === "positional"
          ? [
              data,
              "--blocks-dir",
              blocks,
              "--data-root",
              shared,
              "--market-db",
              join(home, "market.duckdb"),
              "--no-auth",
            ]
          : []),
      ],
      env: serverEnv,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("tradeblocks-mcp");
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "list_blocks")).toBe(true);
      const listing = await client.callTool({ name: "list_blocks", arguments: {} });
      expect(listing.isError).not.toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  },
  60_000,
);

it("retains built HTTP, custom port and no-auth invocation with real MCP discovery", async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  socket.close();
  await once(socket, "close");
  const data = join(home, "http data");
  await mkdir(data);
  const child = spawn(
    process.execPath,
    [binary, "--http", "--port", String(port), "--no-auth", data],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.resume();
  const client = new Client({ name: "setup-http-compatibility", version: "1" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        ready = response.ok;
        if (ready) break;
      } catch {
        /* Wait for the real listener. */
      }
      await delay(100);
    }
    expect(ready).toBe(true);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    expect(client.getServerVersion()?.name).toBe("tradeblocks-mcp");
    expect((await client.listTools()).tools.some((tool) => tool.name === "list_blocks")).toBe(true);
  } finally {
    await client.close();
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}, 30_000);

it("returns actionable unsupported-Node guidance before loading setup, without writing", async () => {
  const result = setup(["--yes"], "claude-desktop", [
    "--require",
    join(packageDir, "tests/fixtures/setup-old-node.cjs"),
  ]);
  expect(result.code).toBe(1);
  expect(result.result.status).toBe("prerequisite_missing");
  expect(result.result.nextSteps.join(" ")).toContain("nodejs.org/en/download");
  expect(result.result.appliedChange).toBeNull();
  await expect(access(file)).rejects.toThrow();
  await expect(access(join(home, "data with spaces"))).rejects.toThrow();
});

it("presents the human preview and verified result as prose, keeping environment values private", async () => {
  await writeFile(
    file,
    JSON.stringify({
      mcpServers: { tradeblocks: { command: "old", env: { PRIVATE_NOTE: "do-not-expose-human" } } },
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      binary,
      "setup",
      "--client",
      "claude-desktop",
      "--folder",
      join(home, "data with spaces"),
      "--yes",
      "--replace",
    ],
    { env, encoding: "utf8", timeout: 130_000 },
  );
  expect(child.status).toBe(0);
  expect(() => JSON.parse(child.stdout)).toThrow();
  expect(child.stdout).toContain("tradeblocks-mcp");
  expect(Number(child.stdout.match(/(\d+) tools discovered/)?.[1])).toBeGreaterThan(50);
  expect(child.stdout).toMatch(/restart|reopen/i);
  expect(child.stderr).toContain(file);
  expect(child.stderr).toContain(`'${join(home, "data with spaces")}'`);
  expect(child.stderr).toContain("PRIVATE_NOTE");
  expect(child.stderr).toContain("120 seconds");
  expect(child.stderr).toMatch(/download.*DuckDB/);
  expect(child.stderr).not.toContain('"envKeys"');
  expect(child.stdout + child.stderr).not.toContain("do-not-expose-human");
}, 140_000);

it("presents unsupported-Node human guidance using the declared engine rather than JSON", () => {
  const child = spawnSync(
    process.execPath,
    ["--require", join(packageDir, "tests/fixtures/setup-old-node.cjs"), binary, "setup"],
    { env, encoding: "utf8", timeout: 5_000 },
  );
  expect(child.status).toBe(1);
  expect(() => JSON.parse(child.stdout)).toThrow();
  expect(child.stdout).toContain(
    JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).engines.node,
  );
  expect(child.stdout).toContain("nodejs.org/en/download");
});
