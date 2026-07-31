/**
 * A hand-typed simulation horizon survives a strategy switch on purpose, so it
 * can end up describing a longer or shorter history than the one now in scope.
 * The helper text has to make that visible instead of leaving the user to
 * notice on their own.
 *
 * The "edited by hand" flag is the only input that decides whether the horizon
 * is still following the history, so the copy and the behavior cannot disagree.
 */

import { describeSimulationHorizon } from "@/app/(platform)/risk-simulator/horizon-notice";

describe("describeSimulationHorizon", () => {
  it("says it matches the history while the horizon is still following it", () => {
    expect(
      describeSimulationHorizon({
        horizonEdited: false,
        simulationLength: 30,
        historyTradeCount: 30,
        unit: "trades",
        paceText: "1.4 months",
      }),
    ).toEqual({
      followsHistory: true,
      text: "Matches your history (30 trades ≈ 1.4 months)",
    });
  });

  it("names the history when a manual horizon no longer matches it", () => {
    const notice = describeSimulationHorizon({
      horizonEdited: true,
      simulationLength: 500,
      historyTradeCount: 30,
      unit: "trades",
      paceText: "2.0 years",
    });

    expect(notice.followsHistory).toBe(false);
    expect(notice.text).toContain("Manual horizon");
    expect(notice.text).toContain("your history is 30 trades");
    expect(notice.text).toContain("500 trades ≈ 2.0 years");
  });

  it("names the history for time units too, in trades", () => {
    const notice = describeSimulationHorizon({
      horizonEdited: true,
      simulationLength: 504,
      historyTradeCount: 83,
      unit: "years",
      paceText: "2.0 years",
    });

    expect(notice.text).toBe(
      "Manual horizon: ≈ 504 trades at your pace — your history is 83 trades",
    );
  });

  it("never claims to match the history when a manual horizon only happens to equal it", () => {
    // The divergence that used to be possible: a horizon typed by hand keeps
    // its own value across a block switch, so landing on a block whose history
    // happens to be that long must not read as "Matches your history" — the
    // next block switch will not move this horizon.
    const notice = describeSimulationHorizon({
      horizonEdited: true,
      simulationLength: 30,
      historyTradeCount: 30,
      unit: "trades",
      paceText: "1.4 months",
    });

    expect(notice.followsHistory).toBe(false);
    expect(notice.text).toBe("30 trades ≈ 1.4 months");
    expect(notice.text).not.toContain("Matches your history");
  });

  it("uses the singular for a one-trade history", () => {
    expect(
      describeSimulationHorizon({
        horizonEdited: true,
        simulationLength: 200,
        historyTradeCount: 1,
        unit: "trades",
        paceText: "9.5 months",
      }).text,
    ).toContain("your history is 1 trade");
  });
});
