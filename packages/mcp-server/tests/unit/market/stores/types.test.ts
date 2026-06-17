import type {
  LegEnvelope,
  ReadWindowParams,
  WindowQuoteRow,
} from "../../../../src/market/stores/types.ts";

describe("readWindow types", () => {
  it("LegEnvelope accepts contract_type/dte range/optional strike range", () => {
    const env: LegEnvelope = {
      contractType: "put",
      dteMin: 7,
      dteMax: 11,
      strikeMin: 5142,
      strikeMax: 6075,
    };
    expect(env.contractType).toBe("put");
  });

  it("ReadWindowParams collects underlying/date/time window/leg envelopes", () => {
    const p: ReadWindowParams = {
      underlying: "SPX",
      date: "2025-04-01",
      timeStart: "09:35",
      timeEnd: "11:30",
      legEnvelopes: [{ contractType: "put", dteMin: 7, dteMax: 11 }],
    };
    expect(p.legEnvelopes.length).toBe(1);
  });

  it("WindowQuoteRow exposes chain-derived fields and quote+greeks", () => {
    const row: WindowQuoteRow = {
      underlying: "SPX",
      date: "2025-04-01",
      ticker: "SPXW250408P05500000",
      time: "10:00",
      contract_type: "put",
      strike: 5500,
      expiration: "2025-04-08",
      dte: 7,
      bid: 1.0,
      ask: 1.2,
      mid: 1.1,
      delta: -0.25,
      gamma: 0.001,
      theta: -0.5,
      vega: 0.3,
      iv: 0.18,
    };
    expect(row.dte).toBe(7);
  });
});
