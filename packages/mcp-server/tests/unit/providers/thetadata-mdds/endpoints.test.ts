import { describe, expect, it, jest } from "@jest/globals";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import protobuf from "protobufjs";
import {
  normalizeThetaFirstOrderGreekRow,
  normalizeThetaQuoteRow,
  normalizeThetaContractListRow,
  optionAtTimeQuote,
  optionHistoryGreeksFirstOrderBand,
  optionHistoryGreeksFirstOrder,
  optionHistoryQuote,
  optionHistoryQuoteBand,
  optionListContracts,
  thetaRequestRight,
} from "../../../../src/utils/providers/thetadata/endpoints.ts";

// Resolve relative to this test file, not process.cwd(): CI runs jest from the
// repo root (`--config packages/mcp-server/jest.config.js`), where a cwd-relative
// `src/...` path does not exist.
const MDDS_PROTO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../src/utils/providers/thetadata/mdds.proto",
);

function encodeRows(headers: string[], dataTable: Array<{ values: unknown[] }>) {
  const root = protobuf.loadSync(MDDS_PROTO_PATH);
  const DataTable = root.lookupType("BetaEndpoints.DataTable");
  return {
    compressedData: Buffer.from(DataTable.encode({ headers, dataTable }).finish()),
  };
}

function fakeClient(chunks: unknown[]) {
  return {
    queryInfo: () => ({ authToken: { sessionUuid: "session-123" } }),
    callStream: jest.fn<(_method: string, _request: unknown) => Promise<unknown[]>>()
      .mockResolvedValue(chunks),
  };
}

