import { describe, expect, it, jest } from "@jest/globals";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import protobuf from "protobufjs";
import {
  normalizeThetaOpenInterestRow,
  optionHistoryOpenInterest,
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

describe("ThetaData MDDS open-interest wrapper", () => {
  it("normalizes an open-interest tick into a clean daily row", () => {
    expect(normalizeThetaOpenInterestRow({
      symbol: "spxw",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      date: "20240715",
      open_interest: 1234,
    })).toEqual({
      ticker: "SPXW240805C05725000",
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      date: "2024-07-15",
      openInterest: 1234,
    });
  });

  it("rejects malformed required open-interest identity fields", () => {
    expect(() => normalizeThetaOpenInterestRow({
      symbol: "",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      date: "20240715",
      open_interest: 100,
    })).toThrow("ThetaData open-interest row missing symbol");
    expect(() => normalizeThetaOpenInterestRow({
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "CALL",
      date: "20240715",
      open_interest: null,
    })).toThrow("ThetaData open-interest row invalid open_interest");
  });

  it("fetches daily open interest with the date-range request shape and wildcard contract spec", async () => {
    const chunk = encodeRows(
      ["symbol", "expiration", "strike", "right", "date", "open_interest"],
      [{
        values: [
          { text: "SPXW" },
          { text: "2024-08-05" },
          { number: 5725 },
          { text: "CALL" },
          { number: 20240715 },
          { number: 4096 },
        ],
      }],
    );
    const client = fakeClient([chunk]);

    await expect(optionHistoryOpenInterest(client as never, {
      symbol: "SPXW",
      expiration: "*",
      startDate: "2024-07-15",
      endDate: "2024-07-16",
      strikeRange: 10,
    })).resolves.toEqual([{
      ticker: "SPXW240805C05725000",
      symbol: "SPXW",
      expiration: "2024-08-05",
      strike: 5725,
      right: "call",
      date: "2024-07-15",
      openInterest: 4096,
    }]);

    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryOpenInterest", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: {
        contractSpec: {
          symbol: "SPXW",
          expiration: "*",
          strike: "*",
          right: "both",
        },
        expiration: "*",
        startDate: "2024-07-15",
        endDate: "2024-07-16",
        strikeRange: 10,
      },
    });
  });

  it("omits strikeRange from the request when not supplied", async () => {
    const client = fakeClient([]);

    await optionHistoryOpenInterest(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      startDate: "2024-07-15",
      endDate: "2024-07-15",
    });

    expect(client.callStream).toHaveBeenCalledWith("GetOptionHistoryOpenInterest", {
      queryInfo: { authToken: { sessionUuid: "session-123" } },
      params: expect.not.objectContaining({
        strikeRange: expect.anything(),
      }),
    });
  });

  it("rejects invalid wrapper request dates before calling MDDS", async () => {
    const client = fakeClient([]);

    await expect(optionHistoryOpenInterest(client as never, {
      symbol: "SPXW",
      expiration: "2024-08-05",
      startDate: "20240715",
      endDate: "2024-07-16",
    })).rejects.toThrow("ThetaData date must use YYYY-MM-DD");
    expect(client.callStream).not.toHaveBeenCalled();
  });
});
