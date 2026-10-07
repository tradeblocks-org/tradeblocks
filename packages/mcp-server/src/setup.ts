import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

const clients = ["claude-desktop", "claude-code", "codex", "gemini"] as const;
type ClientName = (typeof clients)[number];
type Entry = { command: string; args: string[]; env?: Record<string, string>; type?: string };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

class SetupError extends Error {
  status: string;
  constructor(status: string, message: string) {
    super(message);
    this.status = status;
  }
}

async function contents(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SetupError("config_error", `Cannot read ${file}; check file permissions.`);
  }
}

function jsonConfig(text: string | null, file: string): ObjectValue {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SetupError(
      "config_error",
      `Cannot parse ${file} as JSON. Repair it manually first; JSON comments are not rewritten.`,
    );
  }
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) {
    throw new SetupError(
      "config_error",
      `Invalid settings object or mcpServers in ${file}; repair it manually first.`,
    );
  }
  return value;
}

async function executable(name: string): Promise<string> {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const file = path.resolve(dir, name + ext.toLowerCase());
      try {
        await fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        /* Search the remaining PATH. */
      }
    }
  }
  const links: Record<string, string> = {
    npx: "Install Node.js with npm from https://nodejs.org/en/download and reopen your terminal.",
    claude: "Install Claude Code: https://code.claude.com/docs/en/setup",
    codex:
      "Install Codex CLI: npm install -g @openai/codex (https://developers.openai.com/codex/cli/)",
    gemini:
      "Install Gemini CLI: npm install -g @google/gemini-cli (https://geminicli.com/docs/get-started/installation/)",
  };
  throw new SetupError("prerequisite_missing", `${name} is not on PATH. ${links[name]}`);
}

// npm's Windows shims launch a Node script. Launch that script directly, rather
// than handing user paths or secret-bearing argv to cmd.exe for interpolation.
async function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const shim = await fs.readFile(command, "utf8");
    const match = shim.match(/"%dp0%\\([^"\r\n]+\.(?:js|cjs|mjs))"/i);
    if (!match)
      throw new SetupError(
        "prerequisite_missing",
        "Unsupported Windows client launcher; install the official npm or native CLI distribution.",
      );
    args = [path.resolve(path.dirname(command), match[1]), ...args];
    command = process.execPath;
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let tooLarge = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new SetupError(
          "client_error",
          "Client command timed out; check the client installation and retry.",
        ),
      );
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1024 * 1024) {
        tooLarge = true;
        child.kill();
      } else stdout += chunk.toString();
    });
    // Never echo client diagnostics: existing configuration may contain secrets.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new SetupError(
          "client_error",
          "Could not start the client command; check its installation.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: tooLarge ? 1 : (code ?? 1), stdout });
    });
  });
}

async function codexEntry(cli: string, file: string): Promise<unknown> {
  const list = await runCommand(cli, ["mcp", "list", "--json"]);
  if (list.code !== 0)
    throw new SetupError(
      "config_error",
      `Codex cannot read ${file}; repair its TOML/settings before setup.`,
    );
  let servers: unknown;
  try {
    servers = JSON.parse(list.stdout);
  } catch {
    throw new SetupError(
      "client_error",
      "Codex did not return a JSON server list; update the CLI.",
    );
  }
  if (!Array.isArray(servers))
    throw new SetupError("client_error", "Codex returned an invalid server list.");
  if (!servers.some((s: unknown) => object(s) && s.name === "tradeblocks")) return undefined;
  const get = await runCommand(cli, ["mcp", "get", "tradeblocks", "--json"]);
  let server: unknown;
  try {
    server = JSON.parse(get.stdout);
  } catch {
    /* Report without client content. */
  }
  if (get.code !== 0 || !object(server) || !object(server.transport))
    throw new SetupError(
      "client_error",
      `Cannot read the existing Codex tradeblocks entry in ${file}.`,
    );
  return { ...server.transport, disabled: server.enabled === false };
}

function environment(entry: unknown, file: string): Record<string, string> {
  if (!object(entry) || entry.env === undefined || entry.env === null) return {};
  if (!object(entry.env) || Object.values(entry.env).some((v) => typeof v !== "string")) {
    throw new SetupError(
      "config_error",
      `Invalid tradeblocks env in ${file}; repair it before replacing the entry.`,
    );
  }
  return entry.env as Record<string, string>;
}

