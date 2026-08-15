import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

describe("public market-datasets type compatibility", () => {
  it("compiles the legacy DatasetDef assignment through the package subpath", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const tsc = path.resolve(packageRoot, "../../node_modules/typescript/bin/tsc");
    const project = path.join(packageRoot, "tests/typecheck/tsconfig.json");

    expect(() =>
      execFileSync(process.execPath, [tsc, "--project", project], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
