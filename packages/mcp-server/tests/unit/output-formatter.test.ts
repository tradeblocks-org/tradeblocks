import { createToolOutput } from "../../src/utils/output-formatter.ts";

describe("createToolOutput", () => {
  it("returns authoritative structuredContent while preserving legacy content", () => {
    const data = {
      stats: { netPl: 10704.08, sharpeRatio: 1.2 },
      calculationMethodology: {
        pnl: { sourceBasis: "net_includes_fees" },
        sharpe: { riskFreeRate: { mode: "fixed", annualRatePct: 2 } },
      },
    };

    const output = createToolOutput("Stats ready", data);

    expect(output.structuredContent).toEqual(data);
    expect(output.content[0]).toEqual({ type: "text", text: "Stats ready" });
    expect(output.content[1]).toMatchObject({
      type: "resource",
      resource: {
        uri: "data:application/json",
        mimeType: "application/json",
        text: JSON.stringify(data),
      },
    });
  });
});