function equivalent(existing: unknown, desired: Entry): boolean {
  return (
    object(existing) &&
    existing.command === desired.command &&
    Array.isArray(existing.args) &&
    JSON.stringify(existing.args) === JSON.stringify(desired.args) &&
    (existing.type === undefined || existing.type === "stdio") &&
    existing.disabled !== true &&
    (existing.cwd === undefined || existing.cwd === null) &&
    (existing.env_vars === undefined ||
      (Array.isArray(existing.env_vars) && existing.env_vars.length === 0))
  );
}

async function verify(entry: Entry): Promise<ObjectValue> {
  const client = new Client({ name: "tradeblocks-setup", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...getDefaultEnvironment(), ...entry.env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    /* Drain without exposing diagnostics or credentials. */
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const info = client.getServerVersion();
        let count = 0;
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          count += page.tools.length;
          cursor = page.nextCursor;
        } while (cursor);
        if (!info || !count) throw new Error("No tools");
        return {
          initialized: true,
          serverName: info.name,
          serverVersion: info.version,
          toolCount: count,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout")), 30_000);
      }),
    ]);
  } catch {
    return {
      initialized: false,
      error:
        "The configured server did not complete MCP initialize and tools/list within 30 seconds. Check Node/npm, network access to npm, folder permissions, and any existing server environment settings.",
    };
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}

