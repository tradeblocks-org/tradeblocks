import { describe, expect, it } from "@jest/globals";
import { gzipSync } from "zlib";
import { loadMddsProtoRoot } from "../../../../src/utils/providers/thetadata/proto.ts";
import {
  decodeThetaResponseData,
  decodeThetaDataTablePayload,
  thetaPriceToNumber,
  thetaTimestampToEtMinute,
} from "../../../../src/utils/providers/thetadata/decode.ts";

function encodeSampleTable(): Buffer {
  const root = loadMddsProtoRoot();
  const DataTable = root.lookupType("BetaEndpoints.DataTable");
  const payload = DataTable.encode({
    headers: ["symbol", "strike"],
    dataTable: [
      { values: [{ text: "SPXW" }, { number: 5725 }] },
    ],
  }).finish();
  return Buffer.from(payload);
}

describe("ThetaData MDDS decoder", () => {
  it("maps price encoding with ThetaData factors", () => {
    expect(thetaPriceToNumber({ value: 278, type: 8 })).toBe(2.7800000000000002);
    expect(thetaPriceToNumber({ value: 999, type: 6 })).toBe(0.0999);
    expect(Number.isNaN(thetaPriceToNumber({ value: 1, type: 0 }))).toBe(true);
  });

  it("converts UTC timestamps to DST-aware Eastern minute keys", () => {
    expect(thetaTimestampToEtMinute("2024-07-15T13:45:00.000Z")).toBe("2024-07-15 09:45");
    expect(thetaTimestampToEtMinute("2024-12-16T14:45:00.000Z")).toBe("2024-12-16 09:45");
    expect(thetaTimestampToEtMinute("2024-07-15 09:45")).toBe("2024-07-15 09:45");
  });

  it("decodes an uncompressed DataTable payload", () => {
    expect(decodeThetaDataTablePayload(encodeSampleTable())).toEqual({
      headers: ["symbol", "strike"],
      rows: [{ symbol: "SPXW", strike: 5725 }],
    });
  });

  it("decodes timestamp cells as Eastern minute keys", () => {
    const root = loadMddsProtoRoot();
    const DataTable = root.lookupType("BetaEndpoints.DataTable");
    const payload = DataTable.encode({
      headers: ["time", "symbol"],
      dataTable: [
        {
          values: [
            { timestamp: { epochMs: Date.parse("2024-07-15T13:45:00.000Z"), zone: "UTC" } },
            { text: "SPXW" },
          ],
        },
      ],
    }).finish();

    expect(decodeThetaDataTablePayload(Buffer.from(payload))).toEqual({
      headers: ["time", "symbol"],
      rows: [{ time: "2024-07-15 09:45", symbol: "SPXW" }],
    });
  });

  it("throws a decode error for non-DataTable bytes", () => {
    expect(() => decodeThetaDataTablePayload(gzipSync("not a protobuf"))).toThrow(
      "ThetaData DataTable decode failed",
    );
  });

  it.each([
    ["missing", undefined],
    ["NONE string", "NONE"],
    ["NONE enum", 0],
  ])("decodes %s ResponseData as an uncompressed table", (_label, algo) => {
    expect(decodeThetaResponseData({
      compressedData: encodeSampleTable(),
      compressionDescription: algo === undefined ? undefined : { algo },
    })).toEqual({
      headers: ["symbol", "strike"],
      rows: [{ symbol: "SPXW", strike: 5725 }],
    });
  });

  it("decodes ZSTD-compressed ResponseData", () => {
    // Fixture generated from encodeSampleTable() with:
    // zstd -q -f /tmp/theta-table.pb -o /tmp/theta-table.pb.zst
    const compressedData = Buffer.from(
      "KLUv/SQf+QAACgZzeW1ib2wKBnN0cmlrZRINCgYKBFNQWFcKAxDdLOEbFfM=",
      "base64",
    );

    expect(decodeThetaResponseData({
      compressedData,
      compressionDescription: { algo: "ZSTD" },
    })).toEqual({
      headers: ["symbol", "strike"],
      rows: [{ symbol: "SPXW", strike: 5725 }],
    });
  });

  it("wraps invalid ZSTD bytes with ThetaData context", () => {
    expect(() => decodeThetaResponseData({
      compressedData: Buffer.from("not zstd"),
      compressionDescription: { algo: "ZSTD" },
    })).toThrow("ThetaData ResponseData decompression failed");
  });

  it("throws for unsupported ResponseData compression algos", () => {
    expect(() => decodeThetaResponseData({
      compressedData: encodeSampleTable(),
      compressionDescription: { algo: "BROTLI" },
    })).toThrow("ThetaData ResponseData compression unsupported");
  });
});
