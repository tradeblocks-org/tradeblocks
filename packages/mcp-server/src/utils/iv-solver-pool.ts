/**
 * iv-solver-pool.ts
 *
 * A small worker_threads pool that fans the option-greeks Newton-Raphson solve
 * out across CPU cores. The solve is pure CPU over independent rows
 * (embarrassingly parallel), so splitting a batch across N workers scales
 * close to linearly until memory-bandwidth / scheduling overhead dominates.
 *
 * Output parity is exact: each worker runs the identical `computeLegGreeks`
 * over flat numeric jobs (see iv-solver-worker.ts), so the greeks it returns
 * are bit-identical to the single-threaded path. The pool only decides *where*
 * the loop runs, never *what* it computes.
 *
 * Degrade-to-inline rules (no worker spawned):
 *   - host reports <= 1 usable core
 *   - batch is smaller than the inline threshold (worker round-trip +
 *     structured-clone overhead would dominate the solve)
 *   - the pool is disabled via TRADEBLOCKS_IV_WORKERS=0
 * In every inline case the result is produced by the same `solveIvBatch`
 * function the worker runs, so inline and parallel are interchangeable.
 */

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  solveIvBatch,
  type IvSolveBatchRequest,
  type IvSolveBatchReply,
} from "./iv-solver-worker.ts";

/**
 * One job = one option row to solve. Flat numbers only — nothing here is a
 * closure or a Map, so the batch transfers cleanly to a worker.
 */
export interface IvSolveJob {
  optionPrice: number;
  underlyingPrice: number;
  strike: number;
  dte: number;
  type: "C" | "P";
  riskFreeRate: number;
  dividendYield: number;
}

export interface IvSolveJobResult {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  ok: boolean;
}

/**
 * Pre-built column batch — the hot-path input that avoids materializing an
 * `IvSolveJob[]` of plain objects. Callers fill these typed arrays directly
 * during row resolution; the pool shards and dispatches them without a copy.
 */
export interface IvSolveColumns {
  count: number;
  optionPrice: Float64Array;
  underlyingPrice: Float64Array;
  strike: Float64Array;
  dte: Float64Array;
  riskFreeRate: Float64Array;
  dividendYield: Float64Array;
  type: Uint8Array; // 0 = call, 1 = put
}

/** Reply columns — one entry per input row, in input order. */
export interface IvSolveColumnsResult {
  count: number;
  delta: Float64Array;
  gamma: Float64Array;
  theta: Float64Array;
  vega: Float64Array;
  iv: Float64Array;
  ok: Uint8Array; // 1 = finite greeks, 0 = solve failed
}

export interface IvSolverPoolOptions {
  /** Max workers. Defaults to availableParallelism()-1, clamped to >= 1. */
  maxWorkers?: number;
  /**
   * Below this many jobs the whole batch is solved inline on the calling
   * thread — the worker round-trip isn't worth it for small batches.
   */
  inlineThreshold?: number;
}

const DEFAULT_INLINE_THRESHOLD = 2_000;
// Don't bother splitting into shards smaller than this; tiny shards waste a
// worker round-trip. A batch is divided into at most `ceil(count / MIN_SHARD)`
// shards, never more than the worker count.
const MIN_SHARD = 1_000;

