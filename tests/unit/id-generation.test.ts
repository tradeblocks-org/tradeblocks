/**
 * Tests for opaque id generation
 *
 * crypto.randomUUID() only exists in secure contexts, so the app must still
 * produce ids when it is served over plain http from a LAN address.
 */
import { generateId } from "@tradeblocks/lib";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const realCrypto = globalThis.crypto;

/** Replace globalThis.crypto for the duration of a single assertion block. */
function withCrypto(replacement: Partial<Crypto> | undefined, fn: () => void): void {
  Object.defineProperty(globalThis, "crypto", {
    value: replacement,
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: realCrypto,
      configurable: true,
      writable: true,
    });
  }
}

describe("generateId", () => {
  it("returns a canonical v4 UUID string", () => {
    expect(generateId()).toMatch(UUID_PATTERN);
  });

  it("returns a distinct value on every call", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
  });

  it("uses crypto.randomUUID when it is available", () => {
    const randomUUID = jest.fn(() => "11111111-2222-4333-8444-555555555555");
    withCrypto({ randomUUID } as unknown as Partial<Crypto>, () => {
      expect(generateId()).toBe("11111111-2222-4333-8444-555555555555");
      expect(randomUUID).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to getRandomValues when randomUUID is absent", () => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => {
      // All bits set: proves the version/variant bits are stamped, not inherited.
      bytes.fill(0xff);
      return bytes;
    });

    withCrypto({ getRandomValues } as unknown as Partial<Crypto>, () => {
      const id = generateId();
      expect(getRandomValues).toHaveBeenCalledTimes(1);
      expect(id).toMatch(UUID_PATTERN);
      expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    });
  });

  it("produces distinct ids from getRandomValues without repeating bytes", () => {
    let counter = 0;
    const getRandomValues = jest.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (counter + i) % 256;
      }
      counter += 1;
      return bytes;
    });

    withCrypto({ getRandomValues } as unknown as Partial<Crypto>, () => {
      const ids = new Set([generateId(), generateId(), generateId()]);
      expect(ids.size).toBe(3);
      for (const id of ids) {
        expect(id).toMatch(UUID_PATTERN);
      }
    });
  });

  it("falls back to Math.random when crypto is unavailable entirely", () => {
    withCrypto(undefined, () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
      for (const id of ids) {
        expect(id).toMatch(UUID_PATTERN);
      }
    });
  });
});
