// Global test setup
import { jest } from "@jest/globals";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// Use fake-indexeddb for tests - provides complete IndexedDB implementation
// This is automatically populated to global scope by 'fake-indexeddb/auto'
// but we can also explicitly set it if needed
if (!global.indexedDB) {
  global.indexedDB = new IDBFactory();
}

// Polyfill structuredClone for Node.js environments that don't have it
if (typeof global.structuredClone === "undefined") {
  global.structuredClone = <T>(obj: T): T => {
    return JSON.parse(JSON.stringify(obj));
  };
}

// Mock console.log for cleaner test output (optional - can be commented out for debugging)
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
