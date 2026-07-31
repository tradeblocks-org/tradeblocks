/**
 * Opaque identifier generation
 *
 * `crypto.randomUUID()` is only exposed in secure contexts. Serving a production
 * build over plain http from a LAN address (anything that is not localhost or
 * https) leaves `crypto` defined but `crypto.randomUUID` undefined, so call sites
 * that used it directly threw "crypto.randomUUID is not a function". Every id in
 * the app is an opaque string, so falling back to a locally generated UUIDv4
 * keeps the stored format identical.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Format 16 random bytes as a canonical UUID string, stamping the version 4 and
 * RFC 4122 variant bits.
 */
function formatUuidV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => HEX[byte]);
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Generate an opaque identifier as a canonical UUID string.
 *
 * Prefers `crypto.randomUUID()`, falls back to `crypto.getRandomValues()`, and
 * only reaches `Math.random()` when neither is available.
 *
 * @returns A UUID string, e.g. "3f6b0f3e-9c5b-4f4e-8a2f-1d0c9b8a7e6f"
 */
export function generateId(): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (typeof cryptoObj?.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return formatUuidV4(bytes);
}
