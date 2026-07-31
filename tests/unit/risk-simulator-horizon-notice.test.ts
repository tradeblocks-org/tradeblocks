/**
 * A hand-typed simulation horizon survives a strategy switch on purpose, so it
 * can end up describing a longer or shorter history than the one now in scope.
 * The helper text has to make that visible instead of leaving the user to
 * notice on their own.
 */

import { describeSimulationHorizon } from "@/app/(platform)/risk-simulator/horizon-notice";

describe("describeSimulationHorizon", () => {
  it("says it matches the history at the default", () => {
    expect(
      describeSimulationHorizon({
        isAtDefault: true,
        simulationLength: 30,
        historyTradeCount: 30,
        unit: "trades",
        paceText: "1.4 months",
      }),
    ).toBe("Matches your history (30 trades ≈ 1.4 months)");
  });

  it("names the history when a manual horizon no longer matches it", () => {
    const notice = describeSimulationHorizon({
      isAtDefault: false,
      simulationLength: 500,
      historyTradeCount: 30,
      unit: "trades",
      paceText: "2.0 years",
    });

    expect(notice).toContain("Manual horizon");
    expect(notice).toContain("your history is 30 trades");
    expect(notice).toContain("500 trades ≈ 2.0 years");
  });

  it("names the history for time units too, in trades", () => {
    const notice = describeSimulationHorizon({
      isAtDefault: false,
      simulationLength: 504,
      historyTradeCount: 83,
      unit: "years",
      paceText: "2.0 years",
    });

    expect(notice).toBe("Manual horizon: ≈ 504 trades at your pace — your history is 83 trades");
  });

  it("keeps the plain reading when a manual horizon still equals the history", () => {
    expect(
      describeSimulationHorizon({
        isAtDefault: false,
        simulationLength: 30,
        historyTradeCount: 30,
        unit: "trades",
        paceText: "1.4 months",
      }),
    ).toBe("30 trades ≈ 1.4 months");
  });

  it("uses the singular for a one-trade history", () => {
    expect(
      describeSimulationHorizon({
        isAtDefault: false,
        simulationLength: 200,
        historyTradeCount: 1,
        unit: "trades",
        paceText: "9.5 months",
      }),
    ).toContain("your history is 1 trade");
  });
});