describe("ThetaData MDDS endpoint wrappers", () => {
  it("normalizes quote rows", () => {
    expect(normalizeThetaQuoteRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      timestamp: "2024-07-15T13:45:00.000Z",
      bid: 26.2,
      ask: 26.5,
    })).toEqual({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      timestamp: "2024-07-15 09:45",
      bid: 26.2,
      ask: 26.5,
    });
  });

  it("normalizes first-order greek rows", () => {
    expect(normalizeThetaFirstOrderGreekRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5730,
      right: "CALL",
      timestamp: "2024-07-15T13:45:00.000Z",
      bid: 24.6,
      ask: 24.9,
      delta: 0.2953,
      theta: -1.345,
      vega: 466.8939,
      implied_vol: 0.0994,
      underlying_timestamp: "2024-07-15T13:45:00.000Z",
      underlying_price: 5638.05,
    })).toMatchObject({
      strike: 5730,
      right: "call",
      timestamp: "2024-07-15 09:45",
      delta: 0.2953,
      iv: 0.0994,
      underlyingTimestamp: "2024-07-15 09:45",
      underlyingPrice: 5638.05,
    });
  });

  it("normalizes request right values", () => {
    expect(thetaRequestRight("call")).toBe("call");
    expect(thetaRequestRight("put")).toBe("put");
  });

  it("normalizes date-specific contract-list rows", () => {
    expect(normalizeThetaContractListRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
    })).toEqual({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
    });
  });

  it("fetches option history quote chunks with MDDS defaults and normalizes decoded rows", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right", "timestamp", "bid", "ask"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5725 },
          { text: "CALL" },
          { text: "2024-07-15T13:45:00.000Z" },
          { price: { value: 262, type: 8 } },
          { price: { value: 265, type: 8 } },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryQuote(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: "5725",
      right: "call",
      date: "2024-07-15",
    })).resolves.toEqual([{
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      timestamp: "2024-07-15 09:45",
      bid: 2.62,
      ask: 2.65,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryQuote", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: {
        contractSpec: {
          symbol: "SPXW",
          expiration: "2024-08-05",
          strike: "5725",
          right: "call",
        },
        expiration: "2024-08-05",
        date: "2024-07-15",
        interval: "1m",
        startTime: "09:30:00.000",
        endTime: "16:00:00.000",
      },
    });
  });

  it("fetches option at-time quote chunks with wildcard-capable request shape", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right", "timestamp", "bid", "ask"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5725 },
          { text: "CALL" },
          { text: "2024-07-15T13:45:00.000Z" },
          { price: { value: 262, type: 8 } },
          { price: { value: 265, type: 8 } },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionAtTimeQuote(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: "5725",
      right: "call",
      date: "2024-07-15",
      time: "09:45",
      strikeRange: 20,
    })).resolves.toEqual([{
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      timestamp: "2024-07-15 09:45",
      bid: 2.62,
      ask: 2.65,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionAtTimeQuote", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: {
        contractSpec: {
          symbol: "SPXW",
          expiration: "2024-08-05",
          strike: "5725",
          right: "call",
        },
        startDate: "2024-07-15",
        endDate: "2024-07-15",
        timeOfDay: "09:45:00.000",
        expiration: "2024-08-05",
        strikeRange: 20,
      },
    });
  });

  it("fetches first-order greek chunks with explicit times and greek defaults", async () => {
    const chunk = encodeRows(
      [
        "symbol",
        "expiration",
        "strike",
        "right",
        "timestamp",
        "bid",
        "ask",
        "delta",
        "theta",
        "vega",
        "implied_vol",
        "underlying_timestamp",
        "underlying_price",
      ],
      [{
        values: [
          { text: "spxw" },
          { text: "2024-08-05" },
          { number: 5730 },
          { text: "C" },
          { text: "2024-07-15T13:45:00.000Z" },
          { text: "24.6" },
          { text: "24.9" },
          { text: "0.2953" },
          { text: "-1.345" },
          { text: "466.8939" },
          { text: "0.0994" },
          { text: "2024-07-15T13:45:00.000Z" },
          { text: "5638.05" },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryGreeksFirstOrder(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: "5730",
      right: "call",
      date: "2024-07-15",
      interval: "5m",
      startTime: "09:45",
      endTime: "15:30:00",
    })).resolves.toMatchObject([{
      symbol: "SPXW",
      strike: 5730,
      right: "call",
      timestamp: "2024-07-15 09:45",
      delta: 0.2953,
      theta: -1.345,
      vega: 466.8939,
      iv: 0.0994,
      underlyingTimestamp: "2024-07-15 09:45",
      underlyingPrice: 5638.05,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryGreeksFirstOrder", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.objectContaining({
        interval: "5m",
        startTime: "09:45:00.000",
        endTime: "15:30:00.000",
        rateType: "sofr",
        version: "latest",
      }),
    });
  });

  it("passes strike_range through for bulk-shape probes", async () => {
    const client = fakeClient([]);

    await optionHistoryGreeksFirstOrder(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: "5725",
      right: "call",
      date: "2024-07-15",
      startTime: "09:45",
      endTime: "09:45",
      strikeRange: 2,
    });

    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryGreeksFirstOrder", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.objectContaining({
        strikeRange: 2,
      }),
    });
  });

  it("fetches first-order greek bands with wildcard strike and both rights", async () => {
    const chunk = encodeRows(
      [
        "symbol",
        "expiration",
        "strike",
        "right",
        "timestamp",
        "bid",
        "ask",
        "delta",
        "theta",
        "vega",
        "implied_vol",
      ],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5590 },
          { text: "PUT" },
          { text: "2024-07-15T13:45:00.000Z" },
          { text: "32.9" },
          { text: "33.3" },
          { text: "-0.3278" },
          { text: "-1.0292" },
          { text: "488.4875" },
          { text: "0.1121" },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryGreeksFirstOrderBand(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      date: "2024-07-15",
      startTime: "09:45",
      endTime: "09:45",
      strikeRange: 10,
    })).resolves.toMatchObject([{
      symbol: "SPXW",
      strike: 5590,
      right: "put",
      timestamp: "2024-07-15 09:45",
      delta: -0.3278,
      iv: 0.1121,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryGreeksFirstOrder", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.objectContaining({
        contractSpec: {
          symbol: "SPXW",
          expiration: "2024-08-05",
          strike: "*",
          right: "both",
        },
        expiration: "2024-08-05",
        date: "2024-07-15",
        interval: "1m",
        startTime: "09:45:00.000",
        endTime: "09:45:00.000",
        rateType: "sofr",
        version: "latest",
        strikeRange: 10,
      }),
    });
  });

  it("fetches quote bands with wildcard strike and both rights", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right", "timestamp", "bid", "ask"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5725 },
          { text: "CALL" },
          { text: "2024-07-15T13:45:00.000Z" },
          { price: { value: 262, type: 8 } },
          { price: { value: 265, type: 8 } },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryQuoteBand(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      date: "2024-07-15",
      strikeRange: 10,
      startTime: "09:45",
      endTime: "09:45",
    })).resolves.toEqual([{
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      timestamp: "2024-07-15 09:45",
      bid: 2.62,
      ask: 2.65,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryQuote", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.objectContaining({
        contractSpec: {
          symbol: "SPXW",
          expiration: "2024-08-05",
          strike: "*",
          right: "both",
        },
        expiration: "2024-08-05",
        date: "2024-07-15",
        interval: "1m",
        startTime: "09:45:00.000",
        endTime: "09:45:00.000",
        strikeRange: 10,
      }),
    });
  });

  it("fetches quote bands without strikeRange when omitted", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right", "timestamp", "bid", "ask"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5730 },
          { text: "PUT" },
          { text: "2024-07-15T13:30:00.000Z" },
          { price: { value: 329, type: 8 } },
          { price: { value: 333, type: 8 } },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryQuoteBand(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      date: "2024-07-15",
    })).resolves.toEqual([{
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5730,
      right: "put",
      timestamp: "2024-07-15 09:30",
      bid: 3.29,
      ask: 3.33,
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryQuote", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.not.objectContaining({
        strikeRange: expect.anything(),
      }),
    });
  });

  it("fetches option contract-list chunks with defaults and normalizes decoded rows", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5725 },
          { text: "P" },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionListContracts(client as never, {
      symbol: "SPXW",
      date: "2024-07-15",
    })).resolves.toEqual([{
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "put",
    }]);
    expect(client.callStream).toHaveBeenCalledWith("GetOptionListContracts", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: {
        requestType: "quote",
        symbol: ["SPXW"],
        date: "2024-07-15",
      },
    });
  });

  it("rejects malformed required history row identity fields", () => {
    expect(() => normalizeThetaQuoteRow({
      symbol: "",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      timestamp: "2024-07-15T13:45:00.000Z",
    })).toThrow("ThetaData quote row missing symbol");
    expect(() => normalizeThetaQuoteRow({
      symbol: "SPXW",
      expiration: "",
      strike: 5725,
      right: "CALL",
      timestamp: "2024-07-15T13:45:00.000Z",
    })).toThrow("ThetaData quote row missing expiration");
    expect(() => normalizeThetaQuoteRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: null,
      right: "CALL",
      timestamp: "2024-07-15T13:45:00.000Z",
    })).toThrow("ThetaData quote row invalid strike");
    expect(() => normalizeThetaQuoteRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      timestamp: "",
    })).toThrow("ThetaData quote row missing timestamp");
  });

  it("rejects malformed required contract-list row identity fields", () => {
    expect(() => normalizeThetaContractListRow({
      symbol: "",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
    })).toThrow("ThetaData contract-list row missing symbol");
    expect(() => normalizeThetaContractListRow({
      symbol: "SPXW",
      expiration: "",
      strike: 5725,
      right: "CALL",
    })).toThrow("ThetaData contract-list row missing expiration");
    expect(() => normalizeThetaContractListRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: null,
      right: "CALL",
    })).toThrow("ThetaData contract-list row invalid strike");
  });

  it("rejects invalid wrapper request dates and strikes before calling MDDS", async () => {
    const client = fakeClient([]);

    await expect(optionHistoryQuote(client as never, {
      symbol: "SPXW",
      expiration: "20240805",
      strike: "5725",
      right: "call",
      date: "2024-07-15",
    })).rejects.toThrow("ThetaData expiration must use YYYY-MM-DD");
    await expect(optionHistoryQuote(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: "abc",
      right: "call",
      date: "2024-07-15",
    })).rejects.toThrow("ThetaData strike must be finite");
    await expect(optionListContracts(client as never, {
      symbol: "SPXW",
      date: "20240715",
    })).rejects.toThrow("ThetaData date must use YYYY-MM-DD");
    expect(client.callStream).not.toHaveBeenCalled();
  });
});
