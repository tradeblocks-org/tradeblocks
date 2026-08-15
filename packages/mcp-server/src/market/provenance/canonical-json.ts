import { createHash } from "node:crypto";

/**
 * Canonical JSON version used by the market-data provenance object store.
 *
 * The version defines normalization and numeric semantics. Addresses remain
 * ordinary SHA-256 addresses of the exact encoded bytes.
 */
export const CANONICAL_JSON_VERSION = 1 as const;

export type Sha256Address = `sha256:${string}`;
export type CanonicalJsonAddress = Sha256Address;

const SHA256_ADDRESS_RE = /^sha256:([0-9a-f]{64})$/;

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0) as number);
  const rightPoints = Array.from(right, (char) => char.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let i = 0; i < length; i++) {
    if (leftPoints[i] !== rightPoints[i]) return leftPoints[i] - rightPoints[i];
  }
  return leftPoints.length - rightPoints.length;
}

function encode(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError("Canonical JSON v1 supports only safe integers");
      }
      // JSON.stringify already emits ECMAScript's shortest round-trippable
      // representation and normalizes negative zero to zero.
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
    case "object":
      break;
  }

  const object = value as object;
  if (seen.has(object)) throw new TypeError("Canonical JSON does not support cyclic values");
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError("Canonical JSON does not support sparse arrays");
        elements.push(encode(value[i], seen));
      }
      return `[${elements.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects and arrays");
    }

    const normalizedKeys = new Map<string, string>();
    for (const sourceKey of Object.keys(value as Record<string, unknown>)) {
      const normalizedKey = sourceKey.normalize("NFC");
      const collision = normalizedKeys.get(normalizedKey);
      if (collision !== undefined && collision !== sourceKey) {
        throw new TypeError(
          `Canonical JSON key collision after NFC normalization: ${JSON.stringify(collision)} and ${JSON.stringify(sourceKey)}`,
        );
      }
      normalizedKeys.set(normalizedKey, sourceKey);
    }
    const entries = [...normalizedKeys.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(
        ([normalizedKey, sourceKey]) =>
          `${JSON.stringify(normalizedKey)}:${encode((value as Record<string, unknown>)[sourceKey], seen)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** Encode a JSON value with stable recursive object-key ordering. */
export function canonicalJson(value: unknown): string {
  return encode(value, new WeakSet<object>());
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

/** Address the exact canonical JSON bytes. */
export function addressCanonicalJson(value: unknown): CanonicalJsonAddress {
  return addressBytes(canonicalJsonBytes(value));
}

/** Address exact binary bytes, such as a completed Parquet file. */
export function addressBytes(bytes: Uint8Array): Sha256Address {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export function parseCanonicalJsonAddress(address: string): string {
  return parseSha256Address(address);
}

export function parseSha256Address(address: string): string {
  const match = SHA256_ADDRESS_RE.exec(address);
  if (!match) throw new TypeError(`Invalid SHA-256 address: ${JSON.stringify(address)}`);
  return match[1];
}
