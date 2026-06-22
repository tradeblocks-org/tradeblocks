import { QuoteStore } from "../../../../src/market/stores/quote-store.ts";

describe("QuoteStore abstract surface", () => {
  it("subclass that omits readWindow fails type-check (runtime check: abstract method present)", () => {
    // TypeScript's `abstract` keyword erases at runtime — the prototype simply
    // doesn't have a definition. This is a runtime sanity check that the
    // method is abstract (no default implementation on the prototype).
    expect(Object.getOwnPropertyDescriptor(QuoteStore.prototype, "readWindow")).toBeUndefined();
    expect(typeof (QuoteStore.prototype as { readWindow?: unknown }).readWindow).toBe("undefined");
  });
});
