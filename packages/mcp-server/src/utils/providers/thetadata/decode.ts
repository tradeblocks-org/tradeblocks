import { decompress } from "fzstd";
import { loadMddsProtoRoot } from "./proto.ts";

export type ThetaCellValue = string | number | null;

export interface DecodedThetaTable {
  headers: string[];
  rows: Array<Record<string, ThetaCellValue>>;
}

export interface ThetaPriceLike {
  value: number;
  type: number;
}

const PRICE_TYPE_FACTORS = [
  0,
  1e-9,
  1e-8,
  1e-7,
  1e-6,
  1e-5,
  1e-4,
  1e-3,
  1e-2,
  1e-1,
  1,
  10,
  100,
  1000,
  10000,
  100000,
  1000000,
  10000000,
  100000000,
  1000000000,
] as const;

const ET_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// Constructing an Intl.DateTimeFormat is expensive (it builds an ICU formatter)
// and the options are constant. Build it once at module load instead of per
// call — this function runs once per decoded quote row, so a per-row construct
// dominated the decode cost on dense chains.
const ET_MINUTE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export function thetaPriceToNumber(price: ThetaPriceLike): number {
  return price.type === 0 ? Number.NaN : price.value * PRICE_TYPE_FACTORS[price.type];
}

export function thetaTimestampToEtMinute(value: string | number | Date): string {
  if (typeof value === "string" && ET_MINUTE_PATTERN.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  const parts = ET_MINUTE_FORMAT.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toNumber(value: unknown): number {
  return typeof value === "object" && value !== null && "toNumber" in value
    ? (value as { toNumber: () => number }).toNumber()
    : Number(value);
}

function decodeCell(value: unknown): ThetaCellValue {
  if (!value || typeof value !== "object") return null;
  const cell = value as Record<string, unknown>;
  if (hasOwn(cell, "text")) return String(cell.text);
  if (hasOwn(cell, "number")) return toNumber(cell.number);
  if (hasOwn(cell, "price")) return thetaPriceToNumber(cell.price as ThetaPriceLike);
  if (hasOwn(cell, "timestamp")) {
    const timestamp = cell.timestamp as { epochMs?: unknown };
    return thetaTimestampToEtMinute(toNumber(timestamp.epochMs));
  }
  if (hasOwn(cell, "nullValue")) return null;
  return null;
}

export function decodeThetaDataTablePayload(payload: Buffer | Uint8Array): DecodedThetaTable {
  try {
    const DataTable = loadMddsProtoRoot().lookupType("BetaEndpoints.DataTable");
    const table = DataTable.decode(payload) as unknown as {
      headers: string[];
      dataTable: Array<{ values: unknown[] }>;
    };
    return {
      headers: table.headers,
      rows: table.dataTable.map((row) => {
        const out: Record<string, ThetaCellValue> = {};
        table.headers.forEach((header, index) => {
          out[header] = decodeCell(row.values[index]);
        });
        return out;
      }),
    };
  } catch (error) {
    throw new Error(
      `ThetaData DataTable decode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function decodeThetaResponseData(response: {
  compressedData: Buffer | Uint8Array;
  compressionDescription?: { algo?: string | number };
}): DecodedThetaTable {
  const algo = response.compressionDescription?.algo;
  const compressed = response.compressedData;
  let payload: Buffer;
  if (algo === undefined || algo === "NONE" || algo === 0) {
    payload = Buffer.from(compressed);
  } else if (algo === "ZSTD" || algo === 1) {
    try {
      payload = Buffer.from(decompress(new Uint8Array(compressed)));
    } catch (error) {
      throw new Error(
        `ThetaData ResponseData decompression failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    throw new Error(`ThetaData ResponseData compression unsupported: ${String(algo)}`);
  }
  return decodeThetaDataTablePayload(payload);
}
