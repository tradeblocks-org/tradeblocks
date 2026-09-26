/**
 * Unit tests for refresh-market-data.mjs env-var config parsing.
 *
 * Covers the `parseList` helper that resolves TRADEBLOCKS_SPOT_TICKERS and
 * TRADEBLOCKS_OPTION_UNDERLYINGS per ADR 0018 (#197). The helper fails loud
 * on missing/empty input and shape-validates each token.
 */
import { describe, expect, it, beforeAll } from "@jest/globals";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let parseList;

beforeAll(async () => {
  const scriptUrl = pathToFileURL(resolve(__dirname, "../refresh-market-data.mjs")).href;
  const mod = await import(scriptUrl);
  parseList = mod.parseList;
});

describe("refresh-market-data parseList", () => {
  it("throws when env value is undefined", () => {
    expect(() => parseList(undefined, "X")).toThrow(/^X is required/);
  });

  it("throws when env value is empty string", () => {
    expect(() => parseList("", "X")).toThrow(/^X is required/);
  });

  it("throws when env value is whitespace-only", () => {
    expect(() => parseList("   ", "X")).toThrow(/^X is required/);
  });

  it("parses a simple comma-separated list", () => {
    expect(parseList("SPX,QQQ", "X")).toEqual(["SPX", "QQQ"]);
  });

  it("trims whitespace and uppercases tokens", () => {
    expect(parseList(" spx , qqq ", "X")).toEqual(["SPX", "QQQ"]);
  });

  it("dedupes tokens, preserving first-seen order", () => {
    expect(parseList("SPX,SPX,QQQ", "X")).toEqual(["SPX", "QQQ"]);
  });

  it("drops empty tokens between commas", () => {
    expect(parseList("SPX,,QQQ", "X")).toEqual(["SPX", "QQQ"]);
  });

  it("throws on tokens with invalid characters (whitespace within)", () => {
    expect(() => parseList("SP X", "X")).toThrow(/invalid token/);
  });

  it("names the offending variable in error messages", () => {
    expect(() => parseList(undefined, "TRADEBLOCKS_SPOT_TICKERS")).toThrow(
      /TRADEBLOCKS_SPOT_TICKERS is required/,
    );
    expect(() => parseList("BAD!", "TRADEBLOCKS_OPTION_UNDERLYINGS")).toThrow(
      /TRADEBLOCKS_OPTION_UNDERLYINGS contains invalid token/,
    );
  });
});