function resolveWorkerUrl(): URL {
  // Prefer the bundled sibling (.js) when present — that's the production
  // `dist/` runtime. Fall back to the .ts source for dev / test / ad-hoc node,
  // which Node strips types from natively.
  const jsUrl = new URL("./iv-solver-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) return jsUrl;
  return new URL("./iv-solver-worker.ts", import.meta.url);
}

function workersDisabledByEnv(): boolean {
  const flag = process.env.TRADEBLOCKS_IV_WORKERS;
  return flag === "0" || flag === "false" || flag === "off";
}

function defaultMaxWorkers(): number {
  const cores = Math.max(1, availableParallelism());
  return Math.max(1, cores - 1);
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

function jobsToColumns(jobs: IvSolveJob[]): IvSolveColumns {
  const count = jobs.length;
  const cols: IvSolveColumns = {
    count,
    optionPrice: new Float64Array(count),
    underlyingPrice: new Float64Array(count),
    strike: new Float64Array(count),
    dte: new Float64Array(count),
    riskFreeRate: new Float64Array(count),
    dividendYield: new Float64Array(count),
    type: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const job = jobs[i];
    cols.optionPrice[i] = job.optionPrice;
    cols.underlyingPrice[i] = job.underlyingPrice;
    cols.strike[i] = job.strike;
    cols.dte[i] = job.dte;
    cols.riskFreeRate[i] = job.riskFreeRate;
    cols.dividendYield[i] = job.dividendYield;
    cols.type[i] = job.type === "C" ? 0 : 1;
  }
  return cols;
}

/** Slice a column batch into a per-shard request, copying the [lo, hi) window. */
function shardRequest(
  cols: IvSolveColumns,
  id: number,
  lo: number,
  hi: number,
): IvSolveBatchRequest {
  return {
    id,
    count: hi - lo,
    optionPrice: cols.optionPrice.slice(lo, hi),
    underlyingPrice: cols.underlyingPrice.slice(lo, hi),
    strike: cols.strike.slice(lo, hi),
    dte: cols.dte.slice(lo, hi),
    riskFreeRate: cols.riskFreeRate.slice(lo, hi),
    dividendYield: cols.dividendYield.slice(lo, hi),
    type: cols.type.slice(lo, hi),
  };
}

function wholeRequest(cols: IvSolveColumns, id: number): IvSolveBatchRequest {
  return {
    id,
    count: cols.count,
    optionPrice: cols.optionPrice,
    underlyingPrice: cols.underlyingPrice,
    strike: cols.strike,
    dte: cols.dte,
    riskFreeRate: cols.riskFreeRate,
    dividendYield: cols.dividendYield,
    type: cols.type,
  };
}

function columnsResultFrom(reply: IvSolveBatchReply): IvSolveColumnsResult {
  return {
    count: reply.count,
    delta: reply.delta,
    gamma: reply.gamma,
    theta: reply.theta,
    vega: reply.vega,
    iv: reply.iv,
    ok: reply.ok,
  };
}

function resultsFromColumns(cols: IvSolveColumnsResult): IvSolveJobResult[] {
  const out: IvSolveJobResult[] = new Array(cols.count);
  for (let i = 0; i < cols.count; i++) {
    out[i] = {
      delta: cols.delta[i],
      gamma: cols.gamma[i],
      theta: cols.theta[i],
      vega: cols.vega[i],
      iv: cols.iv[i],
      ok: cols.ok[i] === 1,
    };
  }
  return out;
}

export class IvSolverPool {
  private readonly maxWorkers: number;
  private readonly inlineThreshold: number;
  private readonly workerUrl: URL;
  private readonly enabled: boolean;
  private pool: PoolWorker[] = [];
  private nextRequestId = 1;
  // Serializes parallel solves against the shared worker set. The `busy`/slot
  // accounting in solveColumnsParallel is only correct when a single solve
  // owns the whole pool; without this gate, two concurrent callers could route
  // shards onto the same worker and corrupt the busy bookkeeping. Inline solves
  // don't touch workers and bypass the gate.
  private parallelChain: Promise<unknown> = Promise.resolve();

  constructor(options: IvSolverPoolOptions = {}) {
    this.maxWorkers = Math.max(1, options.maxWorkers ?? defaultMaxWorkers());
    this.inlineThreshold = options.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
    this.workerUrl = resolveWorkerUrl();
    this.enabled = !workersDisabledByEnv() && this.maxWorkers > 1;
  }

  /**
   * Solve a batch of jobs, returning one result per job in input order. Thin
   * wrapper over `solveColumns` — convenient for callers (and tests) that hold
   * an `IvSolveJob[]`. The hot ingest path uses `solveColumns` directly to
   * avoid materializing the object array.
   */
  async solve(jobs: IvSolveJob[]): Promise<IvSolveJobResult[]> {
    if (jobs.length === 0) return [];
    const result = await this.solveColumns(jobsToColumns(jobs));
    return resultsFromColumns(result);
  }

  /**
   * Solve a pre-built column batch. Uses the worker pool when the batch is
   * large enough and workers are enabled; otherwise solves inline via the same
   * `solveIvBatch` the workers run (so inline and parallel are interchangeable).
   * The reply columns are positionally aligned with the input.
   */
  async solveColumns(cols: IvSolveColumns): Promise<IvSolveColumnsResult> {
    if (cols.count === 0) {
      return {
        count: 0,
        delta: new Float64Array(0),
        gamma: new Float64Array(0),
        theta: new Float64Array(0),
        vega: new Float64Array(0),
        iv: new Float64Array(0),
        ok: new Uint8Array(0),
      };
    }
    const shardCount = this.enabled
      ? Math.min(this.maxWorkers, Math.ceil(cols.count / MIN_SHARD))
      : 1;
    if (shardCount <= 1 || cols.count < this.inlineThreshold) {
      return columnsResultFrom(solveIvBatch(wholeRequest(cols, 0)));
    }
    // Single-flight: chain this parallel solve after any in-flight one so each
    // owns the worker pool exclusively. Errors don't poison the chain.
    const run = this.parallelChain
      .catch(() => undefined)
      .then(() => this.solveColumnsParallel(cols, shardCount));
    this.parallelChain = run;
    return run;
  }

  private async solveColumnsParallel(
    cols: IvSolveColumns,
    shardCount: number,
  ): Promise<IvSolveColumnsResult> {
    this.ensureWorkers(shardCount);

    const out: IvSolveColumnsResult = {
      count: cols.count,
      delta: new Float64Array(cols.count),
      gamma: new Float64Array(cols.count),
      theta: new Float64Array(cols.count),
      vega: new Float64Array(cols.count),
      iv: new Float64Array(cols.count),
      ok: new Uint8Array(cols.count),
    };

    // Ref the workers for the duration of this in-flight solve so the event
    // loop stays alive until every shard's result is back — the process can't
    // exit mid-solve and lose results. Idle workers are unref'd (see
    // ensureWorkers), so once the solve completes the pool stops pinning the
    // loop and a one-shot process exits naturally.
    this.refPool();
    try {
      const base = Math.floor(cols.count / shardCount);
      const remainder = cols.count % shardCount;
      const shardPromises: Promise<void>[] = [];
      let cursor = 0;
      for (let s = 0; s < shardCount; s++) {
        const size = base + (s < remainder ? 1 : 0);
        const lo = cursor;
        const hi = cursor + size;
        cursor = hi;
        if (size === 0) continue;
        const request = shardRequest(cols, this.nextRequestId++, lo, hi);
        shardPromises.push(
          this.runOnWorker(request).then((reply) => {
            out.delta.set(reply.delta, lo);
            out.gamma.set(reply.gamma, lo);
            out.theta.set(reply.theta, lo);
            out.vega.set(reply.vega, lo);
            out.iv.set(reply.iv, lo);
            out.ok.set(reply.ok, lo);
          }),
        );
      }

      await Promise.all(shardPromises);
      return out;
    } finally {
      this.unrefPool();
    }
  }

  private ensureWorkers(target: number): void {
    while (this.pool.length < target) {
      const worker = new Worker(this.workerUrl);
      worker.setMaxListeners(0);
      // Idle workers must not keep the libuv event loop alive — otherwise a
      // one-shot process that uses the pool and returns normally would hang
      // forever. solveColumnsParallel ref's the pool for the duration of an
      // in-flight solve and unref's it again when done.
      worker.unref();
      // Surface a worker crash by failing loud; an unhandled worker error
      // would otherwise leave the pending shard promise hanging forever.
      worker.on("error", (err) => {
        throw err;
      });
      this.pool.push({ worker, busy: false });
    }
  }

  /** Keep the event loop alive while a solve is in flight. */
  private refPool(): void {
    for (const { worker } of this.pool) worker.ref();
  }

  /** Release the event loop once a solve completes so idle workers don't pin it. */
  private unrefPool(): void {
    for (const { worker } of this.pool) worker.unref();
  }

  private runOnWorker(request: IvSolveBatchRequest): Promise<IvSolveBatchReply> {
    return new Promise<IvSolveBatchReply>((resolve, reject) => {
      const slot = this.acquire();
      const onMessage = (reply: IvSolveBatchReply) => {
        if (reply.id !== request.id) return;
        cleanup();
        slot.busy = false;
        resolve(reply);
      };
      const onError = (err: Error) => {
        cleanup();
        slot.busy = false;
        reject(err);
      };
      const cleanup = () => {
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
      };
      slot.worker.on("message", onMessage);
      slot.worker.once("error", onError);
      // All request columns are freshly-allocated ArrayBuffer-backed typed
      // arrays (never SharedArrayBuffer), so transferring their buffers is safe.
      slot.worker.postMessage(request, [
        request.optionPrice.buffer,
        request.underlyingPrice.buffer,
        request.strike.buffer,
        request.dte.buffer,
        request.riskFreeRate.buffer,
        request.dividendYield.buffer,
        request.type.buffer,
      ] as ArrayBuffer[]);
    });
  }

  private acquire(): PoolWorker {
    const free = this.pool.find((w) => !w.busy);
    // ensureWorkers always provisions one worker per shard before dispatch, so
    // a free slot is guaranteed here.
    const slot = free ?? this.pool[0];
    slot.busy = true;
    return slot;
  }

  /** Terminate all workers. Idempotent. */
  async destroy(): Promise<void> {
    const workers = this.pool;
    this.pool = [];
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
  }
}

let sharedPool: IvSolverPool | null = null;

/**
 * Process-wide shared pool. The ingest path reuses one pool across batches so
 * workers are spawned once, not per batch.
 */
export function getSharedIvSolverPool(): IvSolverPool {
  if (!sharedPool) {
    sharedPool = new IvSolverPool();
  }
  return sharedPool;
}

export async function destroySharedIvSolverPool(): Promise<void> {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    await pool.destroy();
  }
}
