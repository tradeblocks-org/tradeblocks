#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const {
  FilePartitionCommitStore,
  addressBytes,
  addressCanonicalJson,
  canonicalJson,
  parseCanonicalJsonAddress,
} = await import(process.env.PROVENANCE_PACKAGE_IMPORT ?? "../dist/market/provenance/index.js");

const scriptPath = fileURLToPath(import.meta.url);

function bootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unavailable";
  } catch {
    return "unavailable";
  }
}

function identityDigest(identity) {
  return parseCanonicalJsonAddress(
    addressCanonicalJson({
      kind: "tradeblocks.market-data.partition-identity",
      version: 1,
      ...identity,
    }),
  );
}

function syncPath(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function worker(jobPath) {
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  const store = new FilePartitionCommitStore(job.marketRoot, {
    staleLockMs: 0,
    lockWaitMs: 5_000,
  });
  const stored = await store.publishFileCommit(job.input);
  process.stdout.write(
    `${JSON.stringify({ address: stored.address, classification: stored.receipt.classification })}\n`,
  );
}

async function claimHolder(marketRoot, digest, token) {
  const claimPath = join(
    marketRoot,
    ".provenance",
    "locks",
    digest.slice(0, 2),
    digest,
    "claims",
    token,
  );
  mkdirSync(claimPath, { recursive: true });
  const ownerPath = join(claimPath, "owner.json");
  const ticketPath = join(claimPath, "ticket.json");
  writeFileSync(
    ownerPath,
    canonicalJson({
      kind: "tradeblocks.market-data.partition-lock-owner",
      version: 1,
      token,
      pid: process.pid,
      hostname: hostname(),
      bootId: bootId(),
      createdAtMs: 0,
    }),
  );
  writeFileSync(
    ticketPath,
    canonicalJson({
      kind: "tradeblocks.market-data.partition-lock-ticket",
      version: 1,
      token,
      number: 1,
    }),
  );
  syncPath(ownerPath);
  syncPath(ticketPath);
  for (let directory = claimPath; directory !== marketRoot; directory = dirname(directory)) {
    syncPath(directory);
  }
  syncPath(marketRoot);
  process.stdout.write("READY\n");
  await new Promise(() => setInterval(() => undefined, 60_000));
}

function runChild(args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed, stdout: () => stdout };
}

function publicationInput(marketRoot, identity, content, suffix) {
  const relativePath = `spot/ticker=${identity.partition.ticker}/date=${identity.partition.date}/data.parquet`;
  const targetPath = join(marketRoot, ...relativePath.split("/"));
  mkdirSync(dirname(targetPath), { recursive: true });
  const preparedPath = `${targetPath}.prepared-${suffix}`;
  const bytes = Buffer.from(content);
  writeFileSync(preparedPath, bytes);
  return {
    dataset: identity.dataset,
    partition: identity.partition,
    schemaRevision: 1,
    relativePath,
    coverage: {
      kind: "date-range",
      from: identity.partition.date,
      through: identity.partition.date,
    },
    quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
    file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
    preparedPath,
    expectedTargetPath: targetPath,
  };
}

async function waitForReady(processRun) {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (processRun.stdout().includes("READY")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("claim holder did not become ready");
}

async function verify() {
  const root = mkdtempSync(join(tmpdir(), "provenance-process-lock-"));
  const marketRoot = join(root, "market");
  mkdirSync(marketRoot, { recursive: true });
  try {
    const identity = {
      dataset: "spot",
      partition: { ticker: "IWM", date: "2026-07-20" },
    };
    const jobs = ["first", "second"].map((content, index) => {
      const jobPath = join(root, `job-${index}.json`);
      writeFileSync(
        jobPath,
        JSON.stringify({
          marketRoot,
          input: publicationInput(marketRoot, identity, content, index),
        }),
      );
      return runChild(["worker", jobPath]);
    });
    const results = await Promise.all(jobs.map((job) => job.completed));
    for (const result of results) {
      if (result.code !== 0) throw new Error(`writer failed: ${result.stderr}`);
    }
    const classifications = results
      .map((result) => JSON.parse(result.stdout.trim()).classification)
      .sort();
    if (JSON.stringify(classifications) !== JSON.stringify(["append", "repair"])) {
      throw new Error(`writers were not serialized: ${JSON.stringify(classifications)}`);
    }
    const store = new FilePartitionCommitStore(marketRoot);
    const inspection = await store.inspectPartition(identity);
    if (inspection.status !== "match") throw new Error(`final partition is ${inspection.status}`);
    const digest = identityDigest(identity);
    const eventFiles = readdirSync(
      join(marketRoot, ".provenance", "events", digest.slice(0, 2), digest),
    );
    if (eventFiles.length !== 2)
      throw new Error(`expected two linear events, got ${eventFiles.length}`);

    const killedIdentity = {
      dataset: "spot",
      partition: { ticker: "IWM", date: "2026-07-21" },
    };
    const killedDigest = identityDigest(killedIdentity);
    const killedToken = "30000000-0000-4000-8000-000000000000";
    const holder = runChild(["claim-holder", marketRoot, killedDigest, killedToken]);
    await waitForReady(holder);
    holder.child.kill("SIGKILL");
    await holder.completed;

    const recoveryStore = new FilePartitionCommitStore(marketRoot, {
      staleLockMs: 0,
      lockWaitMs: 5_000,
    });
    await recoveryStore.publishFileCommit(
      publicationInput(marketRoot, killedIdentity, "after-kill", "recovery"),
    );
    const quarantine = readdirSync(
      join(
        marketRoot,
        ".provenance",
        "locks",
        killedDigest.slice(0, 2),
        killedDigest,
        "quarantine",
      ),
    );
    if (quarantine.length !== 1) throw new Error("killed claim was not quarantined exactly once");

    console.log(
      "verify-provenance-process-lock: OK (two-process linear chain, matching target/head, killed-owner recovery)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "worker") await worker(process.argv[3]);
else if (mode === "claim-holder") {
  await claimHolder(process.argv[3], process.argv[4], process.argv[5]);
} else await verify();
