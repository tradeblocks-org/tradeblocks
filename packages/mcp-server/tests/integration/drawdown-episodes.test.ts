import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it, expect } from "@jest/globals";

describe("drawdown_attribution episode transport", () => {
  it("keeps default bytes and exposes ranked sequence windows with independent caps", async () => {
    const packageDir = resolve(import.meta.dirname, "../..");
    const root = await mkdtemp(join(tmpdir(), "tb-dd-episodes-"));
    const client = new Client({ name: "drawdown-episodes-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", join(packageDir, "src/index.ts"), root],
      cwd: resolve(packageDir, "../.."),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const csvPath = join(root, "trades.csv");
      await writeFile(
        csvPath,
        [
          "Date Opened,Time Opened,Date Closed,Time Closed,P/L,Strategy,Funds at Close",
          "2026-01-05,09:30:00,2026-01-05,15:00:00,100,Peak,1100",
          "2026-01-05,09:30:00,2026-01-05,15:01:00,-200,B,900",
          "2026-01-05,09:30:00,2026-01-05,15:02:00,50,A,950",
          "2026-01-05,09:30:00,2026-01-05,15:03:00,-150,B,800",
          "2026-01-06,09:30:00,2026-01-06,15:00:00,300,Recovery,1100",
          "2026-01-07,09:30:00,2026-01-07,15:00:00,-300,C,800",
          "",
        ].join("\n"),
      );
      const imported = await client.callTool({
        name: "import_csv",
        arguments: { csvPath, blockName: "Episodes" },
      });
      expect(imported.isError).not.toBe(true);
      const call = async (args: Record<string, unknown> = {}) =>
        client.callTool({
          name: "drawdown_attribution",
          arguments: { blockId: "episodes", topN: 1, ...args },
        });
      const legacy = await call();
      expect(legacy.isError).not.toBe(true);
      expect(JSON.stringify(legacy.structuredContent)).toBe(
        '{"blockId":"episodes","filters":{"strategy":null,"topN":1},"drawdownPeriod":{"peakDate":"2026-01-05","troughDate":"2026-01-05","peakEquity":1100,"troughEquity":800,"maxDrawdown":300,"maxDrawdownPct":27.27272727272727,"durationDays":0},"periodStats":{"totalTrades":4,"totalPl":-200},"attribution":[{"strategy":"B","pl":-350,"trades":2,"wins":0,"losses":2,"contributionPct":175}]}',
      );
      const ranked = await call({ episodeCount: 20 });
      expect(ranked.isError).not.toBe(true);
      const data = ranked.structuredContent as {
        episodes: Array<{
          drawdownPeriod: Record<string, unknown>;
          periodStats: { totalTrades: number; totalPl: number };
          attribution: Array<{ strategy: string; pl: number }>;
        }>;
      };
      expect(data.episodes).toMatchObject([
        {
          drawdownPeriod: {
            peakEquity: 1100,
            troughEquity: 800,
            maxDrawdown: 300,
            recoveryDate: "2026-01-06",
          },
          periodStats: { totalTrades: 3, totalPl: -300 },
          attribution: [{ strategy: "B", pl: -350 }],
        },
        {
          drawdownPeriod: {
            peakDate: "2026-01-06",
            troughDate: "2026-01-07",
            maxDrawdown: 300,
            recoveryDate: null,
          },
          periodStats: { totalTrades: 1, totalPl: -300 },
          attribution: [{ strategy: "C", pl: -300 }],
        },
      ]);
      expect(data.episodes.map((episode) => episode.attribution.length)).toEqual([1, 1]);
      expect((await call({ episodeCount: 1 })).structuredContent).toMatchObject({
        episodes: [data.episodes[0]],
      });
      for (const args of [
        { episodeCount: 0 },
        { episodeCount: 21 },
        { episodeCount: 1.5 },
        { topN: 0 },
        { topN: 51 },
      ]) {
        expect((await call(args)).isError).toBe(true);
      }
      const seed = await call({ strategy: "B", episodeCount: 2 });
      expect(seed.structuredContent).toMatchObject({
        episodes: [
          {
            drawdownPeriod: {
              peakEquity: 1100,
              troughEquity: 750,
              maxDrawdown: 350,
              recoveryDate: null,
            },
            periodStats: { totalTrades: 2, totalPl: -350 },
          },
        ],
      });
      expect((await call({ strategy: "Peak", episodeCount: 2 })).structuredContent).toMatchObject({
        drawdownPeriod: null,
        episodes: [],
      });
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
