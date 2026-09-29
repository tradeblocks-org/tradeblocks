/**
 * Undeclared arguments are refused, not silently dropped (enterprise#4197).
 *
 * Runs the real stdio server, so the refusal is proven through the same registration
 * path and SDK validation a client reaches, for every tool family and every prompt.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dirname, "../..");

function text(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("\n");
}

it("refuses undeclared tool and prompt arguments by name and runs nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "tb-unknown-args-"));
  const client = new Client({ name: "unknown-arguments-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", join(packageDir, "src/index.ts"), dataDir],
    cwd: resolve(packageDir, "../.."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);

    // Every tool advertises a closed input object and refuses two undeclared keys,
    // naming the tool and both keys.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect([tool.name, tool.inputSchema.additionalProperties]).toEqual([tool.name, false]);
      const refused = await client.callTool({
        name: tool.name,
        arguments: { unexpectedAlpha: 1, unexpectedBeta: "x" },
      });
      expect([tool.name, refused.isError]).toEqual([tool.name, true]);
      const message = text(refused);
      expect(message).toContain(`Invalid arguments for tool ${tool.name}`);
      expect(message).toContain('"unexpectedAlpha"');
      expect(message).toContain('"unexpectedBeta"');
    }

    // A call that is otherwise valid still refuses, and the handler never runs:
    // an import with an option this server lacks creates no block.
    const csvPath = join(dataDir, "trades.csv");
    await writeFile(
      csvPath,
      "Date Opened,Date Closed,P/L,Strategy,Legs\n2024-01-02,2024-01-02,100,Alpha,SPY\n",
    );
    const before = await readdir(dataDir);
    const importArgs = { csvPath, blockName: "strict-args", csvType: "tradelog" };
    const refusedImport = await client.callTool({
      name: "import_csv",
      arguments: { ...importArgs, ooCurvePath: join(dataDir, "curve.csv") },
    });
    expect(refusedImport.isError).toBe(true);
    expect(text(refusedImport)).toContain('"ooCurvePath"');
    expect(await readdir(dataDir)).toEqual(before);

    // Declared arguments alone keep working.
    const imported = await client.callTool({ name: "import_csv", arguments: importArgs });
    expect([text(imported), imported.isError]).toEqual([text(imported), undefined]);

    // Prompts refuse an undeclared argument by name; declared and omitted ones render.
    await expect(
      client.getPrompt({
        name: "bring-in-oo-backtest",
        arguments: { ooId: "saved-1", unexpectedPromptArg: "x" },
      }),
    ).rejects.toThrow(/unexpectedPromptArg/);
    const rendered = await client.getPrompt({
      name: "bring-in-oo-backtest",
      arguments: { ooId: "saved-1" },
    });
    expect(rendered.messages).toHaveLength(1);
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);
