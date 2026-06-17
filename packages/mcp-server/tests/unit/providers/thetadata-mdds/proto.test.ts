import { describe, expect, it } from "@jest/globals";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as protoLoader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";

// Resolve relative to this test file, not process.cwd(): CI runs jest from the
// repo root (`--config packages/mcp-server/jest.config.js`), where a cwd-relative
// `src/...` path does not exist.
const protoPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../src/utils/providers/thetadata/mdds.proto",
);

describe("ThetaData MDDS proto asset", () => {
  it("loads BetaEndpoints.BetaThetaTerminal", () => {
    expect(existsSync(protoPath)).toBe(true);
    const definition = protoLoader.loadSync(protoPath, {
      longs: Number,
      enums: String,
      defaults: false,
      oneofs: true,
      bytes: Buffer,
    });
    const loaded = grpc.loadPackageDefinition(definition) as {
      BetaEndpoints?: { BetaThetaTerminal?: unknown };
    };
    expect(loaded.BetaEndpoints?.BetaThetaTerminal).toBeDefined();
  });
});
