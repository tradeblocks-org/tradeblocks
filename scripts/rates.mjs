import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SOFR_RATES } from "../packages/lib/data/sofr-rates.ts";
import { TREASURY_RATES } from "../packages/lib/data/treasury-rates.ts";
import {
  PUBLISHED_RATES_URL,
  validatePublishedRates,
} from "../packages/lib/utils/published-rates.ts";

const sourceFiles = {
  DTB3: fileURLToPath(new URL("../packages/lib/data/treasury-rates.ts", import.meta.url)),
  SOFR: fileURLToPath(new URL("../packages/lib/data/sofr-rates.ts", import.meta.url)),
};
const bundled = { DTB3: TREASURY_RATES, SOFR: SOFR_RATES };
const FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export function parseFredCsv(csv, series = "DTB3") {
  const lines = csv
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/);
  if (lines[0] !== `DATE,${series}` && lines[0] !== `observation_date,${series}`) {
    throw new Error(`FRED ${series} CSV header is invalid`);
  }
  const observations = [];
  let previousDate = "";
  for (const line of lines.slice(1)) {
    const match = /^(\d{4}-\d{2}-\d{2}),(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid FRED ${series} CSV row: ${line}`);
    const [, date, value] = match;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid FRED ${series} observation date: ${date}`);
    }
    if (date <= previousDate)
      throw new Error(`FRED ${series} dates are not strictly ascending: ${date}`);
    previousDate = date;
    if (value === "" || value === ".") continue;
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
      throw new Error(`Invalid FRED ${series} value on ${date}: ${value}`);
    }
    const rate = Number(value);
    if (!Number.isFinite(rate) || !Number.isSafeInteger(Math.round(rate * 100))) {
      throw new Error(`Invalid FRED ${series} value on ${date}: ${value}`);
    }
    observations.push({ date, rate });
  }
  return observations;
}

export function mergeBundledRates(source, observations) {
  const entries = [...source.matchAll(/^  "(\d{4}-\d{2}-\d{2})": [^\n]+,$/gm)];
  if (!entries.length || !source.endsWith("};\n")) {
    throw new Error("Invalid bundled rate source shape");
  }
  const tail = entries.at(-1)[1];
  const additions = observations.filter(({ date }) => date > tail);
  const rendered = additions.map(({ date, rate }) => `  "${date}": ${rate},\n`).join("");
  return {
    tail,
    latest: additions.at(-1)?.date ?? tail,
    added: additions.length,
    source: source.slice(0, -3) + rendered + "};\n",
  };
}

export function publishedStatus(published, latest) {
  const series = {};
  for (const name of ["DTB3", "SOFR"]) {
    const publishedThrough = published.series[name].lastDate;
    const fredLatest = latest[name];
    if (!fredLatest || fredLatest < publishedThrough) {
      throw new Error(
        `FRED ${name} returned no numeric observation at or after ${publishedThrough}`,
      );
    }
    series[name] = {
      publishedThrough,
      fredLatest,
      lagDays: Math.round(
        (Date.parse(`${fredLatest}T00:00:00Z`) - Date.parse(`${publishedThrough}T00:00:00Z`)) /
          86400000,
      ),
    };
  }
  return series;
}

