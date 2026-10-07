// Stateful adapters for the external client commands on CI. They persist each
// vendor's format; the configured npx adapter still runs the real MCP server.
import * as fs from "node:fs";
import * as path from "node:path";
const [client, ...args] = process.argv.slice(2);
const file =
  client === "claude"
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : client === "codex"
      ? path.join(process.env.CODEX_HOME, "config.toml")
      : path.join(process.env.GEMINI_CLI_HOME, ".gemini/settings.json");
let config = {};
if (fs.existsSync(file)) {
  const text = fs.readFileSync(file, "utf8");
  try {
    if (client !== "codex") config = JSON.parse(text);
    else {
      // The fixture only needs TOML scalar/array assignments and server tables.
      let table = config;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const header = trimmed.match(/^\[mcp_servers\.([\w-]+)(\.env)?\]$/);
        if (header) {
          config.mcp_servers ??= {};
          config.mcp_servers[header[1]] ??= {};
          table = config.mcp_servers[header[1]];
          if (header[2]) table = table.env ??= {};
        } else {
          const assignment = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
          if (!assignment) throw new Error("Malformed TOML");
          table[assignment[1]] = JSON.parse(assignment[2]);
        }
      }
    }
  } catch {
    console.error("Malformed settings");
    process.exit(1);
  }
}
const servers = (config[client === "codex" ? "mcp_servers" : "mcpServers"] ??= {});
if (args[0] !== "mcp") process.exit(2);
if (args[1] === "list") {
  console.log(JSON.stringify(Object.keys(servers).map((name) => ({ name }))));
  process.exit(0);
}
if (args[1] === "get") {
  if (!servers.tradeblocks) process.exit(1);
  console.log(
    JSON.stringify({
      name: "tradeblocks",
      enabled: true,
      disabled_reason: null,
      enabled_tools: servers.tradeblocks.enabled_tools ?? null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      transport: { type: "stdio", env_vars: [], cwd: null, ...servers.tradeblocks },
    }),
  );
  process.exit(0);
}
if (args[1] === "remove") {
  if (client !== "claude" || args.join(" ") !== "mcp remove -s user tradeblocks") process.exit(2);
  delete servers.tradeblocks;
} else if (args[1] === "add") {
  let rest = args.slice(2);
  if (client === "codex") {
    if (rest.shift() !== "tradeblocks") process.exit(2);
  } else {
    if (rest.splice(0, 5).join(" ") !== "-s user -t stdio tradeblocks") process.exit(2);
  }
  const env = {};
  while (rest[0] === "--env" || rest[0] === "-e") {
    rest.shift();
    const item = rest.shift();
    const split = item.indexOf("=");
    env[item.slice(0, split)] = client === "gemini" ? item.split("=")[1] : item.slice(split + 1);
  }
  if (client !== "gemini") {
    if (rest.shift() !== "--") process.exit(2);
  }
  if (client === "claude" && servers.tradeblocks) process.exit(1);
  servers.tradeblocks = {
    command: rest.shift(),
    args: rest,
    ...(Object.keys(env).length ? { env } : {}),
  };
} else process.exit(2);
fs.mkdirSync(path.dirname(file), { recursive: true });
if (client !== "codex") fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
else {
  let text = "";
  for (const [key, value] of Object.entries(config))
    if (key !== "mcp_servers") text += `${key} = ${JSON.stringify(value)}\n`;
  for (const [name, entry] of Object.entries(servers)) {
    text += `\n[mcp_servers.${name}]\n`;
    for (const [key, value] of Object.entries(entry))
      if (key !== "env") text += `${key} = ${JSON.stringify(value)}\n`;
    if (entry.env) {
      text += `[mcp_servers.${name}.env]\n`;
      for (const [key, value] of Object.entries(entry.env))
        text += `${key} = ${JSON.stringify(value)}\n`;
    }
  }
  fs.writeFileSync(file, text);
}
// Do not fake a verification receipt: setup must launch the persisted entry.
console.log("Registered");
