import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import type { Root } from "protobufjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function protoCandidates(): string[] {
  return Array.from(
    new Set([
      resolve(moduleDir, "mdds.proto"),
      resolve(moduleDir, "../../../mdds.proto"),
      resolve(moduleDir, "../../../../server/mdds.proto"),
      resolve(moduleDir, "../../../../dist/mdds.proto"),
      resolve(process.cwd(), "packages/mcp-server/src/utils/providers/thetadata/mdds.proto"),
      resolve(process.cwd(), "src/utils/providers/thetadata/mdds.proto"),
      resolve(process.cwd(), "server/mdds.proto"),
      resolve(process.cwd(), "dist/mdds.proto"),
    ]),
  );
}

export function resolveMddsProtoPath(): string {
  const candidates = protoCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`ThetaData MDDS proto not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

let grpcPackage: unknown | null = null;
let protobufRoot: Root | null = null;

export function loadMddsGrpcPackage(): unknown {
  if (!grpcPackage) {
    const definition = protoLoader.loadSync(resolveMddsProtoPath(), {
      longs: Number,
      enums: String,
      defaults: false,
      oneofs: true,
      bytes: Buffer,
    });
    grpcPackage = grpc.loadPackageDefinition(definition);
  }
  return grpcPackage;
}

export function loadMddsProtoRoot(): Root {
  if (!protobufRoot) protobufRoot = protobuf.loadSync(resolveMddsProtoPath());
  return protobufRoot;
}
