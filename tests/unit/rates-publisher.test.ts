import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const csv = readFileSync(join(__dirname, "../data/fred-dtb3-2026-07.csv"), "utf8");
const bundled = readFileSync(join(__dirname, "../../packages/lib/data/treasury-rates.ts"), "utf8");
const updater = join(__dirname, "../../scripts/rates.mjs");
function runPure(operation: "parse" | "merge" | "status", input: string, source?: string) {
  const code = `import { readFileSync } from "node:fs";
    import { parseFredCsv, mergeBundledRates, publishedStatus } from ${JSON.stringify(updater)};
    try {
      const { operation, input, source } = JSON.parse(readFileSync(0, "utf8"));
      const observations = parseFredCsv(input);
      const result = operation === "parse" ? observations :
        operation === "merge" ? mergeBundledRates(source, observations) :
        publishedStatus({ series: { DTB3: { lastDate: source }, SOFR: { lastDate: source } } },
          { DTB3: observations.at(-1)?.date, SOFR: observations.at(-1)?.date });
      console.log(JSON.stringify({ value: result }));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      input: JSON.stringify({ operation, input, source }),
    }),
  );
}
function ratesFrom(source: string): Record<string, number> {
  const exports: { TREASURY_RATES?: Record<string, number> } = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(js, { exports });
  return exports.TREASURY_RATES!;
}

describe("FRED Treasury rate refresh", () => {
  it("parses the recorded FRED response with blank holiday rows and only adds dates after the tail", () => {
    const parsed = runPure("parse", csv);
    expect(parsed.error).toBeUndefined();
    expect(parsed.value).not.toContainEqual(expect.objectContaining({ date: "2026-07-03" }));
    expect(parsed.value).toContainEqual({ date: "2026-07-21", rate: 3.74 });
    const previous = bundled.replace(/(  "2026-07-20": 3.73,\n)[\s\S]*?(?=};\n$)/, "$1");
    const result = runPure("merge", csv, previous).value;
    expect(result.added).toBe(5);
    expect(result.latest).toBe("2026-07-27");
    const before = ratesFrom(previous);
    const after = ratesFrom(result.source);
    expect(Object.keys(after).filter((date) => !(date in before))).toEqual([
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-27",
    ]);
    expect(after["2026-07-21"]).toBe(3.74);
    expect(after["2026-07-27"]).toBe(3.82);
    expect(after["2026-07-03"]).toBeUndefined();
  });

  it("filters a full-history response and makes no change when there are no newer observations", () => {
    const source =
      'export const TREASURY_RATES: Record<string, number> = {\n  "2026-07-24": 3.81,\n};\n';
    const result = runPure("merge", csv, source).value;
    expect(result.added).toBe(1);
    expect(ratesFrom(result.source)["2026-07-27"]).toBe(3.82);
    const current = runPure("merge", csv, result.source).value;
    expect(current.added).toBe(0);
    expect(current.source).toBe(result.source);
  });

  it("rejects unexpected headers, invalid dates, unordered rows and non-cent values", () => {
    expect(runPure("parse", "<html>error</html>\n").error).toMatch(/header/);
    expect(runPure("parse", "DATE,DTB3\n2026-02-30,3.50\n").error).toMatch(/date/);
    expect(runPure("parse", "DATE,DTB3\n2026-07-22,3.75\n2026-07-21,3.74\n").error).toMatch(
      /ascending/,
    );
    expect(runPure("parse", "DATE,DTB3\n2026-07-21,3.741\n").error).toMatch(/value/);
    expect(runPure("parse", "DATE,DTB3\n2026-07-03,.\n2026-07-06,3.74\n").value).toEqual([
      { date: "2026-07-06", rate: 3.74 },
    ]);
  });
  it("reports each published series' true calendar lag", () => {
    const datedCsv = "DATE,DTB3\n2026-07-17,3.71\n2026-07-27,3.82\n";
    expect(runPure("status", datedCsv, "2026-07-17").value).toEqual({
      DTB3: { publishedThrough: "2026-07-17", fredLatest: "2026-07-27", lagDays: 10 },
      SOFR: { publishedThrough: "2026-07-17", fredLatest: "2026-07-27", lagDays: 10 },
    });
    expect(runPure("status", "DATE,DTB3\n2026-07-17,.\n", "2026-07-17").error).toMatch(
      /no numeric observation/,
    );
  });
});
