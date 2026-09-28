import {
  calculateOoReplayAttribution,
  type ReplayStrategyCost,
  type ReplayTrade,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

import cases from "./oo-replay-named-days.fixture.json";

describe("OO replay v2 saved valuation days", () => {
  // Read-only #4148 exports: original OO curves/trades and market bid/ask sides,
  // not replay-derived marks. Both book dates and the standalone BWB fallback
  // would fail under the previous 2×-fee/raw-mid open-position rule.
  it.each(cases)("reconciles $name on $date to an OO cent", (sample) => {
    const quoteLookup = (date: string, ticker: string, markTime: string) => {
      const sides = (sample.quotes as unknown as Record<string, [number, number]>)[
        `${date}|${markTime}|${ticker}`
      ];
      return sides ? { bid: sides[0], ask: sides[1] } : undefined;
    };
    const attribution = calculateOoReplayAttribution({
      trades: sample.rows as ReplayTrade[],
      curve: sample.curve,
      quoteLookup,
      parameters: { cost_schedule: sample.costs as unknown as Record<string, ReplayStrategyCost> },
    });
    expect(attribution.stats.daily).toHaveLength(1);
    expect(attribution.stats.daily[0].status).toBe("available");
    expect(Math.abs(attribution.stats.daily[0].residual!)).toBeLessThanOrEqual(0.01);
    if (sample.name === "5 BWB") {
      const source = Object.values(attribution.method_parameters.cost_schedule)[0];
      expect(source.exit_slippage_source).toBe("entrySlippage_legacy");
      expect(source.exit_slippage).toBe(0.1);
    }
  });
});
