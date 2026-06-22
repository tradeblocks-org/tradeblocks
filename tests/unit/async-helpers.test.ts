/**
 * Tests for async helper utilities
 */
import { yieldToMain, checkCancelled, waitForRender, RENDER_DELAY_MS } from "@tradeblocks/lib";

describe("async-helpers", () => {
  describe("yieldToMain", () => {
    it("should resolve without error", async () => {
      await expect(yieldToMain()).resolves.toBeUndefined();
    });

    it("should yield control and return", async () => {
      const start = Date.now();
      await yieldToMain();
      const elapsed = Date.now() - start;

      // Should complete quickly (under 100ms in test environment)
      expect(elapsed).toBeLessThan(100);
    });

    it("should be callable multiple times in succession", async () => {
      // Simulate yielding in a loop like we do in expensive operations
      for (let i = 0; i < 5; i++) {
        await yieldToMain();
      }
      // If we get here without hanging, the test passes
      expect(true).toBe(true);
    });
  });

  describe("checkCancelled", () => {
    it("should not throw when signal is undefined", () => {
      expect(() => checkCancelled(undefined)).not.toThrow();
    });

    it("should not throw when signal is not aborted", () => {
      const controller = new AbortController();
      expect(() => checkCancelled(controller.signal)).not.toThrow();
    });

    it("should throw AbortError when signal is aborted", () => {
      const controller = new AbortController();
      controller.abort();

      expect(() => checkCancelled(controller.signal)).toThrow(DOMException);
      expect(() => checkCancelled(controller.signal)).toThrow("Operation cancelled");
    });

    it("should throw error with name AbortError", () => {
      const controller = new AbortController();
      controller.abort();

      try {
        checkCancelled(controller.signal);
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      }
    });
  });

  describe("waitForRender", () => {
    it("should delay for at least RENDER_DELAY_MS", async () => {
      const start = Date.now();
      await waitForRender();
      const elapsed = Date.now() - start;

      // Should take at least RENDER_DELAY_MS (with some tolerance for timing)
      expect(elapsed).toBeGreaterThanOrEqual(RENDER_DELAY_MS - 10);
    });

    it("should resolve after delay", async () => {
      await expect(waitForRender()).resolves.toBeUndefined();
    });
  });

  describe("RENDER_DELAY_MS", () => {
    it("should be a positive number", () => {
      expect(RENDER_DELAY_MS).toBeGreaterThan(0);
    });

    it("should be 150ms", () => {
      expect(RENDER_DELAY_MS).toBe(150);
    });
  });
});
