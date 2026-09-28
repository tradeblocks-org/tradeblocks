import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FilePartitionCommitStore,
  MarketIngestor,
  activePartitionCommitAttempt,
  addressBytes,
  canonicalJson,
  capturePartitionCommitReceipt,
  getEnrichedThrough,
  publishCanonicalMarketResolverRegistry,
  publishInputClosure,
  verifyCanonicalMarketDataCutoff,
  verifyCanonicalRefreshCompletion,
  type BulkProgressEvent,
  type IngestBarsOptions,
  type IngestChainOptions,
  type IngestOpenInterestOptions,
  type IngestQuotesOptions,
  type IngestResult,
  type MarketIngestorDeps,
} from "../../src/test-exports.ts";

describe("producer-owned canonical refresh completion", () => {
  let dataRoot: string;
  let marketRoot: string;
  let deps: MarketIngestorDeps;

  beforeEach(() => {
    dataRoot = join(
      tmpdir(),
      `refresh-completion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    marketRoot = join(dataRoot, "market");
    mkdirSync(marketRoot, { recursive: true });
    deps = {
      dataRoot,
      stores: {
        spot: {} as MarketIngestorDeps["stores"]["spot"],
        chain: {} as MarketIngestorDeps["stores"]["chain"],
        quote: {
          tickers: { resolve: (symbol: string) => symbol.toUpperCase() },
        } as MarketIngestorDeps["stores"]["quote"],
        oiDaily: {} as MarketIngestorDeps["stores"]["oiDaily"],
        enriched: {
          compute: async () => undefined,
          computeContext: async () => undefined,
        } as unknown as MarketIngestorDeps["stores"]["enriched"],
      },
    };
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  class StubIngestor extends MarketIngestor {
    zeroRows = false;
    extraReceipt = false;
    droppedRows = 0;
    quoteProgress: "complete" | "none" | "late-error" = "complete";

    async commit(
      dataset:
        | "spot"
        | "enriched"
        | "enriched_context"
        | "option_chain"
        | "option_quote_minutes"
        | "option_oi_daily",
      partition: Record<string, string>,
    ) {
      const attempt = activePartitionCommitAttempt();
      if (!attempt) throw new Error("test stub expected an active receipt attempt");
      const parts =
        dataset === "spot" || dataset === "enriched"
          ? [dataset, `ticker=${partition.ticker}`, `date=${partition.date}`, "data.parquet"]
          : dataset === "enriched_context"
            ? ["enriched", "context", `date=${partition.date}`, "data.parquet"]
            : [
                dataset,
                `underlying=${partition.underlying}`,
                `date=${partition.date}`,
                "data.parquet",
              ];
      const relativePath = parts.join("/");
      const targetPath = join(marketRoot, ...parts);
      const preparedPath = `${targetPath}.prepared-${Math.random().toString(36).slice(2)}`;
      const bytes = Buffer.from(canonicalJson({ dataset, partition, rows: 1 }));
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(preparedPath, bytes);
      const stored = await attempt.recorder.publishFileCommit({
        dataset,
        partition,
        schemaRevision: 1,
        relativePath,
        coverage: { kind: "date-range", from: partition.date, through: partition.date },
        quality: {
          inputRows: 1 + this.droppedRows,
          writtenRows: 1,
          droppedRows: this.droppedRows,
        },
        file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
        preparedPath,
        expectedTargetPath: targetPath,
      });
      capturePartitionCommitReceipt(stored);
    }

    override async ingestBars(opts: IngestBarsOptions): Promise<IngestResult> {
      if (this.zeroRows) return { status: "ok", rowsWritten: 0 };
      await this.commit("spot", { ticker: opts.tickers[0].toUpperCase(), date: opts.from });
      if (this.extraReceipt) {
        await this.commit("spot", { ticker: "SPY", date: opts.from });
      }
      return { status: "ok", rowsWritten: 1, dateRange: { from: opts.from, to: opts.to } };
    }

    override async ingestChain(opts: IngestChainOptions): Promise<IngestResult> {
      await this.commit("option_chain", {
        underlying: opts.underlyings[0].toUpperCase(),
        date: opts.from,
      });
      return { status: "ok", rowsWritten: 1, dateRange: { from: opts.from, to: opts.to } };
    }

    override async ingestQuotes(opts: IngestQuotesOptions): Promise<IngestResult> {
      const underlying = opts.underlyings![0].toUpperCase();
      await this.commit("option_quote_minutes", {
        underlying,
        date: opts.from,
      });
      const complete = (right: "call" | "put"): BulkProgressEvent => ({
        kind: "group",
        underlying,
        root: underlying,
        right,
        date: opts.from,
        status: "ok",
        phase: "complete",
        completedContracts: 1,
        totalContracts: 1,
      });
      if (this.quoteProgress !== "none") {
        await opts.onProgress?.(complete("call"));
        await opts.onProgress?.(complete("put"));
      }
      if (this.quoteProgress === "late-error") {
        await opts.onProgress?.({
          kind: "group",
          underlying,
          root: underlying,
          right: "call",
          date: opts.from,
          status: "error",
          phase: "complete",
        });
      }
      return { status: "ok", rowsWritten: 1, dateRange: { from: opts.from, to: opts.to } };
    }

    override async ingestOpenInterest(opts: IngestOpenInterestOptions): Promise<IngestResult> {
      await this.commit("option_oi_daily", {
        underlying: opts.underlyings[0].toUpperCase(),
        date: opts.from,
      });
      return { status: "ok", rowsWritten: 1, dateRange: { from: opts.from, to: opts.to } };
    }
  }

  async function spotClosure() {
    const partitions = new FilePartitionCommitStore(marketRoot);
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        {
          kind: "range",
          dataClass: "spot",
          selectorPrefix: { ticker: "IWM" },
          fromSession: "2026-07-06",
          throughSession: "2026-07-06",
        },
      ],
    });
    return { partitions, closure };
  }

  async function quoteClosure() {
    const partitions = new FilePartitionCommitStore(marketRoot);
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        {
          kind: "range",
          dataClass: "option_quote_minutes",
          selectorPrefix: { underlying: "IWM" },
          fromSession: "2026-07-06",
          throughSession: "2026-07-06",
        },
      ],
    });
    return { partitions, closure };
  }

  async function enrichedClosure() {
    const partitions = new FilePartitionCommitStore(marketRoot);
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        {
          kind: "exact",
          dataClass: "spot",
          selector: { ticker: "IWM", date: "2026-07-06" },
          session: "2026-07-06",
        },
        {
          kind: "exact",
          dataClass: "enriched",
          selector: { ticker: "IWM", date: "2026-07-06" },
          session: "2026-07-06",
        },
      ],
    });
    return { partitions, closure };
  }

  async function enrichedContextClosure() {
    const partitions = new FilePartitionCommitStore(marketRoot);
    const registry = await publishCanonicalMarketResolverRegistry(partitions.objects);
    const session = "2026-07-06";
    const closure = await publishInputClosure(partitions.objects, {
      registry: registry.address,
      observations: [
        ...["SPX", "VIX", "VIX3M", "VIX9D"].map((ticker) => ({
          kind: "exact" as const,
          dataClass: "spot",
          selector: { ticker, date: session },
          session,
        })),
        {
          kind: "exact",
          dataClass: "enriched_context",
          selector: { date: session },
          session,
        },
      ],
    });
    return { partitions, closure };
  }

  it("mints a refresh completion and binds it into the cutoff authority", async () => {
    const { partitions, closure } = await spotClosure();
    const ingestor = new StubIngestor(deps);
    const result = await ingestor.refresh({
      asOf: "2026-07-06",
      spotTickers: ["iwm", "IWM"],
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "refresh-success" },
    });

    expect(result.status).toBe("ok");
    expect(result.provenance?.receipts).toHaveLength(1);
    const completion = await verifyCanonicalRefreshCompletion(
      partitions,
      result.provenance!.completion,
    );
    expect(completion.value.plan.spotTickers).toEqual(["IWM"]);
    const cutoff = await verifyCanonicalMarketDataCutoff(partitions, result.provenance!.cutoff);
    expect(cutoff.manifest.refreshCompletion).toBe(result.provenance!.completion);
    expect(cutoff.manifest.aggregateRoot).toBe(result.provenance!.aggregateRoot);
  });

  it("requires the closure-owned enriched partition before minting completion", async () => {
    const { partitions, closure } = await enrichedClosure();
    const missing = new StubIngestor(deps);
    await expect(
      missing.refresh({
        asOf: "2026-07-06",
        spotTickers: ["IWM"],
        computeVixContext: false,
        provenance: { closure: closure.address, attemptId: "enriched-missing" },
      }),
    ).rejects.toThrow(/do not equal the producer inventory/);
    await expect(getEnrichedThrough("IWM", dataRoot)).resolves.toBeNull();

    const ingestor = new StubIngestor(deps);
    deps.stores.enriched = {
      compute: async (ticker: string, from: string) => {
        await ingestor.commit("enriched", { ticker, date: from });
      },
      computeContext: async () => undefined,
    } as unknown as MarketIngestorDeps["stores"]["enriched"];
    const result = await ingestor.refresh({
      asOf: "2026-07-06",
      spotTickers: ["IWM"],
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "enriched-success" },
    });
    const completion = await verifyCanonicalRefreshCompletion(
      partitions,
      result.provenance!.completion,
    );
    expect(completion.value.plan.enrichedTickers).toEqual(["IWM"]);
    expect(completion.value.receipts.map((receipt) => receipt.dataset)).toEqual([
      "enriched",
      "spot",
    ]);
    await expect(getEnrichedThrough("IWM", dataRoot)).resolves.toBe("2026-07-06");
    await expect(
      verifyCanonicalMarketDataCutoff(partitions, result.provenance!.cutoff),
    ).resolves.toBeDefined();
  });

  it("requires the closure-owned context receipt without advancing ticker watermarks", async () => {
    const { partitions, closure } = await enrichedContextClosure();
    const input = {
      asOf: "2026-07-06",
      spotTickers: ["SPX", "VIX", "VIX3M", "VIX9D"],
      provenance: { closure: closure.address, attemptId: "context-missing" },
    } as const;
    const missing = new StubIngestor(deps);
    await expect(missing.refresh(input)).rejects.toThrow(/do not equal the producer inventory/);
    for (const ticker of input.spotTickers) {
      await expect(getEnrichedThrough(ticker, dataRoot)).resolves.toBeNull();
    }

    const ingestor = new StubIngestor(deps);
    deps.stores.enriched = {
      compute: async () => undefined,
      computeContext: async (from: string) => {
        await ingestor.commit("enriched_context", { date: from });
      },
    } as unknown as MarketIngestorDeps["stores"]["enriched"];
    const result = await ingestor.refresh({
      ...input,
      provenance: { ...input.provenance, attemptId: "context-success" },
    });
    const completion = await verifyCanonicalRefreshCompletion(
      partitions,
      result.provenance!.completion,
    );
    expect(completion.value.plan.includeEnrichedContext).toBe(true);
    expect(completion.value.receipts.map((receipt) => receipt.dataset)).toEqual([
      "enriched_context",
      "spot",
      "spot",
      "spot",
      "spot",
    ]);
    for (const ticker of input.spotTickers) {
      await expect(getEnrichedThrough(ticker, dataRoot)).resolves.toBeNull();
    }
  });

  it("refuses ok-with-zero, unexpected receipts, and dropped rows", async () => {
    const { closure } = await spotClosure();
    const input = {
      asOf: "2026-07-06",
      spotTickers: ["IWM"],
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "refresh-refusal" },
    } as const;

    const zero = new StubIngestor(deps);
    zero.zeroRows = true;
    await expect(zero.refresh(input)).rejects.toThrow(/was not terminal/);

    const extra = new StubIngestor(deps);
    extra.extraReceipt = true;
    await expect(extra.refresh(input)).rejects.toThrow(/do not equal the producer inventory/);

    const dropped = new StubIngestor(deps);
    dropped.droppedRows = 1;
    await expect(dropped.refresh(input)).rejects.toThrow(/complete zero-drop cutoff partition/);
  });

  it("refuses per-ticker quote overwrite mode and unsupported cutoff dates", async () => {
    const { closure } = await spotClosure();
    const ingestor = new StubIngestor(deps);
    await expect(
      ingestor.refresh({
        asOf: "2026-07-06",
        spotTickers: ["IWM"],
        quoteTickers: ["IWM260717C00200000"],
        provenance: { closure: closure.address, attemptId: "ticker-overwrite" },
      }),
    ).rejects.toThrow(/refuses quoteTickers/);
    await expect(
      ingestor.refresh({
        asOf: "2026-07-04",
        spotTickers: ["IWM"],
        provenance: { closure: closure.address, attemptId: "holiday" },
      }),
    ).rejects.toThrow(/not a supported XNYS session/);
  });

  it("requires and persists every terminal quote root/right completion", async () => {
    const { partitions, closure } = await quoteClosure();
    const ingestor = new StubIngestor(deps);
    const result = await ingestor.refresh({
      asOf: "2026-07-06",
      quoteUnderlyings: ["IWM"],
      provider: "thetadata",
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "quote-terminal-success" },
    });

    const completion = await verifyCanonicalRefreshCompletion(
      partitions,
      result.provenance!.completion,
    );
    expect(completion.value.quoteGroups).toEqual([
      {
        underlying: "IWM",
        root: "IWM",
        right: "call",
        date: "2026-07-06",
        completedContracts: 1,
        totalContracts: 1,
      },
      {
        underlying: "IWM",
        root: "IWM",
        right: "put",
        date: "2026-07-06",
        completedContracts: 1,
        totalContracts: 1,
      },
    ]);
    await expect(
      verifyCanonicalMarketDataCutoff(partitions, result.provenance!.cutoff),
    ).resolves.toBeDefined();
  });

  it("refuses absent or subsequently poisoned quote terminal evidence", async () => {
    const { closure } = await quoteClosure();
    const input = {
      asOf: "2026-07-06",
      quoteUnderlyings: ["IWM"],
      provider: "thetadata",
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "quote-terminal-refusal" },
    } as const;

    const absent = new StubIngestor(deps);
    absent.quoteProgress = "none";
    await expect(absent.refresh(input)).rejects.toThrow(/did not complete every root\/right group/);

    const poisoned = new StubIngestor(deps);
    poisoned.quoteProgress = "late-error";
    await expect(poisoned.refresh(input)).rejects.toThrow(
      /did not complete every root\/right group/,
    );
  });

  it("invalidates a completion when its cutoff receipt is repaired", async () => {
    const { partitions, closure } = await spotClosure();
    const ingestor = new StubIngestor(deps);
    const result = await ingestor.refresh({
      asOf: "2026-07-06",
      spotTickers: ["IWM"],
      computeVixContext: false,
      provenance: { closure: closure.address, attemptId: "refresh-repair" },
    });
    const partition = { ticker: "IWM", date: "2026-07-06" };
    const relativePath = "spot/ticker=IWM/date=2026-07-06/data.parquet";
    const targetPath = join(marketRoot, ...relativePath.split("/"));
    const preparedPath = `${targetPath}.prepared-repair`;
    const bytes = Buffer.from(canonicalJson({ repaired: true }));
    mkdirSync(dirname(preparedPath), { recursive: true });
    writeFileSync(preparedPath, bytes);
    await partitions.publishFileCommit({
      dataset: "spot",
      partition,
      schemaRevision: 1,
      relativePath,
      coverage: { kind: "date-range", from: partition.date, through: partition.date },
      quality: { inputRows: 1, writtenRows: 1, droppedRows: 0 },
      file: { address: addressBytes(bytes), bytes: bytes.byteLength, rows: 1 },
      preparedPath,
      expectedTargetPath: targetPath,
    });

    await expect(
      verifyCanonicalRefreshCompletion(partitions, result.provenance!.completion),
    ).rejects.toThrow(/current exact-byte authority tip/);
  });
});