export async function runSetup(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const interactive = !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const prompt = interactive
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  const result: ObjectValue = {
    status: "invalid_arguments",
    client: null,
    folder: null,
    plannedChange: null,
    appliedChange: null,
    verification: { initialized: false, skipped: true },
    clientActionNeeded: null,
    nextSteps: [],
  };
  const emit = () => {
    if (json) console.log(JSON.stringify(result));
    else console.log(JSON.stringify(result, null, 2));
  };
  try {
    let client: string | undefined;
    let folder: string | undefined;
    let yes = false;
    let replace = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json") continue;
      if (arg === "--yes") yes = true;
      else if (arg === "--replace") replace = true;
      else if (
        (arg === "--client" || arg === "--folder") &&
        args[i + 1] &&
        !args[i + 1].startsWith("--")
      ) {
        if (arg === "--client") client = args[++i];
        else folder = args[++i];
      } else
        throw new SetupError(
          "invalid_arguments",
          "Usage: tradeblocks-mcp setup --client <claude-desktop|claude-code|codex|gemini> --folder <path> [--yes] [--replace] [--json]",
        );
    }
    if (!client && prompt) client = await prompt.question(`Client (${clients.join(", ")}): `);
    if (!folder && prompt)
      folder = await prompt.question("Data folder (absolute or relative path): ");
    if (!clients.includes(client as ClientName) || !folder?.trim())
      throw new SetupError(
        "invalid_arguments",
        "Provide a supported --client and --folder. Non-interactive setup never prompts.",
      );
    folder = path.resolve(
      folder === "~"
        ? homedir()
        : folder.startsWith("~/")
          ? path.join(homedir(), folder.slice(2))
          : folder,
    );
    result.client = client;
    result.folder = folder;
    result.clientActionNeeded =
      client === "claude-desktop"
        ? "Restart/reopen Claude Desktop to load the registration."
        : "Start a new client session to load the registration.";
    const nextSteps = [
      "Verification checks the configured server subprocess, not a connection from your AI client. No OO or provider credentials are required.",
    ];
    if (client === "claude-code")
      nextSteps.push(
        "Optional, separate tradeblocks-skills plugin: https://github.com/tradeblocks-org/tradeblocks-skills (not installed by setup).",
      );
    result.nextSteps = nextSteps;
    const manifest = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    const minimum = Number(manifest.engines.node.match(/^>=(\d+)$/)?.[1]);
    if (!minimum || Number(process.versions.node.split(".")[0]) < minimum)
      throw new SetupError(
        "prerequisite_missing",
        `Node ${manifest.engines.node} is required. Install Node with npm from https://nodejs.org/en/download and reopen the terminal.`,
      );
    const npx = await executable("npx");
    const cli =
      client === "claude-desktop"
        ? undefined
        : await executable(client === "claude-code" ? "claude" : client!);
    let file: string;
    if (client === "claude-desktop") {
      file =
        process.platform === "darwin"
          ? path.join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
          : process.platform === "win32"
            ? path.join(
                process.env.APPDATA || path.join(homedir(), "AppData/Roaming"),
                "Claude/claude_desktop_config.json",
              )
            : path.join(homedir(), ".config/Claude/claude_desktop_config.json");
      try {
        if (!(await fs.stat(path.dirname(file))).isDirectory()) throw new Error();
      } catch {
        throw new SetupError(
          "prerequisite_missing",
          `Claude Desktop configuration directory is absent: ${path.dirname(file)}. Install/open Claude Desktop first (https://claude.ai/download). On Linux use your Desktop distribution's documented setup.`,
        );
      }
    } else if (client === "claude-code")
      file = path.join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
    else if (client === "codex")
      file = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "config.toml");
    else file = path.join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini/settings.json");
    const before = await contents(file);
    const config = client === "codex" ? undefined : jsonConfig(before, file);
    const existing =
      client === "codex"
        ? await codexEntry(cli!, file)
        : (config!.mcpServers as ObjectValue | undefined)?.tradeblocks;
    const env = environment(existing, file);
    const entry: Entry = {
      command: npx,
      args: ["-y", "tradeblocks-mcp", folder],
      ...(Object.keys(env).length ? { env } : {}),
    };
    if (client === "claude-desktop" && env.PATH === undefined && !equivalent(existing, entry)) {
      env.PATH = [path.dirname(process.execPath), path.dirname(npx), process.env.PATH || ""].join(
        path.delimiter,
      );
      entry.env = env;
    }
    const already = equivalent(existing, entry);
    const conflict = existing !== undefined && !already;
    let createFolder = false;
    try {
      if (!(await fs.stat(folder)).isDirectory())
        throw new SetupError("folder_error", "The selected data folder is not a directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") createFolder = true;
      else throw error;
    }
    const backup =
      before !== null &&
      !already &&
      (client === "claude-desktop" || (client === "claude-code" && conflict))
        ? `${file}.backup-${randomUUID()}`
        : null;
    const envArgs = Object.entries(env).flatMap(([key, value]) => [
      client === "codex" ? "--env" : "-e",
      `${key}=${value}`,
    ]);
    const addArgs =
      client === "claude-code"
        ? [
            "mcp",
            "add",
            "-s",
            "user",
            "-t",
            "stdio",
            "tradeblocks",
            ...envArgs,
            "--",
            entry.command,
            ...entry.args,
          ]
        : client === "codex"
          ? ["mcp", "add", "tradeblocks", ...envArgs, "--", entry.command, ...entry.args]
          : [
              "mcp",
              "add",
              "-s",
              "user",
              "-t",
              "stdio",
              "tradeblocks",
              ...envArgs,
              entry.command,
              ...entry.args,
            ];
    const publicArgs = addArgs.map((arg) =>
      envArgs.includes(arg) && arg.includes("=") ? `${arg.split("=")[0]}=<preserved>` : arg,
    );
    result.plannedChange = {
      file,
      entry: {
        name: "tradeblocks",
        type: "stdio",
        command: entry.command,
        args: entry.args,
        envKeys: Object.keys(env),
      },
      command: cli && !already ? { executable: cli, args: publicArgs } : null,
      removeCommand:
        client === "claude-code" && conflict
          ? { executable: cli, args: ["mcp", "remove", "-s", "user", "tradeblocks"] }
          : null,
      backup,
      createFolder,
      alreadyConfigured: already,
      conflict: conflict
        ? {
            differingFields: object(existing)
              ? Object.keys(existing).filter(
                  (key) =>
                    key !== "env" &&
                    JSON.stringify(existing[key]) !==
                      JSON.stringify((entry as unknown as ObjectValue)[key]),
                )
              : ["entry"],
            envKeys: Object.keys(env),
            behavior:
              "Replace launch settings; preserve every existing env key and value. Other tradeblocks-specific settings are removed. Unrelated settings remain unchanged.",
          }
        : null,
    };
    // Show the preview before writing, including with --yes. JSON mode keeps
    // stdout to one final result; the earlier preview goes to stderr.
    console.error("Preview:\n" + JSON.stringify(result.plannedChange, null, 2));
    if (
      conflict &&
      !replace &&
      !(
        prompt &&
        /^y(es)?$/i.test(
          await prompt.question(
            "Replace the conflicting tradeblocks entry (keeping its env)? [y/N] ",
          ),
        )
      )
    ) {
      result.status = "conflict";
      nextSteps.push("Review the differing fields. To replace, use --replace together with --yes.");
      emit();
      return 1;
    }
    if (
      (!already || createFolder) &&
      !yes &&
      !(prompt && /^y(es)?$/i.test(await prompt.question("Apply the previewed changes? [y/N] ")))
    ) {
      result.status = "consent_required";
      nextSteps.push("No changes made. Review the preview and rerun with --yes to consent.");
      emit();
      return 1;
    }
    if ((await contents(file)) !== before)
      throw new SetupError(
        "config_error",
        `Configuration changed during setup: ${file}. Nothing written; rerun to review the new preview.`,
      );
    if (createFolder) await fs.mkdir(folder, { recursive: true });
    if (!already) {
      if (client === "claude-desktop") {
        const mode = before !== null ? (await fs.stat(file)).mode & 0o777 : 0o600;
        const updated = {
          ...config,
          mcpServers: { ...(config!.mcpServers as ObjectValue), tradeblocks: entry },
        };
        const indentation = before?.match(/\n([\t ]+)"/)?.[1] || "  ";
        const temp = `${file}.tmp-${randomUUID()}`;
        try {
          if (backup) await fs.copyFile(file, backup, constants.COPYFILE_EXCL);
          await fs.writeFile(temp, JSON.stringify(updated, null, indentation) + "\n", {
            flag: "wx",
            mode,
          });
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true });
        }
      } else {
        if (backup) await fs.copyFile(file, backup, constants.COPYFILE_EXCL);
        try {
          if (client === "claude-code" && conflict) {
            if ((await runCommand(cli!, ["mcp", "remove", "-s", "user", "tradeblocks"])).code !== 0)
              throw new SetupError(
                "client_error",
                `Client failed to remove the conflicting entry in ${file}; inspect that file before retrying.`,
              );
          }
          if ((await runCommand(cli!, addArgs)).code !== 0)
            throw new SetupError(
              "client_error",
              `Client registration failed for ${file}; inspect its settings before retrying. Client diagnostics are withheld to protect secrets.`,
            );
        } catch (error) {
          if (backup) {
            const temp = `${file}.restore-${randomUUID()}`;
            try {
              await fs.copyFile(backup, temp, constants.COPYFILE_EXCL);
              await fs.rename(temp, file);
            } finally {
              await fs.rm(temp, { force: true });
            }
          }
          throw error;
        }
      }
      result.appliedChange = { file, backup, createdFolder: createFolder, registered: true };
    } else if (createFolder) result.appliedChange = { createdFolder: true };
    const readback =
      client === "codex"
        ? await codexEntry(cli!, file)
        : (jsonConfig(await contents(file), file).mcpServers as ObjectValue | undefined)
            ?.tradeblocks;
    const readbackEnv = environment(readback, file);
    if (
      !equivalent(readback, entry) ||
      Object.keys(readbackEnv).length !== Object.keys(env).length ||
      Object.keys(env).some((key) => readbackEnv[key] !== env[key])
    )
      throw new SetupError(
        "client_error",
        `Registration read-back did not match the preview in ${file}; inspect settings before retrying.`,
      );
    result.verification = await verify({
      command: (readback as Entry).command,
      args: (readback as Entry).args,
      env: environment(readback, file),
    });
    result.status = (result.verification as ObjectValue).initialized
      ? already
        ? "already_configured"
        : "configured"
      : "verification_failed";
    emit();
    return (result.verification as ObjectValue).initialized ? 0 : 1;
  } catch (error) {
    result.status = error instanceof SetupError ? error.status : "setup_error";
    // Unexpected filesystem/client errors can include secret data. Do not echo them.
    (result.nextSteps as string[]).push(
      error instanceof SetupError
        ? error.message
        : "Setup could not complete. Check folder/configuration permissions and retry; no verification success is claimed.",
    );
    emit();
    return 1;
  } finally {
    prompt?.close();
  }
}