async function readPublished(url) {
  if (url.startsWith("file://"))
    return validatePublishedRates(JSON.parse(await readFile(fileURLToPath(url), "utf8")));
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Published rates HTTP ${response.status}`);
  return validatePublishedRates(await response.json());
}

async function fetchFred(series, start) {
  const url = new URL(FRED_URL);
  url.searchParams.set("id", series);
  url.searchParams.set("cosd", start);
  url.searchParams.set("coed", new Date().toISOString().slice(0, 10));
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`FRED ${series} HTTP ${response.status}`);
  return parseFredCsv(await response.text(), series).filter(({ date }) => date >= start);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const getOption = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const json = args.includes("--json");
  const ratesUrl = getOption("--rates-url") ?? PUBLISHED_RATES_URL;
  const out = getOption("--out");
  const maxLagText = getOption("--max-lag-days");
  if (
    !["publish", "check", "seed", "seed-check"].includes(command) ||
    args.some(
      (arg, index) =>
        !["--json", "--rates-url", "--out", "--max-lag-days"].includes(arg) &&
        ![
          args.indexOf("--rates-url") + 1,
          args.indexOf("--out") + 1,
          args.indexOf("--max-lag-days") + 1,
        ].includes(index),
    ) ||
    (command !== "check" && json) ||
    (command === "publish" && !out) ||
    (command !== "publish" && out) ||
    (command !== "seed-check" && maxLagText !== null) ||
    (command === "seed-check" &&
      (!/^(0|[1-9]\d*)$/.test(maxLagText) || !Number.isSafeInteger(Number(maxLagText))))
  ) {
    throw new Error(
      "Usage: rates.mjs publish --out FILE | check [--json] | seed | seed-check --max-lag-days N [--rates-url URL]",
    );
  }
  let published = null;
  let series = { DTB3: null, SOFR: null };
  try {
    if (command === "publish") {
      const results = await Promise.all(
        ["DTB3", "SOFR"].map(async (name) => {
          const firstDate = Object.keys(bundled[name])[0];
          const observations = await fetchFred(name, firstDate);
          if (!observations.length) throw new Error(`FRED ${name} returned no observations`);
          const rates = Object.fromEntries(observations.map(({ date, rate }) => [date, rate]));
          for (const [date, rate] of Object.entries(bundled[name])) {
            if (rates[date] !== rate) {
              throw new Error(`FRED ${name} disagrees with bundled observation on ${date}`);
            }
          }
          return [
            name,
            {
              unit: "annual-percent",
              firstDate,
              lastDate: observations.at(-1).date,
              rates,
            },
          ];
        }),
      );
      published = validatePublishedRates({
        schemaVersion: 1,
        source: "Federal Reserve Economic Data (FRED), Federal Reserve Bank of St. Louis",
        fetchedAt: new Date().toISOString(),
        series: Object.fromEntries(results),
      });
      // On an existing data branch, revisions to already published observations are not silent updates.
      let prior;
      try {
        prior = await readPublished(ratesUrl);
      } catch (error) {
        if (!String(error.message).includes("HTTP 404")) throw error;
      }
      if (prior) {
        for (const name of ["DTB3", "SOFR"]) {
          for (const [date, rate] of Object.entries(prior.series[name].rates)) {
            if (published.series[name].rates[date] !== rate) {
              throw new Error(`FRED ${name} revised published observation on ${date}`);
            }
          }
        }
      }
      await writeFile(out, JSON.stringify(published) + "\n");
      console.log(
        `Published rates written: DTB3 ${published.series.DTB3.lastDate}, SOFR ${published.series.SOFR.lastDate}`,
      );
      return;
    }
    published = await readPublished(ratesUrl);
    if (command === "check") {
      const names = ["DTB3", "SOFR"];
      const observations = await Promise.all(
        names.map((name) => fetchFred(name, published.series[name].lastDate)),
      );
      series = publishedStatus(
        published,
        Object.fromEntries(observations.map((rows, index) => [names[index], rows.at(-1)?.date])),
      );
      const status = Object.values(series).some(({ lagDays }) => lagDays > 0)
        ? "behind"
        : "current";
      const result = { ratesUrl, fetchedAt: published.fetchedAt, status, reason: null, series };
      if (json) console.log(JSON.stringify(result));
      else
        console.log(
          `Published rates ${status}: DTB3 ${series.DTB3.publishedThrough}/${series.DTB3.fredLatest}; SOFR ${series.SOFR.publishedThrough}/${series.SOFR.fredLatest}`,
        );
      process.exitCode = status === "behind" ? 1 : 0;
      return;
    }
    const updates = {};
    for (const name of ["DTB3", "SOFR"]) {
      const source = await readFile(sourceFiles[name], "utf8");
      updates[name] = mergeBundledRates(
        source,
        Object.entries(published.series[name].rates).map(([date, rate]) => ({ date, rate })),
      );
      if (command === "seed-check") {
        const lag = Math.round(
          (Date.parse(`${published.series[name].lastDate}T00:00:00Z`) -
            Date.parse(`${updates[name].tail}T00:00:00Z`)) /
            86400000,
        );
        if (lag > Number(maxLagText)) {
          throw new Error(
            `Bundled ${name} rates lag published data by ${lag} days; run node scripts/rates.mjs seed before release`,
          );
        }
      }
    }
    if (command === "seed") {
      for (const name of ["DTB3", "SOFR"]) await writeFile(sourceFiles[name], updates[name].source);
      console.log(`Seeded bundles: DTB3 ${updates.DTB3.latest}, SOFR ${updates.SOFR.latest}`);
    } else console.log(`Bundled rates within ${maxLagText} days of published data`);
  } catch (error) {
    if (command === "check" && json)
      console.log(
        JSON.stringify({
          ratesUrl,
          fetchedAt: published?.fetchedAt ?? null,
          status: "unknown",
          reason: error.message,
          series: {
            DTB3: {
              publishedThrough: published?.series.DTB3.lastDate ?? null,
              fredLatest: series.DTB3?.fredLatest ?? null,
              lagDays: series.DTB3?.lagDays ?? null,
            },
            SOFR: {
              publishedThrough: published?.series.SOFR.lastDate ?? null,
              fredLatest: series.SOFR?.fredLatest ?? null,
              lagDays: series.SOFR?.lagDays ?? null,
            },
          },
        }),
      );
    console.error(`::error::Rates ${command} failed: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`::error::Rates command failed: ${error.message}`);
    process.exitCode = 2;
  });
}
